/**
 * Shared test helpers for the distill extension.
 *
 * Keep this file lightweight: small, well-scoped helpers used across
 * multiple test files. Anything that grows past ~30 LOC or pulls in
 * heavy deps probably belongs in its own file.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { createDistillWorkspace } from "./distill-workspace";
import { DISTILL_WRAPPER_SCRIPT } from "./scripts-paths";

/**
 * Augment `process.env.PATH` so the spawned wrapper can resolve `napkin`
 * via `command -v` (R7-CI-1 — the wrapper's `--version` smoke test
 * needs the binary on PATH from `node_modules/.bin/`).
 *
 * After `bun install` napkin lives at `<repo>/node_modules/.bin/napkin`
 * (a symlink with `#!/usr/bin/env node` shebang). Test environments
 * typically don't have napkin on the global PATH, so wrapper-spawning
 * tests need to prepend the local bin dir.
 *
 * Contract:
 *   - Mutates `process.env.PATH` in place. The Bun spawn API inherits
 *     the parent's env, so a wrapper spawned after the call sees the
 *     augmented PATH automatically.
 *   - Returns a `{ restore }` handle the caller MUST call (typically in
 *     `afterEach`) to revert.
 *   - Capture happens at call time (NOT module load), so each test's
 *     beforeEach gets a fresh snapshot. Avoids the brittle
 *     module-load-const pattern that R7-SC-6 / R7-CC-2 flagged.
 *   - Throws if `node_modules/.bin/` doesn't exist (R8-CI-1, R8-SC-10).
 *     The previous silent-no-op behaviour caused wrapper-spawning
 *     tests to fail with the wrapper's `napkin not found on PATH`
 *     diagnostic when a developer ran `bun test` before `bun install`,
 *     pointing at the wrapper instead of at the missing setup step.
 *     Failing here surfaces the actual problem at the helper.
 *
 * Repo-root resolution: `__dirname` resolves to this helper's directory
 * (`extensions/distill/`), so `../../node_modules/.bin/` is the repo's
 * regardless of which test file imports the helper.
 */
export function withNapkinOnPath(): { restore: () => void } {
  const localBin = path.resolve(__dirname, "..", "..", "node_modules", ".bin");
  if (!fs.existsSync(localBin)) {
    throw new Error(
      `withNapkinOnPath: ${localBin} does not exist. Run \`bun install\` ` +
        `before \`bun test\` so the wrapper-spawning tests can resolve \`napkin\`.`,
    );
  }
  const saved = process.env.PATH;
  process.env.PATH = `${localBin}${path.delimiter}${process.env.PATH ?? ""}`;
  return {
    restore() {
      if (saved === undefined) delete process.env.PATH;
      else process.env.PATH = saved;
    },
  };
}

// ---------------------------------------------------------------------------
// Wrapper-spawning test scaffolding (CLEAN-A-6)
//
// Shared across `wrapper-validation.test.ts` and `wrapper-salvage.test.ts`,
// which both drive `distill-wrapper.sh` end-to-end with a stubbed `pi`
// binary. Phase C will reuse these for additional bash-stub fixtures
// (~10 mocked-pi behaviors), so factoring them once now keeps the per-
// test-file size manageable.
// ---------------------------------------------------------------------------

/**
 * Test scaffold layout per case:
 *   <root>/vault/         — main vault (git-init, default branch `main`,
 *                           one seed commit so `<seed-sha>..HEAD`
 *                           rev-list semantics work)
 *   <root>/parent/        — parent pi cwd
 *   <root>/sessions/      — session file dir
 *   <root>/vault/.napkin/distill/errors/ — error/outcome sidecar dir
 *   <root>/stub-pi        — the agent stub script (caller writes it)
 */
export interface WrapperScaffold {
  root: string;
  vault: string;
  parentCwd: string;
  sessionFile: string;
  errorDir: string;
  stubPi: string;
}

/**
 * Build a fresh test scaffold per test. Creates a git-init'd vault with
 * one seed commit, a parent cwd, an empty session file, and the error
 * dir. Caller is responsible for `fs.rmSync(scaffold.root, { recursive:
 * true, force: true })` in a `finally` block.
 *
 * @param prefix mkdtemp prefix (e.g. `"napkin-distill-a3-"`); use
 *               distinct prefixes per test file so concurrent test
 *               failures leave readable `/tmp` debris.
 */
export function makeWrapperScaffold(prefix: string): WrapperScaffold {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const vault = path.join(root, "vault");
  const parentCwd = path.join(root, "parent");
  const sessionsDir = path.join(root, "sessions");
  const errorDir = path.join(vault, ".napkin", "distill", "errors");
  const stubPi = path.join(root, "stub-pi");

  fs.mkdirSync(vault);
  fs.mkdirSync(parentCwd);
  fs.mkdirSync(sessionsDir);
  fs.mkdirSync(errorDir, { recursive: true });

  // git init + seed commit. Use -b main so detectDefaultBranch resolves.
  spawnSync("git", ["init", "-b", "main", vault], { encoding: "utf-8" });
  spawnSync("git", ["-C", vault, "config", "user.email", "test@example.com"]);
  spawnSync("git", ["-C", vault, "config", "user.name", "test"]);
  fs.writeFileSync(path.join(vault, "seed.md"), "# seed\n");
  spawnSync("git", ["-C", vault, "add", "."]);
  spawnSync("git", ["-C", vault, "commit", "-m", "seed"]);

  const sm = SessionManager.create(parentCwd, sessionsDir);
  sm.appendMessage({ role: "user", content: "hello" });
  sm.appendMessage({ role: "assistant", content: "hi" });
  const sessionFile = sm.getSessionFile();
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    throw new Error("failed to create test session on disk");
  }

  return { root, vault, parentCwd, sessionFile, errorDir, stubPi };
}

/**
 * Write a stub `pi` binary. The body is whatever the test wants the
 * agent to do; positional args are ignored unless the body parses
 * them. `chmod +x`, then return the path so the caller can pass it
 * as `NAPKIN_DISTILL_PI_BIN`.
 */
export function writePiStub(
  scaffold: WrapperScaffold,
  bodyScript: string,
): string {
  const stub = `#!/usr/bin/env bash\nset -e\n${bodyScript}\n`;
  fs.writeFileSync(scaffold.stubPi, stub, { mode: 0o755 });
  return scaffold.stubPi;
}

/**
 * Run the wrapper end-to-end against the given scaffold and stub pi.
 *
 * The wrapper's argv shape (PR #12 A2): vault, worktree, branch,
 * sessionFork, prompt, errorDir, model, defaultBranch, parentCwd,
 * maxDurationSecs.
 *
 * Returns:
 *   - exitCode / stderr  — the wrapper process's status & stderr
 *   - branch / workspace — the distill workspace this run targeted
 *   - preSha             — vault main HEAD captured BEFORE the wrapper
 *                          runs (used by salvage tests to assert main
 *                          history wasn't reset by the salvage path)
 *   - outcome / outcomePath — line 1 of the outcome sidecar (the
 *                          canonical class string) and its path, or
 *                          null if no sidecar was written. Multi-line
 *                          sidecars (`failed:*` classes carry a
 *                          recovery hint on lines 2+) collapse to
 *                          line 1 for the canonical class — same
 *                          shape as the JS-side
 *                          `findDistillOutcomeForBranch`.
 */
export function runWrapperWithStub(
  scaffold: WrapperScaffold,
  opts: {
    skipPi?: boolean;
    extraEnv?: Record<string, string>;
    maxDurationSecs?: string;
  } = {},
): {
  exitCode: number;
  stderr: string;
  outcome: string | null;
  outcomePath: string | null;
  branch: string;
  workspace: ReturnType<typeof createDistillWorkspace>;
  preSha: string;
} {
  const workspace = createDistillWorkspace(
    scaffold.vault,
    scaffold.sessionFile,
    scaffold.parentCwd,
  );
  const branch = workspace.branchName;
  const preSha = spawnSync("git", ["-C", scaffold.vault, "rev-parse", "main"], {
    encoding: "utf-8",
  }).stdout.trim();

  const env: Record<string, string> = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    NAPKIN_DISTILL_NO_RECURSE: "1",
    NAPKIN_DISTILL_PI_BIN: scaffold.stubPi,
    ...(opts.extraEnv ?? {}),
  };
  if (opts.skipPi) {
    env.NAPKIN_DISTILL_SKIP_PI = "1";
  }

  const r = spawnSync(
    "bash",
    [
      DISTILL_WRAPPER_SCRIPT,
      scaffold.vault,
      workspace.worktreePath,
      branch,
      workspace.sessionForkPath,
      "test prompt",
      scaffold.errorDir,
      "",
      "main",
      scaffold.parentCwd,
      opts.maxDurationSecs ?? "60",
      // SEC-2 / CORR-3: cache root is the worktree's parent dir per
      // the cache layout `<cache-root>/<branch-suffix>/`. Tests pass
      // it explicitly so safe_rm_worktree's strict-mode descendant
      // check fires instead of the legacy cache-segment-glob
      // fallback. The wrapper-validation suite covers the strict
      // path; wrapper-salvage's safe_rm_worktree describe block has
      // dedicated tests for both modes (legacy glob and strict).
      path.dirname(workspace.worktreePath),
    ],
    {
      cwd: scaffold.parentCwd,
      encoding: "utf-8",
      env,
    },
  );

  // Locate the outcome sidecar. The wrapper names it
  // `<ts>-<pid>-<branchShort>.outcome`. PR #12 A4 made the file
  // multi-line for `failed:*` classes (line 1 = class, lines 2+ =
  // recovery hint); use only line 1 as the canonical class string.
  const branchShort = branch.replace(/^distill\//, "");
  const outcomeFiles = fs.existsSync(scaffold.errorDir)
    ? fs
        .readdirSync(scaffold.errorDir)
        .filter((f) => f.endsWith(`-${branchShort}.outcome`))
    : [];
  let outcome: string | null = null;
  let outcomePath: string | null = null;
  if (outcomeFiles.length === 1) {
    outcomePath = path.join(scaffold.errorDir, outcomeFiles[0]);
    const raw = fs.readFileSync(outcomePath, "utf-8");
    outcome = (raw.split("\n")[0] ?? "").trim();
  }

  return {
    exitCode: r.status ?? -1,
    stderr: r.stderr ?? "",
    outcome,
    outcomePath,
    branch,
    workspace,
    preSha,
  };
}
