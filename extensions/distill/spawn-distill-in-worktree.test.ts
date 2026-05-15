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
  buildWorktreeDistillPrompt,
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
  // Pre-scaffold the merge-driver .gitattributes rule. Mirrors what Phase C
  // auto-init will do so `registerMergeDriver` becomes a no-op in tests — if
  // we didn't do this, the first distill would always commit a .gitattributes
  // change on top of any content changes, polluting test expectations and
  // causing cross-distill merge conflicts on .gitattributes.
  fs.writeFileSync(
    path.join(dir, ".gitattributes"),
    "*.md merge=napkin-distill-merge\n",
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
    // isolation prefix (POST-R6-CACHE) AND the agent-driven step markers
    // for steps 7–10 (merge / squash / push / cleanup) with the four
    // template placeholders substituted to real values.
    expect(call.args[5]).toContain(
      `isolated git worktree at ${result.workspace.worktreePath}`,
    );
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
// buildWorktreeDistillPrompt — POST-R6-CACHE worktree-isolation prefix.
// ---------------------------------------------------------------------------

describe("buildWorktreeDistillPrompt (POST-R6-CACHE)", () => {
  test("prepends a worktree-isolation prefix that names the worktree path", () => {
    const wt = "/tmp/example-worktree-abc/123";
    const out = buildWorktreeDistillPrompt(wt, "BASE PROMPT");
    expect(out).toContain(`isolated git worktree at ${wt}`);
    expect(out).toContain(
      "Do NOT use absolute paths from the conversation history",
    );
    // Base prompt is preserved verbatim at the end.
    expect(out.endsWith("BASE PROMPT")).toBe(true);
  });

  test("prefix is non-trivial in length so the agent can't miss it", () => {
    const out = buildWorktreeDistillPrompt("/tmp/wt", "x");
    // Base prompt is 1 char; everything else is the prefix. Length floor
    // catches accidental degeneration of the prefix to a one-liner.
    expect(out.length).toBeGreaterThan(200);
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

  /**
   * Run the wrapper synchronously using the workspace handle. Returns
   * { exitCode, stderr }.
   *
   * We use `NAPKIN_DISTILL_SKIP_PI=1` to bypass the pi call; the caller
   * pre-stages any file changes they want to simulate.
   */
  function runWrapper(
    workspace: DistillWorkspace,
    extraEnv: Record<string, string> = {},
  ): { exitCode: number; stderr: string } {
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
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_SKIP_PI: "1",
          ...extraEnv,
        },
      },
    );
    return { exitCode: r.status ?? -1, stderr: r.stderr ?? "" };
  }

  /**
   * Create a workspace and stage a new markdown file in it so the wrapper's
   * `git add -A` has something to commit. Returns the workspace and the
   * absolute path to the staged file.
   */
  function createWorkspaceWithChanges(
    filename: string,
    content: string,
  ): { workspace: DistillWorkspace; stagedFile: string } {
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace = createDistillWorkspace(vault, sessionFile, sessionDir);
    const stagedFile = path.join(workspace.worktreePath, filename);
    fs.writeFileSync(stagedFile, content);
    return { workspace, stagedFile };
  }

  // ---------------------------------------------------------------------
  // PR #12 A2: the wrapper no longer does add / commit / merge / squash —
  // the agent owns those steps via the prompt's steps 7–10. The four
  // tests below assume the deleted wrapper logic and are therefore skipped
  // pending replacement in Phase C with bash-stub mocked-pi fixtures that
  // simulate each agent-behavior class (clean-distill, no-distill,
  // conflict-leave-markers, etc.). // will be deleted in Phase B/C
  // ---------------------------------------------------------------------
  test.skip("happy path: commits distill changes and squash-merges to main", () => {
    const { workspace } = createWorkspaceWithChanges(
      "note.md",
      "---\ntitle: new\n---\n# new note\n",
    );
    const branch = workspace.branchName;

    const r = runWrapper(workspace);
    expect(r.exitCode).toBe(0);

    // Worktree and branch cleaned up.
    expect(fs.existsSync(workspace.worktreePath)).toBe(false);
    const branches = spawnSync("git", ["-C", vault, "branch"], {
      encoding: "utf-8",
    }).stdout;
    expect(branches).not.toContain(branch);

    // main has a new squash commit with our file.
    const log = spawnSync("git", ["-C", vault, "log", "--oneline", "-n", "5"], {
      encoding: "utf-8",
    }).stdout;
    expect(log).toContain("distill: merge");

    // The note.md should be on main now.
    const mainFile = path.join(vault, "note.md");
    expect(fs.existsSync(mainFile)).toBe(true);
    expect(fs.readFileSync(mainFile, "utf-8")).toContain("# new note");

    // POST-CONV-5: outcome sidecar records `merged-content`.
    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    const branchShort = branch.replace(/^distill\//, "");
    const outcomeFiles = fs
      .readdirSync(errorDir)
      .filter((f) => f.endsWith(`-${branchShort}.outcome`));
    expect(outcomeFiles).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(errorDir, outcomeFiles[0]), "utf-8").trim(),
    ).toBe("merged-content");
  });

  test.skip("empty distill (no changes): exits 0 and cleans up without creating a commit", () => {
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace = createDistillWorkspace(vault, sessionFile, sessionDir);
    const branch = workspace.branchName;
    const logBefore = spawnSync("git", ["-C", vault, "log", "--oneline"], {
      encoding: "utf-8",
    }).stdout;

    const r = runWrapper(workspace);
    expect(r.exitCode).toBe(0);

    // Cleanup happened.
    expect(fs.existsSync(workspace.worktreePath)).toBe(false);
    const branches = spawnSync("git", ["-C", vault, "branch"], {
      encoding: "utf-8",
    }).stdout;
    expect(branches).not.toContain(branch);

    // No new commits on main.
    const logAfter = spawnSync("git", ["-C", vault, "log", "--oneline"], {
      encoding: "utf-8",
    }).stdout;
    expect(logAfter).toBe(logBefore);

    // POST-CONV-5: outcome sidecar records `no-content`.
    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    const branchShort = branch.replace(/^distill\//, "");
    const outcomeFiles = fs
      .readdirSync(errorDir)
      .filter((f) => f.endsWith(`-${branchShort}.outcome`));
    expect(outcomeFiles).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(errorDir, outcomeFiles[0]), "utf-8").trim(),
    ).toBe("no-content");
  });

  test.skip("POST-CONV-1: pi-self-committed content squashes to main (no silent drop)", () => {
    // Regression for the dropped-distill-commit `a13e8b1` failure mode:
    // pi's bash tool ran `git commit` itself, leaving the worktree clean
    // post-`add -A` because pi already advanced HEAD. The legacy
    // `git diff --cached --quiet` check reported false-no-op and the
    // wrapper exited 0 before the squash phase, then the cleanup trap
    // force-deleted the branch. The new `git diff --quiet $START_SHA`
    // check catches both the staged-only and pi-committed cases.
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace = createDistillWorkspace(vault, sessionFile, sessionDir);
    const branch = workspace.branchName;

    // Simulate pi self-committing inside the worktree.
    const stagedFile = path.join(workspace.worktreePath, "selfcommit.md");
    fs.writeFileSync(
      stagedFile,
      "---\ntitle: self\n---\n# pi self-committed this\n",
    );
    const stage = spawnSync(
      "git",
      ["-C", workspace.worktreePath, "add", "-A"],
      { encoding: "utf-8" },
    );
    expect(stage.status).toBe(0);
    const commit = spawnSync(
      "git",
      [
        "-C",
        workspace.worktreePath,
        "-c",
        "user.name=pi",
        "-c",
        "user.email=pi@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "pi self-commit",
      ],
      { encoding: "utf-8" },
    );
    expect(commit.status).toBe(0);

    const r = runWrapper(workspace);
    expect(r.exitCode).toBe(0);

    // Worktree and branch cleaned up.
    expect(fs.existsSync(workspace.worktreePath)).toBe(false);
    const branches = spawnSync("git", ["-C", vault, "branch"], {
      encoding: "utf-8",
    }).stdout;
    expect(branches).not.toContain(branch);

    // main has the squash commit + pi's file content.
    const log = spawnSync("git", ["-C", vault, "log", "--oneline", "-n", "5"], {
      encoding: "utf-8",
    }).stdout;
    expect(log).toContain("distill: merge");
    const mainFile = path.join(vault, "selfcommit.md");
    expect(fs.existsSync(mainFile)).toBe(true);
    expect(fs.readFileSync(mainFile, "utf-8")).toContain(
      "# pi self-committed this",
    );

    // POST-CONV-5: outcome sidecar records `merged-content` even though
    // the wrapper did not run its own `git commit` step.
    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    const branchShort = branch.replace(/^distill\//, "");
    const outcomeFiles = fs
      .readdirSync(errorDir)
      .filter((f) => f.endsWith(`-${branchShort}.outcome`));
    expect(outcomeFiles).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(errorDir, outcomeFiles[0]), "utf-8").trim(),
    ).toBe("merged-content");
  });

  test.skip("concurrent worktrees don't interfere (both complete)", () => {
    // Two workspaces with disjoint content — both should land on main.
    const a = createWorkspaceWithChanges("a.md", "---\ntitle: a\n---\n# a\n");
    const b = createWorkspaceWithChanges("b.md", "---\ntitle: b\n---\n# b\n");

    const rA = runWrapper(a.workspace);
    expect(rA.exitCode).toBe(0);
    const rB = runWrapper(b.workspace);
    expect(rB.exitCode).toBe(0);

    expect(fs.existsSync(path.join(vault, "a.md"))).toBe(true);
    expect(fs.existsSync(path.join(vault, "b.md"))).toBe(true);
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
          NAPKIN_GIT_RETRY_MAX: "2",
          NAPKIN_GIT_RETRY_DELAY: "0",
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
// Partial-merge salvage tests. Forces a conflict between main and the distill
// branch, stubs the merge driver via NAPKIN_DISTILL_MERGE_MOCK=fail so the
// LLM path always 3-strikes, then verifies that:
//   - clean files keep the distill's content
//   - conflicted files revert to main's version
//   - error log is written with file path + reason
//   - main still receives a squash commit with the clean-file change
//
// Note: the wrapper self-heals .gitattributes via registerMergeDriver. The
// vault fixture pre-scaffolds the same line so config drift doesn't affect
// these assertions.
//
// PR #12 A2: the merge driver is gone (the agent owns merge resolution).
// These tests assert the deleted code path. // will be deleted in Phase B
// ---------------------------------------------------------------------------

describe.skip("distill-wrapper.sh (partial-merge salvage)", () => {
  let vault: string;
  let sessionDir: string;
  let sessionFile: string;
  let xdgCacheDir: string;
  let _savedXdgCache: string | undefined;

  beforeEach(() => {
    _savedXdgCache = process.env.XDG_CACHE_HOME;
    xdgCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-salvage-xdg-"));
    process.env.XDG_CACHE_HOME = xdgCacheDir;
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-salvage-src-"));
    sessionFile = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
    if (xdgCacheDir) fs.rmSync(xdgCacheDir, { recursive: true, force: true });
    if (_savedXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = _savedXdgCache;
  });

  /**
   * Run a git command in `dir`, throwing on non-zero exit. Used to build
   * conflict-inducing state on the vault's main branch before invoking the
   * wrapper.
   */
  function runGitOrThrow(dir: string, args: string[]): string {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const r = spawnSync("git", ["-C", dir, ...args], {
      env,
      encoding: "utf-8",
    });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
    return r.stdout;
  }

  /**
   * Run the wrapper with the merge driver mocked to always fail. Pre-stages
   * the given files in the worktree before invoking. Returns exit code +
   * error log contents (read post-run from the vault's error dir).
   */
  function runWrapperWithMockFail(
    workspace: DistillWorkspace,
    worktreeFiles: Record<string, string>,
  ): { exitCode: number; errorLogs: string[] } {
    for (const [relPath, content] of Object.entries(worktreeFiles)) {
      const abs = path.join(workspace.worktreePath, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
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
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_SKIP_PI: "1",
          NAPKIN_DISTILL_MERGE_MOCK: "fail",
          // Speed up tests: no retry backoff.
          NAPKIN_GIT_RETRY_MAX: "2",
          NAPKIN_GIT_RETRY_DELAY: "0",
        },
      },
    );
    const errorLogs: string[] = [];
    if (fs.existsSync(errorDir)) {
      for (const f of fs.readdirSync(errorDir)) {
        // Skip the `.outcome` sidecar (POST-CONV-5) — not a log; tests
        // assert outcome separately. Skip `.merge-driver*` files
        // (R12-SC-1: driver now co-locates its forensic log + 3-strike
        // snapshots here too). Keep both `.log` (fatal) and
        // `.partial-merge.log` (R8-CC-1 forensic) — partial-merge tests
        // below assert content of the latter.
        if (f.endsWith(".outcome")) continue;
        if (f.includes(".merge-driver")) continue;
        errorLogs.push(fs.readFileSync(path.join(errorDir, f), "utf-8"));
      }
    }
    return { exitCode: r.status ?? -1, errorLogs };
  }

  test("clean file keeps distill's content, conflicted file reverts to main", () => {
    // Baseline: main already has `conflict.md` and `clean.md` from the seed
    // commit. Mutate `conflict.md` on main so the distill's version
    // conflicts; leave `clean.md` untouched on main.
    const conflictPath = path.join(vault, "conflict.md");
    const cleanPath = path.join(vault, "clean.md");
    fs.writeFileSync(
      conflictPath,
      "---\ntitle: conflict\n---\n# initial content\n",
    );
    fs.writeFileSync(
      cleanPath,
      "---\ntitle: clean\n---\n# initial clean content\n",
    );
    runGitOrThrow(vault, ["add", "-A"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "add baseline files"]);

    // Create workspace AFTER the baseline commit so the worktree sees both
    // files. Then mutate main's copy of conflict.md to force a divergence.
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
      sessionDir,
    );

    fs.writeFileSync(
      conflictPath,
      "---\ntitle: conflict\n---\n# MAIN's version after baseline\n",
    );
    runGitOrThrow(vault, ["add", "conflict.md"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "main mutates conflict.md"]);

    // Stage distill-branch changes in the worktree:
    //   - conflict.md: different content → merge conflict
    //   - clean.md:    modified, no conflict on main → clean merge
    const r = runWrapperWithMockFail(workspace, {
      "conflict.md":
        "---\ntitle: conflict\n---\n# DISTILL's different version\n",
      "clean.md": "---\ntitle: clean\n---\n# distill updated the clean file\n",
    });

    expect(r.exitCode).toBe(0);

    // Worktree + branch cleaned up.
    expect(fs.existsSync(workspace.worktreePath)).toBe(false);
    const branches = runGitOrThrow(vault, ["branch"]);
    expect(branches).not.toContain(workspace.branchName);

    // conflict.md on main = MAIN's version (salvage reverted distill's).
    const conflictAfter = fs.readFileSync(conflictPath, "utf-8");
    expect(conflictAfter).toContain("MAIN's version after baseline");
    expect(conflictAfter).not.toContain("DISTILL's different version");

    // clean.md on main = distill's version (merged cleanly).
    const cleanAfter = fs.readFileSync(cleanPath, "utf-8");
    expect(cleanAfter).toContain("distill updated the clean file");

    // Error log written with the conflicted file path + reason.
    expect(r.errorLogs.length).toBeGreaterThan(0);
    const combined = r.errorLogs.join("\n");
    expect(combined).toContain("conflict.md");
    expect(combined).toContain("partial-merge");

    // Main has a squash commit.
    const log = runGitOrThrow(vault, ["log", "--oneline", "-n", "5"]);
    expect(log).toContain("distill: merge");

    // POST-CONV-5: outcome sidecar records `partial-merge` (squash
    // landed on main, but some files reverted to default-branch's copy).
    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    const branchShort = workspace.branchName.replace(/^distill\//, "");
    const outcomeFiles = fs
      .readdirSync(errorDir)
      .filter((f) => f.endsWith(`-${branchShort}.outcome`));
    expect(outcomeFiles).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(errorDir, outcomeFiles[0]), "utf-8").trim(),
    ).toBe("partial-merge");
  });

  test("all files conflict: salvage reverts everything, no squash commit created", () => {
    // Both distill's files collide with main, AND there are no clean files
    // — the squash merge produces nothing new, so main should NOT get a
    // distill commit. This verifies the empty-squash guard survives the
    // salvage path.
    const a = path.join(vault, "a.md");
    fs.writeFileSync(a, "---\ntitle: a\n---\n# baseline\n");
    runGitOrThrow(vault, ["add", "a.md"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "add a"]);

    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
      sessionDir,
    );

    fs.writeFileSync(a, "---\ntitle: a\n---\n# MAIN's later version\n");
    runGitOrThrow(vault, ["add", "a.md"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "main mutates a"]);

    const logBefore = runGitOrThrow(vault, ["log", "--oneline"]);

    const r = runWrapperWithMockFail(workspace, {
      "a.md": "---\ntitle: a\n---\n# DISTILL's different version\n",
    });
    expect(r.exitCode).toBe(0);

    // Cleanup happened.
    expect(fs.existsSync(workspace.worktreePath)).toBe(false);

    // Main unchanged: no new squash commit because all content was salvaged
    // back to main's version.
    const logAfter = runGitOrThrow(vault, ["log", "--oneline"]);
    expect(logAfter).toBe(logBefore);

    // Error log records the salvage.
    expect(r.errorLogs.length).toBeGreaterThan(0);
    expect(r.errorLogs.join("\n")).toContain("a.md");

    // POST-CONV-5: outcome sidecar records `no-content` because the
    // squash produced no staged changes on main (all files reverted to
    // main's existing version). Even though the inner merge ran the
    // salvage path, no distill content reached main this round.
    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    const branchShort = workspace.branchName.replace(/^distill\//, "");
    const outcomeFiles = fs
      .readdirSync(errorDir)
      .filter((f) => f.endsWith(`-${branchShort}.outcome`));
    expect(outcomeFiles).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(errorDir, outcomeFiles[0]), "utf-8").trim(),
    ).toBe("no-content");
  });

  // R12-SC-1: the wrapper sets NAPKIN_DISTILL_ERROR_DIR but historically
  // forgot to `export` it, so the merge driver — spawned by `git merge`
  // two layers below the wrapper — fell through to its XDG_CACHE_HOME
  // fallback. Tests didn't catch the drift because `runMergeDriverWithEnv`
  // in scripts.test.ts sets the env var explicitly. This regression
  // exercises the export through the real wrapper-driver call chain.
  test("merge-driver log co-locates in vault errorDir, not XDG cache", () => {
    const conflictPath = path.join(vault, "conflict.md");
    fs.writeFileSync(
      conflictPath,
      "---\ntitle: conflict\n---\n# initial content\n",
    );
    runGitOrThrow(vault, ["add", "-A"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "add baseline"]);

    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
      sessionDir,
    );

    fs.writeFileSync(
      conflictPath,
      "---\ntitle: conflict\n---\n# MAIN's later version\n",
    );
    runGitOrThrow(vault, ["add", "conflict.md"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "main mutates conflict"]);

    const r = runWrapperWithMockFail(workspace, {
      "conflict.md":
        "---\ntitle: conflict\n---\n# DISTILL's different version\n",
    });
    expect(r.exitCode).toBe(0);

    const errorDir = path.join(vault, ".napkin", "distill", "errors");
    const driverLogsInVault = fs
      .readdirSync(errorDir)
      .filter((f) => f.endsWith(".merge-driver.log"));
    expect(driverLogsInVault.length).toBeGreaterThan(0);

    // XDG fallback dir must not have received any merge-driver logs.
    // beforeEach overrides XDG_CACHE_HOME to a per-test temp; the
    // pre-export bug landed logs at $xdgCacheDir/napkin-distill/
    // merge-driver-logs/ instead.
    const xdgFallbackDir = path.join(
      xdgCacheDir,
      "napkin-distill",
      "merge-driver-logs",
    );
    const xdgFallbackEntries = fs.existsSync(xdgFallbackDir)
      ? fs.readdirSync(xdgFallbackDir)
      : [];
    expect(xdgFallbackEntries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MERGE_HEAD escape-hatch. The wrapper's last-line defense (after salvage)
// covers the case where the driver returned exit 0 but its output still
// contained conflict markers — git then sees MERGE_HEAD still present and
// the merge is incomplete. The wrapper bails and writes to error log.
// Previously dead code in CI (no mock mode emitted conflict markers).
// Covers coverage-review G4.
// ---------------------------------------------------------------------------

describe.skip("distill-wrapper.sh (MERGE_HEAD escape-hatch)", () => {
  let vault: string;
  let sessionDir: string;
  let sessionFile: string;
  let xdgCacheDir: string;
  let _savedXdgCache: string | undefined;

  beforeEach(() => {
    _savedXdgCache = process.env.XDG_CACHE_HOME;
    xdgCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-mh-xdg-"));
    process.env.XDG_CACHE_HOME = xdgCacheDir;
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-mh-src-"));
    sessionFile = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
    if (xdgCacheDir) fs.rmSync(xdgCacheDir, { recursive: true, force: true });
    if (_savedXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = _savedXdgCache;
  });

  function runGitOrThrow(dir: string, args: string[]): string {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const r = spawnSync("git", ["-C", dir, ...args], {
      env,
      encoding: "utf-8",
    });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
    return r.stdout;
  }

  test("MERGE_HEAD persists after merge: wrapper bails + logs", () => {
    // Real-world triggering (driver writes conflict-markers and git still
    // marks merge incomplete) requires a specific git internals state
    // that CI can't reliably stage: driver exit 0 clears MERGE_HEAD. Use
    // the NAPKIN_DISTILL_FORCE_MERGE_HEAD=1 testing hook so the wrapper
    // creates MERGE_HEAD immediately before its escape-hatch check.
    //
    // Pre-stage a simple change so the wrapper runs past the no-op early
    // exit.
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
      sessionDir,
    );
    fs.writeFileSync(
      path.join(workspace.worktreePath, "new.md"),
      "---\ntitle: new\n---\n# content\n",
    );

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
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_SKIP_PI: "1",
          NAPKIN_DISTILL_FORCE_MERGE_HEAD: "1",
          NAPKIN_GIT_RETRY_MAX: "2",
          NAPKIN_GIT_RETRY_DELAY: "0",
        },
      },
    );

    // Wrapper exits 1 because the escape-hatch fires.
    expect(r.status).toBe(1);

    // Error log contains the MERGE_HEAD diagnostic.
    const errorLogs = fs.existsSync(errorDir)
      ? fs
          .readdirSync(errorDir)
          // Skip `.outcome` (sidecar) and `.merge-driver*` (R12-SC-1
          // driver-side forensic) — we want the wrapper-side fatal log.
          .filter(
            (f) => !f.endsWith(".outcome") && !f.includes(".merge-driver"),
          )
          .map((f) => fs.readFileSync(path.join(errorDir, f), "utf-8"))
      : [];
    expect(errorLogs.length).toBeGreaterThan(0);
    expect(errorLogs.join("\n")).toContain("MERGE_HEAD still present");

    // Dangling SHA recorded for forensic recovery.
    expect(errorLogs.join("\n")).toContain("dangling distill commit SHA:");

    // No distill squash commit on main — the content was never merged.
    const log = runGitOrThrow(vault, ["log", "--oneline", "-n", "10"]);
    expect(log).not.toContain("distill: merge");
  });

  test("git merge returns unexpected exit code (C6): wrapper aborts + logs, no salvage", () => {
    // Force merge_rc=128 via the testing hook so we exercise the
    // unexpected-exit-code bail-out path. 128 is git's "general fatal"
    // (corrupt index, invalid ref, etc.) — distinct from the expected
    // exit 1 (conflicts remain, salvage). Without this branch the wrapper
    // would fall through to the empty-UNMERGED salvage and attempt a
    // spurious squash on a branch that was never actually merged.
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
      sessionDir,
    );
    fs.writeFileSync(
      path.join(workspace.worktreePath, "new.md"),
      "---\ntitle: new\n---\n# content\n",
    );

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
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_SKIP_PI: "1",
          NAPKIN_DISTILL_FORCE_MERGE_RC: "128",
          NAPKIN_GIT_RETRY_MAX: "2",
          NAPKIN_GIT_RETRY_DELAY: "0",
        },
      },
    );

    // Wrapper exits 1 via the unexpected-exit branch.
    expect(r.status).toBe(1);

    const errorLogs = fs.existsSync(errorDir)
      ? fs
          .readdirSync(errorDir)
          // Skip `.outcome` (sidecar) and `.merge-driver*` (R12-SC-1).
          .filter(
            (f) => !f.endsWith(".outcome") && !f.includes(".merge-driver"),
          )
          .map((f) => fs.readFileSync(path.join(errorDir, f), "utf-8"))
      : [];
    expect(errorLogs.length).toBeGreaterThan(0);
    const combined = errorLogs.join("\n");
    // Explicit diagnostic: unexpected exit code + dangling SHA.
    expect(combined).toMatch(/failed unexpectedly \(exit 128\)/);
    expect(combined).toContain("aborting");
    expect(combined).toContain("dangling distill commit SHA:");

    // No squash to main.
    const log = runGitOrThrow(vault, ["log", "--oneline", "-n", "10"]);
    expect(log).not.toContain("distill: merge");
  });
});

// ---------------------------------------------------------------------------
// End-to-end LLM-resolved conflict tests. Forces a real conflict between main
// and the distill branch, uses NAPKIN_DISTILL_MERGE_MOCK=ok so the driver
// emits a plausible merge (ours+theirs concatenated), then verifies that the
// resolved content SURVIVES the squash-merge to main.
//
// Covers the core concurrency story end-to-end: `.gitattributes` routes to
// the driver, the driver fires during `git merge main` in the wrapper, and
// the driver's output reaches main. Previous salvage tests only force
// `fail`; these pin the happy path.
// ---------------------------------------------------------------------------

describe.skip("distill-wrapper.sh (LLM-resolved conflict, end-to-end)", () => {
  let vault: string;
  let sessionDir: string;
  let sessionFile: string;
  let xdgCacheDir: string;
  let _savedXdgCache: string | undefined;

  beforeEach(() => {
    _savedXdgCache = process.env.XDG_CACHE_HOME;
    xdgCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-e2e-xdg-"));
    process.env.XDG_CACHE_HOME = xdgCacheDir;
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-e2e-src-"));
    sessionFile = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
    if (xdgCacheDir) fs.rmSync(xdgCacheDir, { recursive: true, force: true });
    if (_savedXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = _savedXdgCache;
  });

  function runGitOrThrow(dir: string, args: string[]): string {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const r = spawnSync("git", ["-C", dir, ...args], {
      env,
      encoding: "utf-8",
    });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
    return r.stdout;
  }

  /**
   * Invoke the wrapper against a pre-populated worktree with the `ok`
   * merge-driver mock enabled, so the LLM driver "resolves" conflicts by
   * concatenating ours+theirs. Returns the wrapper exit code + any error-log
   * contents (expected empty on the happy path).
   */
  function runWrapperWithMockOk(
    workspace: DistillWorkspace,
    worktreeFiles: Record<string, string>,
    mockOverride?: string,
  ): { exitCode: number; errorLogs: string[] } {
    for (const [relPath, content] of Object.entries(worktreeFiles)) {
      const abs = path.join(workspace.worktreePath, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
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
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_SKIP_PI: "1",
          NAPKIN_DISTILL_MERGE_MOCK: mockOverride ?? "ok",
          NAPKIN_GIT_RETRY_MAX: "2",
          NAPKIN_GIT_RETRY_DELAY: "0",
        },
      },
    );
    const errorLogs: string[] = [];
    if (fs.existsSync(errorDir)) {
      for (const f of fs.readdirSync(errorDir)) {
        // Skip the `.outcome` sidecar (POST-CONV-5) and `.merge-driver*`
        // files (R12-SC-1). Keep both `.log` (fatal) and
        // `.partial-merge.log` (R8-CC-1 forensic) — partial-merge tests
        // below assert content of the latter.
        if (f.endsWith(".outcome")) continue;
        if (f.includes(".merge-driver")) continue;
        errorLogs.push(fs.readFileSync(path.join(errorDir, f), "utf-8"));
      }
    }
    return { exitCode: r.status ?? -1, errorLogs };
  }

  test("LLM-resolved conflict: driver output lands on main", () => {
    // Baseline: a file that both sides will diverge on.
    const conflictPath = path.join(vault, "shared.md");
    fs.writeFileSync(
      conflictPath,
      "---\ntitle: shared\n---\n# baseline shared content\n",
    );
    runGitOrThrow(vault, ["add", "-A"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "add shared"]);

    // Create the worktree at this baseline, then mutate main post-hoc so
    // the divergence is real (same pattern as the salvage tests).
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
      sessionDir,
    );

    fs.writeFileSync(
      conflictPath,
      "---\ntitle: shared\n---\n# MAIN's later addition\n",
    );
    runGitOrThrow(vault, ["add", "shared.md"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "main mutates shared"]);

    // The distill branch writes its own divergent version. With the `ok`
    // mock the driver emits ours+theirs concatenated.
    const r = runWrapperWithMockOk(workspace, {
      "shared.md":
        "---\ntitle: shared\n---\n# DISTILL's addition (not the same)\n",
    });
    expect(r.exitCode).toBe(0);
    // No error log on the happy path.
    expect(r.errorLogs).toEqual([]);

    // Worktree + branch cleaned up.
    expect(fs.existsSync(workspace.worktreePath)).toBe(false);
    const branches = runGitOrThrow(vault, ["branch"]);
    expect(branches).not.toContain(workspace.branchName);

    // Resolved content on main contains BOTH sides' markers (driver=ok
    // concatenates). Proves: (1) driver fired during git merge in the
    // worktree, (2) the resolved content survived the squash-merge to main.
    const finalContent = fs.readFileSync(conflictPath, "utf-8");
    expect(finalContent).toContain("MAIN's later addition");
    expect(finalContent).toContain("DISTILL's addition (not the same)");

    // Main has a squash commit.
    const log = runGitOrThrow(vault, ["log", "--oneline", "-n", "5"]);
    expect(log).toContain("distill: merge");
  });

  test("driver retries: ok-after-2 succeeds on the third attempt", () => {
    // Verifies the 3-strike retry loop bridges transient failures. The
    // first two attempts fail (exit 1) and the third succeeds — the
    // resolved content must still land on main.
    const conflictPath = path.join(vault, "retry.md");
    fs.writeFileSync(conflictPath, "---\ntitle: retry\n---\n# baseline\n");
    runGitOrThrow(vault, ["add", "-A"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "add retry"]);

    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
      sessionDir,
    );

    fs.writeFileSync(
      conflictPath,
      "---\ntitle: retry\n---\n# MAIN post-baseline\n",
    );
    runGitOrThrow(vault, ["add", "retry.md"]);
    runGitOrThrow(vault, ["commit", "-q", "-m", "main mutates retry"]);

    const r = runWrapperWithMockOk(
      workspace,
      {
        "retry.md":
          "---\ntitle: retry\n---\n# DISTILL post-baseline (diverges)\n",
      },
      "ok-after-2",
    );
    expect(r.exitCode).toBe(0);
    expect(r.errorLogs).toEqual([]);

    const finalContent = fs.readFileSync(conflictPath, "utf-8");
    expect(finalContent).toContain("MAIN post-baseline");
    expect(finalContent).toContain("DISTILL post-baseline (diverges)");

    const log = runGitOrThrow(vault, ["log", "--oneline", "-n", "5"]);
    expect(log).toContain("distill: merge");
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
  let sessionFile: string;

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
    fs.writeFileSync(
      path.join(dir, ".gitattributes"),
      "*.md merge=napkin-distill-merge\n",
    );
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
    sessionFile = createSeededSessionFile(sessionDir, sessionDir);
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

  // PR #12 A2: the wrapper no longer squash-merges — the agent does. This
  // test is skipped pending Phase C replacement with a bash-stub mocked-pi
  // fixture that exercises the master-default-branch path through the
  // agent's prompt. // will be deleted in Phase B/C
  test.skip("wrapper squash-merges into master when default branch is master", () => {
    const { createDistillWorkspace } = require("./distill-workspace");
    const workspace: DistillWorkspace = createDistillWorkspace(
      vault,
      sessionFile,
      sessionDir,
    );
    const stagedFile = path.join(workspace.worktreePath, "new-note.md");
    fs.writeFileSync(stagedFile, "---\ntitle: new\n---\n# new note\n");

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
        "master", // 8th arg: default branch
        vault,
      ],
      {
        cwd: workspace.worktreePath,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          NAPKIN_DISTILL_NO_RECURSE: "1",
          NAPKIN_DISTILL_SKIP_PI: "1",
          NAPKIN_GIT_RETRY_MAX: "2",
          NAPKIN_GIT_RETRY_DELAY: "0",
        },
      },
    );
    expect(r.status).toBe(0);

    // No error log entries.
    const errorLogs = fs.existsSync(errorDir)
      ? fs
          .readdirSync(errorDir)
          // Skip `.outcome` (POST-CONV-5 success-path marker) and
          // `.merge-driver*` (R12-SC-1 driver forensic). `.partial-merge.log`
          // (R8-CC-1) is also a success-path forensic file but doesn't
          // appear here (no salvage).
          .filter(
            (f) => !f.endsWith(".outcome") && !f.includes(".merge-driver"),
          )
          .map((f) => fs.readFileSync(path.join(errorDir, f), "utf-8"))
      : [];
    expect(errorLogs).toEqual([]);

    // master has the squash commit.
    const log = spawnSync(
      "git",
      ["-C", vault, "log", "--oneline", "master", "-n", "5"],
      { encoding: "utf-8" },
    ).stdout;
    expect(log).toContain("distill: merge");

    // The new note lands on master.
    expect(fs.existsSync(path.join(vault, "new-note.md"))).toBe(true);
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
