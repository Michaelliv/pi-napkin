import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  cleanupDistillWorkspace,
  cleanupStaleWorktrees,
  createDistillWorkspace,
  createDistillWorktree,
  DISTILL_SUBDIR,
  DistillError,
  type DistillMeta,
  diffWorktreeSinceStart,
  generateDistillBranchName,
  getActiveDistills,
  getDistillState,
  getUnmergedDistillBranches,
  parseWorktreeList,
  readDistillMeta,
  removeDistillWorktree,
  resolveCacheRoot,
  STALE_META_AGE_MS,
  STALE_WORKTREE_MINUTES,
} from "./distill-workspace";

/**
 * Minimal real session file to feed SessionManager.forkFrom. The fork API
 * rejects empty session files; SessionManager only flushes to disk once an
 * assistant message is present (see `_persist` in pi's session-manager.js).
 * We seed with a user/assistant round-trip so the file is on disk and valid.
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

/**
 * Initialize a throwaway git repo with one commit so HEAD resolves. Returns
 * the absolute vault path.
 */
function createGitVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-git-vault-"));
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
  fs.writeFileSync(path.join(dir, "seed.md"), "# seed\n");
  run(["add", "seed.md"]);
  run(["commit", "-q", "-m", "seed"]);
  return dir;
}

describe("generateDistillBranchName", () => {
  test("format: distill/<hex6>-<epoch>", () => {
    const name = generateDistillBranchName(new Date(1_000_000_000 * 1000));
    expect(name).toMatch(/^distill\/[0-9a-f]{6}-1000000000$/);
  });

  test("accepts explicit nonce for deterministic testing", () => {
    const name = generateDistillBranchName(
      new Date(1_700_000_000 * 1000),
      "deadbe",
    );
    expect(name).toBe("distill/deadbe-1700000000");
  });

  test("two calls in the same second differ (random nonce)", () => {
    const now = new Date();
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(generateDistillBranchName(now));
    }
    // Collision with 24 bits of entropy in 50 draws is <1 in 700M \u2014 flake-proof.
    expect(seen.size).toBe(50);
  });
});

describe("resolveCacheRoot (XDG cache placement)", () => {
  // Guard the XDG_CACHE_HOME env var so tests don't leak mutations across
  // the suite (other tests rely on the host's default cache behaviour).
  let savedXdg: string | undefined;
  beforeEach(() => {
    savedXdg = process.env.XDG_CACHE_HOME;
  });
  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = savedXdg;
  });

  test("respects $XDG_CACHE_HOME when set", () => {
    const fakeCache = fs.mkdtempSync(path.join(os.tmpdir(), "xdg-cache-"));
    try {
      process.env.XDG_CACHE_HOME = fakeCache;
      const root = resolveCacheRoot("/some/vault");
      expect(
        root.startsWith(`${fakeCache}${path.sep}napkin-distill${path.sep}`),
      ).toBe(true);
    } finally {
      fs.rmSync(fakeCache, { recursive: true, force: true });
    }
  });

  test("falls back to $HOME/.cache when XDG_CACHE_HOME is unset", () => {
    delete process.env.XDG_CACHE_HOME;
    const root = resolveCacheRoot("/some/vault");
    const expectedPrefix = path.join(os.homedir(), ".cache", "napkin-distill");
    expect(root.startsWith(`${expectedPrefix}${path.sep}`)).toBe(true);
  });

  test("empty XDG_CACHE_HOME is treated as unset (falsy) \u2014 falls back to ~/.cache", () => {
    // `process.env.XDG_CACHE_HOME || path.join(...)` treats `""` as falsy.
    // Pinned so a future refactor doesn't change the guard to `!==
    // undefined` and silently plant worktrees in the current directory.
    process.env.XDG_CACHE_HOME = "";
    const root = resolveCacheRoot("/some/vault");
    const expectedPrefix = path.join(os.homedir(), ".cache", "napkin-distill");
    expect(root.startsWith(`${expectedPrefix}${path.sep}`)).toBe(true);
  });

  test("vault-hash is stable per contentPath (same input \u2192 same hash)", () => {
    process.env.XDG_CACHE_HOME = "/tmp/xdg";
    const a = resolveCacheRoot("/home/user/my-vault");
    const b = resolveCacheRoot("/home/user/my-vault");
    expect(a).toBe(b);
  });

  test("vault-hash differs across distinct contentPaths (collision-resistant)", () => {
    process.env.XDG_CACHE_HOME = "/tmp/xdg";
    const a = resolveCacheRoot("/home/user/vault-a");
    const b = resolveCacheRoot("/home/user/vault-b");
    expect(a).not.toBe(b);
  });

  test("vault-hash is 16 hex chars", () => {
    process.env.XDG_CACHE_HOME = "/tmp/xdg";
    const root = resolveCacheRoot("/home/user/my-vault");
    const hash = path.basename(root);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("layout is $cacheHome/napkin-distill/<hash>", () => {
    process.env.XDG_CACHE_HOME = "/tmp/xdg";
    const root = resolveCacheRoot("/home/user/vault");
    expect(path.dirname(root)).toBe(path.join("/tmp/xdg", "napkin-distill"));
  });

  test("symlinked vault path hashes the same as its realpath (R4-L-1)", () => {
    // Symlinked content paths (e.g. `~/workplace` → `/workplace/pcad` on
    // Amazon cloud desktops) must resolve to the same cache dir as the
    // underlying realpath so a single vault doesn't end up with two
    // parallel worktree trees depending on which path the caller happened
    // to pass.
    process.env.XDG_CACHE_HOME = "/tmp/xdg";
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "realpath-target-"));
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "realpath-link-"));
    try {
      const target = path.join(realDir, "vault");
      fs.mkdirSync(target);
      const symlink = path.join(linkDir, "vault-link");
      fs.symlinkSync(target, symlink);

      const viaReal = resolveCacheRoot(target);
      const viaLink = resolveCacheRoot(symlink);
      expect(viaLink).toBe(viaReal);
    } finally {
      fs.rmSync(realDir, { recursive: true, force: true });
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
  });

  test("broken symlink falls back to the raw path (R4-L-1)", () => {
    // Readable guarantee: realpath failure must NOT throw out of
    // `resolveCacheRoot` — it's called from status / spawn paths that
    // have to stay reliable even on weird filesystems.
    process.env.XDG_CACHE_HOME = "/tmp/xdg";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "broken-link-"));
    try {
      const symlink = path.join(dir, "dangling");
      fs.symlinkSync(path.join(dir, "does-not-exist"), symlink);

      // Should not throw; should produce the same hash as passing the raw
      // symlink path (fallback branch).
      const root = resolveCacheRoot(symlink);
      expect(root.startsWith(path.join("/tmp/xdg", "napkin-distill"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createDistillWorktree", () => {
  let vault: string;

  beforeEach(() => {
    vault = createGitVault();
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("creates a git worktree on a fresh branch rooted at HEAD", () => {
    const branch = generateDistillBranchName();
    const wt = path.join(vault, "test-worktrees", "wt1");
    createDistillWorktree(vault, branch, wt);

    // Seed file from parent commit is present in the worktree.
    expect(fs.existsSync(path.join(wt, "seed.md"))).toBe(true);
    // And git knows about the branch.
    const list = spawnSync(
      "git",
      ["-C", vault, "worktree", "list", "--porcelain"],
      { encoding: "utf-8" },
    ).stdout;
    expect(list).toContain(branch);

    removeDistillWorktree(vault, wt, branch);
  });

  test("throws DistillError if vault has no .git", () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"));
    try {
      expect(() =>
        createDistillWorktree(noGit, "distill/aa-1", path.join(noGit, "wt")),
      ).toThrow(DistillError);
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });

  test("FB-2: throws DistillError with helpful message if vault repo has no commits (HEAD unresolvable)", () => {
    // Pre-FB-2 `git worktree add ... HEAD` would bubble up the raw
    // 'fatal: invalid reference: HEAD' (exit 128) as a generic
    // DistillError message. Now we pre-validate and throw a targeted
    // message the shutdown handler / interval handler logs instead.
    const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), "empty-repo-"));
    try {
      // git init but NO commit — HEAD points at refs/heads/main but
      // refs/heads/main does not exist.
      spawnSync("git", ["-C", emptyRepo, "init", "-q", "-b", "main"], {
        encoding: "utf-8",
      });
      expect(() =>
        createDistillWorktree(
          emptyRepo,
          "distill/fb2-1",
          path.join(emptyRepo, "wt"),
        ),
      ).toThrow(DistillError);
      // Confirm the message is the FB-2 diagnostic, not the raw git exit.
      try {
        createDistillWorktree(
          emptyRepo,
          "distill/fb2-2",
          path.join(emptyRepo, "wt2"),
        );
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(DistillError);
        expect((err as Error).message).toMatch(/no commits yet/);
        expect((err as Error).message).toMatch(/HEAD unresolvable/);
      }
    } finally {
      fs.rmSync(emptyRepo, { recursive: true, force: true });
    }
  });

  test("throws DistillError if branch name already taken", () => {
    const branch = generateDistillBranchName();
    const wt1 = path.join(vault, "test-worktrees", "wt1");
    createDistillWorktree(vault, branch, wt1);
    try {
      const wt2 = path.join(vault, "test-worktrees", "wt2");
      expect(() => createDistillWorktree(vault, branch, wt2)).toThrow(
        DistillError,
      );
    } finally {
      removeDistillWorktree(vault, wt1, branch);
    }
  });
});

describe("removeDistillWorktree", () => {
  let vault: string;

  beforeEach(() => {
    vault = createGitVault();
  });

  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("removes worktree + branch", () => {
    const branch = generateDistillBranchName();
    const wt = path.join(vault, "test-worktrees", "wt");
    createDistillWorktree(vault, branch, wt);
    expect(fs.existsSync(wt)).toBe(true);

    removeDistillWorktree(vault, wt, branch);

    expect(fs.existsSync(wt)).toBe(false);
    const branches = spawnSync("git", ["-C", vault, "branch"], {
      encoding: "utf-8",
    }).stdout;
    expect(branches).not.toContain(branch);
  });

  test("is idempotent on missing paths / branches", () => {
    expect(() =>
      removeDistillWorktree(vault, "/tmp/does-not-exist", "distill/zz-1"),
    ).not.toThrow();
  });

  test("no-ops cleanly if vault is gone", () => {
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), "gone-"));
    fs.rmSync(gone, { recursive: true, force: true });
    expect(() =>
      removeDistillWorktree(gone, "/tmp/wt", "distill/zz-1"),
    ).not.toThrow();
  });

  // POST-CONV-4: rmdir parent vault-hash dir after last leaf removed.
  test("keeps parent dir when other distills exist; rmdirs it on last leaf", () => {
    const parent = path.join(vault, "test-worktrees");
    const branch1 = generateDistillBranchName();
    const branch2 = generateDistillBranchName();
    // Branch names are time-seeded; ensure they differ.
    expect(branch1).not.toBe(branch2);
    const wt1 = path.join(parent, "wt-1");
    const wt2 = path.join(parent, "wt-2");
    createDistillWorktree(vault, branch1, wt1);
    createDistillWorktree(vault, branch2, wt2);
    expect(fs.existsSync(parent)).toBe(true);

    // Removing the first leaf must NOT rmdir the parent — wt2 still lives.
    removeDistillWorktree(vault, wt1, branch1);
    expect(fs.existsSync(wt1)).toBe(false);
    expect(fs.existsSync(parent)).toBe(true);

    // Removing the last leaf rmdirs the now-empty parent.
    removeDistillWorktree(vault, wt2, branch2);
    expect(fs.existsSync(wt2)).toBe(false);
    expect(fs.existsSync(parent)).toBe(false);
  });
});

describe("createDistillWorkspace", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;
  const workspaces: { worktreePath: string; branchName: string }[] = [];

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "distill-workspace-test-src-"),
    );
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    for (const w of workspaces) {
      cleanupDistillWorkspace(vault, w);
    }
    workspaces.length = 0;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  function track<T extends { worktreePath: string; branchName: string }>(
    w: T,
  ): T {
    workspaces.push({ worktreePath: w.worktreePath, branchName: w.branchName });
    return w;
  }

  test("creates <wt>/.napkin/distill/ with session.jsonl and meta.json", () => {
    const w = track(createDistillWorkspace(vault, sourceSession, sessionDir));

    expect(fs.existsSync(w.worktreePath)).toBe(true);
    expect(fs.existsSync(w.sessionForkPath)).toBe(true);
    expect(fs.existsSync(w.metaPath)).toBe(true);

    // The distill subdir layout is stable.
    const distillDir = path.join(w.worktreePath, DISTILL_SUBDIR);
    expect(path.dirname(w.sessionForkPath)).toBe(distillDir);
    expect(path.dirname(w.metaPath)).toBe(distillDir);
    expect(path.basename(w.sessionForkPath)).toBe("session.jsonl");
    expect(path.basename(w.metaPath)).toBe("meta.json");
  });

  test("worktree lives under XDG cache / napkin-distill / vault-hash, not inside vault", () => {
    // Worktrees must be placed OUTSIDE the vault (see `resolveCacheRoot`
    // docstring) to avoid cloud-sync pollution, plugin re-indexing, and
    // autocommit-cron noise. We pin the expected layout here.
    const w = track(createDistillWorkspace(vault, sourceSession, sessionDir));
    const expectedPrefix = resolveCacheRoot(vault);
    expect(w.worktreePath.startsWith(expectedPrefix + path.sep)).toBe(true);
    // Belt-and-braces: confirm the worktree is NOT nested inside the vault.
    expect(w.worktreePath.startsWith(vault + path.sep)).toBe(false);
  });

  test("meta.json has all DistillMeta fields", () => {
    const w = track(createDistillWorkspace(vault, sourceSession, sessionDir));
    const meta = JSON.parse(
      fs.readFileSync(w.metaPath, "utf-8"),
    ) as DistillMeta;

    expect(meta.pid).toBe(process.pid);
    expect(meta.vault).toBe(vault);
    expect(meta.branch).toBe(w.branchName);
    expect(meta.parentSession).toBe(sourceSession);

    const parsed = new Date(meta.startedAt);
    expect(parsed.toISOString()).toBe(meta.startedAt);
    expect(Date.now() - parsed.getTime()).toBeLessThan(5000);
  });

  test("branch name matches distill/<hex>-<epoch> shape", () => {
    const w = track(createDistillWorkspace(vault, sourceSession, sessionDir));
    expect(w.branchName).toMatch(/^distill\/[0-9a-f]{6}-\d{10}$/);
  });

  test("POST-R6-CACHE: fork header cwd is parentCwd, not worktreePath", () => {
    // Cache parity: pi rebuilds the system prompt with `Current working
    // directory: <header.cwd>`. If the distill's fork header carries the
    // worktree path, the system prompt diverges from the parent's and
    // every conversation message gets re-encoded (cache miss for the
    // entire prefix). Forking with parentCwd keeps prefixes byte-identical
    // so Anthropic-style prompt caching hits across the parent→distill
    // boundary.
    const parentCwd = sessionDir;
    const w = track(createDistillWorkspace(vault, sourceSession, parentCwd));
    const firstLine = fs
      .readFileSync(w.sessionForkPath, "utf-8")
      .split("\n")[0];
    const header = JSON.parse(firstLine) as { cwd: string };
    expect(header.cwd).toBe(parentCwd);
    expect(header.cwd).not.toBe(w.worktreePath);
  });

  test("two workspaces from the same session are independent", () => {
    const a = track(createDistillWorkspace(vault, sourceSession, sessionDir));
    const b = track(createDistillWorkspace(vault, sourceSession, sessionDir));

    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(a.branchName).not.toBe(b.branchName);
    expect(a.sessionForkPath).not.toBe(b.sessionForkPath);

    // Both worktrees and branches present in git.
    const list = spawnSync(
      "git",
      ["-C", vault, "worktree", "list", "--porcelain"],
      { encoding: "utf-8" },
    ).stdout;
    expect(list).toContain(a.branchName);
    expect(list).toContain(b.branchName);
  });

  test("throws DistillError if vault is not a git repo", () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-vault-"));
    try {
      expect(() =>
        createDistillWorkspace(noGit, sourceSession, sessionDir),
      ).toThrow(DistillError);
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });

  test("throws DistillError if parentCwd is relative (R7-SC-12)", () => {
    // POST-R6-CACHE: parentCwd is load-bearing for prompt-cache
    // parity. A relative path would silently fail at the wrapper's
    // `cd $PARENT_CWD || exit 1` step (UI-silent, error log only).
    // Validate up-front so the caller gets a clear DistillError.
    expect(() =>
      createDistillWorkspace(vault, sourceSession, "some/relative/path"),
    ).toThrow(DistillError);
    expect(() => createDistillWorkspace(vault, sourceSession, "")).toThrow(
      DistillError,
    );
  });

  test("throws DistillError if parentCwd does not exist (R7-SC-12)", () => {
    expect(() =>
      createDistillWorkspace(
        vault,
        sourceSession,
        "/tmp/does-not-exist-parent-cwd-test-12345",
      ),
    ).toThrow(DistillError);
  });

  test("throws if sourceSessionFile does not exist, cleaning up worktree", () => {
    const before = spawnSync("git", ["-C", vault, "branch"], {
      encoding: "utf-8",
    }).stdout;
    expect(() =>
      createDistillWorkspace(vault, "/tmp/does-not-exist.jsonl", sessionDir),
    ).toThrow();
    const after = spawnSync("git", ["-C", vault, "branch"], {
      encoding: "utf-8",
    }).stdout;
    // No distill branch left behind.
    expect(after.match(/distill\//g)).toBeNull();
    expect(before).toBe(after);
  });
});

describe("cleanupDistillWorkspace", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-ws-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("removes worktree tree and branch", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    expect(fs.existsSync(w.worktreePath)).toBe(true);

    cleanupDistillWorkspace(vault, w);

    expect(fs.existsSync(w.worktreePath)).toBe(false);
    const branches = spawnSync("git", ["-C", vault, "branch"], {
      encoding: "utf-8",
    }).stdout;
    expect(branches).not.toContain(w.branchName);
  });

  test("is idempotent (double-cleanup is safe)", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    cleanupDistillWorkspace(vault, w);
    expect(() => cleanupDistillWorkspace(vault, w)).not.toThrow();
  });
});

describe("readDistillMeta", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-meta-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("returns parsed meta for a real workspace", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    try {
      const meta = readDistillMeta(w.worktreePath);
      expect(meta).not.toBeNull();
      expect(meta?.branch).toBe(w.branchName);
      expect(meta?.vault).toBe(vault);
      expect(meta?.pid).toBe(process.pid);
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });

  test("returns null for missing path", () => {
    expect(readDistillMeta(`/tmp/nope-${Date.now()}`)).toBeNull();
  });

  test("returns null for workspace without meta.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-meta-test-"));
    try {
      fs.mkdirSync(path.join(dir, DISTILL_SUBDIR), { recursive: true });
      expect(readDistillMeta(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null for malformed meta.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bad-meta-test-"));
    try {
      fs.mkdirSync(path.join(dir, DISTILL_SUBDIR), { recursive: true });
      fs.writeFileSync(
        path.join(dir, DISTILL_SUBDIR, "meta.json"),
        "{ not valid json",
      );
      expect(readDistillMeta(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when required fields are missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "partial-meta-test-"));
    try {
      fs.mkdirSync(path.join(dir, DISTILL_SUBDIR), { recursive: true });
      fs.writeFileSync(
        path.join(dir, DISTILL_SUBDIR, "meta.json"),
        JSON.stringify({ pid: 123 }),
      );
      expect(readDistillMeta(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Pick a pid that is not currently alive. We scan downward from 999999 so
 * we don't flake on systems where pid_max is low. Signal 0 throws ESRCH
 * when the pid is dead.
 */
function findDeadPid(): number {
  for (let pid = 999_999; pid > 1000; pid -= 1) {
    try {
      process.kill(pid, 0);
      // alive — keep scanning
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ESRCH") return pid;
      // EPERM means it exists but we can't signal it — skip
    }
  }
  throw new Error("could not locate a dead pid in test range");
}

describe("parseWorktreeList", () => {
  test("parses main + branched worktree entries", () => {
    const input = [
      "worktree /tmp/vault",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /home/user/.cache/napkin-distill/abc1234567890def/aa-1",
      "HEAD def456",
      "branch refs/heads/distill/aa-1",
      "",
    ].join("\n");
    const parsed = parseWorktreeList(input);
    expect(parsed).toEqual([
      { path: "/tmp/vault", branch: "main" },
      {
        path: "/home/user/.cache/napkin-distill/abc1234567890def/aa-1",
        branch: "distill/aa-1",
      },
    ]);
  });

  test("skips detached-HEAD entries (no branch line)", () => {
    const input = [
      "worktree /tmp/detached",
      "HEAD abc123",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreeList(input)).toEqual([]);
  });

  test("handles trailing record without blank line", () => {
    const input = [
      "worktree /tmp/v",
      "HEAD a",
      "branch refs/heads/distill/x-1",
    ].join("\n");
    expect(parseWorktreeList(input)).toEqual([
      { path: "/tmp/v", branch: "distill/x-1" },
    ]);
  });
});

describe("cleanupStaleWorktrees", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-wt-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("no-op when vault has no .git (returns 0)", () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-vault-"));
    try {
      expect(cleanupStaleWorktrees({ contentPath: noGit })).toBe(0);
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });

  test("leaves a live worktree alone (pid = self)", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    // createDistillWorkspace already sets meta.pid to process.pid.
    try {
      const removed = cleanupStaleWorktrees({ contentPath: vault });
      expect(removed).toBe(0);
      expect(fs.existsSync(w.worktreePath)).toBe(true);
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });

  test("removes a worktree whose pid is dead", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    // Overwrite meta.json with a dead pid.
    const meta = readDistillMeta(w.worktreePath);
    if (!meta) throw new Error("meta expected");
    meta.pid = findDeadPid();
    fs.writeFileSync(w.metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    const removed = cleanupStaleWorktrees({ contentPath: vault });
    expect(removed).toBe(1);
    expect(fs.existsSync(w.worktreePath)).toBe(false);
    const branches = spawnSync("git", ["-C", vault, "branch"], {
      encoding: "utf-8",
    }).stdout;
    expect(branches).not.toContain(w.branchName);
  });

  test("removes a worktree whose meta.json is missing", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    fs.rmSync(w.metaPath);

    const removed = cleanupStaleWorktrees({ contentPath: vault });
    expect(removed).toBe(1);
    expect(fs.existsSync(w.worktreePath)).toBe(false);
  });

  test("removes a worktree whose meta.json mtime is beyond the stale threshold", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    // Backdate meta.json by ~2 hours.
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(w.metaPath, old, old);

    const removed = cleanupStaleWorktrees({ contentPath: vault });
    expect(removed).toBe(1);
    expect(fs.existsSync(w.worktreePath)).toBe(false);
  });

  test("ignores non-distill-branch worktrees", () => {
    // Create a sibling worktree on a branch NOT under `distill/`.
    const other = path.join(vault, "other-wt");
    const res = spawnSync(
      "git",
      ["-C", vault, "worktree", "add", "-b", "feature/xyz", other, "HEAD"],
      { encoding: "utf-8" },
    );
    if (res.status !== 0) {
      throw new Error(`worktree setup failed: ${res.stderr}`);
    }
    try {
      const removed = cleanupStaleWorktrees({ contentPath: vault });
      expect(removed).toBe(0);
      expect(fs.existsSync(other)).toBe(true);
    } finally {
      spawnSync("git", ["-C", vault, "worktree", "remove", "--force", other]);
      spawnSync("git", ["-C", vault, "branch", "-D", "feature/xyz"]);
    }
  });

  test("sweeps mixed state: live, dead-pid, missing-meta, feature-branch", () => {
    // live: untouched meta.pid (self)
    const live = createDistillWorkspace(vault, sourceSession, sessionDir);
    // dead-pid
    const deadPid = createDistillWorkspace(vault, sourceSession, sessionDir);
    const meta = readDistillMeta(deadPid.worktreePath);
    if (!meta) throw new Error("meta expected");
    meta.pid = findDeadPid();
    fs.writeFileSync(deadPid.metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    // missing-meta
    const missing = createDistillWorkspace(vault, sourceSession, sessionDir);
    fs.rmSync(missing.metaPath);
    // feature-branch (not touched)
    const feat = path.join(vault, "feat-wt");
    const addRes = spawnSync(
      "git",
      ["-C", vault, "worktree", "add", "-b", "feature/unrelated", feat, "HEAD"],
      { encoding: "utf-8" },
    );
    if (addRes.status !== 0) {
      throw new Error(`worktree setup failed: ${addRes.stderr}`);
    }

    try {
      const removed = cleanupStaleWorktrees({ contentPath: vault });
      expect(removed).toBe(2);
      expect(fs.existsSync(live.worktreePath)).toBe(true);
      expect(fs.existsSync(deadPid.worktreePath)).toBe(false);
      expect(fs.existsSync(missing.worktreePath)).toBe(false);
      expect(fs.existsSync(feat)).toBe(true);
    } finally {
      cleanupDistillWorkspace(vault, live);
      spawnSync("git", ["-C", vault, "worktree", "remove", "--force", feat]);
      spawnSync("git", ["-C", vault, "branch", "-D", "feature/unrelated"]);
    }
  });
});

describe("STALE_WORKTREE_MINUTES constant", () => {
  test("STALE_META_AGE_MS equals minutes * 60 * 1000", () => {
    expect(STALE_META_AGE_MS).toBe(STALE_WORKTREE_MINUTES * 60 * 1000);
  });

  test("threshold is 60 minutes (documented default)", () => {
    expect(STALE_WORKTREE_MINUTES).toBe(60);
  });
});

describe("createDistillWorkspace records startSha", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "startsha-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("meta.json.startSha matches vault HEAD at create-time", () => {
    const headRes = spawnSync("git", ["-C", vault, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    });
    const expectedSha = headRes.stdout.trim();

    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    try {
      const meta = readDistillMeta(w.worktreePath);
      expect(meta).not.toBeNull();
      expect(meta?.startSha).toBe(expectedSha);
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });
});

describe("getActiveDistills", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;
  const toCleanup: { worktreePath: string; branchName: string }[] = [];

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "active-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    for (const w of toCleanup) {
      try {
        cleanupDistillWorkspace(vault, w);
      } catch {
        // ignore — test teardown only
      }
    }
    toCleanup.length = 0;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("returns [] when vault has no .git", () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-active-"));
    try {
      expect(getActiveDistills({ contentPath: noGit })).toEqual([]);
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });

  test("returns [] when there are no distill worktrees", () => {
    expect(getActiveDistills({ contentPath: vault })).toEqual([]);
  });

  test("returns one entry per distill worktree with live pid (self)", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    toCleanup.push(w);

    const active = getActiveDistills({ contentPath: vault });
    expect(active.length).toBe(1);
    const [a] = active;
    expect(a.branch).toBe(w.branchName);
    expect(a.worktreePath).toBe(w.worktreePath);
    expect(a.pid).toBe(process.pid);
    expect(a.alive).toBe(true);
    expect(a.sessionPath).toBe(sourceSession);
    expect(a.startedAt).not.toBeNull();
    expect(a.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(a.startSha).toMatch(/^[0-9a-f]{7,64}$/);
  });

  test("reports alive=false for worktrees whose pid is dead", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    toCleanup.push(w);

    // Overwrite meta.pid with a dead pid. Reuse test helper.
    const meta = readDistillMeta(w.worktreePath);
    if (!meta) throw new Error("meta expected");
    meta.pid = findDeadPid();
    fs.writeFileSync(w.metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    const active = getActiveDistills({ contentPath: vault });
    expect(active.length).toBe(1);
    expect(active[0].alive).toBe(false);
  });

  test("ignores non-distill worktrees", () => {
    const other = path.join(vault, "feat-wt");
    const addRes = spawnSync(
      "git",
      ["-C", vault, "worktree", "add", "-b", "feature/zzz", other, "HEAD"],
      { encoding: "utf-8" },
    );
    if (addRes.status !== 0) throw new Error(addRes.stderr);
    try {
      expect(getActiveDistills({ contentPath: vault })).toEqual([]);
    } finally {
      spawnSync("git", ["-C", vault, "worktree", "remove", "--force", other]);
      spawnSync("git", ["-C", vault, "branch", "-D", "feature/zzz"]);
    }
  });

  test("mixed state: two distills + one feature branch", () => {
    const a = createDistillWorkspace(vault, sourceSession, sessionDir);
    toCleanup.push(a);
    const b = createDistillWorkspace(vault, sourceSession, sessionDir);
    toCleanup.push(b);
    const feat = path.join(vault, "feat-wt-2");
    spawnSync(
      "git",
      ["-C", vault, "worktree", "add", "-b", "feature/other", feat, "HEAD"],
      { encoding: "utf-8" },
    );

    try {
      const active = getActiveDistills({ contentPath: vault });
      const branches = active.map((e) => e.branch).sort();
      expect(branches).toEqual([a.branchName, b.branchName].sort());
    } finally {
      spawnSync("git", ["-C", vault, "worktree", "remove", "--force", feat]);
      spawnSync("git", ["-C", vault, "branch", "-D", "feature/other"]);
    }
  });

  test("tolerates missing meta.json (reports alive=false, pid=-1)", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    toCleanup.push(w);
    fs.rmSync(w.metaPath);

    const active = getActiveDistills({ contentPath: vault });
    expect(active.length).toBe(1);
    expect(active[0].pid).toBe(-1);
    expect(active[0].alive).toBe(false);
    expect(active[0].startedAt).toBeNull();
    expect(active[0].sessionPath).toBeNull();
  });
});

describe("getUnmergedDistillBranches", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "unmerged-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("returns [] when no distill branches exist", () => {
    expect(getUnmergedDistillBranches({ contentPath: vault })).toEqual([]);
  });

  test("returns [] when vault has no .git", () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), "unmerged-no-git-"));
    try {
      expect(getUnmergedDistillBranches({ contentPath: noGit })).toEqual([]);
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });

  test("skips branches that are checked out in a worktree", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    try {
      // w.branchName is live (in a worktree) → NOT unmerged.
      expect(getUnmergedDistillBranches({ contentPath: vault })).toEqual([]);
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });

  test("reports distill branches with no worktree", () => {
    // Create a distill branch WITHOUT a worktree — simulates a crashed distill
    // whose worktree was removed but whose branch ref lingers.
    const branch = "distill/orphan-1700000000";
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    const res = spawnSync("git", ["-C", vault, "branch", branch], {
      encoding: "utf-8",
      env,
    });
    if (res.status !== 0) throw new Error(res.stderr);

    try {
      expect(getUnmergedDistillBranches({ contentPath: vault })).toEqual([
        branch,
      ]);
    } finally {
      spawnSync("git", ["-C", vault, "branch", "-D", branch]);
    }
  });

  test("mixed: one live worktree + one orphan branch → returns only orphan", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    const orphan = "distill/zz-1700000001";
    spawnSync("git", ["-C", vault, "branch", orphan]);

    try {
      expect(getUnmergedDistillBranches({ contentPath: vault })).toEqual([
        orphan,
      ]);
    } finally {
      spawnSync("git", ["-C", vault, "branch", "-D", orphan]);
      cleanupDistillWorkspace(vault, w);
    }
  });
});

describe("getDistillState (consolidated enumeration, CLN-3)", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("no .git → both halves empty", () => {
    const noGit = fs.mkdtempSync(path.join(os.tmpdir(), "state-no-git-"));
    try {
      expect(getDistillState({ contentPath: noGit })).toEqual({
        active: [],
        unmerged: [],
      });
    } finally {
      fs.rmSync(noGit, { recursive: true, force: true });
    }
  });

  test("fresh vault, no distills → both halves empty", () => {
    expect(getDistillState({ contentPath: vault })).toEqual({
      active: [],
      unmerged: [],
    });
  });

  test("mixed: one live worktree + one orphan branch → active=[live], unmerged=[orphan]", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    const orphan = "distill/zz-1700000002";
    spawnSync("git", ["-C", vault, "branch", orphan]);

    try {
      const state = getDistillState({ contentPath: vault });
      // active: only the live worktree
      expect(state.active.length).toBe(1);
      expect(state.active[0].branch).toBe(w.branchName);
      // unmerged: only the orphan (live worktree's branch is excluded)
      expect(state.unmerged).toEqual([orphan]);
    } finally {
      spawnSync("git", ["-C", vault, "branch", "-D", orphan]);
      cleanupDistillWorkspace(vault, w);
    }
  });

  test("agrees with getActiveDistills + getUnmergedDistillBranches on the same state", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    const orphan = "distill/zz-1700000003";
    spawnSync("git", ["-C", vault, "branch", orphan]);

    try {
      const combined = getDistillState({ contentPath: vault });
      const active = getActiveDistills({ contentPath: vault });
      const unmerged = getUnmergedDistillBranches({ contentPath: vault });
      // Both enumerations see the same worktree/branch set; the consolidated
      // call's output must match the sum of the thin wrappers.
      expect(combined.active.map((a) => a.branch)).toEqual(
        active.map((a) => a.branch),
      );
      expect(combined.unmerged).toEqual(unmerged);
    } finally {
      spawnSync("git", ["-C", vault, "branch", "-D", orphan]);
      cleanupDistillWorkspace(vault, w);
    }
  });
});

describe("R2-4: getActiveDistills skips branch listing", () => {
  // Proves the optimization: `getActiveDistills` must NOT invoke
  // `git branch --list` (it only needs worktrees + liveness). The
  // `getUnmergedDistillBranches` and `getDistillState` paths still do,
  // because a branch can exist without a worktree.
  //
  // Observation strategy: prepend a PATH shim that logs each `git <args>`
  // invocation to a file, then exec the real git. No in-process mocking.
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;
  let shimDir: string;
  let gitLog: string;
  let realGit: string;
  let origPath: string | undefined;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "r24-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);

    // Resolve absolute path to the real git binary BEFORE the shim hides it.
    const which = spawnSync("which", ["git"], { encoding: "utf-8" });
    realGit = which.stdout.trim();
    if (!realGit) throw new Error("cannot locate real git");

    // Build shim.
    shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "r24-shim-"));
    gitLog = path.join(shimDir, "git.log");
    const gitShim = path.join(shimDir, "git");
    fs.writeFileSync(
      gitShim,
      `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(gitLog)}\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o755 },
    );

    origPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${origPath ?? ""}`;
  });

  afterEach(() => {
    if (origPath === undefined) delete process.env.PATH;
    else process.env.PATH = origPath;
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  const readLog = (): string[] =>
    fs.existsSync(gitLog)
      ? fs
          .readFileSync(gitLog, "utf-8")
          .split("\n")
          .filter((l) => l.length > 0)
      : [];

  test("getActiveDistills does NOT shell out for `git branch --list`", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    // Drain any setup-phase invocations: only count git calls from
    // getActiveDistills onward.
    fs.writeFileSync(gitLog, "");

    try {
      const active = getActiveDistills({ contentPath: vault });
      expect(active.length).toBe(1);

      const calls = readLog();
      // Sanity: worktree-list IS called.
      expect(calls.some((c) => c.includes("worktree list"))).toBe(true);
      // R2-4 invariant: branch-list is NOT called.
      expect(calls.some((c) => c.includes("branch --list"))).toBe(false);
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });

  test("getUnmergedDistillBranches DOES shell out for `git branch --list`", () => {
    // Sanity/contrast: the unmerged path genuinely needs branch listing.
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    fs.writeFileSync(gitLog, "");

    try {
      getUnmergedDistillBranches({ contentPath: vault });
      const calls = readLog();
      expect(calls.some((c) => c.includes("worktree list"))).toBe(true);
      expect(calls.some((c) => c.includes("branch --list"))).toBe(true);
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });

  test("getDistillState DOES shell out for `git branch --list` (composed path)", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    fs.writeFileSync(gitLog, "");

    try {
      getDistillState({ contentPath: vault });
      const calls = readLog();
      expect(calls.some((c) => c.includes("worktree list"))).toBe(true);
      expect(calls.some((c) => c.includes("branch --list"))).toBe(true);
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });
});

describe("diffWorktreeSinceStart", () => {
  let vault: string;
  let sessionDir: string;
  let sourceSession: string;

  beforeEach(() => {
    vault = createGitVault();
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-src-"));
    sourceSession = createSeededSessionFile(sessionDir, sessionDir);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
  });

  test("empty worktree (no changes since startSha) returns []", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    try {
      const meta = readDistillMeta(w.worktreePath);
      expect(
        diffWorktreeSinceStart({
          worktreePath: w.worktreePath,
          startSha: meta?.startSha,
        }),
      ).toEqual([]);
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });

  test("committed change shows up after startSha", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    try {
      // Write + commit a new file inside the worktree.
      const newFile = path.join(w.worktreePath, "distilled.md");
      fs.writeFileSync(newFile, "# new\n");
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      };
      spawnSync("git", ["-C", w.worktreePath, "add", "distilled.md"], { env });
      spawnSync(
        "git",
        ["-C", w.worktreePath, "commit", "-m", "add distilled.md"],
        { env },
      );

      const meta = readDistillMeta(w.worktreePath);
      const changed = diffWorktreeSinceStart({
        worktreePath: w.worktreePath,
        startSha: meta?.startSha,
      });
      expect(changed).toContain("distilled.md");
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });

  test("legacy meta (no startSha) falls back to status --porcelain", () => {
    const w = createDistillWorkspace(vault, sourceSession, sessionDir);
    try {
      // Uncommitted change — status picks it up.
      fs.writeFileSync(path.join(w.worktreePath, "scratch.md"), "# scratch\n");

      const changed = diffWorktreeSinceStart({
        worktreePath: w.worktreePath,
        startSha: undefined,
      });
      expect(changed).toContain("scratch.md");
    } finally {
      cleanupDistillWorkspace(vault, w);
    }
  });

  test("returns [] for missing worktree path", () => {
    expect(
      diffWorktreeSinceStart({
        worktreePath: "/tmp/does-not-exist",
        startSha: "abc1234",
      }),
    ).toEqual([]);
  });
});
