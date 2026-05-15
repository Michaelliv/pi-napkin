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

import {
  makeWrapperScaffold,
  runWrapperWithStub,
  withNapkinOnPath,
  writePiStub,
} from "./_test-helpers";
import { DISTILL_WRAPPER_SCRIPT } from "./scripts-paths";

// Local aliases keep test bodies aligned with the prior in-file helpers
// so the CLEAN-A-6 extraction is a pure call-site move with no per-test
// edits. Phase C may switch new tests to the canonical helper names.
const makeScaffold = () => makeWrapperScaffold("napkin-distill-a3-");
const writeStubPi = writePiStub;
const runWrapper = runWrapperWithStub;

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

  // ---- validate_no_markers regression guards (CORR-A-1, SEC-A-7) ---------
  // The validator was tightened to require ALL THREE marker types
  // (`^<{7} `, `^={7}$`, `^>{7} `) co-present in the same file before
  // declaring a conflict. The next five tests pin the false-positive
  // shapes the prior any-of-three regex would have tripped on, and the
  // one acknowledged tradeoff (all-three inside a code block).

  test("validate_no_markers PASS (CORR-A-1): setext H1 underline `=======` is not a conflict", () => {
    // Markdown setext H1: `# title\n=======` renders as a heading and
    // is exceedingly common in user vaults. The prior `^={7}$` rule
    // false-positived on every such heading. The tightened validator
    // requires all three marker types co-present, so a lone
    // `=======` line passes.
    const s = makeScaffold();
    try {
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
cat > "${s.vault}/setext.md" <<'BODY'
# Heading
=======
body text
BODY
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: setext heading" >/dev/null
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("validate_no_markers PASS (CORR-A-1): single-marker documentation prose is not a conflict", () => {
    // Notes / READMEs may legitimately quote a single conflict marker
    // when discussing merges (e.g. \"the `<<<<<<< HEAD` line marks the
    // local side\"). The prior validator would permanently block
    // distills on such vaults. With co-presence required, a lone
    // `<<<<<<< HEAD` line in prose passes.
    const s = makeScaffold();
    try {
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
cat > "${s.vault}/doc.md" <<'BODY'
# Merge conflict notes
When git renders a conflict it inserts a header marker:
<<<<<<< HEAD
That line opens the local side. (No closing markers in this note.)
BODY
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: doc with single marker" >/dev/null
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("validate_no_markers PASS (CORR-A-1): two-marker documentation prose is not a conflict", () => {
    // A note may walk the reader through the opening half of a
    // conflict (`<<<<<<< HEAD` + `=======`) without ever showing the
    // closing `>>>>>>> ` line. The any-of-three rule would have
    // failed; co-presence requires all three, so this passes.
    const s = makeScaffold();
    try {
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
cat > "${s.vault}/doc.md" <<'BODY'
# Conflict marker primer
The opening half of a conflict block:
<<<<<<< HEAD
local side
=======
(closing marker omitted intentionally for brevity)
BODY
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: doc with two markers" >/dev/null
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("validate_no_markers PASS (CORR-A-1): markers split across two files is not a conflict", () => {
    // Per-file all-three predicate: the validator inspects each tracked
    // *.md file in isolation. A vault that splits marker examples
    // across two notes (one shows `<<<<<<<`, another shows `>>>>>>>`)
    // never has any single file with all three, so passes. The prior
    // any-of-three rule would have flagged both files.
    const s = makeScaffold();
    try {
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
cat > "${s.vault}/opener.md" <<'BODY'
<<<<<<< HEAD
opener-only note
BODY
cat > "${s.vault}/closer.md" <<'BODY'
>>>>>>> feature
closer-only note
BODY
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: split markers" >/dev/null
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("validate_no_markers FAIL (CORR-A-1, SEC-A-7): all-three markers inside a code block trip the validator — acknowledged tradeoff", () => {
    // Acknowledged tradeoff: the validator does not parse markdown
    // structure, so a fenced code block that demonstrates a complete
    // `<<<<<<<` / `=======` / `>>>>>>>` example will trip the
    // co-presence check. Users who genuinely want to document a full
    // example can escape the markers (leading whitespace, HTML
    // comments, or split across two files — see the split-across-
    // files test above). The cost of false-positives on the prior
    // any-of-three regex was much higher (block-all-distills-forever
    // on legitimate documentation) than this rare-explicit-doc case.
    const s = makeScaffold();
    try {
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
cat > "${s.vault}/example.md" <<'BODY'
# Conflict block example
A full conflict block looks like this:
\`\`\`
<<<<<<< HEAD
local
=======
remote
>>>>>>> feature
\`\`\`
BODY
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: full doc example" >/dev/null
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

describe("distill-wrapper.sh write_outcome atomicity (PR #12 SEC-A-4)", () => {
  // SEC-A-4 regression: the outcome sidecar must be written atomically
  // via a temp-and-rename pattern, not as two `printf`s into the same
  // redirect. Without atomicity the JS-side poller
  // (`findDistillOutcomeForBranch`) could open the file between the
  // kernel's write of line 1 and line 2, see only the outcome class,
  // and misclassify a `failed:*` distill as having no recovery hint.
  //
  // We extract the function from the wrapper file and source it in a
  // tiny bash harness, then assert post-conditions: (a) the final
  // sidecar contents match the expected bytes exactly (no extra
  // whitespace, line 1 = class, line 2 = hint), and (b) no `.tmp`
  // straggler is left behind in the error dir after a successful
  // `write_outcome`.
  //
  // Function extraction: same pattern as safe_rm_worktree above.
  // `write_outcome() {` to the next bare `}` at column 0.
  function extractWriteOutcome(): string {
    const wrapper = fs.readFileSync(DISTILL_WRAPPER_SCRIPT, "utf-8");
    const lines = wrapper.split("\n");
    const start = lines.findIndex((l) => /^write_outcome\(\) \{/.test(l));
    if (start === -1) {
      throw new Error("write_outcome() not found in wrapper script");
    }
    const end = lines.findIndex((l, i) => i > start && /^\}$/.test(l));
    if (end === -1) {
      throw new Error("write_outcome() body terminator not found");
    }
    return lines.slice(start, end + 1).join("\n");
  }

  /**
   * Run a bash harness that sources only the write_outcome function
   * and calls it with the given (class, hint) tuple. Returns the
   * exit code, the final sidecar contents (or null if missing), and
   * the list of files left in the dir afterward (so the caller can
   * detect `.tmp` stragglers).
   */
  function callWriteOutcome(
    outcomeDir: string,
    klass: string,
    hint?: string,
  ): { rc: number; contents: string | null; files: string[] } {
    const fn = extractWriteOutcome();
    const sidecar = path.join(outcomeDir, "test.outcome");
    const args =
      hint === undefined
        ? `${JSON.stringify(klass)}`
        : `${JSON.stringify(klass)} ${JSON.stringify(hint)}`;
    const harness = `
set -uo pipefail
ERROR_DIR=${JSON.stringify(outcomeDir)}
OUTCOME_PATH=${JSON.stringify(sidecar)}
log_error() { printf '%s\n' "$*" >&2; }
${fn}
write_outcome ${args}
exit $?
`;
    const r = spawnSync("bash", ["-c", harness], { encoding: "utf-8" });
    const contents = fs.existsSync(sidecar)
      ? fs.readFileSync(sidecar, "utf-8")
      : null;
    const files = fs.existsSync(outcomeDir) ? fs.readdirSync(outcomeDir) : [];
    return { rc: r.status ?? -1, contents, files };
  }

  test("single-line outcome: writes class only, no .tmp straggler", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sec-a-4-single-"));
    try {
      const r = callWriteOutcome(root, "merged-content");
      expect(r.rc).toBe(0);
      expect(r.contents).toBe("merged-content\n");
      // No .tmp file left behind — the rename consumed it.
      expect(r.files.some((f) => f.endsWith(".tmp"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("multi-line outcome: line 1 = class, line 2 = hint, no .tmp straggler", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sec-a-4-multi-"));
    try {
      const r = callWriteOutcome(
        root,
        "failed:agent-timeout",
        "Agent task exceeded budget; bump distill.maxDurationMinutes.",
      );
      expect(r.rc).toBe(0);
      // Exact bytes: line 1 = class \n, line 2 = hint \n. No extra
      // whitespace, no trailing data, no truncation.
      expect(r.contents).toBe(
        "failed:agent-timeout\nAgent task exceeded budget; bump distill.maxDurationMinutes.\n",
      );
      expect(r.files.some((f) => f.endsWith(".tmp"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("idempotent rewrite: a second call replaces the file atomically with no .tmp straggler", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sec-a-4-rewrite-"));
    try {
      callWriteOutcome(root, "merged-content");
      const second = callWriteOutcome(
        root,
        "failed:markers-after-agent-exit",
        "Inspect vault and revert.",
      );
      expect(second.rc).toBe(0);
      expect(second.contents).toBe(
        "failed:markers-after-agent-exit\nInspect vault and revert.\n",
      );
      expect(second.files.some((f) => f.endsWith(".tmp"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("end-to-end: real wrapper run leaves no .tmp straggler in error dir", () => {
    // Defense-in-depth E2E: spawn the actual wrapper and assert the
    // post-run error dir contains no `*.outcome.tmp` file. The
    // refactored write_outcome's mv leaves only the canonical
    // `<ts>-<pid>-<branchShort>.outcome` behind. A regression that
    // dropped the mv (or used `cp` instead) would leak the .tmp.
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
      const pathHandle = withNapkinOnPath();
      try {
        const r = runWrapper(s);
        expect(r.exitCode).toBe(0);
        expect(r.outcome).toBe("merged-content");
        const stragglers = fs
          .readdirSync(s.errorDir)
          .filter((f) => f.endsWith(".tmp"));
        expect(stragglers).toEqual([]);
      } finally {
        pathHandle.restore();
      }
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });
});
