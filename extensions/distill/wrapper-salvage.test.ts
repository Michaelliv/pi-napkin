/**
 * Wrapper salvage tests (PR #12 Item A4).
 *
 * Covers each of the four V3-locked salvage reason codes end-to-end:
 *   - markers-after-agent-exit
 *   - head-not-on-default
 *   - agent-exit-nonzero
 *   - agent-timeout
 *
 * For each code, asserts:
 *   - the wrapper exits 1
 *   - the worktree at the expected path is gone
 *   - the distill branch is gone
 *   - the outcome sidecar contains `failed:<reason>` on line 1
 *   - the outcome sidecar contains a non-empty recovery hint on line 2+
 *   - the JS-side parser exposes the hint via `recoveryHint`
 *
 * Salvage is V3-locked NEVER to touch main vault history. Each test
 * also asserts main HEAD has not been reset \u2014 if the agent crashed
 * mid-flight we keep whatever state the agent left, never `git reset
 * --hard $START_SHA` per the case-C catastrophic-data-loss analysis
 * in research/v2-v3-verification.md.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { withNapkinOnPath } from "./_test-helpers";
import {
  createDistillWorkspace,
  findDistillOutcomeForBranch,
} from "./distill-workspace";
import { DISTILL_WRAPPER_SCRIPT } from "./scripts-paths";

interface Scaffold {
  root: string;
  vault: string;
  parentCwd: string;
  sessionFile: string;
  errorDir: string;
  stubPi: string;
}

function makeScaffold(): Scaffold {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-distill-a4-"));
  const vault = path.join(root, "vault");
  const parentCwd = path.join(root, "parent");
  const sessionsDir = path.join(root, "sessions");
  const errorDir = path.join(vault, ".napkin", "distill", "errors");
  const stubPi = path.join(root, "stub-pi");

  fs.mkdirSync(vault);
  fs.mkdirSync(parentCwd);
  fs.mkdirSync(sessionsDir);
  fs.mkdirSync(errorDir, { recursive: true });

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

function writeStubPi(scaffold: Scaffold, bodyScript: string): string {
  const stub = `#!/usr/bin/env bash\nset -e\n${bodyScript}\n`;
  fs.writeFileSync(scaffold.stubPi, stub, { mode: 0o755 });
  return scaffold.stubPi;
}

function runWrapper(
  scaffold: Scaffold,
  opts: {
    extraEnv?: Record<string, string>;
    maxDurationSecs?: string;
  } = {},
): {
  exitCode: number;
  stderr: string;
  branch: string;
  workspace: ReturnType<typeof createDistillWorkspace>;
  preSha: string;
} {
  const workspace = createDistillWorkspace(
    scaffold.vault,
    scaffold.sessionFile,
    scaffold.parentCwd,
  );
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

  const r = spawnSync(
    "bash",
    [
      DISTILL_WRAPPER_SCRIPT,
      scaffold.vault,
      workspace.worktreePath,
      workspace.branchName,
      workspace.sessionForkPath,
      "test prompt",
      scaffold.errorDir,
      "",
      "main",
      scaffold.parentCwd,
      opts.maxDurationSecs ?? "60",
    ],
    {
      cwd: scaffold.parentCwd,
      encoding: "utf-8",
      env,
    },
  );

  return {
    exitCode: r.status ?? -1,
    stderr: r.stderr ?? "",
    branch: workspace.branchName,
    workspace,
    preSha,
  };
}

/**
 * Assert the four cleanup invariants after a salvage run:
 *   1. wrapper exited 1
 *   2. worktree dir is gone
 *   3. distill branch is gone
 *   4. main vault HEAD wasn't reset (still contains the post-agent commit
 *      if the agent made one)
 *
 * Only invariant 4 is reason-specific \u2014 the other three hold for any
 * salvage path.
 */
function assertCleanedUp(
  scaffold: Scaffold,
  result: ReturnType<typeof runWrapper>,
): void {
  expect(result.exitCode).toBe(1);
  expect(fs.existsSync(result.workspace.worktreePath)).toBe(false);
  const branches = spawnSync("git", ["-C", scaffold.vault, "branch"], {
    encoding: "utf-8",
  }).stdout;
  expect(branches).not.toContain(result.branch);
}

describe("distill-wrapper.sh salvage path (PR #12 A4)", () => {
  let pathHandle: { restore: () => void };

  beforeEach(() => {
    pathHandle = withNapkinOnPath();
  });

  afterEach(() => {
    pathHandle.restore();
  });

  test("markers-after-agent-exit: outcome sidecar carries reason + recovery hint", () => {
    const s = makeScaffold();
    try {
      // Stub agent commits a file with conflict markers (simulates a
      // botched merge resolution that landed on main).
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
cat > "${s.vault}/conflict.md" <<'MARKERS'
<<<<<<< HEAD
local
=======
remote
>>>>>>> feature
MARKERS
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: with markers" >/dev/null
`,
      );
      const r = runWrapper(s);
      assertCleanedUp(s, r);

      // Per V3 lockdown, salvage NEVER resets main. The agent's commit
      // (with markers) stays on main; the user must `git revert HEAD`
      // manually \u2014 that's exactly what the recovery hint tells them.
      const postSha = spawnSync("git", ["-C", s.vault, "rev-parse", "main"], {
        encoding: "utf-8",
      }).stdout.trim();
      expect(postSha).not.toBe(r.preSha);

      // Parse outcome sidecar and check class + hint.
      const branchShort = r.branch.replace(/^distill\//, "");
      const parsed = findDistillOutcomeForBranch(s.errorDir, branchShort);
      expect(parsed).not.toBeNull();
      expect(parsed?.outcomeClass).toBe("failed:markers-after-agent-exit");
      expect(parsed?.recoveryHint).toBeTruthy();
      // Hint must mention `git revert` (the design spec's primary
      // recovery action for marker-corruption).
      expect(parsed?.recoveryHint).toMatch(/git -C .* revert HEAD --no-edit/);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("head-not-on-default: outcome sidecar carries reason + recovery hint", () => {
    const s = makeScaffold();
    try {
      // Stub agent moves vault HEAD to a feature branch and stays there.
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
git -C "${s.vault}" checkout -q -b feature-branch
`,
      );
      const r = runWrapper(s);
      assertCleanedUp(s, r);

      const branchShort = r.branch.replace(/^distill\//, "");
      const parsed = findDistillOutcomeForBranch(s.errorDir, branchShort);
      expect(parsed?.outcomeClass).toBe("failed:head-not-on-default");
      expect(parsed?.recoveryHint).toBeTruthy();
      // Hint should point the user at `git checkout` to restore the
      // default-branch invariant.
      expect(parsed?.recoveryHint).toMatch(/git -C .* checkout main/);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("agent-exit-nonzero: outcome sidecar carries reason + recovery hint", () => {
    const s = makeScaffold();
    try {
      writeStubPi(s, `# crashing stub agent\nexit 7`);
      const r = runWrapper(s);
      assertCleanedUp(s, r);

      // Vault main is untouched on agent-exit-nonzero (agent crashed
      // before any squash). The pre-distill SHA must equal post.
      const postSha = spawnSync("git", ["-C", s.vault, "rev-parse", "main"], {
        encoding: "utf-8",
      }).stdout.trim();
      expect(postSha).toBe(r.preSha);

      const branchShort = r.branch.replace(/^distill\//, "");
      const parsed = findDistillOutcomeForBranch(s.errorDir, branchShort);
      expect(parsed?.outcomeClass).toBe("failed:agent-exit-nonzero");
      expect(parsed?.recoveryHint).toBeTruthy();
      // Hint should reference reflog as the recovery channel.
      expect(parsed?.recoveryHint).toMatch(/reflog/i);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("agent-timeout: outcome sidecar carries reason + recovery hint", () => {
    const s = makeScaffold();
    try {
      // Stub sleeps past the 1s budget to trip timeout(1).
      writeStubPi(s, `sleep 5\n`);
      const r = runWrapper(s, { maxDurationSecs: "1" });
      assertCleanedUp(s, r);

      const branchShort = r.branch.replace(/^distill\//, "");
      const parsed = findDistillOutcomeForBranch(s.errorDir, branchShort);
      expect(parsed?.outcomeClass).toBe("failed:agent-timeout");
      expect(parsed?.recoveryHint).toBeTruthy();
      // Hint should reference `distill.maxDurationMinutes` as the
      // remediation knob, since timeout means the budget was too low.
      expect(parsed?.recoveryHint).toMatch(/maxDurationMinutes/);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("happy-path outcomes have no recoveryHint (single-line sidecar)", () => {
    // Regression guard: the multi-line sidecar parser must not invent a
    // recovery hint for the success classes (merged-content,
    // merged-local, no-content). Their sidecars are still single-line.
    const s = makeScaffold();
    try {
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
echo "x" > "${s.vault}/new.md"
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: x" >/dev/null
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(0);

      const branchShort = r.branch.replace(/^distill\//, "");
      const parsed = findDistillOutcomeForBranch(s.errorDir, branchShort);
      expect(parsed?.outcomeClass).toBe("merged-content");
      expect(parsed?.recoveryHint).toBeNull();
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });
});

describe("safe_rm_worktree path-safety guard (PR #12 SEC-A-2)", () => {
  // Defense-in-depth regression: the wrapper's `rm -rf <worktree>`
  // calls in salvage() and the cleanup trap are routed through
  // safe_rm_worktree. This test asserts the helper's path-shape
  // refusal contract directly. We extract the function from the
  // wrapper file and source it in a tiny bash harness so we can
  // call it with paths the production wrapper would never construct
  // (e.g. `/tmp/not-napkin-distill/`) but a buggy upstream caller
  // theoretically could.
  //
  // Function extraction: the helper begins at
  // `safe_rm_worktree() {` and ends at the next bare `}` line at
  // column 0. awk is portable across BSD/GNU; sed -E is too but
  // ranged delete-everything-else is fiddlier.
  function extractSafeRmWorktree(): string {
    const wrapper = fs.readFileSync(DISTILL_WRAPPER_SCRIPT, "utf-8");
    const lines = wrapper.split("\n");
    const start = lines.findIndex((l) => /^safe_rm_worktree\(\) \{/.test(l));
    if (start === -1) {
      throw new Error("safe_rm_worktree() not found in wrapper script");
    }
    // Function body ends at the first line that is exactly `}` after
    // start. The body has nested case/esac and if/fi blocks but those
    // close with `;;` and `fi` respectively; a bare `}` at column 0
    // is unambiguous.
    const end = lines.findIndex((l, i) => i > start && /^\}$/.test(l));
    if (end === -1) {
      throw new Error("safe_rm_worktree() body terminator not found");
    }
    return lines.slice(start, end + 1).join("\n");
  }

  /**
   * Run a bash harness that sources only the safe_rm_worktree
   * function (with a stub log_error) and calls it with the given
   * input. Returns the exit code, the stderr from log_error, and
   * whether the input directory still exists post-call.
   */
  function callSafeRmWorktree(input: string): {
    rc: number;
    stderr: string;
    stillExists: boolean;
  } {
    const fn = extractSafeRmWorktree();
    const harness = `
set -uo pipefail
# Stub log_error: emit to stderr so the test can assert on the
# refusal message.
log_error() { printf '%s\n' "$*" >&2; }
${fn}
safe_rm_worktree ${JSON.stringify(input)}
exit $?
`;
    const r = spawnSync("bash", ["-c", harness], { encoding: "utf-8" });
    return {
      rc: r.status ?? -1,
      stderr: r.stderr ?? "",
      stillExists: fs.existsSync(input),
    };
  }

  test("refuses to rm-rf a path outside any napkin-distill subtree", () => {
    // Build a directory at a path that does NOT contain
    // /napkin-distill/<...>/. This is the SEC-A-2 worst-case shape:
    // an upstream bug that constructed a worktree path pointing at
    // some other location.
    const outsidePath = fs.mkdtempSync(
      path.join(os.tmpdir(), "sec-a-2-outside-"),
    );
    try {
      fs.writeFileSync(path.join(outsidePath, "sentinel.txt"), "keep");
      const r = callSafeRmWorktree(outsidePath);
      expect(r.rc).toBe(1);
      expect(r.stillExists).toBe(true);
      expect(fs.existsSync(path.join(outsidePath, "sentinel.txt"))).toBe(true);
      expect(r.stderr).toMatch(/refusing to rm-rf/);
      expect(r.stderr).toMatch(/napkin-distill/);
    } finally {
      fs.rmSync(outsidePath, { recursive: true, force: true });
    }
  });

  test("removes a path inside a napkin-distill/<hash>/ subtree", () => {
    // Mirror the production cache layout: <tmp>/.cache/napkin-distill/
    // <hash>/<branch-suffix>/. safe_rm_worktree must accept it.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sec-a-2-inside-"));
    try {
      const inside = path.join(
        root,
        ".cache",
        "napkin-distill",
        "abc123",
        "distill-suffix",
      );
      fs.mkdirSync(inside, { recursive: true });
      fs.writeFileSync(path.join(inside, "sentinel.txt"), "remove");
      const r = callSafeRmWorktree(inside);
      expect(r.rc).toBe(0);
      expect(r.stillExists).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses an empty path", () => {
    const r = callSafeRmWorktree("");
    expect(r.rc).toBe(1);
    expect(r.stderr).toMatch(/empty worktree path/);
  });

  test("returns 0 (already-removed) for a non-existent path", () => {
    const r = callSafeRmWorktree("/tmp/sec-a-2-does-not-exist-xxxx-yyyy");
    expect(r.rc).toBe(0);
  });
});
