import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withNapkinOnPath } from "./_test-helpers";
import {
  cleanupDistillWorkspace,
  type DistillWorkspace,
  spawnDistillInWorktree,
} from "./distill-workspace";
import { DISTILL_WRAPPER_SCRIPT } from "./scripts-paths";

// Tests that need a deliberately-stripped PATH (e.g. to verify
// napkin-missing diagnostics) still have to keep node reachable since
// the wrapper invokes `node -e` for startSha extraction (R12-CC-3 +
// R12-SC-5). On dev boxes / CI runners using mise, nvm, or asdf, node
// lives outside /usr/bin. Prepend the test runner's own node bindir
// (mirrors the wrapper's runtime expectation — pi-bun spawns the
// wrapper with node on PATH).
const NODE_BIN_DIR = path.dirname(
  spawnSync("sh", ["-c", "command -v node"], {
    encoding: "utf-8",
  }).stdout.trim() || "/usr/bin",
);
const NAPKIN_STRIPPED_PATH = `${NODE_BIN_DIR}:/usr/bin:/bin`;

// Path that has napkin reachable (via repo-local node_modules/.bin)
// but deliberately strips the node bindir, exercising the
// node-not-on-PATH guard (R13-CI-1 / R13-CC-3). Mirrors the cron /
// systemd / launchd / container-init scenarios where pi inherits a
// minimal PATH that lacks node's mise/nvm/asdf install dir.
const NAPKIN_LOCAL_BIN = path.resolve(
  __dirname,
  "..",
  "..",
  "node_modules",
  ".bin",
);
const NAPKIN_NODE_STRIPPED_PATH = `${NAPKIN_LOCAL_BIN}:/usr/bin:/bin`;
// Probe whether the test runner's `/usr/bin:/bin` happens to also
// contain node (e.g. some Linux distros ship it there). When that is
// the case the node-missing test cannot be exercised on this host;
// the test self-skips with a diagnostic rather than producing a
// false-positive.
const NODE_REACHABLE_VIA_STRIPPED_PATH =
  spawnSync("sh", ["-c", "command -v node"], {
    encoding: "utf-8",
    env: { PATH: NAPKIN_NODE_STRIPPED_PATH },
  }).stdout.trim() !== "";

/**
 * Tests for `spawnDistillInWorktree` split into two groups:
 *   - unit: mock the `spawn` function, verify we pass the right args to the
 *     shell. Does not create a git repo or touch pi.
 *   - integration: real bash wrapper against a temp git repo. Stubs pi via
 *     `NAPKIN_DISTILL_SKIP_PI=1` and pre-stages changes manually so we can
 *     test the git lifecycle independently of any pi binary.
 *
 * The integration tests don't go through `spawnDistillInWorktree` directly
 * (the detached + stdio:ignore spawn makes exit-code assertions flaky).
 * Instead they invoke the wrapper via `spawnSync` so we get the exit code.
 */

/**
 * Minimal real session file to feed SessionManager.forkFrom. Identical helper
 * as in distill-workspace.test.ts — copied rather than shared because these
 * test fixtures tend to drift independently.
 */
function createSeededSessionFile(dir: string, cwd: string): string {
  const sm = SessionManager.create(cwd, dir);
  sm.appendMessage({ role: "user", content: "hello" });
  sm.appendMessage({ role: "assistant", content: "hi" });
  const file = sm.getSessionFile();
  if (!file || !fs.existsSync(file)) {
    throw new Error("failed to create test session on disk");
  }
  return file;
}

/** Initialize a throwaway git vault with one commit + `.napkin/` scaffold. */
function createGitVault(opts: { seedMd?: string } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-spawn-vault-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const run = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf-8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
  };
  run(["init", "-q", "-b", "main"]);
  run(["config", "commit.gpgsign", "false"]);
  run(["config", "user.name", "test"]);
  run(["config", "user.email", "test@example.com"]);
  // Seed a markdown file so merges have something to test with.
  fs.writeFileSync(
    path.join(dir, "seed.md"),
    opts.seedMd ?? "---\ntitle: seed\n---\n# seed\n",
  );
  // Pre-scaffold the `.gitignore` rule that Phase C auto-setup writes at
  // session_start. Needed for the wrapper's `git add -A` step: without
  // this exclude, the distill's session fork (`.napkin/distill/*`) would
  // get staged into the distill commit.
  //
  // Distill worktrees themselves live under \u007e/.cache/napkin-distill/,
  // outside the vault, so `.gitignore` no longer needs to exclude them.
  fs.writeFileSync(path.join(dir, ".gitignore"), ".napkin/distill/\n");
  // Napkin's configPath expects `.napkin/` to exist for the content vault
  // layout; create it upfront.
  fs.mkdirSync(path.join(dir, ".napkin"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".napkin", "config.json"), "{}");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "seed"]);
  return dir;
}

// ---------------------------------------------------------------------------
// Unit tests — mock `spawn` to verify the wrapper invocation.
// ---------------------------------------------------------------------------

describe("spawnDistillInWorktree (unit, mocked spawn)", () => {
  let vault: string;
  let sessionDir: string;
  let sessionFile: string;
  let xdgCacheDir: string;
  let _savedXdgCache: string | undefined;
  const workspaces: Pick<DistillWorkspace, "worktreePath" | "branchName">[] =
    [];

  beforeEach(() => {
    _savedXdgCache = process.env.XDG_CACHE_HOME;
    xdgCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-unit-xdg-"));
    process.env.XDG_CACHE_HOME = xdgCacheDir;
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-unit-src-"));
    sessionFile = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    for (const w of workspaces) cleanupDistillWorkspace(vault, w);
    workspaces.length = 0;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
    if (xdgCacheDir) fs.rmSync(xdgCacheDir, { recursive: true, force: true });
    if (_savedXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = _savedXdgCache;
  });

  /**
   * Build a fake ChildProcess object that captures the spawn call for
   * assertions but doesn't actually start anything.
   */
  function makeMockSpawn(): {
    spawnFn: typeof spawn;
    calls: Array<{
      command: string;
      args: readonly string[];
      // biome-ignore lint/suspicious/noExplicitAny: options are opaque
      options: any;
    }>;
  } {
    const calls: Array<{
      command: string;
      args: readonly string[];
      // biome-ignore lint/suspicious/noExplicitAny: options are opaque
      options: any;
    }> = [];
    const spawnFn = ((
      command: string,
      args: readonly string[],
      // biome-ignore lint/suspicious/noExplicitAny: options are opaque
      options: any,
    ) => {
      calls.push({ command, args, options });
      const emitter = new EventEmitter() as EventEmitter & {
        unref: () => void;
        pid: number;
      };
      emitter.unref = () => {};
      emitter.pid = 12345;
      // Schedule a no-op exit so anyone who .on('exit') listens wouldn't hang.
      setImmediate(() => emitter.emit("exit", 0, null));
      return emitter;
    }) as unknown as typeof spawn;
    return { spawnFn, calls };
  }

  test("spawns `bash` with the wrapper script path and expected positional args", () => {
    const { spawnFn, calls } = makeMockSpawn();
    const parentCwd = sessionDir;
    const result = spawnDistillInWorktree({
      vault,
      sessionFile,
      parentCwd,
      maxDurationSecs: 600,
      spawnFn,
    });
    workspaces.push(result.workspace);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.command).toBe("bash");

    // Args (PR #12 A2): [wrapper, vault, worktree, branch, sessionFork,
    //   prompt, errorDir, model, defaultBranch, parentCwd, maxDurationSecs]
    expect(call.args[0]).toBe(DISTILL_WRAPPER_SCRIPT);
    expect(call.args[1]).toBe(vault);
    expect(call.args[2]).toBe(result.workspace.worktreePath);
    expect(call.args[3]).toBe(result.workspace.branchName);
    expect(call.args[4]).toBe(result.workspace.sessionForkPath);
    // Prompt is now built internally via buildDistillPrompt against the
    // shipped distill-prompt.md template. It must contain the worktree-
    // isolation cwd contract (POST-R6-CACHE; CLEAN-A-2/CLEAN-A-3 prompt
    // rewrite) AND the agent-driven step markers for steps 7–10
    // (merge / squash / push / cleanup) with the four template
    // placeholders substituted to real values.
    expect(call.args[5]).toContain(
      `git worktree at ${result.workspace.worktreePath}`,
    );
    expect(call.args[5]).toContain(`git -C ${result.workspace.worktreePath}`);
    expect(call.args[5]).toContain(result.workspace.branchName);
    expect(call.args[5]).toContain(vault);
    // Steps 1–10 markers (line-start `<n>.`).
    for (let n = 1; n <= 10; n++) {
      expect(call.args[5]).toMatch(new RegExp(`^${n}\\.`, "m"));
    }
    // No leftover unresolved placeholders.
    expect(call.args[5]).not.toContain("{{worktreePath}}");
    expect(call.args[5]).not.toContain("{{vaultPath}}");
    expect(call.args[5]).not.toContain("{{branchName}}");
    expect(call.args[5]).not.toContain("{{defaultBranch}}");
    // errorDir lives under Napkin's configPath — may be either `<vault>/.napkin`
    // (content layout) or `~/.napkin` (legacy). Just assert it ends with
    // `distill/errors`.
    expect(call.args[6].endsWith(path.join("distill", "errors"))).toBe(true);
    // Empty model string when model is omitted.
    expect(call.args[7]).toBe("");
    // Default branch resolved from the vault — createGitVault() uses
    // `git init -b main` so this should be `main`.
    expect(call.args[8]).toBe("main");
    // POST-R6-CACHE: parentCwd flows through as positional arg [9] so the
    // wrapper can `cd` there before running pi (preserves prompt-cache hits).
    expect(call.args[9]).toBe(parentCwd);
    // PR #12 A2: maxDurationSecs flows through as positional arg [10] so the
    // wrapper can `timeout(1)` the agent task.
    expect(call.args[10]).toBe("600");
  });

  test("sets detached, stdio:ignore, and NAPKIN_DISTILL_NO_RECURSE", () => {
    const { spawnFn, calls } = makeMockSpawn();
    const parentCwd = sessionDir;
    const result = spawnDistillInWorktree({
      vault,
      sessionFile,
      parentCwd,
      maxDurationSecs: 600,
      spawnFn,
    });
    workspaces.push(result.workspace);

    const opts = calls[0].options;
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe("ignore");
    // POST-R6-CACHE: spawn cwd is parentCwd (NOT the worktree) so pi's
    // process.cwd() matches the session-fork header's cwd, keeping the
    // system prompt cwd line byte-identical to the parent's.
    expect(opts.cwd).toBe(parentCwd);
    expect(opts.env.NAPKIN_DISTILL_NO_RECURSE).toBe("1");
  });

  test("passes model through when provided", () => {
    const { spawnFn, calls } = makeMockSpawn();
    const result = spawnDistillInWorktree({
      vault,
      sessionFile,
      parentCwd: sessionDir,
      maxDurationSecs: 600,
      model: "anthropic/claude-sonnet-4-5",
      spawnFn,
    });
    workspaces.push(result.workspace);

    expect(calls[0].args[7]).toBe("anthropic/claude-sonnet-4-5");
  });

  test("ensures errorDir exists on disk before spawning", () => {
    const { spawnFn, calls } = makeMockSpawn();
    const result = spawnDistillInWorktree({
      vault,
      sessionFile,
      parentCwd: sessionDir,
      maxDurationSecs: 600,
      spawnFn,
    });
    workspaces.push(result.workspace);

    const errorDir = calls[0].args[6];
    expect(fs.existsSync(errorDir)).toBe(true);
    expect(fs.statSync(errorDir).isDirectory()).toBe(true);
  });

  test("returns the workspace handle and spawn pid", () => {
    const { spawnFn } = makeMockSpawn();
    const result = spawnDistillInWorktree({
      vault,
      sessionFile,
      parentCwd: sessionDir,
      maxDurationSecs: 600,
      spawnFn,
    });
    workspaces.push(result.workspace);

    expect(result.workspace.branchName).toMatch(/^distill\/[0-9a-f]{6}-\d+$/);
    expect(result.pid).toBe(12345);
    expect(fs.existsSync(result.workspace.worktreePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real bash wrapper, stubbed pi.
// ---------------------------------------------------------------------------

describe("distill-wrapper.sh (integration)", () => {
  let vault: string;
  let sessionDir: string;
  let sessionFile: string;
  let xdgCacheDir: string;
  let _savedXdgCache: string | undefined;

  beforeEach(() => {
    _savedXdgCache = process.env.XDG_CACHE_HOME;
    xdgCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-integ-xdg-"));
    process.env.XDG_CACHE_HOME = xdgCacheDir;
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-integ-src-"));
    sessionFile = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
    if (xdgCacheDir) fs.rmSync(xdgCacheDir, { recursive: true, force: true });
    if (_savedXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = _savedXdgCache;
  });

  test("missing required arg: exits 2 without cleanup errors", () => {
    const r = spawnSync("bash", [DISTILL_WRAPPER_SCRIPT, "only-one-arg"], {
      encoding: "utf-8",
    });
    expect(r.status).toBe(2);
  });

  test("missing parentCwd (arg 9) hard-fails with exit 2 (R7-PERF-7, R7-CI-6)", () => {
    // R7-PERF-7 / R7-CI-6: previously the wrapper fell back silently to
    // $WORKTREE if parentCwd was empty, re-introducing the cache
    // regression POST-R6-CACHE fixed (no observable signal). Now the
    // wrapper hard-fails so any out-of-tree caller surfaces the
    // contract violation immediately.
    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    fs.mkdirSync(errorDir, { recursive: true });
    const r = spawnSync(
      "bash",
      [
        DISTILL_WRAPPER_SCRIPT,
        vault,
        "/tmp/wt",
        "distill/abc-1",
        "/tmp/session.jsonl",
        "prompt",
        errorDir,
        "",
        "main",
        // 9th arg deliberately omitted — expect exit 2.
      ],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("missing required argument 9 (parentCwd)");
  });

  test("wrapper rewrites meta.json pid to its own pid (C2)", () => {
    // The parent JS side writes meta.json with `pid: process.pid` (the
    // parent pi session). The wrapper MUST overwrite that with its own
    // pid ($$) so liveness checks against the recorded pid track the
    // wrapper's lifetime, not the long-lived parent session's.
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
      sessionDir,
    );
    const metaPath = path.join(
      workspace.worktreePath,
      ".napkin",
      "distill",
      "meta.json",
    );

    // Before wrapper runs: meta.pid = parent (this process).
    const beforeMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(beforeMeta.pid).toBe(process.pid);

    // Run the wrapper with HALT_AFTER_META so it updates meta.json then
    // exits 0 without touching pi, git, or the cleanup trap. The worktree
    // survives so we can inspect meta.json.
    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    fs.mkdirSync(errorDir, { recursive: true });
    const r = spawnSync(
      "bash",
      [
        DISTILL_WRAPPER_SCRIPT,
        vault,
        workspace.worktreePath,
        workspace.branchName,
        workspace.sessionForkPath,
        "test prompt",
        errorDir,
        "",
        "main",
        vault,
      ],
      {
        cwd: workspace.worktreePath,
        encoding: "utf-8",
        env: {
          ...process.env,
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_HALT_AFTER_META: "1",
        },
      },
    );
    expect(r.status).toBe(0);

    // After wrapper runs: meta.pid should NOT be this process's pid.
    // (The wrapper's pid is distinct from the test's pid; spawnSync
    // exits the child before returning, so we can't compare to a live
    // pid — but we CAN confirm it's no longer the parent's.)
    const afterMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(typeof afterMeta.pid).toBe("number");
    expect(afterMeta.pid).not.toBe(process.pid);
    expect(afterMeta.pid).toBeGreaterThan(0);

    // Other meta fields unchanged by the pid rewrite.
    expect(afterMeta.vault).toBe(beforeMeta.vault);
    expect(afterMeta.branch).toBe(beforeMeta.branch);
    expect(afterMeta.startedAt).toBe(beforeMeta.startedAt);
    expect(afterMeta.parentSession).toBe(beforeMeta.parentSession);

    // Clean up — HALT_AFTER_META skipped the trap so we must manually
    // tear down the worktree and branch.
    spawnSync(
      "git",
      ["-C", vault, "worktree", "remove", "--force", workspace.worktreePath],
      { encoding: "utf-8" },
    );
    spawnSync("git", ["-C", vault, "branch", "-D", workspace.branchName], {
      encoding: "utf-8",
    });
  });

  test("POST-R6-CACHE: wrapper installs napkin shim and exports it on PATH", () => {
    // The shim auto-routes the agent's `napkin` calls to the distill
    // worktree (`napkin --vault <worktree>`) so vault writes from the
    // bash tool land in the worktree even though pi runs at the parent's
    // cwd (parent cwd preserves prompt-cache hits). Verify the shim is
    // installed at the expected path with the right content.
    //
    // CI portability: napkin lives in `node_modules/.bin/` after `bun
    // install`. Add that to PATH so the wrapper's `command -v napkin`
    // finds it on fresh runners that don't have a global napkin install.
    const repoRoot = path.resolve(__dirname, "..", "..");
    const localBin = path.join(repoRoot, "node_modules", ".bin");
    const augmentedPath = `${localBin}${path.delimiter}${process.env.PATH ?? ""}`;
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace = createDistillWorkspace(vault, sessionFile, sessionDir);
    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    fs.mkdirSync(errorDir, { recursive: true });

    const r = spawnSync(
      "bash",
      [
        DISTILL_WRAPPER_SCRIPT,
        vault,
        workspace.worktreePath,
        workspace.branchName,
        workspace.sessionForkPath,
        "test prompt",
        errorDir,
        "",
        "main",
        sessionDir, // parentCwd
      ],
      {
        cwd: sessionDir,
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: augmentedPath,
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_HALT_AFTER_SHIM: "1",
        },
      },
    );
    expect(r.status).toBe(0);

    const shimPath = path.join(
      workspace.worktreePath,
      ".napkin",
      "distill",
      "bin",
      "napkin",
    );
    expect(fs.existsSync(shimPath)).toBe(true);

    // Shim must be executable.
    const shimStat = fs.statSync(shimPath);
    // 0o111 = any-execute bits.
    expect(shimStat.mode & 0o111).not.toBe(0);

    // Shim must inject `--vault <worktree>` into every napkin call. The
    // real napkin path is baked in at install-time as an absolute path
    // (resolved via `command -v napkin` in the wrapper) — so the shim,
    // once invoked, execs that absolute napkin binary directly, no
    // further PATH resolution. The agent's shell still uses PATH
    // ordering to find THIS shim (the wrapper prepends $SHIM_DIR);
    // that's what makes the indirection work end-to-end.
    //
    // Note: the shim is generated with `printf %q` so paths are shell-
    // escaped. For clean paths (no spaces / quotes / backticks), %q
    // emits the path bare; only paths with shell-special characters get
    // surrounding quotes or backslash escapes. Both the worktree path
    // (XDG cache + hex hash + hex/epoch suffix) and the resolved napkin
    // path are normally clean, so we expect the bare-path form.
    const shimContent = fs.readFileSync(shimPath, "utf-8");
    expect(shimContent).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(shimContent).toContain(`--vault ${workspace.worktreePath}`);
    // Real napkin path baked in (we test that it's an absolute path —
    // could be /usr/local/bin/napkin or pnpm bin shim, but never just
    // "napkin" which would recurse). %q quoting may add an outer pair
    // of single quotes if the path contains shell-special chars; the
    // common (clean) case is bare path. Match either.
    expect(shimContent).toMatch(/exec '?\/[^ '"]+'? --vault /);

    // Manual teardown: HALT_AFTER_SHIM cleared the trap.
    spawnSync(
      "git",
      ["-C", vault, "worktree", "remove", "--force", workspace.worktreePath],
      { encoding: "utf-8" },
    );
    spawnSync("git", ["-C", vault, "branch", "-D", workspace.branchName], {
      encoding: "utf-8",
    });
  });

  test("POST-R6-CACHE: missing napkin on PATH — wrapper fails loud, cleans up, error log records PATH (R7-CC-5, R7-SC-10)", () => {
    // R7-CC-5 / R7-SC-3: when napkin is unresolvable on the wrapper's
    // PATH and SKIP_PI is unset (production code path), the wrapper
    // exits 1, the cleanup trap removes the worktree, and the error
    // log records the diagnostic + the PATH the wrapper saw (R7-SC-10
    // — forensic info for the user to fix their environment).
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace = createDistillWorkspace(vault, sessionFile, sessionDir);
    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    fs.mkdirSync(errorDir, { recursive: true });

    // Strip PATH to a system minimum that doesn't contain napkin.
    const r = spawnSync(
      "bash",
      [
        DISTILL_WRAPPER_SCRIPT,
        vault,
        workspace.worktreePath,
        workspace.branchName,
        workspace.sessionForkPath,
        "test prompt",
        errorDir,
        "",
        "main",
        sessionDir,
      ],
      {
        cwd: sessionDir,
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: NAPKIN_STRIPPED_PATH,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          NAPKIN_DISTILL_NO_RECURSE: "1",
          // SKIP_PI deliberately unset so we exercise the production path.
        },
      },
    );
    expect(r.status).toBe(1);

    // Cleanup trap fires — worktree is gone.
    expect(fs.existsSync(workspace.worktreePath)).toBe(false);

    // Error log records the failure with the resolved-path diagnostic
    // and the wrapper's PATH for forensic recovery.
    const errors = fs.readdirSync(errorDir);
    expect(errors.length).toBeGreaterThan(0);
    const errorContent = fs.readFileSync(
      path.join(errorDir, errors[0]),
      "utf-8",
    );
    expect(errorContent).toContain("napkin binary not found on wrapper PATH");
    expect(errorContent).toContain(`PATH=${NAPKIN_STRIPPED_PATH}`);
  });

  test("missing node on PATH — wrapper fails with node-specific diagnostic, not the misleading meta.json one (R13-CI-1, R13-CC-3)", () => {
    // R13-CI-1 / R13-CC-3: round-12's `0a03b8e` switched startSha
    // extraction from sed to `node -e` for JSON-shape robustness, but
    // made `node` on PATH a hard precondition. When node is missing
    // (cron / systemd / launchd / container-init / mise-or-nvm dev
    // boxes whose runtime PATH lacks the node bindir), the previous
    // build let `node -e` produce empty stdout, which fell through to
    // the meta.json-missing-startSha hard-fail at line 332 — a
    // misleading diagnostic since the user's meta.json is fine, only
    // node is missing. The fix-now guard probes node before the
    // extraction and emits a node-specific error. Pin the diagnostic
    // shape here so a future revert to the silent-empty-startSha
    // shape regresses loudly.
    if (NODE_REACHABLE_VIA_STRIPPED_PATH) {
      // /usr/bin or /bin contains a node binary on this host — the
      // test cannot exercise the missing-node path. Skip with a
      // diagnostic rather than asserting on the wrong code path.
      console.warn(
        "[skip] node is reachable via /usr/bin or /bin on this host; " +
          "the missing-node guard cannot be exercised here.",
      );
      return;
    }
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace = createDistillWorkspace(vault, sessionFile, sessionDir);
    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    fs.mkdirSync(errorDir, { recursive: true });

    const r = spawnSync(
      "bash",
      [
        DISTILL_WRAPPER_SCRIPT,
        vault,
        workspace.worktreePath,
        workspace.branchName,
        workspace.sessionForkPath,
        "test prompt",
        errorDir,
        "",
        "main",
        sessionDir,
      ],
      {
        cwd: sessionDir,
        encoding: "utf-8",
        env: {
          ...process.env,
          // PATH has napkin (via node_modules/.bin) reachable but
          // deliberately strips NODE_BIN_DIR. SKIP_PI=1 to keep the
          // shim install block out of the picture — the node guard
          // sits BEFORE the shim install, so this isolates the guard.
          PATH: NAPKIN_NODE_STRIPPED_PATH,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_SKIP_PI: "1",
        },
      },
    );
    expect(r.status).toBe(1);

    const errors = fs
      .readdirSync(errorDir)
      .filter((f) => f.endsWith(".log") && !f.includes(".merge-driver"));
    expect(errors.length).toBeGreaterThan(0);
    const errorContent = errors
      .map((f) => fs.readFileSync(path.join(errorDir, f), "utf-8"))
      .join("\n");
    // The new node-specific diagnostic fires.
    expect(errorContent).toContain("node binary not found on wrapper PATH");
    expect(errorContent).toContain(`PATH=${NAPKIN_NODE_STRIPPED_PATH}`);
    // Crucially, NOT the misleading downstream meta.json hard-fail
    // (the previous behaviour before the guard).
    expect(errorContent).not.toContain("meta.json missing startSha");
  });

  test("POST-R6-CACHE: SKIP_PI=1 skips shim install (R7-SC-15)", () => {
    // R7-SC-15: pin the SKIP_PI=1 contract — the shim install block in
    // the wrapper is gated on `NAPKIN_DISTILL_SKIP_PI != "1"`. Tests
    // that stub pi via SKIP_PI=1 depend on the shim NOT existing
    // afterwards (no napkin invocation to route, and the test
    // environment may not have napkin on PATH at all). Without this
    // pin, a future refactor that moves the shim install above the
    // SKIP_PI gate would silently break those tests' isolation.
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace = createDistillWorkspace(vault, sessionFile, sessionDir);
    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    fs.mkdirSync(errorDir, { recursive: true });

    // HALT_AFTER_SHIM with SKIP_PI=1: the wrapper should reach the
    // halt point WITHOUT having installed a shim (since the shim
    // block is skipped under SKIP_PI). The halt clears the cleanup
    // trap so we can inspect the worktree afterwards.
    const r = spawnSync(
      "bash",
      [
        DISTILL_WRAPPER_SCRIPT,
        vault,
        workspace.worktreePath,
        workspace.branchName,
        workspace.sessionForkPath,
        "test prompt",
        errorDir,
        "",
        "main",
        sessionDir, // parentCwd
      ],
      {
        cwd: sessionDir,
        encoding: "utf-8",
        env: {
          ...process.env,
          // PATH stripped of napkin (testing SKIP_PI gate); node
          // preserved because the wrapper needs it for startSha
          // extraction (R12-CC-3).
          PATH: NAPKIN_STRIPPED_PATH,
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_SKIP_PI: "1",
          NAPKIN_DISTILL_HALT_AFTER_SHIM: "1",
        },
      },
    );
    expect(r.status).toBe(0);

    // No shim was installed.
    const shimPath = path.join(
      workspace.worktreePath,
      ".napkin",
      "distill",
      "bin",
      "napkin",
    );
    expect(fs.existsSync(shimPath)).toBe(false);

    // Manual teardown.
    spawnSync(
      "git",
      ["-C", vault, "worktree", "remove", "--force", workspace.worktreePath],
      { encoding: "utf-8" },
    );
    spawnSync("git", ["-C", vault, "branch", "-D", workspace.branchName], {
      encoding: "utf-8",
    });
  });

  // R12-CC-3 + R12-SC-5: meta.json missing startSha must hard-fail
  // rather than silently degrading to the legacy --cached path that
  // dropped pi-self-committed content (POST-CONV-1; real failure:
  // dropped commit a13e8b1).
  test("meta.json without startSha hard-fails with diagnostic (R12-CC-3, R12-SC-5)", () => {
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
      sessionDir,
    );
    const metaPath = path.join(
      workspace.worktreePath,
      ".napkin",
      "distill",
      "meta.json",
    );

    // Strip startSha from meta.json to simulate an out-of-tree caller
    // or a contract violation. createDistillWorkspace always populates
    // it; we mutate after-the-fact to exercise the wrapper's defence.
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    delete meta.startSha;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    fs.mkdirSync(errorDir, { recursive: true });
    const r = spawnSync(
      "bash",
      [
        DISTILL_WRAPPER_SCRIPT,
        vault,
        workspace.worktreePath,
        workspace.branchName,
        workspace.sessionForkPath,
        "test prompt",
        errorDir,
        "",
        "main",
        vault,
      ],
      {
        cwd: workspace.worktreePath,
        encoding: "utf-8",
        env: {
          ...process.env,
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_SKIP_PI: "1",
        },
      },
    );
    expect(r.status).toBe(1);

    // Diagnostic landed in the error log file (not just stderr).
    const errorEntries = fs
      .readdirSync(errorDir)
      .filter((f) => f.endsWith(".log") && !f.includes(".merge-driver"));
    expect(errorEntries.length).toBeGreaterThan(0);
    const combined = errorEntries
      .map((f) => fs.readFileSync(path.join(errorDir, f), "utf-8"))
      .join("\n");
    expect(combined).toContain("meta.json missing startSha");
    expect(combined).toContain("refusing to proceed");
  });
});

// ---------------------------------------------------------------------------
// Default-branch detection + respect. Hardcoding `main` silently corrupts
// vaults that use `master` (older git, users with init.defaultBranch=master
// in global config). Verify the wrapper works end-to-end on a `master`-
// default vault.
// ---------------------------------------------------------------------------

describe("distill-wrapper.sh (non-main default branch)", () => {
  let vault: string;
  let sessionDir: string;

  function createMasterDefaultVault(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-master-vault-"));
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const run = (args: string[]) => {
      const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf-8" });
      if (r.status !== 0) {
        throw new Error(
          `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`,
        );
      }
    };
    run(["init", "-q", "-b", "master"]);
    run(["config", "commit.gpgsign", "false"]);
    run(["config", "user.name", "test"]);
    run(["config", "user.email", "test@example.com"]);
    fs.writeFileSync(path.join(dir, "seed.md"), "# seed\n");
    fs.writeFileSync(path.join(dir, ".gitignore"), ".napkin/distill/\n");
    fs.mkdirSync(path.join(dir, ".napkin"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".napkin", "config.json"), "{}");
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "seed"]);
    return dir;
  }

  let xdgCacheDir: string;
  let _savedXdgCache: string | undefined;

  beforeEach(() => {
    _savedXdgCache = process.env.XDG_CACHE_HOME;
    xdgCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-master-xdg-"));
    process.env.XDG_CACHE_HOME = xdgCacheDir;
    vault = createMasterDefaultVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-master-src-"));
    // Side-effect-only: createSeededSessionFile seeds a SessionManager
    // disk fixture under sessionDir. The current tests in this describe
    // call detectDefaultBranch(vault) directly without spawning the
    // wrapper, so we don't need to retain the returned path.
    createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
    if (xdgCacheDir) fs.rmSync(xdgCacheDir, { recursive: true, force: true });
    if (_savedXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = _savedXdgCache;
  });

  test("detectDefaultBranch returns 'master' for a master-default vault", () => {
    const { detectDefaultBranch } = require("./distill-workspace");
    expect(detectDefaultBranch(vault)).toBe("master");
  });
});

// ---------------------------------------------------------------------------
// Wrapper cleanup-trap rm-rf fallback (POST-CONV-3) and rmdir parent
// vault-hash dir (POST-CONV-4). Driven through the actual wrapper EXIT
// trap via the NAPKIN_DISTILL_FORCE_CLEANUP=1 halt hook (R12-CC-4) so
// the test exercises the production cleanup path, not an inline-bash
// reproduction. The hook fires `exit 1` post-shim-install without
// clearing the trap, letting the cleanup function fire normally.
// ---------------------------------------------------------------------------

describe("distill-wrapper.sh cleanup trap (POST-CONV-3, POST-CONV-4)", () => {
  let xdgCacheDir: string;
  let _savedXdgCache: string | undefined;
  let vault: string;
  let sessionDir: string;
  let sessionFile: string;
  let napkinPathRestore: { restore: () => void } | undefined;

  beforeEach(() => {
    _savedXdgCache = process.env.XDG_CACHE_HOME;
    xdgCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-cleanup-xdg-"));
    process.env.XDG_CACHE_HOME = xdgCacheDir;
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-cleanup-src-"));
    sessionFile = createSeededSessionFile(sessionDir, sessionDir);
    // R13-CC-1: the previous setup used NAPKIN_STRIPPED_PATH (no
    // node_modules/.bin) AND NAPKIN_DISTILL_SKIP_PI=1 — the shim
    // install block was bypassed entirely, so the FORCE_CLEANUP hook
    // fired post-NOTHING and the rm-rf fallback test pinned a
    // worktree that had no gitignored shim to survive `git worktree
    // remove --force`. The hook was effectively a no-op for this
    // test. Use withNapkinOnPath() so napkin resolves, the shim
    // install block runs, the FORCE_CLEANUP hook fires post-shim-
    // install, and the rm-rf fallback genuinely targets a gitignored
    // file the worktree-remove couldn't clean.
    napkinPathRestore = withNapkinOnPath();
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
    if (xdgCacheDir) fs.rmSync(xdgCacheDir, { recursive: true, force: true });
    if (_savedXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = _savedXdgCache;
    if (napkinPathRestore) {
      napkinPathRestore.restore();
      napkinPathRestore = undefined;
    }
  });

  function runWrapperForceCleanup(workspace: DistillWorkspace): {
    exitCode: number;
    errorDir: string;
  } {
    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    fs.mkdirSync(errorDir, { recursive: true });
    const r = spawnSync(
      "bash",
      [
        DISTILL_WRAPPER_SCRIPT,
        vault,
        workspace.worktreePath,
        workspace.branchName,
        workspace.sessionForkPath,
        "test prompt",
        errorDir,
        "",
        "main",
        sessionDir, // parentCwd
      ],
      {
        cwd: sessionDir,
        encoding: "utf-8",
        env: {
          ...process.env,
          // PATH inherited from withNapkinOnPath() so napkin resolves
          // and the shim install actually runs. SKIP_PI deliberately
          // unset — we want the shim block to execute so the
          // FORCE_CLEANUP hook below fires from its documented post-
          // shim-install location, not from the SKIP_PI bypass.
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_FORCE_CLEANUP: "1",
        },
      },
    );
    return { exitCode: r.status ?? -1, errorDir };
  }

  test("rm -rf fallback removes leaf when git worktree remove leaves gitignored content (POST-CONV-3, R13-CC-1)", () => {
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
      sessionDir,
    );
    expect(fs.existsSync(workspace.worktreePath)).toBe(true);

    const { exitCode, errorDir } = runWrapperForceCleanup(workspace);
    // FORCE_CLEANUP exits 1 deliberately. The cleanup trap then fires.
    expect(exitCode).toBe(1);

    // Pin the exit path: the wrapper exited from the FORCE_CLEANUP
    // hook (post-shim-install), NOT from the napkin-not-found,
    // node-not-found, or meta-missing-startSha paths above. Without
    // this assertion the test was passing for the wrong reason
    // (R13-CC-1 — PATH stripped of napkin made it bail at the shim-
    // install block, never reaching the hook).
    const errorFiles = fs
      .readdirSync(errorDir)
      .filter((f) => f.endsWith(".log") && !f.includes(".merge-driver"));
    expect(errorFiles.length).toBeGreaterThan(0);
    const errorContent = errorFiles
      .map((f) => fs.readFileSync(path.join(errorDir, f), "utf-8"))
      .join("\n");
    expect(errorContent).toContain(
      "FORCE_CLEANUP hook fired post-shim-install",
    );
    expect(errorContent).not.toContain("napkin binary not found");
    expect(errorContent).not.toContain("node binary not found");

    // The shim install put a gitignored file under .napkin/distill/
    // that survives `git worktree remove --force`. The rm-rf fallback
    // is what makes the leaf disappear.
    expect(fs.existsSync(workspace.worktreePath)).toBe(false);

    // Branch was force-deleted by the trap.
    const branches = spawnSync("git", ["-C", vault, "branch"], {
      encoding: "utf-8",
    }).stdout;
    expect(branches).not.toContain(workspace.branchName);
  });

  test("rmdir removes parent vault-hash dir after last distill cleared (POST-CONV-4, R13-CC-1)", () => {
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
      sessionDir,
    );
    const parentDir = path.dirname(workspace.worktreePath);
    expect(fs.existsSync(parentDir)).toBe(true);

    const { exitCode, errorDir } = runWrapperForceCleanup(workspace);
    expect(exitCode).toBe(1);

    // Pin the exit path here too — R13-CC-1 affected both tests in
    // this describe block, since both share runWrapperForceCleanup.
    const errorFiles = fs
      .readdirSync(errorDir)
      .filter((f) => f.endsWith(".log") && !f.includes(".merge-driver"));
    expect(errorFiles.length).toBeGreaterThan(0);
    const errorContent = errorFiles
      .map((f) => fs.readFileSync(path.join(errorDir, f), "utf-8"))
      .join("\n");
    expect(errorContent).toContain(
      "FORCE_CLEANUP hook fired post-shim-install",
    );

    // Single-distill setup — rmdir parent succeeded because no
    // sibling distills survive in the same vault-hash dir.
    expect(fs.existsSync(parentDir)).toBe(false);
  });
});
