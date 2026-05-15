/**
 * Wrapper post-validation tests (PR #12 Item A3).
 *
 * Drives the wrapper end-to-end with `NAPKIN_DISTILL_PI_BIN=<stub>`
 * pointing at a tiny bash script that produces specific filesystem
 * effects (mimicking the agent's behavior). Asserts that each
 * validator helper trips the right outcome class:
 *
 *   - validate_no_markers       \u2192 failed:markers-after-agent-exit
 *   - validate_head_on_default  \u2192 failed:head-not-on-default
 *   - validate_commit_count     \u2192 no-content (when 0 commits since startSha)
 *   - detect_local_only         \u2192 merged-local (when origin diverges)
 *   - happy path                \u2192 merged-content
 *
 * Each helper has at least one pass test and one fail test.
 *
 * Test scaffold layout per case:
 *   <tmp>/vault/         \u2014 main vault (git-init, default branch `main`,
 *                          one seed commit)
 *   <tmp>/parent/        \u2014 parent pi cwd
 *   <tmp>/sessions/      \u2014 session file dir
 *   <tmp>/stub-pi         \u2014 the agent stub script
 *
 * The stub-pi receives the wrapper's positional invocation
 * (`--session ... [--model ...] -p $PROMPT`) and runs whatever
 * filesystem mutations the test wants \u2014 e.g. write a file with
 * conflict markers into the vault, or do nothing at all, or move
 * HEAD off main. The wrapper proceeds to validate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { withNapkinOnPath } from "./_test-helpers";
import { createDistillWorkspace } from "./distill-workspace";
import { DISTILL_WRAPPER_SCRIPT } from "./scripts-paths";

interface Scaffold {
  root: string;
  vault: string;
  parentCwd: string;
  sessionFile: string;
  errorDir: string;
  stubPi: string;
}

/**
 * Build a fresh test scaffold per test. Creates a git-init'd vault
 * with one seed commit (so `<seed-sha>..HEAD` rev-list semantics work),
 * a parent cwd, an empty session file, and the error dir. Caller must
 * call `cleanup` in afterEach.
 */
function makeScaffold(): Scaffold {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-distill-a3-"));
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

  const sessionFile = (() => {
    const sm = SessionManager.create(parentCwd, sessionsDir);
    sm.appendMessage({ role: "user", content: "hello" });
    sm.appendMessage({ role: "assistant", content: "hi" });
    const file = sm.getSessionFile();
    if (!file || !fs.existsSync(file)) {
      throw new Error("failed to create test session on disk");
    }
    return file;
  })();

  return { root, vault, parentCwd, sessionFile, errorDir, stubPi };
}

/**
 * Write a stub `pi` binary. The body is whatever the test wants the
 * agent to do; positional args are ignored unless the body parses them.
 * `chmod +x`, then return the path so the caller can pass it as
 * `NAPKIN_DISTILL_PI_BIN`.
 */
function writeStubPi(scaffold: Scaffold, bodyScript: string): string {
  const stub = `#!/usr/bin/env bash\nset -e\n${bodyScript}\n`;
  fs.writeFileSync(scaffold.stubPi, stub, { mode: 0o755 });
  return scaffold.stubPi;
}

/**
 * Run the wrapper end-to-end and return its exit code, stderr, and the
 * outcome sidecar path (if any was written).
 *
 * The wrapper's argv shape (PR #12 A2): vault, worktree, branch,
 * sessionFork, prompt, errorDir, model, defaultBranch, parentCwd,
 * maxDurationSecs.
 */
function runWrapper(
  scaffold: Scaffold,
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
} {
  const workspace = createDistillWorkspace(
    scaffold.vault,
    scaffold.sessionFile,
    scaffold.parentCwd,
  );
  const branch = workspace.branchName;

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
  // recovery hint); use only line 1 as the canonical class string
  // — same shape as the JS-side `findDistillOutcomeForBranch`.
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
  };
}

describe("distill-wrapper.sh post-agent validation (PR #12 A3)", () => {
  let pathHandle: { restore: () => void };

  beforeEach(() => {
    pathHandle = withNapkinOnPath();
  });

  afterEach(() => {
    pathHandle.restore();
  });

  // -------------------------------------------------------------------------
  // validate_head_on_default
  // -------------------------------------------------------------------------

  test("validate_head_on_default PASS: vault HEAD is on the default branch \u2192 happy path", () => {
    const s = makeScaffold();
    try {
      // Stub: agent commits one new file directly on main (simulates a
      // successful squash). Vault HEAD stays on main.
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
echo "# distilled" > "${s.vault}/distilled.md"
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: test" >/dev/null
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("validate_head_on_default FAIL: vault HEAD is on a feature branch \u2192 failed:head-not-on-default", () => {
    const s = makeScaffold();
    try {
      // Stub: agent moves vault HEAD to a non-default branch.
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
git -C "${s.vault}" checkout -q -b feature-branch
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:head-not-on-default");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // validate_no_markers
  // -------------------------------------------------------------------------

  test("validate_no_markers PASS: no conflict markers in vault \u2192 happy path", () => {
    const s = makeScaffold();
    try {
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
echo "# clean content" > "${s.vault}/clean.md"
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: clean" >/dev/null
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("validate_no_markers FAIL: tracked *.md file has unresolved markers \u2192 failed:markers-after-agent-exit", () => {
    const s = makeScaffold();
    try {
      // Stub: agent commits a file with conflict markers (simulates an
      // incomplete merge resolution). Heredoc ensures the markers land
      // verbatim at line start.
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
cat > "${s.vault}/conflict.md" <<'MARKERS'
# header
<<<<<<< HEAD
local
=======
remote
>>>>>>> feature
trailing
MARKERS
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: with markers" >/dev/null
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:markers-after-agent-exit");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // validate_commit_count
  // -------------------------------------------------------------------------

  test("validate_commit_count PASS: 1 new commit since startSha \u2192 merged-content", () => {
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
      expect(r.outcome).toBe("merged-content");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("validate_commit_count FAIL: 0 new commits since startSha \u2192 no-content", () => {
    const s = makeScaffold();
    try {
      // Stub: agent does nothing. Vault HEAD stays at startSha.
      writeStubPi(s, `# no-op stub agent\n:`);
      const r = runWrapper(s);
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("no-content");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // detect_local_only
  // -------------------------------------------------------------------------

  test("detect_local_only PASS (no origin): origin not configured \u2192 merged-content", () => {
    // No origin configured \u2192 detect_local_only returns false \u2192 merged-content.
    // This is the same shape as the validate_commit_count PASS test, so we
    // re-assert the no-origin case here for clarity.
    const s = makeScaffold();
    try {
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
echo "y" > "${s.vault}/new.md"
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: y" >/dev/null
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(0);
      // Confirm origin is genuinely absent in this scaffold.
      const remotes = spawnSync("git", ["-C", s.vault, "remote"], {
        encoding: "utf-8",
      }).stdout.trim();
      expect(remotes).toBe("");
      expect(r.outcome).toBe("merged-content");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("detect_local_only TRIGGERED: origin diverges from local \u2192 merged-local", () => {
    const s = makeScaffold();
    try {
      // Add a bare-repo origin and fetch so origin/main is reachable.
      const originPath = path.join(s.root, "origin.git");
      spawnSync("git", ["init", "--bare", "-b", "main", originPath]);
      spawnSync("git", ["-C", s.vault, "remote", "add", "origin", originPath]);
      spawnSync("git", ["-C", s.vault, "push", "-u", "origin", "main"]);
      // origin/main now == seed sha. Stub agent commits without pushing
      // \u2192 local main is ahead of origin/main \u2192 merged-local.
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
echo "ahead" > "${s.vault}/ahead.md"
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: ahead" >/dev/null
# Deliberately do NOT push.
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-local");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("detect_local_only DIVERGENT: origin rewritten under local \u2192 failed:force-push-detected (SEC-A-1)", () => {
    // Spec at "Push behavior: never force" mandates a wrapper-side
    // ancestry check. Equality alone (the pre-fix detect_local_only)
    // couldn't distinguish a fast-forward push from a force-push: in
    // either case after the agent's push fetches back, local == origin.
    // Here we simulate a force-push by giving origin a divergent
    // history (commit not in local's reachability) before the wrapper
    // runs detect_local_only; the helper must return rc=2 and the
    // wrapper must classify as failed:force-push-detected.
    const s = makeScaffold();
    try {
      // Stand up a bare-repo origin.
      const originPath = path.join(s.root, "origin.git");
      spawnSync("git", ["init", "--bare", "-b", "main", originPath]);
      spawnSync("git", ["-C", s.vault, "remote", "add", "origin", originPath]);
      spawnSync("git", ["-C", s.vault, "push", "-u", "origin", "main"]);

      // Build a divergent origin/main from a SECOND clone: clone the
      // bare origin into a working clone, commit a file there, force-
      // push it to origin (rewriting origin/main onto a history that
      // doesn't share commits with the vault's main beyond the seed).
      // Then in the vault, the agent will commit a different file on
      // its main \u2014 the result is local and origin both ahead of
      // the shared seed, in incompatible directions.
      const otherClone = path.join(s.root, "other-clone");
      spawnSync("git", ["clone", originPath, otherClone]);
      spawnSync("git", [
        "-C",
        otherClone,
        "config",
        "user.email",
        "other@example.com",
      ]);
      spawnSync("git", ["-C", otherClone, "config", "user.name", "other"]);
      fs.writeFileSync(path.join(otherClone, "foreign.md"), "# foreign\n");
      spawnSync("git", ["-C", otherClone, "add", "."]);
      spawnSync("git", ["-C", otherClone, "commit", "-m", "foreign"]);
      spawnSync("git", ["-C", otherClone, "push", "origin", "main"]);

      // Fetch into the vault so origin/main moves to the foreign tip.
      // This is what would happen if the agent did a `git fetch origin`
      // mid-distill before discovering the contention.
      spawnSync("git", ["-C", s.vault, "fetch", "origin"]);

      // Stub agent commits on local main without pulling. After this
      // commit, local main has the seed + local commit; origin/main
      // has the seed + foreign commit. Neither is an ancestor of the
      // other \u2014 divergent.
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
echo "local" > "${s.vault}/local.md"
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: local" >/dev/null
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:force-push-detected");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Agent crash / timeout dispatch (touches the same outcome sidecar plumbing)
  // -------------------------------------------------------------------------

  test("agent exit non-zero \u2192 failed:agent-exit-nonzero", () => {
    const s = makeScaffold();
    try {
      writeStubPi(s, `# crashing stub agent\nexit 7`);
      const r = runWrapper(s);
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:agent-exit-nonzero");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("agent exceeds maxDurationSecs \u2192 failed:agent-timeout", () => {
    const s = makeScaffold();
    try {
      // Stub sleeps longer than the 1s budget. timeout(1) fires SIGTERM
      // and the wrapper classifies as agent-timeout.
      writeStubPi(s, `sleep 5\n`);
      const r = runWrapper(s, { maxDurationSecs: "1" });
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:agent-timeout");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  }, 30_000);

  test("SIGTERM-ignoring agent \u2192 SIGKILL escalates within grace, classifies as agent-timeout (CLEAN-A-1, SEC-A-3, CI-A-1)", () => {
    // Regression for the missing -k/--kill-after on timeout(1). A stub
    // that traps SIGTERM and ignores it must still be killed via
    // SIGKILL after TIMEOUT_KILL_GRACE_SECS so the wrapper exits
    // cleanly (rc 137, classified as agent-timeout). Without the -k
    // flag the wrapper would hang indefinitely waiting on the SIGTERM-
    // resistant child.
    //
    // Test budget: maxDurationSecs=1 + grace=2 + slack=~5 = ~8s wall.
    // The stub records its start time; if SIGKILL didn't happen it
    // would still be alive at wall-clock = grace + maxDuration + slack.
    const s = makeScaffold();
    const stubMarker = path.join(s.root, "stub-completed");
    try {
      writeStubPi(
        s,
        `
# Trap SIGTERM and ignore it \u2014 simulates a stuck agent that won't
# exit on the budget-boundary SIGTERM. timeout(1) must escalate via
# SIGKILL after the grace period.
trap '' TERM
# Sleep is interruptible only by SIGKILL while the SIGTERM trap is
# active. We sleep well past any plausible test budget so that the
# wrapper's grace period is what kills us, not the sleep returning.
sleep 60
# This line only runs if SIGKILL didn't fire \u2014 marker proves the
# escalation didn't happen, so the test should fail loud.
touch ${JSON.stringify(stubMarker)}
`,
      );
      const start = Date.now();
      const r = runWrapper(s, {
        maxDurationSecs: "1",
        extraEnv: { NAPKIN_DISTILL_TIMEOUT_KILL_GRACE_SECS: "2" },
      });
      const elapsedMs = Date.now() - start;

      // Wrapper classified as agent-timeout (rc 137 from SIGKILL
      // escalation, distinguished from rc 124 from SIGTERM by the
      // dispatch case but routed to the same outcome class).
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:agent-timeout");

      // The stub never reached its `touch` line \u2014 SIGKILL fired
      // before `sleep 60` returned.
      expect(fs.existsSync(stubMarker)).toBe(false);

      // Wall-clock is bounded: maxDurationSecs=1 + grace=2 + slack.
      // 15s is comfortably loose; a regression where -k is dropped
      // would either hang past the outer timeout (\u2265 30s) or
      // require some other mechanism to kill the child.
      expect(elapsedMs).toBeLessThan(15_000);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  }, 30_000);
});
