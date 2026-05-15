import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { withNapkinOnPath } from "./_test-helpers";
import { resolveCacheRoot } from "./distill-workspace";
import distillExtension from "./index";

/**
 * Tests for the session_shutdown handler (Phase B Item 8). Verifies that
 * the handler spawns an auto-distill worktree iff `shouldDistillOnShutdown`
 * returns true, and never blocks shutdown regardless of inner failures.
 *
 * Approach: observe the filesystem for worktree directories under the vault's
 * XDG cache (`$XDG_CACHE_HOME/napkin-distill/<vault-hash>/<suffix>/`) as a
 * proxy for "spawnDistillInWorktree was invoked". The workspace is created
 * synchronously by `spawnDistillInWorktree` before the detached process
 * exec, so we can assert immediately after the handler returns without
 * racing the wrapper's cleanup trap.
 *
 * `shouldDistillOnShutdown` itself has direct unit-test coverage in
 * should-distill-on-shutdown.test.ts \u2014 these tests cover the WIRING (the
 * handler assembles the right inputs and reacts to the predicate).
 */

/** Capture pi.on/registerCommand handlers; same shape as routing.test.ts. */
interface CapturedAPI {
  // biome-ignore lint/suspicious/noExplicitAny: opaque handlers
  handlers: Record<string, (event: any, ctx: any) => Promise<void> | void>;
  commands: Record<
    string,
    // biome-ignore lint/suspicious/noExplicitAny: opaque handlers
    { handler: (args: string, ctx: any) => Promise<void> | void }
  >;
}

function makeMockAPI(): { api: unknown; captured: CapturedAPI } {
  const captured: CapturedAPI = { handlers: {}, commands: {} };
  const api = {
    // biome-ignore lint/suspicious/noExplicitAny: loose pi shape
    on(event: string, handler: any) {
      captured.handlers[event] = handler;
    },
    // biome-ignore lint/suspicious/noExplicitAny: loose pi shape
    registerCommand(name: string, opts: any) {
      captured.commands[name] = opts;
    },
    registerTool() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag() {
      return undefined;
    },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    setSessionName() {},
    getSessionName() {
      return undefined;
    },
    setLabel() {},
    async exec() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    getActiveTools() {
      return [];
    },
    getAllTools() {
      return [];
    },
    setActiveTools() {},
  };
  return { api, captured };
}

/**
 * Build a git vault with distill config. Pass `withGit=false` to skip git
 * init \u2014 exercises the "needs git" guard in the shutdown handler.
 */
function createVault(
  config: {
    enabled: boolean;
    onShutdown?: boolean;
    intervalMinutes?: number;
  },
  withGit = true,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-vault-"));
  if (withGit) {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "t@e",
    };
    const git = (args: string[]) =>
      spawnSync("git", ["-C", dir, ...args], { env, encoding: "utf-8" });
    git(["init", "-q", "-b", "main"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["config", "user.name", "t"]);
    git(["config", "user.email", "t@e"]);
    fs.writeFileSync(path.join(dir, "seed.md"), "# seed\n");
    fs.mkdirSync(path.join(dir, ".napkin"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".napkin", "config.json"),
      JSON.stringify({
        // Sibling layout: notes live at <dir>/ (the vault content root),
        // config lives at <dir>/.napkin/. Without `vault.root`, napkin
        // would treat this as a legacy embedded vault and resolve
        // contentPath to <dir>/.napkin — which is where git is NOT.
        vault: { root: ".." },
        distill: {
          enabled: config.enabled,
          onShutdown: config.onShutdown ?? true,
          intervalMinutes: config.intervalMinutes ?? 60,
        },
      }),
    );
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "seed"]);
  } else {
    fs.mkdirSync(path.join(dir, ".napkin"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".napkin", "config.json"),
      JSON.stringify({
        vault: { root: ".." },
        distill: {
          enabled: config.enabled,
          onShutdown: config.onShutdown ?? true,
          intervalMinutes: config.intervalMinutes ?? 60,
        },
      }),
    );
  }
  return dir;
}

/**
 * Create a SessionManager seeded with enough content that `getSessionFile()`
 * returns a path with `size > 0`. Returns the manager so the caller can
 * pass it as `ctx.sessionManager`.
 */
function createSession(dir: string): SessionManager {
  const sm = SessionManager.create(dir, dir);
  sm.appendMessage({ role: "user", content: "hello" });
  sm.appendMessage({ role: "assistant", content: "hi" });
  return sm;
}

/**
 * Create a legacy-embedded-layout vault. napkin's `resolveVaultLayout`
 * returns `{ contentPath = configPath = .napkin/dir }` when the config has
 * no `vault.root`, simulating vaults from pre-subdir-layout napkin
 * versions. Auto-distill's setup refuses to scaffold these, so session
 * shutdown must not spawn a worktree.
 *
 * Layout:
 *   <dir>/.napkin/                  <- napkin's configPath == contentPath
 *   <dir>/.napkin/config.json       <- distill config, NO vault.root
 *
 * We don't git-init here because legacy-layout refusal fires BEFORE any
 * git interaction in auto-setup. If the refusal ever regresses, the test
 * would surface it by spawning a worktree on a vault with no commits
 * (which would throw from createDistillWorktree, leaving a visible error).
 */
function createLegacyVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-vault-"));
  fs.mkdirSync(path.join(dir, ".napkin"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".napkin", "config.json"),
    JSON.stringify({
      // NO `vault.root` key \u2014 napkin treats this as legacy embedded.
      distill: { enabled: true, onShutdown: true, intervalMinutes: 60 },
    }),
  );
  return dir;
}

/**
 * Build a mock `ExtensionUIContext` that captures `notify` calls into an
 * array so tests can assert on migration messages without mounting the
 * real UI. `setStatus` is a no-op to satisfy the type shape.
 */
function makeCaptureUI(): {
  ui: {
    notify: (msg: string, level: string) => void;
    setStatus: (_id: string, _content: unknown) => void;
    theme: {
      fg: (_role: string, s: string) => string;
    };
  };
  notifies: Array<{ message: string; level: string }>;
} {
  const notifies: Array<{ message: string; level: string }> = [];
  const ui = {
    notify: (message: string, level: string) => {
      notifies.push({ message, level });
    },
    setStatus: (_id: string, _content: unknown) => {},
    theme: {
      fg: (_role: string, s: string) => s,
    },
  };
  return { ui, notifies };
}

/** Count worktrees present under the vault's XDG distill cache dir. */
function countWorktrees(vault: string): number {
  const d = resolveCacheRoot(vault);
  if (!fs.existsSync(d)) return 0;
  return fs.readdirSync(d).length;
}

/** Best-effort cleanup of any dangling distill worktrees in `vault`. */
function cleanupWorktrees(vault: string): void {
  const d = resolveCacheRoot(vault);
  if (!fs.existsSync(d)) return;
  for (const entry of fs.readdirSync(d)) {
    const wt = path.join(d, entry);
    spawnSync("git", ["-C", vault, "worktree", "remove", "--force", wt], {
      encoding: "utf-8",
    });
  }
  spawnSync("git", ["-C", vault, "worktree", "prune"], { encoding: "utf-8" });
}

describe("session_shutdown handler (Item 8)", () => {
  let vault: string;
  let sm: SessionManager;
  let originalSetInterval: typeof setInterval;
  /** Per-test XDG_CACHE_HOME override so distill worktrees land in a test
   * tmpdir instead of the user's real `~/.cache/napkin-distill/`. */
  let xdgCacheDir: string;

  // Clear the recursion-guard env var — test runner may be inside a distill subprocess.
  const _savedRecurse = process.env.NAPKIN_DISTILL_NO_RECURSE;
  const _savedXdgCache = process.env.XDG_CACHE_HOME;
  // Saved git identity env vars — set dummy values before each test so the
  // Phase C1 auto-init test (production does `git init` + `git commit` on a
  // fresh vault) succeeds on CI runners without a global ~/.gitconfig.
  // Local users already have identity via their gitconfig; this is a
  // CI-portability safety net, not a production path.
  const _savedGitEnv = {
    authorName: process.env.GIT_AUTHOR_NAME,
    authorEmail: process.env.GIT_AUTHOR_EMAIL,
    committerName: process.env.GIT_COMMITTER_NAME,
    committerEmail: process.env.GIT_COMMITTER_EMAIL,
  };
  // POST-R6-CACHE: the wrapper now requires `napkin` on PATH for the
  // per-distill shim install. CI runners don't have a global napkin
  // install — napkin lives in `node_modules/.bin/` after `bun install`.
  // The shared helper handles the augment + restore cycle.
  let _napkinPath: { restore: () => void } | null = null;
  beforeEach(() => {
    delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    xdgCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-xdg-"));
    process.env.XDG_CACHE_HOME = xdgCacheDir;
    process.env.GIT_AUTHOR_NAME = "Napkin CI";
    process.env.GIT_AUTHOR_EMAIL = "ci@napkin.test";
    process.env.GIT_COMMITTER_NAME = "Napkin CI";
    process.env.GIT_COMMITTER_EMAIL = "ci@napkin.test";
    _napkinPath = withNapkinOnPath();
    // Stub setInterval so session_start doesn't leak a real timer; shutdown
    // tests don't need the interval to fire.
    originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((
      _cb: () => void,
      _ms: number,
      ..._rest: unknown[]
    ) =>
      ({
        unref: () => {},
        ref: () => {},
      }) as unknown as NodeJS.Timeout) as typeof setInterval;
  });

  afterEach(() => {
    if (_savedRecurse !== undefined)
      process.env.NAPKIN_DISTILL_NO_RECURSE = _savedRecurse;
    else delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    // Restore PATH (POST-R6-CACHE augmentation cleanup).
    _napkinPath?.restore();
    _napkinPath = null;
    // Restore git identity env
    for (const [key, val] of [
      ["GIT_AUTHOR_NAME", _savedGitEnv.authorName],
      ["GIT_AUTHOR_EMAIL", _savedGitEnv.authorEmail],
      ["GIT_COMMITTER_NAME", _savedGitEnv.committerName],
      ["GIT_COMMITTER_EMAIL", _savedGitEnv.committerEmail],
    ] as const) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    globalThis.setInterval = originalSetInterval;
    if (vault) {
      cleanupWorktrees(vault);
      fs.rmSync(vault, { recursive: true, force: true });
    }
    // Tear down the per-test XDG cache dir (where worktrees live now).
    if (xdgCacheDir) fs.rmSync(xdgCacheDir, { recursive: true, force: true });
    if (_savedXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = _savedXdgCache;
  });

  /**
   * Drive the full lifecycle: register extension, call session_start, then
   * session_shutdown with the given reason. Returns the count of worktrees
   * observed after shutdown returned.
   */
  async function runLifecycle(
    vaultPath: string,
    sessionManager: SessionManager,
    shutdownReason: "quit" | "reload" | "new" | "resume" | "fork",
  ): Promise<number> {
    const { api, captured } = makeMockAPI();
    distillExtension(api as never);
    // biome-ignore lint/suspicious/noExplicitAny: partial ctx
    const ctx: any = {
      cwd: vaultPath,
      sessionManager,
      hasUI: false,
      ui: null,
    };
    await captured.handlers.session_start({ reason: "new" }, ctx);
    await captured.handlers.session_shutdown({ reason: shutdownReason }, ctx);
    return countWorktrees(vaultPath);
  }

  test("spawns on normal quit with enabled config + git vault + content", async () => {
    vault = createVault({ enabled: true });
    sm = createSession(vault);
    const worktrees = await runLifecycle(vault, sm, "quit");
    expect(worktrees).toBe(1);
  });

  test("spawns on 'fork' reason (pi's session-fork shutdown)", async () => {
    // Guard 2 only short-circuits on "reload"; every other real reason
    // (quit/new/resume/fork) should let the predicate fall through to the
    // content-based guards. This pins the behaviour for a reason that
    // wasn't exercised by the quit-only happy-path test.
    vault = createVault({ enabled: true });
    sm = createSession(vault);
    const worktrees = await runLifecycle(vault, sm, "fork");
    expect(worktrees).toBe(1);
  });

  test("does NOT spawn when shutdown reason is 'reload'", async () => {
    vault = createVault({ enabled: true });
    sm = createSession(vault);
    const worktrees = await runLifecycle(vault, sm, "reload");
    expect(worktrees).toBe(0);
  });

  test("does NOT spawn when config.onShutdown=false", async () => {
    vault = createVault({ enabled: true, onShutdown: false });
    sm = createSession(vault);
    const worktrees = await runLifecycle(vault, sm, "quit");
    expect(worktrees).toBe(0);
  });

  test("does NOT spawn when config.enabled=false", async () => {
    vault = createVault({ enabled: false });
    sm = createSession(vault);
    const worktrees = await runLifecycle(vault, sm, "quit");
    expect(worktrees).toBe(0);
  });

  test("does NOT spawn when session file is empty", async () => {
    vault = createVault({ enabled: true });
    // Create SessionManager without appending any messages \u2014 the file may
    // not even be flushed to disk yet. Either way, currentSize === 0 trips
    // shouldDistillOnShutdown's guard #7.
    sm = SessionManager.create(vault, vault);
    const worktrees = await runLifecycle(vault, sm, "quit");
    expect(worktrees).toBe(0);
  });

  test("auto-inits git at session_start when vault is not yet a repo (Phase C1)", async () => {
    // With Phase C1's auto-setup, a vault without `.git` gets initialized
    // during session_start, and the shutdown handler then spawns normally.
    // This replaces the Phase B "needs-git guard" test whose guard is
    // effectively dead in the happy path now — `ctx.cwd` is always a git
    // repo by the time session_shutdown runs.
    vault = createVault({ enabled: true }, /* withGit */ false);
    sm = createSession(vault);
    const worktrees = await runLifecycle(vault, sm, "quit");
    // Auto-init ran, so .git exists by shutdown, so the shutdown handler
    // does spawn a worktree.
    expect(fs.existsSync(path.join(vault, ".git"))).toBe(true);
    expect(worktrees).toBe(1);
  });

  test("does NOT spawn when NAPKIN_DISTILL_NO_RECURSE is set (recursion guard)", async () => {
    vault = createVault({ enabled: true });
    sm = createSession(vault);
    const before = process.env.NAPKIN_DISTILL_NO_RECURSE;
    process.env.NAPKIN_DISTILL_NO_RECURSE = "1";
    try {
      const worktrees = await runLifecycle(vault, sm, "quit");
      expect(worktrees).toBe(0);
    } finally {
      if (before === undefined) delete process.env.NAPKIN_DISTILL_NO_RECURSE;
      else process.env.NAPKIN_DISTILL_NO_RECURSE = before;
    }
  });

  test("shutdown never blocks when vault resolution fails", async () => {
    // Point ctx.cwd at a directory that Napkin can't resolve to a vault.
    // The handler's outer try/catch must swallow the error and still\u00a0complete.
    const bogusCwd = fs.mkdtempSync(path.join(os.tmpdir(), "no-vault-"));
    try {
      const { api, captured } = makeMockAPI();
      distillExtension(api as never);
      // biome-ignore lint/suspicious/noExplicitAny: partial ctx
      const ctx: any = {
        cwd: bogusCwd,
        sessionManager: SessionManager.create(bogusCwd, bogusCwd),
        hasUI: false,
        ui: null,
      };
      await captured.handlers.session_start({ reason: "new" }, ctx);
      // If this throws, the test fails \u2014 shutdown must be defensive.
      await expect(
        captured.handlers.session_shutdown({ reason: "quit" }, ctx),
      ).resolves.toBeUndefined();
    } finally {
      fs.rmSync(bogusCwd, { recursive: true, force: true });
    }
  });

  test("setup failure: suppresses shutdown distill AND overrides persisted suppression=false (C1)", async () => {
    // Simulate a vault-level setup failure: create a directory where
    // `.gitignore` is supposed to be a file. `ensureVaultReadyForAutoDistill`
    // tries `fs.writeFileSync(.gitignore, ...)` which fails with EISDIR —
    // the function returns `{ error: ... }`.
    //
    // The previous (buggy) implementation set `autoDistillSuppressed = true`
    // inside the setup-failure branch but then OVERWROTE that flag ~40
    // lines later with `readPersistedSuppressed(...)`, which returns `false`
    // for a fresh session. Net effect: a vault-level failure didn't
    // actually suppress anything. This test pins the fixed ordering.
    vault = createVault({ enabled: true });
    // Remove the .gitignore file that createVault's git init+commit added,
    // and replace it with a directory to force mergeLines to fail.
    const giPath = path.join(vault, ".gitignore");
    if (fs.existsSync(giPath)) fs.rmSync(giPath, { force: true });
    fs.mkdirSync(giPath, { recursive: true });

    sm = createSession(vault);
    const worktrees = await runLifecycle(vault, sm, "quit");

    // Setup failed — shutdown distill must NOT have spawned. The
    // suppression is the user-visible fail-safe.
    expect(worktrees).toBe(0);
  });

  test("sets lastSpawnedSize so a re-entry of shutdown on same content is a no-op", async () => {
    vault = createVault({ enabled: true });
    sm = createSession(vault);
    const { api, captured } = makeMockAPI();
    distillExtension(api as never);
    // biome-ignore lint/suspicious/noExplicitAny: partial ctx
    const ctx: any = {
      cwd: vault,
      sessionManager: sm,
      hasUI: false,
      ui: null,
    };
    await captured.handlers.session_start({ reason: "new" }, ctx);
    await captured.handlers.session_shutdown({ reason: "quit" }, ctx);
    const first = countWorktrees(vault);
    expect(first).toBe(1);

    // Re-register & run again without adding new content. The new closure has
    // a fresh lastSpawnedSize=0, so it WILL spawn \u2014 this just confirms that
    // the same-closure re-entry won't (which is what the `lastSpawnedSize =\n    // currentSize` line after a successful spawn guarantees within one run).
    //
    // To truly assert same-closure dedup we'd need to call session_shutdown
    // twice in the same closure, but pi only fires it once per session. The
    // behavior is already unit-tested via shouldDistillOnShutdown; here we
    // just confirm the successful-spawn path writes lastSpawnedSize.
    await captured.handlers.session_shutdown({ reason: "quit" }, ctx);
    const second = countWorktrees(vault);
    // Second call in same closure should NOT create a new worktree \u2014
    // currentSize matches lastSpawnedSize from the first call. The first
    // worktree is still on disk until the detached wrapper's trap runs.
    expect(second).toBe(first);
  });
});

/**
 * G5 — interval-fires-shortly-before-shutdown race. The scenario:
 *
 *   1. Auto-distill interval ticks. `runAutoDistill` spawns worktree A and
 *      captures `lastSpawnedSize = S1`.
 *   2. User continues typing for a second or two; session grows to S2 > S1.
 *   3. User quits. `session_shutdown` fires.
 *
 * Expected: the shutdown handler spawns a SECOND worktree B to capture the
 * (S1 → S2) delta. Worktree-queueing + the per-distill `startSha` isolates
 * the two, so concurrent merges don't clobber each other.
 *
 * Contrast: if nothing happened between the interval tick and the quit
 * (S2 === S1), the shutdown handler must NOT spawn a duplicate of A.
 *
 * These tests drive the scenario end-to-end by capturing the registered
 * auto-distill interval callback (via a setInterval stub) and firing it
 * manually, so we exercise the REAL `runAutoDistill` → `lastSpawnedSize =
 * currentSize` wiring rather than relying on the predicate-level test in
 * should-distill-on-shutdown.test.ts (guard 8).
 */
describe("session_shutdown handler — interval-fires-before-shutdown race (G5)", () => {
  let vault: string;
  let originalSetInterval: typeof setInterval;
  let xdgCacheDir: string;

  const _savedRecurse = process.env.NAPKIN_DISTILL_NO_RECURSE;
  const _savedXdgCache = process.env.XDG_CACHE_HOME;
  const _savedGitEnv = {
    authorName: process.env.GIT_AUTHOR_NAME,
    authorEmail: process.env.GIT_AUTHOR_EMAIL,
    committerName: process.env.GIT_COMMITTER_NAME,
    committerEmail: process.env.GIT_COMMITTER_EMAIL,
  };

  /**
   * Captured intervals registered during session_start / runDistillWith.
   * The auto-distill tick is the one with `ms === intervalMinutes*60_000`;
   * poll-loop intervals (runDistillWith's pollHandle, 500 ms) land here too
   * but we don't drive them — we only need to simulate the auto tick.
   */
  let capturedIntervals: Array<{ cb: () => void; ms: number }> = [];

  // POST-R6-CACHE: shim install needs napkin on PATH. Shared helper
  // handles the augment + restore cycle. (R7-SC-5/6/13/CI-3/CC-2.)
  let _napkinPath: { restore: () => void } | null = null;

  beforeEach(() => {
    delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    xdgCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "g5-xdg-"));
    process.env.XDG_CACHE_HOME = xdgCacheDir;
    process.env.GIT_AUTHOR_NAME = "Napkin CI";
    process.env.GIT_AUTHOR_EMAIL = "ci@napkin.test";
    process.env.GIT_COMMITTER_NAME = "Napkin CI";
    process.env.GIT_COMMITTER_EMAIL = "ci@napkin.test";
    _napkinPath = withNapkinOnPath();

    capturedIntervals = [];
    originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((
      cb: () => void,
      ms: number,
      ..._rest: unknown[]
    ) => {
      capturedIntervals.push({ cb, ms });
      return {
        unref: () => {},
        ref: () => {},
      } as unknown as NodeJS.Timeout;
    }) as typeof setInterval;
  });

  afterEach(() => {
    if (_savedRecurse !== undefined)
      process.env.NAPKIN_DISTILL_NO_RECURSE = _savedRecurse;
    else delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    // Restore PATH (POST-R6-CACHE).
    _napkinPath?.restore();
    _napkinPath = null;
    for (const [key, val] of [
      ["GIT_AUTHOR_NAME", _savedGitEnv.authorName],
      ["GIT_AUTHOR_EMAIL", _savedGitEnv.authorEmail],
      ["GIT_COMMITTER_NAME", _savedGitEnv.committerName],
      ["GIT_COMMITTER_EMAIL", _savedGitEnv.committerEmail],
    ] as const) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    globalThis.setInterval = originalSetInterval;
    if (vault) {
      cleanupWorktrees(vault);
      fs.rmSync(vault, { recursive: true, force: true });
    }
    if (xdgCacheDir) fs.rmSync(xdgCacheDir, { recursive: true, force: true });
    if (_savedXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = _savedXdgCache;
  });

  test("interval fires at S1, content grows to S2>S1, shutdown spawns delta worktree", async () => {
    vault = createVault({ enabled: true, intervalMinutes: 1 });
    const sm = SessionManager.create(vault, vault);
    // Seed session so the file exists + size > 0 by the time the interval
    // callback runs.
    sm.appendMessage({ role: "user", content: "hello" });
    sm.appendMessage({ role: "assistant", content: "hi" });

    const { api, captured } = makeMockAPI();
    distillExtension(api as never);
    // biome-ignore lint/suspicious/noExplicitAny: partial ctx
    const ctx: any = {
      cwd: vault,
      sessionManager: sm,
      hasUI: false,
      ui: null,
    };
    await captured.handlers.session_start({ reason: "new" }, ctx);

    // Locate the auto-distill interval. intervalMinutes=1 → ms=60_000.
    const autoInterval = capturedIntervals.find((i) => i.ms === 60_000);
    expect(autoInterval).toBeDefined();

    // Fire it: `runAutoDistill` spawns worktree A and records
    // `lastSpawnedSize = <sessionFile size at this tick>`.
    // biome-ignore lint/style/noNonNullAssertion: verified above
    autoInterval!.cb();
    const afterInterval = countWorktrees(vault);
    expect(afterInterval).toBe(1);

    // Grow the session between the interval tick and the quit. Must grow
    // the file size (which is what the handler reads via fs.statSync),
    // so we append real messages rather than mutating in memory.
    sm.appendMessage({
      role: "user",
      content: "more content typed after tick",
    });
    sm.appendMessage({
      role: "assistant",
      content: "response that pushes the file size past the interval mark",
    });

    // Shutdown. currentSize (S2) > lastSpawnedSize (S1) → guard 8 passes,
    // the handler spawns worktree B to capture the (S1 → S2) delta.
    await captured.handlers.session_shutdown({ reason: "quit" }, ctx);
    expect(countWorktrees(vault)).toBe(2);
  });

  test("interval fires at S1, no new content, shutdown does NOT spawn duplicate", async () => {
    vault = createVault({ enabled: true, intervalMinutes: 1 });
    const sm = SessionManager.create(vault, vault);
    sm.appendMessage({ role: "user", content: "hello" });
    sm.appendMessage({ role: "assistant", content: "hi" });

    const { api, captured } = makeMockAPI();
    distillExtension(api as never);
    // biome-ignore lint/suspicious/noExplicitAny: partial ctx
    const ctx: any = {
      cwd: vault,
      sessionManager: sm,
      hasUI: false,
      ui: null,
    };
    await captured.handlers.session_start({ reason: "new" }, ctx);

    const autoInterval = capturedIntervals.find((i) => i.ms === 60_000);
    expect(autoInterval).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: verified above
    autoInterval!.cb();
    expect(countWorktrees(vault)).toBe(1);

    // No new content between interval and quit → currentSize ===
    // lastSpawnedSize, guard 8 trips, shutdown is a no-op.
    await captured.handlers.session_shutdown({ reason: "quit" }, ctx);
    expect(countWorktrees(vault)).toBe(1);
  });
});

/**
 * Legacy-embedded-layout refusal at session_start. Mirrors the
 * conflicting-.gitattributes suite: a vault-level reason to refuse
 * auto-distill must suppress the shutdown spawn, emit a migration
 * notify, and leave the user's files untouched.
 *
 * Legacy embedded = napkin resolves `contentPath === configPath ===
 * <vault>/.napkin/`. The branch for a distill worktree can't track a
 * `.napkin/config.json` the way it does for subdir-layout vaults, so
 * distill writes would bypass the worktree entirely.
 */
describe("session_start handler \u2014 legacy-embedded layout blocks setup", () => {
  let vault: string;
  let xdgCacheDir: string;
  let originalSetInterval: typeof setInterval;

  const _savedRecurse = process.env.NAPKIN_DISTILL_NO_RECURSE;
  const _savedXdgCache = process.env.XDG_CACHE_HOME;

  beforeEach(() => {
    delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    xdgCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-xdg-"));
    process.env.XDG_CACHE_HOME = xdgCacheDir;
    originalSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((
      _cb: () => void,
      _ms: number,
      ..._rest: unknown[]
    ) =>
      ({
        unref: () => {},
        ref: () => {},
      }) as unknown as NodeJS.Timeout) as typeof setInterval;
  });

  afterEach(() => {
    if (_savedRecurse !== undefined)
      process.env.NAPKIN_DISTILL_NO_RECURSE = _savedRecurse;
    else delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    globalThis.setInterval = originalSetInterval;
    if (vault) {
      cleanupWorktrees(vault);
      fs.rmSync(vault, { recursive: true, force: true });
    }
    if (xdgCacheDir) fs.rmSync(xdgCacheDir, { recursive: true, force: true });
    if (_savedXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = _savedXdgCache;
  });

  test("legacy vault: session_start fires migration notify, no worktree on shutdown", async () => {
    vault = createLegacyVault();
    // napkin resolves cwd=<vault>/.napkin because that's where .napkin is.
    // For legacy, contentPath === configPath === <vault>/.napkin.
    // We launch pi from <vault>/.napkin so findVault lands on it directly.
    const cwd = path.join(vault, ".napkin");
    const sm = SessionManager.create(cwd, cwd);
    sm.appendMessage({ role: "user", content: "hello" });
    sm.appendMessage({ role: "assistant", content: "hi" });

    const { ui, notifies } = makeCaptureUI();
    const { api, captured } = makeMockAPI();
    distillExtension(api as never);
    // biome-ignore lint/suspicious/noExplicitAny: partial ctx
    const ctx: any = {
      cwd,
      sessionManager: sm,
      hasUI: true,
      ui,
    };
    await captured.handlers.session_start({ reason: "new" }, ctx);
    await captured.handlers.session_shutdown({ reason: "quit" }, ctx);

    // Migration notify should have fired with the one-line README pointer
    // (Option C trim: we no longer reproduce mkdir/mv/edit steps in the
    // notify itself — those live in README).
    const migrationNotify = notifies.find((n) =>
      n.message.includes("subdir vault layout"),
    );
    expect(migrationNotify).toBeDefined();
    expect(migrationNotify?.level).toBe("error");
    expect(migrationNotify?.message).toMatch(/See README/i);
    expect(migrationNotify?.message).toMatch(/distill\.enabled: false/);

    // And no worktree spawned on shutdown. setupFailed must override the
    // persisted (false) suppression state.
    expect(countWorktrees(vault)).toBe(0);
  });

  test("subdir-layout vault: normal path still works (regression check)", async () => {
    // Sanity contrast: a subdir-layout vault with distill.enabled=true must
    // still complete auto-setup and spawn on shutdown. If the legacy check
    // ever fires on subdir layouts it would silently kill auto-distill.
    vault = createVault({ enabled: true });
    const sm = createSession(vault);

    const { ui, notifies } = makeCaptureUI();
    const { api, captured } = makeMockAPI();
    distillExtension(api as never);
    // biome-ignore lint/suspicious/noExplicitAny: partial ctx
    const ctx: any = {
      cwd: vault,
      sessionManager: sm,
      hasUI: true,
      ui,
    };
    await captured.handlers.session_start({ reason: "new" }, ctx);
    await captured.handlers.session_shutdown({ reason: "quit" }, ctx);

    // No legacy-layout notify on a subdir vault.
    const migrationNotify = notifies.find((n) =>
      n.message.includes("legacy embedded layout"),
    );
    expect(migrationNotify).toBeUndefined();

    // Shutdown spawned a worktree normally.
    expect(countWorktrees(vault)).toBe(1);
  });
});
