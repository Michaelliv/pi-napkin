/**
 * G8 — exercise the pollHandle timeout branch in `runDistillWith`.
 *
 * Background. When auto-distill spawns a worktree, we start a 2-second
 * poll loop (`pollHandle = setInterval(...)`) that watches for the
 * detached wrapper to clean up its worktree. If the wrapper takes longer
 * than `getMaxDistillDurationMs()` (10 minutes in prod), we abandon it:
 * clear the timer, call the strategy's `cleanup`, reset `isRunning`,
 * and paint a "timed out" status. Before this test, that branch was
 * unreached by the suite — a production regression would go unseen until
 * a real 10-minute hang, which is exactly the kind of tail event we care
 * about.
 *
 * Approach. We wire `distill.maxDurationMinutes` in the vault's
 * `.napkin/config.json` (production reads this via
 * `getMaxDistillDurationMs(config)`) to shrink the timeout to a few
 * milliseconds, capture the pollHandle callback via a `setInterval`
 * stub, then fire it twice: once to observe a still-in-flight state,
 * then once past the shrunk timeout boundary to trip the timeout
 * branch.
 *
 * Because the detached wrapper is real, the worktree directory exists
 * on disk between spawn and wrapper-cleanup. We bypass that by letting
 * the strategy's cleanup function remove the target synchronously so
 * `fs.existsSync(target)` returns false on the timeout poll tick — the
 * actual production path also calls cleanup on timeout, so the timing
 * is representative.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveCacheRoot } from "./distill-workspace";
import distillExtension from "./index";

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

/** Mirror `createVault` from shutdown-handler.test.ts (distill config, git). */
function createVault(
  intervalMinutes: number,
  maxDurationMinutes?: number,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g8-vault-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@e",
    GIT_COMMITTER_NAME: "t",
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
  // biome-ignore lint/suspicious/noExplicitAny: dynamic config
  const distill: Record<string, any> = {
    enabled: true,
    onShutdown: true,
    intervalMinutes,
  };
  if (maxDurationMinutes !== undefined) {
    distill.maxDurationMinutes = maxDurationMinutes;
  }
  fs.writeFileSync(
    path.join(dir, ".napkin", "config.json"),
    JSON.stringify({
      // Sibling-layout declaration so napkin resolves contentPath=<dir>
      // (where `.git` and notes live).
      vault: { root: ".." },
      distill,
    }),
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "seed"]);
  return dir;
}

function countWorktrees(vault: string): number {
  const d = resolveCacheRoot(vault);
  if (!fs.existsSync(d)) return 0;
  return fs.readdirSync(d).length;
}

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

describe("runDistillWith pollHandle timeout (G8)", () => {
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
   * Every `setInterval(cb, ms)` call made during extension registration +
   * session_start + runAutoDistill lands here. The auto-distill tick has
   * `ms === intervalMinutes*60_000`, the pollHandle has `ms === 2000`.
   */
  let capturedIntervals: Array<{ cb: () => void; ms: number }> = [];

  beforeEach(() => {
    delete process.env.NAPKIN_DISTILL_NO_RECURSE;
    xdgCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "poll-xdg-"));
    process.env.XDG_CACHE_HOME = xdgCacheDir;
    process.env.GIT_AUTHOR_NAME = "Napkin CI";
    process.env.GIT_AUTHOR_EMAIL = "ci@napkin.test";
    process.env.GIT_COMMITTER_NAME = "Napkin CI";
    process.env.GIT_COMMITTER_EMAIL = "ci@napkin.test";
    // Make the spawned wrapper halt right after the meta.json pid
    // rewrite (clears the EXIT trap, exits 0). This keeps the worktree
    // directory on disk — exactly what the timeout branch needs to
    // exercise: the JS-side `pollInterval` sees `target` (the worktree)
    // still present until the timeout fires, then `spawnCleanup`
    // removes it. Without HALT_AFTER_META the real wrapper would race
    // with the test's clock (e.g. the POST-R6-CACHE `napkin --version`
    // smoke test alone is ~155ms vs the test's 100ms timeout window),
    // leading to a half-cleaned worktree the next auto-tick can't
    // overwrite cleanly.
    process.env.NAPKIN_DISTILL_HALT_AFTER_META = "1";

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
    delete process.env.NAPKIN_DISTILL_HALT_AFTER_META;
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

  test("timeout branch: removes worktree, resets isRunning, allows next distill", async () => {
    // Shrink the production 10-minute cap to ~100 ms (1/600 of a minute)
    // via the vault config so we can tick past it without real-time
    // delay. Production reads this via `getMaxDistillDurationMs(config)`.
    vault = createVault(
      /* intervalMinutes */ 1,
      /* maxDurationMinutes */ 100 / 60_000,
    );
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

    // Fire the auto-distill tick → spawns worktree A + registers pollHandle.
    const autoInterval = capturedIntervals.find((i) => i.ms === 60_000);
    expect(autoInterval).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: verified above
    autoInterval!.cb();
    expect(countWorktrees(vault)).toBe(1);

    // The 2-second poll loop starts immediately after spawn. It's the
    // LAST captured interval with ms === 2000.
    const pollInterval = [...capturedIntervals]
      .reverse()
      .find((i) => i.ms === 2000);
    expect(pollInterval).toBeDefined();

    // Tick #1: target still exists, no timeout yet — poll callback paints
    // status and returns (observable via the elapsed-seconds math not
    // throwing).
    // biome-ignore lint/style/noNonNullAssertion: verified above
    pollInterval!.cb();

    // Wait out the 100 ms override so the next poll tick sees
    // Date.now() - startTime > getMaxDistillDurationMs().
    await new Promise((r) => setTimeout(r, 150));

    // Tick #2: timeout branch fires. `spawnCleanup` runs and tears down
    // the worktree, isRunning flips back to false.
    // biome-ignore lint/style/noNonNullAssertion: verified above
    pollInterval!.cb();

    // Cleanup ran → the XDG cache worktree dir is empty (or gone). The
    // production path calls `cleanupDistillWorkspace` which removes the
    // worktree via `git worktree remove --force`.
    expect(countWorktrees(vault)).toBe(0);

    // After timeout, isRunning should be reset so a subsequent auto-tick
    // can spawn a fresh distill. Fire the auto-interval again and assert
    // a NEW worktree appears.
    // biome-ignore lint/style/noNonNullAssertion: verified above
    autoInterval!.cb();
    expect(countWorktrees(vault)).toBe(1);
  });

  test("no config → production default is 10 minutes", async () => {
    // Sanity check: `config.maxDurationMinutes` is the only knob. With
    // it unset (or absent from DistillConfig), the function returns the
    // production value.
    const { getMaxDistillDurationMs, DEFAULT_DISTILL } = await import(
      "./index"
    );
    expect(getMaxDistillDurationMs()).toBe(10 * 60 * 1000);
    expect(getMaxDistillDurationMs(DEFAULT_DISTILL)).toBe(10 * 60 * 1000);
  });

  test("non-numeric / undefined maxDurationMinutes → falls back to default", async () => {
    const { getMaxDistillDurationMs, DEFAULT_DISTILL } = await import(
      "./index"
    );
    expect(
      getMaxDistillDurationMs({
        ...DEFAULT_DISTILL,
        maxDurationMinutes: Number.NaN,
      }),
    ).toBe(10 * 60 * 1000);
    expect(
      getMaxDistillDurationMs({
        ...DEFAULT_DISTILL,
        maxDurationMinutes: Number.POSITIVE_INFINITY,
      }),
    ).toBe(10 * 60 * 1000);
    expect(
      getMaxDistillDurationMs({
        ...DEFAULT_DISTILL,
        maxDurationMinutes: undefined,
      }),
    ).toBe(10 * 60 * 1000);
  });

  test("zero / negative maxDurationMinutes → falls back to default (prevents instant timeout)", async () => {
    const { getMaxDistillDurationMs, DEFAULT_DISTILL } = await import(
      "./index"
    );
    expect(
      getMaxDistillDurationMs({ ...DEFAULT_DISTILL, maxDurationMinutes: 0 }),
    ).toBe(10 * 60 * 1000);
    expect(
      getMaxDistillDurationMs({
        ...DEFAULT_DISTILL,
        maxDurationMinutes: -100,
      }),
    ).toBe(10 * 60 * 1000);
  });

  test("positive finite maxDurationMinutes → returns ms equivalent", async () => {
    const { getMaxDistillDurationMs, DEFAULT_DISTILL } = await import(
      "./index"
    );
    expect(
      getMaxDistillDurationMs({ ...DEFAULT_DISTILL, maxDurationMinutes: 5 }),
    ).toBe(5 * 60 * 1000);
    // Sub-minute value (tests use tiny fractions to exercise timeout).
    expect(
      getMaxDistillDurationMs({
        ...DEFAULT_DISTILL,
        maxDurationMinutes: 100 / 60_000,
      }),
    ).toBeCloseTo(100, 0);
  });
});
