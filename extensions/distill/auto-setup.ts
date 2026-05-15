/**
 * First-run auto-setup for auto-distill.
 *
 * Auto-distill needs the vault to be a git repo with a `.gitignore` that
 * excludes its ephemeral state (distill worktrees, Obsidian workspace-local
 * caches). Vaults typically ship without any of this — we scaffold it at
 * `session_start` when `distill.enabled` is true.
 *
 * PR #12 (agent-driven merge): pre-PR-12 auto-distill also installed an
 * `*.md merge=napkin-distill-merge` rule in `.gitattributes` to route
 * concurrent-distill conflicts through an LLM merge driver. PR #12 deleted
 * that driver — the distill agent now resolves merges itself in its
 * worktree, so the rule is no longer needed. New vaults never get the rule
 * installed. Existing vaults that already have it are left alone (manual
 * cleanup; the rule becomes inert once the driver script is gone — git
 * silently falls back to its built-in merge driver). See design.md
 * "Migration" for rationale.
 *
 * Design contract:
 *   - Idempotent: re-running on an already-set-up vault is a no-op (returns
 *     `{ initialized: false, scaffolded: [] }`).
 *   - Non-destructive: never clobbers existing `.gitignore` content; only
 *     appends missing lines.
 *   - Fail-soft: returns `{ error }` instead of throwing so the caller can
 *     surface a notify() and keep the session alive.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Lines appended to `<vault>/.gitignore` when scaffolding. Order is stable so
 * diff noise stays minimal on re-runs. Each group has a section-comment
 * header — we match on the non-comment lines for idempotence, the comments
 * are cosmetic.
 */
export const GITIGNORE_LINES: readonly string[] = [
  "# napkin-distill ephemeral state",
  ".napkin/distill/",
  "",
  "# Obsidian workspace-local state",
  ".obsidian/workspace*.json",
  ".obsidian/cache",
  ".obsidian/.trash/",
  "",
  "# Local tmp/cache",
  "search-cache.json",
  ".DS_Store",
  "",
  "# Common secrets — belt-and-braces for vaults that end up alongside dev",
  "# work. Auto-distill commits 'git add .' on first run; these patterns",
  "# keep credentials out of the initial commit even if a user's vault",
  "# happens to contain them.",
  ".env",
  ".env.local",
  ".env.*.local",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_ecdsa",
  "id_ed25519",
  "secrets.json",
  ".aws/credentials",
];

/**
 * Result of {@link ensureVaultReadyForAutoDistill}.
 *
 * - `initialized`: a brand-new `git init` ran (vault had no `.git/` before).
 * - `scaffolded`: files whose contents were created or modified. Callers use
 *   this to decide whether to surface a first-run notify to the user.
 * - `error`: populated on fail-soft paths (git init failed, filesystem
 *   errors writing the scaffolding, legacy-layout refusal). If set, other
 *   fields reflect partial progress.
 * - `legacyLayout`: populated when auto-setup refused to scaffold because
 *   the vault is using napkin's legacy embedded layout (`configPath ===
 *   contentPath`). The worktree-based concurrency architecture relies on
 *   napkin's findVault resolving cwd=worktree to the worktree itself —
 *   which only works for subdir-layout vaults (those that track a
 *   `.napkin/config.json`). `error` is set to `"legacy-embedded-layout"`
 *   so callers can branch on it.
 */
export interface SetupResult {
  initialized: boolean;
  scaffolded: string[];
  error?: string;
  legacyLayout?: {
    /** Absolute path to the vault's `.napkin/` (= contentPath for legacy). */
    configPath: string;
  };
  /**
   * Set to `true` when the vault had a `.git/` but no commits (HEAD
   * unresolvable) and auto-setup synthesized an empty initial commit to
   * make HEAD valid. Distinct from `initialized` (which is "we ran
   * `git init`"): this path fires on an existing-but-empty repo where
   * someone ran `git init` by hand and never committed. Without the
   * seed, `git worktree add ... HEAD` in createDistillWorktree would
   * fail with `fatal: invalid reference: HEAD` — the bug that
   * motivated FB-2.
   */
  seededCommit?: boolean;
}

/**
 * Sentinel value set in `SetupResult.error` when auto-setup refuses to
 * scaffold because the vault is using napkin's legacy embedded layout.
 * Exported so callers (session_start handler, tests) can branch on the
 * exact sentinel instead of pattern-matching on the free-form message.
 */
export const LEGACY_EMBEDDED_LAYOUT_ERROR = "legacy-embedded-layout";

/**
 * Minimal vault handle this module accepts. Mirrors
 * `StaleCleanupVault` in `distill-workspace.ts` — keeps the callsite
 * symmetric: both setup and cleanup take the same vault shape and
 * neither forces the caller to construct a full Napkin instance.
 *
 * Both paths are required: legacy-embedded-layout detection needs to
 * compare `configPath` and `contentPath` directly (legacy vaults have
 * them equal; subdir vaults have them distinct).
 */
export interface SetupVault {
  contentPath: string;
  configPath: string;
}

/**
 * Run `git` in `cwd` and return `{ status, stdout, stderr }`. Does not throw
 * on non-zero exit — we translate failures to `SetupResult.error`.
 */
function runGit(
  cwd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  // `env: process.env` is required for Bun: unlike Node, Bun's spawnSync
  // does NOT propagate mutations to `process.env` to the child unless
  // `env` is passed explicitly (it snapshots env at runtime startup).
  // Passing process.env here is a no-op on Node and restores Node-compat
  // semantics on Bun so tests can control git identity via env vars.
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    env: process.env,
  });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || r.error?.message || "",
  };
}

/**
 * Merge `newLines` into the file at `filePath`, appending only the
 * non-comment, non-blank lines that aren't already present. A line is
 * considered "present" if it appears verbatim anywhere in the existing file
 * (leading/trailing whitespace trimmed for comparison). Returns `true` if
 * the file was created or modified.
 *
 * Creates the file if it doesn't exist. Preserves the existing content
 * verbatim otherwise — we never rewrite or re-order user lines.
 */
function mergeLines(filePath: string, newLines: readonly string[]): boolean {
  const existed = fs.existsSync(filePath);
  const existing = existed ? fs.readFileSync(filePath, "utf-8") : "";
  const existingSet = new Set(
    existing
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#")),
  );

  const toAppend: string[] = [];
  let sawMeaningful = false;
  for (const line of newLines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      // Only keep headers/spacers if there's at least one real line to append
      // below them. We can't decide that until we've scanned the whole block,
      // so buffer optimistically and trim at the end.
      toAppend.push(line);
      continue;
    }
    if (!existingSet.has(trimmed)) {
      toAppend.push(line);
      sawMeaningful = true;
    }
  }

  if (!sawMeaningful) {
    // File already has everything meaningful — no change needed even if we
    // accumulated section headers in `toAppend`.
    return false;
  }

  // Prefix with a blank line if the existing file doesn't end with one, so
  // appended sections are visually separated.
  let prefix = "";
  if (existed && existing.length > 0 && !existing.endsWith("\n")) prefix = "\n";
  else if (existed && existing.length > 0 && !existing.endsWith("\n\n"))
    prefix = "\n";

  const body = `${toAppend.join("\n")}\n`;
  fs.writeFileSync(filePath, existing + prefix + body);
  return true;
}

/**
 * Ensure `<vaultPath>` is a git repo with a `.gitignore` that covers
 * auto-distill's needs. Called once per `session_start` when
 * `distill.enabled` is true.
 *
 * Lifecycle:
 *   0. Refuse if the vault uses napkin's legacy embedded layout
 *      (`configPath === contentPath`). Worktree-based concurrency doesn't
 *      work on legacy layouts because the branch can't track a `.napkin/`
 *      subdir that findVault could resolve to. Returns `{ error:
 *      "legacy-embedded-layout", legacyLayout }` without touching git.
 *   1. If `.git/` is missing → `git init`. Failure here aborts with `error`.
 *   2. Merge scaffolding lines into `.gitignore` (idempotent; no-op if
 *      already present).
 *   3. If anything changed:
 *      - fresh init → `git add .` + commit `"napkin: initial vault commit
 *        (auto-distill setup)"`
 *      - existing repo → `git add .gitignore` + commit
 *        `"napkin: scaffold auto-distill git config"`
 *
 * Returned `scaffolded` always uses vault-relative paths so notify messages
 * are compact and portable.
 */
export function ensureVaultReadyForAutoDistill(vault: SetupVault): SetupResult {
  const vaultPath = vault.contentPath;

  // Legacy-embedded layout is incompatible with the worktree-based
  // concurrency architecture. In a legacy vault (`~/.napkin/`), the
  // vault IS the `.napkin/` directory — `configPath === contentPath`.
  // When a distill subprocess runs with `cwd = worktree` (a checkout of
  // a `distill/*` branch that does NOT track a `.napkin/` subdir),
  // napkin's `findVault` walks past the worktree and resolves to the
  // user's REAL vault via the global config fallback. Writes bypass the
  // worktree entirely, making the concurrency guarantee a no-op.
  //
  // Refuse to scaffold here so session_start can surface a migration
  // notify. Manual `/distill` still works on any layout (it doesn't go
  // through this path).
  //
  // Detection mirrors napkin's own `resolveVaultLayout` semantics: subdir
  // layout sets `contentPath` via `vault.root` (distinct from `configPath`),
  // while legacy embedded layout has no `vault.root` and defaults both to
  // the `.napkin/` dir. See `@cad0p/napkin` `dist/utils/vault.js`.
  if (vault.configPath === vault.contentPath) {
    return {
      initialized: false,
      scaffolded: [],
      error: LEGACY_EMBEDDED_LAYOUT_ERROR,
      legacyLayout: { configPath: vault.configPath },
    };
  }

  const gitDir = path.join(vaultPath, ".git");
  let initialized = false;

  if (!fs.existsSync(gitDir)) {
    const init = runGit(vaultPath, ["init", "-q", "-b", "main"]);
    if (init.status !== 0) {
      return {
        initialized: false,
        scaffolded: [],
        error: `git init failed: ${init.stderr.trim() || "unknown error"}`,
      };
    }
    initialized = true;
  }

  const scaffolded: string[] = [];

  try {
    const giPath = path.join(vaultPath, ".gitignore");
    if (mergeLines(giPath, GITIGNORE_LINES)) scaffolded.push(".gitignore");
    // PR #12: no `.gitattributes` scaffolding. Pre-PR-12 we wrote an
    // `*.md merge=napkin-distill-merge` line; the agent-driven merge
    // architecture has no driver to register.
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      initialized,
      scaffolded,
      error: `failed to write scaffolding: ${msg}`,
    };
  }

  if (initialized) {
    // Fresh init: commit the entire vault so auto-distill has a HEAD to
    // branch from. `git add .` respects the just-written .gitignore so we
    // don't accidentally stage `.napkin/distill/` (the per-worktree
    // session fork) or common secret files (see GITIGNORE_LINES). Distill
    // worktrees themselves live OUTSIDE the vault now (XDG cache), so
    // there's no in-vault worktrees/ path to exclude.
    const add = runGit(vaultPath, ["add", "."]);
    if (add.status !== 0) {
      return {
        initialized,
        scaffolded,
        error: `git add failed: ${add.stderr.trim() || "unknown error"}`,
      };
    }
    const commit = runGit(vaultPath, [
      "commit",
      "-q",
      "-m",
      "napkin: initial vault commit (auto-distill setup)",
    ]);
    if (commit.status !== 0) {
      return {
        initialized,
        scaffolded,
        error: `git commit failed: ${commit.stderr.trim() || "unknown error"}`,
      };
    }
  } else if (scaffolded.length > 0) {
    // Existing repo: only stage the scaffolding files so we don't sweep in
    // the user's unrelated working changes.
    const add = runGit(vaultPath, ["add", ...scaffolded]);
    if (add.status !== 0) {
      return {
        initialized,
        scaffolded,
        error: `git add failed: ${add.stderr.trim() || "unknown error"}`,
      };
    }
    const commit = runGit(vaultPath, [
      "commit",
      "-q",
      "-m",
      "napkin: scaffold auto-distill git config",
    ]);
    if (commit.status !== 0) {
      return {
        initialized,
        scaffolded,
        error: `git commit failed: ${commit.stderr.trim() || "unknown error"}`,
      };
    }
  }

  // HEAD-valid invariant: createDistillWorktree requires HEAD to resolve
  // to a commit. The paths above (fresh init OR existing repo + scaffolded
  // files) produce a commit; the idempotent path (existing repo, nothing
  // to scaffold) does NOT — so a vault where someone ran `git init` by
  // hand and never committed leaves HEAD unresolvable. Seed an empty
  // initial commit so `git worktree add ... HEAD` has something to pin to.
  // This also covers the narrow window where `git init` succeeded above
  // (we set `initialized = true`) but scaffolding wrote zero lines (both
  // .gitignore and .gitattributes already present with our exact content)
  // — that would fall into neither branch and leave a commit-less repo.
  let seededCommit: SetupResult["seededCommit"];
  const headAfter = runGit(vaultPath, ["rev-parse", "--verify", "HEAD"]);
  if (headAfter.status !== 0) {
    const seed = runGit(vaultPath, [
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "napkin: initial vault commit (auto-distill setup)",
    ]);
    if (seed.status !== 0) {
      return {
        initialized,
        scaffolded,
        error: `git seed commit failed: ${seed.stderr.trim() || "unknown error"}`,
      };
    }
    seededCommit = true;
  }

  return { initialized, scaffolded, seededCommit };
}

/**
 * Count the files tracked in the vault's git index. Used by the first-run
 * notify so the user sees a concrete scope ("42 files tracked") rather
 * than the abstract scaffolding list. Returns `-1` if git fails or the
 * vault isn't a repo; callers treat negative as "don't mention a count".
 */
export function countTrackedFiles(vaultPath: string): number {
  const res = runGit(vaultPath, ["ls-files"]);
  if (res.status !== 0) return -1;
  return res.stdout.split("\n").filter((l) => l.length > 0).length;
}
