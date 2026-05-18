/**
 * Wrapper invariant: `write_outcome` runs BEFORE any worktree-removal
 * step anywhere in the wrapper.
 *
 * The wrapper has two cleanup pathways:
 *   - Happy path: post-validation passes → `write_outcome` writes the
 *     `<class>` sidecar → EXIT trap fires `cleanup()` which removes
 *     the worktree + branch.
 *   - Salvage path: post-validation fails (markers, head-not-on-default,
 *     agent-exit-nonzero, agent-timeout, divergent-history, …) →
 *     `salvage()` composes a recovery hint → writes the
 *     `failed:<reason>` sidecar → removes the worktree + branch.
 *
 * The JS-side poller in `runDistillWith` watches the worktree path
 * and calls `findDistillOutcomeForBranch` as soon as `fs.existsSync`
 * returns false. If any worktree-removal step runs BEFORE
 * `write_outcome`, the lookup returns null and the JS dispatch
 * surfaces a spurious "Distillation terminated abnormally — no
 * outcome record" warning on what is otherwise a successful or
 * cleanly-failed run.
 *
 * This test pins the invariant for both pathways. It spawns the
 * wrapper as a detached subprocess (mirrors `spawnDistillInWorktree`
 * in production), polls the worktree path and outcome sidecar
 * concurrently on a 50 ms tick, and snapshots the outcome-file state
 * at the exact moment the worktree disappears. The polling-vs-
 * subprocess race is the entire point — `runWrapperWithStub` from
 * `_test-helpers.ts` is `spawnSync`-blocking and can only inspect
 * filesystem state AFTER the wrapper exits, by which time the race
 * window is necessarily closed; we use raw `spawn` + `unref()`
 * instead so the test observes the file-system state mid-wrapper.
 *
 * Test cases:
 *   - Happy path: stub-pi commits content + exits 0; wrapper runs
 *     post-validation + write_outcome + EXIT trap. Assert outcome
 *     file exists with class `merged-content` at the moment worktree
 *     disappears.
 *   - Salvage path (added in a follow-up commit): stub-pi commits
 *     content WITH conflict markers + exits 0; wrapper's
 *     `validate_no_markers` fails → `salvage("markers-after-agent-exit")`.
 *     Assert outcome file exists with class
 *     `failed:markers-after-agent-exit` at the moment worktree
 *     disappears.
 *
 * The race-window-widening is fixture-driven on the happy path
 * (`step10-race.sh`'s `sleep 0.5` after agent commit + before exit
 * keeps the wrapper's post-validation + EXIT-trap chain at a known
 * wall-time offset). The salvage path needs PATH-shimmed slow `git`
 * (added with the salvage test) because the race window there is
 * inside the wrapper itself, between `git worktree remove` returning
 * and `write_outcome` being called.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { makeWrapperScaffold, withNapkinOnPath } from "./_test-helpers";
import {
  createDistillWorkspace,
  findDistillOutcomeForBranch,
} from "./distill-workspace";
import { DISTILL_WRAPPER_SCRIPT } from "./scripts-paths";

// step10-race.sh: agent commits content + exits 0 + sleeps 0.5 s
// before exit. The 0.5 s widens the [agent-exit, worktree-removed]
// gap so the JS-side poll's tick reliably lands inside the interval
// where the wrapper is running post-validation + write_outcome but
// hasn't yet hit the EXIT-trap cleanup. Reused from
// race-step10-cleanup.test.ts.
const HAPPY_PATH_STUB = path.join(
  __dirname,
  "test-fixtures",
  "agent-stubs",
  "step10-race.sh",
);

// salvage-race.sh: agent commits content WITH conflict markers + exits 0.
// The wrapper's `validate_no_markers` then fails and routes into
// `salvage("markers-after-agent-exit")`.
const SALVAGE_PATH_STUB = path.join(
  __dirname,
  "test-fixtures",
  "agent-stubs",
  "salvage-race.sh",
);

// slow-git.sh: PATH shim that delays `git worktree remove` by 0.5 s
// AFTER the real git completes. Widens the race window between
// worktree-gone and `write_outcome` inside the wrapper's salvage path.
const SLOW_GIT_SHIM = path.join(__dirname, "test-fixtures", "slow-git.sh");

/**
 * Stage the slow-git shim as `<tmpdir>/git` so the wrapper's bare
 * `git ...` invocations resolve to it via PATH. Returns the tmpdir
 * (caller prepends to PATH) and a `restore()` for cleanup.
 *
 * Resolves the real `git` binary BEFORE PATH is mutated and passes
 * its absolute path to the shim via NAPKIN_SLOW_GIT_REAL_GIT — this
 * avoids PATH-introspection edge cases (BASH_SOURCE+symlink
 * resolution, recursive shim lookup) inside the shim itself.
 */
function stageSlowGitShim(): {
  shimDir: string;
  realGit: string;
  restore: () => void;
} {
  const realGit = (() => {
    const r = spawnSync("command", ["-v", "git"], {
      shell: true,
      encoding: "utf-8",
    });
    const found = (r.stdout ?? "").trim();
    if (!found) {
      throw new Error("stageSlowGitShim: cannot resolve real git binary");
    }
    return found;
  })();
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "slow-git-shim-"));
  const stagedGit = path.join(shimDir, "git");
  fs.copyFileSync(SLOW_GIT_SHIM, stagedGit);
  fs.chmodSync(stagedGit, 0o755);
  return {
    shimDir,
    realGit,
    restore() {
      fs.rmSync(shimDir, { recursive: true, force: true });
    },
  };
}

describe("wrapper invariant: write_outcome before worktree-removal", () => {
  let pathHandle: { restore: () => void };

  beforeEach(() => {
    pathHandle = withNapkinOnPath();
  });

  afterEach(() => {
    pathHandle.restore();
  });

  test("happy path: outcome sidecar exists with class 'merged-content' at the moment worktree disappears", async () => {
    expect(fs.existsSync(HAPPY_PATH_STUB)).toBe(true);

    const s = makeWrapperScaffold("napkin-distill-wrapper-invariant-happy-");
    try {
      const workspace = createDistillWorkspace(
        s.vault,
        s.sessionFile,
        s.parentCwd,
      );
      const branch = workspace.branchName;
      const branchShort = branch.replace(/^distill\//, "");

      const env: Record<string, string> = {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        NAPKIN_DISTILL_NO_RECURSE: "1",
        NAPKIN_DISTILL_PI_BIN: HAPPY_PATH_STUB,
        NAPKIN_STUB_VAULT: s.vault,
        NAPKIN_STUB_WORKTREE: workspace.worktreePath,
        NAPKIN_STUB_BRANCH: branch,
        NAPKIN_STUB_DEFAULT_BRANCH: "main",
      };

      // Detached spawn — mirrors `spawnDistillInWorktree`'s production
      // shape (detached:true, unref()) so any timing-dependent
      // behaviour around the parent-child relationship matches.
      // `spawnSync`-based helpers (e.g. `runWrapperWithStub`) cannot
      // observe filesystem state mid-execution and would close the
      // race window before the test can snapshot it.
      const child = spawn(
        "bash",
        [
          DISTILL_WRAPPER_SCRIPT,
          s.vault,
          workspace.worktreePath,
          branch,
          workspace.sessionForkPath,
          "test prompt",
          s.errorDir,
          "", // model
          "main", // defaultBranch
          s.parentCwd,
          "60", // maxDurationSecs
          path.dirname(workspace.worktreePath), // cache root
        ],
        {
          cwd: s.parentCwd,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.unref();

      let stderrBuf = "";
      child.stderr?.on("data", (chunk) => {
        stderrBuf += chunk.toString();
      });
      let stdoutBuf = "";
      child.stdout?.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
      });

      // Poll worktree disappearance at 50 ms intervals — same logic
      // shape as `runDistillWith`'s pollHandle, with a tighter tick
      // (production: ~2 s) to keep the test fast.
      const target = workspace.worktreePath;
      const startMs = Date.now();
      while (fs.existsSync(target) && Date.now() - startMs < 30_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const timedOut = fs.existsSync(target);

      // Snapshot the FS state at the exact tick where production's
      // poller would call `checkOutcome`. The wrapper invariant
      // guarantees `outcomeAtRaceWindow !== null`.
      const outcomeAtRaceWindow = findDistillOutcomeForBranch(
        s.errorDir,
        branchShort,
      );

      // Wait for the wrapper to fully exit so the after-exit
      // snapshot observes the final state — this is mostly a
      // sanity-check that the wrapper completed cleanly.
      const exitCode = await new Promise<number>((resolve) => {
        if (child.exitCode !== null) {
          resolve(child.exitCode);
          return;
        }
        child.on("exit", (code) => resolve(code ?? -1));
      });

      const outcomeAfterExit = findDistillOutcomeForBranch(
        s.errorDir,
        branchShort,
      );

      const diag = () =>
        `\nwrapper stderr:\n${stderrBuf || "(empty)"}\nwrapper stdout:\n${stdoutBuf || "(empty)"}\ntimedOut waiting for worktree disappearance: ${timedOut}`;

      // Sanity: the worktree did disappear within the budget.
      expect(timedOut, `worktree never disappeared within 30s${diag()}`).toBe(
        false,
      );

      // Sanity: the wrapper completed and the outcome eventually
      // ended up as `merged-content`. If either fails, the test
      // isn't exercising the right scenario (wrapper crashed, or the
      // stub didn't drive the happy path) and the race-window
      // assertion below would be misleading.
      expect(exitCode, `wrapper exit code${diag()}`).toBe(0);
      expect(
        outcomeAfterExit,
        `outcome sidecar missing after wrapper exit${diag()}`,
      ).not.toBeNull();
      expect(outcomeAfterExit?.outcomeClass).toBe("merged-content");

      // Wrapper-invariant assertion. `write_outcome` runs before the
      // EXIT trap removes the worktree, so the outcome sidecar is on
      // disk by the time the worktree disappears.
      expect(
        outcomeAtRaceWindow,
        `outcome sidecar was missing at the moment the worktree disappeared — wrapper write_outcome is no longer running before worktree-removal on the happy path${diag()}`,
      ).not.toBeNull();
      expect(outcomeAtRaceWindow?.outcomeClass).toBe("merged-content");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  }, 60_000);

  test("salvage path: outcome sidecar exists with class 'failed:markers-after-agent-exit' at the moment worktree disappears", async () => {
    expect(fs.existsSync(SALVAGE_PATH_STUB)).toBe(true);
    expect(fs.existsSync(SLOW_GIT_SHIM)).toBe(true);

    const s = makeWrapperScaffold("napkin-distill-wrapper-invariant-salvage-");
    const shim = stageSlowGitShim();
    const savedPath = process.env.PATH;
    try {
      const workspace = createDistillWorkspace(
        s.vault,
        s.sessionFile,
        s.parentCwd,
      );
      const branch = workspace.branchName;
      const branchShort = branch.replace(/^distill\//, "");

      // Prepend the shim directory to PATH so the wrapper's bare
      // `git ...` invocations resolve to slow-git.sh (staged as
      // `<shimDir>/git`). The shim falls back to the real git for
      // every command except `git worktree remove`, which it delays
      // by 0.5 s AFTER the real removal completes.
      const env: Record<string, string> = {
        ...process.env,
        PATH: `${shim.shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
        NAPKIN_SLOW_GIT_REAL_GIT: shim.realGit,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        NAPKIN_DISTILL_NO_RECURSE: "1",
        NAPKIN_DISTILL_PI_BIN: SALVAGE_PATH_STUB,
        NAPKIN_STUB_VAULT: s.vault,
        NAPKIN_STUB_WORKTREE: workspace.worktreePath,
        NAPKIN_STUB_BRANCH: branch,
        NAPKIN_STUB_DEFAULT_BRANCH: "main",
      };

      const child = spawn(
        "bash",
        [
          DISTILL_WRAPPER_SCRIPT,
          s.vault,
          workspace.worktreePath,
          branch,
          workspace.sessionForkPath,
          "test prompt",
          s.errorDir,
          "", // model
          "main", // defaultBranch
          s.parentCwd,
          "60", // maxDurationSecs
          path.dirname(workspace.worktreePath), // cache root
        ],
        {
          cwd: s.parentCwd,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.unref();

      let stderrBuf = "";
      child.stderr?.on("data", (chunk) => {
        stderrBuf += chunk.toString();
      });
      let stdoutBuf = "";
      child.stdout?.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
      });

      const target = workspace.worktreePath;
      const startMs = Date.now();
      while (fs.existsSync(target) && Date.now() - startMs < 30_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const timedOut = fs.existsSync(target);

      // Snapshot the FS state at the exact tick where production's
      // poller would call `checkOutcome`. The wrapper invariant
      // requires `outcomeAtRaceWindow !== null` even on the salvage
      // path; pre-fix the salvage code wrote the outcome AFTER the
      // worktree-removal, so this assertion is RED on the wrapper's
      // pre-reorder code and GREEN after the reorder fix.
      const outcomeAtRaceWindow = findDistillOutcomeForBranch(
        s.errorDir,
        branchShort,
      );

      const exitCode = await new Promise<number>((resolve) => {
        if (child.exitCode !== null) {
          resolve(child.exitCode);
          return;
        }
        child.on("exit", (code) => resolve(code ?? -1));
      });

      const outcomeAfterExit = findDistillOutcomeForBranch(
        s.errorDir,
        branchShort,
      );

      const diag = () =>
        `\nwrapper stderr:\n${stderrBuf || "(empty)"}\nwrapper stdout:\n${stdoutBuf || "(empty)"}\ntimedOut waiting for worktree disappearance: ${timedOut}\nexitCode: ${exitCode}`;

      // Sanity: the worktree did disappear within the budget. The
      // salvage path always removes the worktree (it's a critical-
      // path failure recovery), so this should always fire.
      expect(timedOut, `worktree never disappeared within 30s${diag()}`).toBe(
        false,
      );

      // Sanity: the wrapper completed and the eventual outcome is
      // `failed:markers-after-agent-exit`. If the wrapper crashed or
      // routed into a different reason code, the race-window assertion
      // below would be misleading.
      expect(
        outcomeAfterExit,
        `outcome sidecar missing after wrapper exit${diag()}`,
      ).not.toBeNull();
      expect(outcomeAfterExit?.outcomeClass).toBe(
        "failed:markers-after-agent-exit",
      );

      // Wrapper-invariant assertion. `salvage()` must compose the
      // recovery hint and write the outcome BEFORE removing the
      // worktree. If the salvage code removes the worktree first,
      // this snapshot sees null — same shape as the JS-side poller's
      // production observation.
      expect(
        outcomeAtRaceWindow,
        `outcome sidecar was missing at the moment the worktree disappeared — wrapper salvage() is removing the worktree before write_outcome${diag()}`,
      ).not.toBeNull();
      expect(outcomeAtRaceWindow?.outcomeClass).toBe(
        "failed:markers-after-agent-exit",
      );
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      shim.restore();
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  }, 60_000);
});
