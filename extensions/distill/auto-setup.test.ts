import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  countTrackedFiles,
  ensureVaultReadyForAutoDistill,
  GITIGNORE_LINES,
  LEGACY_EMBEDDED_LAYOUT_ERROR,
} from "./auto-setup";

/**
 * Spawn git with a fixed identity so tests don't trip on whatever the CI
 * runner configured globally.
 */
function git(cwd: string, args: string[]) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  return spawnSync("git", args, { cwd, env, encoding: "utf-8" });
}

describe("ensureVaultReadyForAutoDistill", () => {
  let vault: string;

  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), "auto-setup-"));
    // Configure git identity inside the temp dir via env (commit uses env
    // vars, init does not need one).
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  /**
   * Helper: run setup under a git identity env so the initial commit succeeds
   * even when the CI runner has no default author configured.
   */
  function runSetup(): ReturnType<typeof ensureVaultReadyForAutoDistill> {
    const saved = {
      name: process.env.GIT_AUTHOR_NAME,
      email: process.env.GIT_AUTHOR_EMAIL,
      cname: process.env.GIT_COMMITTER_NAME,
      cemail: process.env.GIT_COMMITTER_EMAIL,
      sign: process.env.GIT_CONFIG_COUNT,
    };
    process.env.GIT_AUTHOR_NAME = "test";
    process.env.GIT_AUTHOR_EMAIL = "test@example.com";
    process.env.GIT_COMMITTER_NAME = "test";
    process.env.GIT_COMMITTER_EMAIL = "test@example.com";
    // Disable gpg signing via git config override through env so commit
    // succeeds on boxes where commit.gpgsign=true is the default.
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "commit.gpgsign";
    process.env.GIT_CONFIG_VALUE_0 = "false";
    try {
      // Subdir layout: configPath is a distinct path from contentPath.
      // The legacy-embedded-layout check compares string equality only;
      // the path doesn't need to exist on disk for the happy-path tests.
      return ensureVaultReadyForAutoDistill({
        contentPath: vault,
        configPath: path.join(vault, ".napkin"),
      });
    } finally {
      if (saved.name === undefined) delete process.env.GIT_AUTHOR_NAME;
      else process.env.GIT_AUTHOR_NAME = saved.name;
      if (saved.email === undefined) delete process.env.GIT_AUTHOR_EMAIL;
      else process.env.GIT_AUTHOR_EMAIL = saved.email;
      if (saved.cname === undefined) delete process.env.GIT_COMMITTER_NAME;
      else process.env.GIT_COMMITTER_NAME = saved.cname;
      if (saved.cemail === undefined) delete process.env.GIT_COMMITTER_EMAIL;
      else process.env.GIT_COMMITTER_EMAIL = saved.cemail;
      if (saved.sign === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = saved.sign;
      delete process.env.GIT_CONFIG_KEY_0;
      delete process.env.GIT_CONFIG_VALUE_0;
    }
  }

  test("fresh vault (no .git): initializes repo + writes scaffolds + commits", () => {
    // Some existing content so the initial commit isn't empty-tree.
    fs.writeFileSync(path.join(vault, "notes.md"), "# notes\n");

    const r = runSetup();

    expect(r.initialized).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.scaffolded).toContain(".gitignore");
    // PR #12: no `.gitattributes` is written by auto-setup any more (the
    // merge driver was removed; the agent owns merge resolution in its
    // worktree).
    expect(r.scaffolded).not.toContain(".gitattributes");
    expect(fs.existsSync(path.join(vault, ".gitattributes"))).toBe(false);
    expect(fs.existsSync(path.join(vault, ".git"))).toBe(true);

    const gi = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    expect(gi).toContain(".napkin/distill/");
    expect(gi).toContain(".obsidian/workspace*.json");

    const log = git(vault, ["log", "--oneline"]).stdout;
    expect(log).toContain("napkin: initial vault commit (auto-distill setup)");
  });

  test("fresh vault: .gitignore contains common secret patterns (SEC-5)", () => {
    // Auto-distill commits 'git add .' on first init; belt-and-braces
    // patterns here keep credentials out of the initial commit even when
    // a user's vault happens to coexist with dev work. Pattern list is
    // intentionally stable — this test pins it so a future refactor
    // doesn't silently drop protections.
    fs.writeFileSync(path.join(vault, "notes.md"), "# notes\n");
    const r = runSetup();
    expect(r.error).toBeUndefined();

    const gi = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    for (const pattern of [
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
    ]) {
      expect(gi).toContain(pattern);
    }
  });

  test("fresh vault: secret files already present at init are NOT committed (SEC-5)", () => {
    // End-to-end check: create .env and id_rsa alongside a normal note,
    // run setup, assert the secrets were excluded from the initial
    // commit's tracked files. Prevents the scenario where a user's
    // first-run commit silently captures credentials.
    fs.writeFileSync(path.join(vault, "notes.md"), "# notes\n");
    fs.writeFileSync(path.join(vault, ".env"), "API_KEY=secret\n");
    fs.writeFileSync(
      path.join(vault, "id_rsa"),
      "-----BEGIN PRIVATE KEY-----\n",
    );
    fs.writeFileSync(
      path.join(vault, "cert.pem"),
      "-----BEGIN CERTIFICATE-----\n",
    );

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.initialized).toBe(true);

    const tracked = git(vault, ["ls-files"]).stdout;
    expect(tracked).toContain("notes.md");
    expect(tracked).not.toContain(".env");
    expect(tracked).not.toContain("id_rsa");
    expect(tracked).not.toContain("cert.pem");
  });

  test("vault with git but no .gitignore: writes scaffolds, commits", () => {
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(vault, "readme.md"), "# r\n");
    git(vault, ["add", "readme.md"]);
    git(vault, ["commit", "-q", "-m", "seed"]);
    const before = git(vault, ["rev-parse", "HEAD"]).stdout.trim();

    const r = runSetup();

    expect(r.initialized).toBe(false);
    expect(r.error).toBeUndefined();
    // PR #12: only `.gitignore` is scaffolded (no `.gitattributes`).
    expect(r.scaffolded).toEqual([".gitignore"]);

    const after = git(vault, ["rev-parse", "HEAD"]).stdout.trim();
    expect(after).not.toBe(before);

    const msg = git(vault, ["log", "-1", "--format=%s"]).stdout.trim();
    expect(msg).toBe("napkin: scaffold auto-distill git config");
  });

  test("idempotent: running twice on the same vault is a no-op on the second run", () => {
    fs.writeFileSync(path.join(vault, "f.md"), "# f\n");
    const first = runSetup();
    expect(first.scaffolded.length).toBeGreaterThan(0);
    const headAfterFirst = git(vault, ["rev-parse", "HEAD"]).stdout.trim();

    const second = runSetup();
    expect(second.initialized).toBe(false);
    expect(second.scaffolded).toEqual([]);
    expect(second.error).toBeUndefined();

    const headAfterSecond = git(vault, ["rev-parse", "HEAD"]).stdout.trim();
    expect(headAfterSecond).toBe(headAfterFirst);
  });

  test("existing .gitignore with user content: merges napkin lines, preserves user lines", () => {
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(vault, ".gitignore"), "# user\nnode_modules/\n");
    git(vault, ["add", ".gitignore"]);
    git(vault, ["commit", "-q", "-m", "user gitignore"]);

    const r = runSetup();

    const gi = fs.readFileSync(path.join(vault, ".gitignore"), "utf-8");
    expect(gi).toContain("# user");
    expect(gi).toContain("node_modules/");
    expect(gi).toContain(".napkin/distill/");
    expect(gi).toContain("search-cache.json");
    expect(r.scaffolded).toContain(".gitignore");
  });

  test("existing .gitignore already contains napkin lines: no-op (no scaffolding)", () => {
    // PR #12: pre-PR-12 this test asserted that `.gitattributes` would be
    // scaffolded if `.gitignore` was already complete. The merge driver is
    // gone, so a complete `.gitignore` means there's nothing left for
    // auto-setup to scaffold.
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(
      path.join(vault, ".gitignore"),
      `${GITIGNORE_LINES.join("\n")}\n`,
    );
    git(vault, ["add", ".gitignore"]);
    git(vault, ["commit", "-q", "-m", "preseeded"]);

    const r = runSetup();

    expect(r.error).toBeUndefined();
    expect(r.scaffolded).toEqual([]);
  });

  test("simulated permission failure: git init fails without throwing", () => {
    const ro = fs.mkdtempSync(path.join(os.tmpdir(), "ro-vault-"));
    fs.chmodSync(ro, 0o500);
    try {
      const savedName = process.env.GIT_AUTHOR_NAME;
      process.env.GIT_AUTHOR_NAME = "test";
      try {
        const r = ensureVaultReadyForAutoDistill({
          contentPath: ro,
          configPath: path.join(ro, ".napkin"),
        });
        // If the kernel didn't enforce the read-only (common under root /
        // bind mounts), the setup may actually succeed. Either way, the
        // contract is: no throw.
        if (r.error) {
          expect(r.error).toMatch(/git (init|add|commit) failed/);
          expect(r.initialized).toBe(false);
        }
      } finally {
        if (savedName === undefined) delete process.env.GIT_AUTHOR_NAME;
        else process.env.GIT_AUTHOR_NAME = savedName;
      }
    } finally {
      fs.chmodSync(ro, 0o700);
      fs.rmSync(ro, { recursive: true, force: true });
    }
  });

  // --- FB-2: HEAD-valid invariant ------------------------------------------
  //
  // `createDistillWorktree` runs `git worktree add ... HEAD`, which fails
  // with `fatal: invalid reference: HEAD` when the repo has no commits.
  // Auto-setup must NEVER leave the vault in a `.git` + empty state —
  // otherwise the FIRST auto-distill after session_start crashes. The
  // tests below pin each entry path.

  test("FB-2: existing empty repo, idempotent scaffolding — seeds empty commit so HEAD is valid", () => {
    // Setup: run `git init` in the vault, then pre-install our scaffolding
    // file with exact content — so mergeLines appends nothing and the
    // existing-repo commit branch is SKIPPED. This is the idempotent
    // re-run path on a vault that happens to have no commits yet. Pre-FB-2
    // this branch left HEAD unresolvable.
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    // Pre-populate .gitignore with our exact content so the scaffold is a
    // no-op. PR #12: no `.gitattributes` to pre-populate any more.
    const giContent = `${GITIGNORE_LINES.filter(
      (l) => l.trim().length > 0 && !l.startsWith("#"),
    ).join("\n")}\n`;
    fs.writeFileSync(path.join(vault, ".gitignore"), giContent);

    // Pre-condition: HEAD does not resolve (no commits).
    const beforeHead = git(vault, ["rev-parse", "--verify", "HEAD"]);
    expect(beforeHead.status).not.toBe(0);

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.initialized).toBe(false);
    expect(r.scaffolded).toEqual([]); // nothing to scaffold
    expect(r.seededCommit).toBe(true);

    // Post-condition: HEAD resolves — subsequent createDistillWorktree
    // won't explode.
    const afterHead = git(vault, ["rev-parse", "--verify", "HEAD"]);
    expect(afterHead.status).toBe(0);
  });

  test("FB-2: existing empty repo, new scaffolding — normal scaffold+commit path still works", () => {
    // Pre-FB-2 this path was fine: the scaffold-commit creates HEAD. We
    // pin it to make sure the FB-2 change doesn't accidentally double-
    // commit (scaffold commit + seeded empty commit).
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    // No pre-existing scaffolding — mergeLines will write `.gitignore`.

    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.initialized).toBe(false);
    expect(r.scaffolded).toEqual([".gitignore"]);
    // The scaffold commit provides HEAD; no empty seed needed.
    expect(r.seededCommit).toBeUndefined();

    const log = git(vault, ["log", "--oneline"]).stdout.trim().split("\n");
    // Exactly one commit: the scaffold commit. No seeded-empty commit on
    // top of it.
    expect(log.length).toBe(1);
    expect(log[0]).toContain("napkin: scaffold auto-distill git config");
  });

  // --- legacy-embedded-layout refusal --------------------------------------
  //
  // Worktree-based concurrency relies on napkin's `findVault` resolving
  // cwd=worktree to the worktree itself. That only works for subdir-
  // layout vaults (where `configPath !== contentPath` because the branch
  // tracks a `.napkin/config.json`). Legacy embedded vaults have
  // `configPath === contentPath` and no `.napkin/` subdir in the branch;
  // distill writes would bypass the worktree silently. Auto-setup refuses
  // here so the session_start handler can surface a migration notify.

  test("legacy-embedded layout (configPath === contentPath) \u2192 refuses, returns legacyLayout", () => {
    // Legacy vault: config.json lives alongside notes at the vault root,
    // no `.napkin/` subdir. napkin resolves contentPath = configPath.
    const r = ensureVaultReadyForAutoDistill({
      contentPath: vault,
      configPath: vault,
    });
    expect(r.error).toBe(LEGACY_EMBEDDED_LAYOUT_ERROR);
    expect(r.legacyLayout).toEqual({ configPath: vault });
    expect(r.initialized).toBe(false);
    expect(r.scaffolded).toEqual([]);
    // Must not have attempted git init — no `.git` dir in the vault.
    expect(fs.existsSync(path.join(vault, ".git"))).toBe(false);
  });

  test("legacy-embedded layout refusal is atomic (does NOT write scaffolding files)", () => {
    // Belt-and-braces: we must not write .gitignore on a legacy vault
    // even if the caller later ignores the error. Otherwise a stale
    // `.gitignore` would be the only artifact the user sees after a
    // failed migration attempt.
    const r = ensureVaultReadyForAutoDistill({
      contentPath: vault,
      configPath: vault,
    });
    expect(r.error).toBe(LEGACY_EMBEDDED_LAYOUT_ERROR);
    expect(fs.existsSync(path.join(vault, ".gitignore"))).toBe(false);
    expect(fs.existsSync(path.join(vault, ".gitattributes"))).toBe(false);
  });

  test("subdir layout (configPath distinct) bypasses the legacy check", () => {
    // Sanity contrast: when configPath is distinct from contentPath,
    // auto-setup proceeds normally (this is the normal happy path, pinned
    // so a refactor of the detection can't flip the polarity).
    const r = runSetup();
    expect(r.error).toBeUndefined();
    expect(r.legacyLayout).toBeUndefined();
  });
});

describe("countTrackedFiles", () => {
  let vault: string;
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), "count-files-"));
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("returns -1 when not a git repo", () => {
    expect(countTrackedFiles(vault)).toBe(-1);
  });

  test("returns the count of tracked files in a seeded repo", () => {
    git(vault, ["init", "-q", "-b", "main"]);
    git(vault, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(vault, "a.md"), "a");
    fs.writeFileSync(path.join(vault, "b.md"), "b");
    git(vault, ["add", "."]);
    git(vault, ["commit", "-q", "-m", "seed"]);
    expect(countTrackedFiles(vault)).toBe(2);
  });
});
