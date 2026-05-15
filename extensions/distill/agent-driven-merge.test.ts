/**
 * Integration tests against the formal bash-stub agent fixtures
 * (PR #12 Item C2).
 *
 * Each test drives the wrapper end-to-end with `NAPKIN_DISTILL_PI_BIN`
 * pointed at one of the fixtures under
 * `extensions/distill/test-fixtures/agent-stubs/`. The fixtures simulate
 * the 10 agent-behavior classes from the design's "Mocked-pi behaviors"
 * testing plan; this test file validates that the wrapper's full
 * pipeline (post-validation + salvage + outcome dispatch + sidecar
 * emission) handles each class correctly.
 *
 * Coverage relationship to existing inline-stub tests:
 *   - `wrapper-validation.test.ts` covers most validators in isolation
 *     (one-validator-per-test) using inline `writePiStub` patterns.
 *   - `wrapper-salvage.test.ts` covers the salvage path's sidecar
 *     contents for the four failed:* classes.
 *   - This file complements both with an integration view: the canonical
 *     fixture + full pipeline + outcome dispatch. It also fills genuine
 *     gaps in the inline-stub matrix:
 *       (a) `conflict-resolve-clean` \u2014 actual git-merge-with-conflict +
 *           agent resolves + squashes to default
 *       (b) `squash-skipped`         \u2014 agent commits to the worktree's
 *           distill branch but never squashes (vault HEAD doesn't move)
 *       (c) `multiple-commits-on-main` \u2014 agent makes 2+ commits on the
 *           default branch (validates the wrapper's `>= 1` commit-count
 *           dispatch)
 *       (d) `pushed-success`         \u2014 origin configured + agent pushes
 *           successfully (complements `merged-local` already covered
 *           in wrapper-validation.test.ts)
 *
 * Future v0.2.x cleanup may migrate the inline-stub patterns in the
 * other test files to call into these fixtures; for now both surfaces
 * coexist.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  makeWrapperScaffold,
  runWrapperWithStub,
  withNapkinOnPath,
} from "./_test-helpers";
import { findDistillOutcomeForBranch } from "./distill-workspace";

const FIXTURES_DIR = path.join(__dirname, "test-fixtures", "agent-stubs");

function fixturePath(name: string): string {
  const p = path.join(FIXTURES_DIR, name);
  if (!fs.existsSync(p)) {
    throw new Error(`fixture not found: ${p}`);
  }
  return p;
}

const makeScaffold = () => makeWrapperScaffold("napkin-distill-c2-");

/**
 * Configure a bare-repo origin for push-related tests. Returns the
 * origin path so callers can inspect post-push state. The vault's main
 * is `push -u`'ed to origin, so origin/main exists at the seed sha.
 */
function setupOriginForVault(scaffoldRoot: string, vault: string): string {
  const originPath = path.join(scaffoldRoot, "origin.git");
  spawnSync("git", ["init", "--bare", "-b", "main", originPath]);
  spawnSync("git", ["-C", vault, "remote", "add", "origin", originPath]);
  spawnSync("git", ["-C", vault, "push", "-u", "origin", "main"]);
  return originPath;
}

/**
 * Advance `origin/<default>` past the vault's local main by pushing a
 * commit from a separate clone. Used by the `push-fail-pull-merge-
 * success` fixture (CORR-1): simulates a teammate landing a commit
 * while the agent's distill ran, so the agent's first push fails
 * non-ff and the recovery flow (`pull --no-rebase` + push) is exercised.
 *
 * Leaves the side clone in `<scaffoldRoot>/side-clone` for forensic
 * inspection if the test fails. Returns the SHA of the side commit.
 */
function advanceOriginFromSideClone(
  scaffoldRoot: string,
  originPath: string,
  defaultBranch: string,
): string {
  const sideClone = path.join(scaffoldRoot, "side-clone");
  spawnSync("git", ["clone", "-q", originPath, sideClone]);
  spawnSync("git", [
    "-C",
    sideClone,
    "config",
    "user.email",
    "side@example.com",
  ]);
  spawnSync("git", ["-C", sideClone, "config", "user.name", "side"]);
  fs.writeFileSync(path.join(sideClone, "side.md"), "# side\n");
  spawnSync("git", ["-C", sideClone, "add", "."]);
  spawnSync("git", ["-C", sideClone, "commit", "-m", "side: concurrent edit"]);
  spawnSync("git", ["-C", sideClone, "push", "origin", defaultBranch]);
  const sha = spawnSync("git", ["-C", sideClone, "rev-parse", defaultBranch], {
    encoding: "utf-8",
  }).stdout.trim();
  return sha;
}

describe("agent-driven merge: integration against formal bash-stub fixtures (PR #12 C2)", () => {
  let pathHandle: { restore: () => void };

  beforeEach(() => {
    pathHandle = withNapkinOnPath();
  });

  afterEach(() => {
    pathHandle.restore();
  });

  // -------------------------------------------------------------------------
  // Behavior 1: clean-distill
  // -------------------------------------------------------------------------

  test("clean-distill fixture \u2192 merged-content", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("clean-distill.sh"),
      });
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
      // Vault should have the agent's content committed.
      expect(fs.existsSync(path.join(s.vault, "distilled.md"))).toBe(true);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 2: conflict-resolve-clean
  //
  // Genuine gap fill: existing inline-stub tests don't simulate an
  // actual `git merge` with conflict + resolution. The fixture drives
  // the full integrate-and-squash flow.
  // -------------------------------------------------------------------------

  test("conflict-resolve-clean fixture \u2192 merged-content (resolved cleanly)", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("conflict-resolve-clean.sh"),
      });
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
      // The resolved file must NOT contain conflict markers.
      const noteContent = fs.readFileSync(
        path.join(s.vault, "note.md"),
        "utf-8",
      );
      expect(noteContent).not.toMatch(/^<{7} /m);
      expect(noteContent).not.toMatch(/^={7}$/m);
      expect(noteContent).not.toMatch(/^>{7} /m);
      expect(noteContent).toContain("merged distill + main");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 3: conflict-leave-markers
  // -------------------------------------------------------------------------

  test("conflict-leave-markers fixture \u2192 failed:markers-after-agent-exit + recovery hint", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("conflict-leave-markers.sh"),
      });
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:markers-after-agent-exit");

      const branchShort = r.branch.replace(/^distill\//, "");
      const parsed = findDistillOutcomeForBranch(s.errorDir, branchShort);
      expect(parsed?.outcomeClass).toBe("failed:markers-after-agent-exit");
      expect(parsed?.recoveryHint).toMatch(/git -C .* revert HEAD --no-edit/);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 4: no-distill
  // -------------------------------------------------------------------------

  test("no-distill fixture \u2192 no-content", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("no-distill.sh"),
      });
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("no-content");
      // Vault main should be at startSha (no commits).
      const postSha = spawnSync("git", ["-C", s.vault, "rev-parse", "main"], {
        encoding: "utf-8",
      }).stdout.trim();
      expect(postSha).toBe(r.preSha);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 5: squash-skipped
  //
  // Genuine gap fill: existing inline-stub tests don't cover the case
  // where the agent commits to the worktree's distill branch but never
  // squashes back to default. From the vault's perspective this is
  // indistinguishable from `no-distill` (both leave default at startSha),
  // but the fixture documents the distinction for forensic clarity.
  // -------------------------------------------------------------------------

  test("squash-skipped fixture \u2192 no-content (default branch never moved)", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("squash-skipped.sh"),
      });
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("no-content");
      // Vault main should be at startSha.
      const postSha = spawnSync("git", ["-C", s.vault, "rev-parse", "main"], {
        encoding: "utf-8",
      }).stdout.trim();
      expect(postSha).toBe(r.preSha);
      // The dangling.md the agent wrote in the worktree shouldn't have
      // landed on default.
      expect(fs.existsSync(path.join(s.vault, "dangling.md"))).toBe(false);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 6: multiple-commits-on-main
  //
  // Genuine gap fill: the validate_commit_count dispatch is documented
  // as "0 \u2192 no-content / 1+ \u2192 has-content"; this test pins the 2-commit
  // case to keep the dispatch invariant locked.
  // -------------------------------------------------------------------------

  test("multiple-commits-on-main fixture \u2192 merged-content (2+ commits accepted)", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("multiple-commits-on-main.sh"),
      });
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
      // Both files should be on default.
      expect(fs.existsSync(path.join(s.vault, "first.md"))).toBe(true);
      expect(fs.existsSync(path.join(s.vault, "second.md"))).toBe(true);
      // And the commit count from startSha should be 2.
      const count = spawnSync(
        "git",
        ["-C", s.vault, "rev-list", "--count", `${r.preSha}..HEAD`],
        { encoding: "utf-8" },
      ).stdout.trim();
      expect(count).toBe("2");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 7: pushed-success
  //
  // Genuine gap fill: existing inline-stub coverage has detect_local_only
  // PASS (no origin) and merged-local TRIGGERED, but no test where origin
  // exists AND the agent pushes successfully.
  // -------------------------------------------------------------------------

  test("pushed-success fixture (origin configured, agent pushes) \u2192 merged-content", () => {
    const s = makeScaffold();
    try {
      const originPath = setupOriginForVault(s.root, s.vault);
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("pushed-success.sh"),
      });
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
      // Origin's main should now equal local main.
      const localSha = spawnSync("git", ["-C", s.vault, "rev-parse", "main"], {
        encoding: "utf-8",
      }).stdout.trim();
      const originSha = spawnSync(
        "git",
        ["-C", originPath, "rev-parse", "main"],
        { encoding: "utf-8" },
      ).stdout.trim();
      expect(localSha).toBe(originSha);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 8: push-fail-merged-local
  // -------------------------------------------------------------------------

  test("push-fail-merged-local fixture (origin diverges, agent doesn't push) \u2192 merged-local", () => {
    const s = makeScaffold();
    try {
      setupOriginForVault(s.root, s.vault);
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("push-fail-merged-local.sh"),
      });
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-local");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 8 (recovery branch): push-fail-pull-merge-success
  //
  // Genuine gap fill (CORR-1, Phase C Round 1): the design's
  // "Mocked-pi behaviors" #8 calls out the recovery flow where the
  // agent's first push fails (origin moved during the distill) and
  // the agent recovers via `git pull --no-rebase` + push. The existing
  // `push-fail-merged-local` covers the OTHER valid path (agent gives
  // up on push); this test covers the recovery-succeeds path so the
  // wrapper's classification stays `merged-content` rather than
  // `merged-local` when the agent's pull-merge-push closes the gap.
  //
  // The `--no-rebase` is the design-mandated invariant (the prompt
  // emits the explicit flag because users with `pull.rebase=true`
  // globally would otherwise rewrite local main). The fixture writes
  // a sentinel file recording the exact `git pull` command it ran;
  // this test reads it to pin that the flag was used.
  // -------------------------------------------------------------------------

  test("push-fail-pull-merge-success fixture (origin moved; agent recovers via pull --no-rebase) \u2192 merged-content + sentinel pins --no-rebase", () => {
    const s = makeScaffold();
    try {
      const originPath = setupOriginForVault(s.root, s.vault);
      // Advance origin BEFORE the wrapper runs so the agent's first
      // push observes a non-ff state.
      const sideSha = advanceOriginFromSideClone(s.root, originPath, "main");
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("push-fail-pull-merge-success.sh"),
      });
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");

      // Origin's main should now equal local main (push landed).
      const localSha = spawnSync("git", ["-C", s.vault, "rev-parse", "main"], {
        encoding: "utf-8",
      }).stdout.trim();
      const originSha = spawnSync(
        "git",
        ["-C", originPath, "rev-parse", "main"],
        { encoding: "utf-8" },
      ).stdout.trim();
      expect(localSha).toBe(originSha);

      // The side-clone commit must be reachable from local main (the
      // pull --no-rebase merge folded it in).
      const ancestryCheck = spawnSync(
        "git",
        ["-C", s.vault, "merge-base", "--is-ancestor", sideSha, "main"],
        { encoding: "utf-8" },
      );
      expect(ancestryCheck.status).toBe(0);

      // Pin the --no-rebase contract via the fixture's sentinel file.
      const flagPath = path.join(s.vault, ".napkin-stub-pull-flag");
      expect(fs.existsSync(flagPath)).toBe(true);
      const flagBody = fs.readFileSync(flagPath, "utf-8");
      expect(flagBody).toContain("pull --no-rebase origin main");

      // Distilled content from the agent must be on default.
      expect(fs.existsSync(path.join(s.vault, "pulled-merged.md"))).toBe(true);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Behavior 9: agent-timeout
  // -------------------------------------------------------------------------

  test("agent-timeout fixture (sleeps past budget) \u2192 failed:agent-timeout + recovery hint", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("agent-timeout.sh"),
        maxDurationSecs: "1",
      });
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:agent-timeout");

      const branchShort = r.branch.replace(/^distill\//, "");
      const parsed = findDistillOutcomeForBranch(s.errorDir, branchShort);
      expect(parsed?.outcomeClass).toBe("failed:agent-timeout");
      expect(parsed?.recoveryHint).toMatch(/maxDurationMinutes/);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  }, 30_000);

  // -------------------------------------------------------------------------
  // Behavior 10: agent-crashes
  // -------------------------------------------------------------------------

  test("agent-crashes fixture (exits 7 with stderr) \u2192 failed:agent-exit-nonzero", () => {
    const s = makeScaffold();
    try {
      const r = runWrapperWithStub(s, {
        fixturePath: fixturePath("agent-crashes.sh"),
      });
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:agent-exit-nonzero");

      const branchShort = r.branch.replace(/^distill\//, "");
      const parsed = findDistillOutcomeForBranch(s.errorDir, branchShort);
      expect(parsed?.outcomeClass).toBe("failed:agent-exit-nonzero");
      expect(parsed?.recoveryHint).toMatch(/reflog/i);
      // The crash diagnostic from the fixture's stderr should be in the
      // wrapper's error log alongside the outcome sidecar. Inspect the
      // .log sibling.
      const logFiles = fs
        .readdirSync(s.errorDir)
        .filter((f) => f.endsWith(`-${branchShort}.log`));
      expect(logFiles.length).toBe(1);
      const logBody = fs.readFileSync(
        path.join(s.errorDir, logFiles[0]),
        "utf-8",
      );
      expect(logBody).toContain("simulated crash");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });
});
