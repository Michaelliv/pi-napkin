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

  test("validate_head_on_default FAIL: vault HEAD detached \u2192 failed:head-not-on-default + detached-specific log message (PR #12 C4)", () => {
    // Gap fill (C4): the wrapper's validate_head_on_default has two
    // distinct failure paths — (a) HEAD on a different branch and
    // (b) HEAD detached. The latter routes through the same
    // `failed:head-not-on-default` outcome class but the salvage
    // function emits a detached-specific log line that points the
    // user at `git checkout <default>` to recover. Existing tests
    // covered (a); this test pins (b) so a future refactor can't
    // collapse the two paths and silently regress the diagnostic.
    const s = makeScaffold();
    try {
      // Stub: detach vault HEAD by checking out the seed SHA. The
      // detached state is what `git symbolic-ref --short HEAD`
      // returns non-zero on — distinct from the feature-branch case
      // where it returns the branch name.
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
seed_sha="$(git -C "${s.vault}" rev-parse HEAD)"
git -C "${s.vault}" checkout -q --detach "$seed_sha"
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:head-not-on-default");
      // Inspect the .log sibling to confirm the detached-specific
      // diagnostic fired (distinct from the feature-branch log).
      const branchShort = r.branch.replace(/^distill\//, "");
      const logFiles = fs
        .readdirSync(s.errorDir)
        .filter((f) => f.endsWith(`-${branchShort}.log`));
      expect(logFiles.length).toBe(1);
      const logBody = fs.readFileSync(
        path.join(s.errorDir, logFiles[0]),
        "utf-8",
      );
      // The salvage-side message specifically mentions "detached" and
      // tells the user to checkout the default branch manually.
      expect(logBody).toMatch(/detached/i);
      expect(logBody).toContain("main");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("multi-validator dispatch: markers AND wrong HEAD \u2192 head-not-on-default wins (PR #12 C4)", () => {
    // Gap fill (C4): the wrapper's post-agent dispatch order is
    // documented at distill-wrapper.sh as:
    //   1. agent-timeout (rc 124/137)
    //   2. agent-exit-nonzero (rc != 0)
    //   3. validate_head_on_default → head-not-on-default
    //   4. validate_no_markers      → markers-after-agent-exit / etc.
    //   5. validate_commit_count    → no-content / agent-exit-nonzero
    //   6. detect_local_only        → merged-local / divergent-history
    //
    // When the agent leaves the vault in MULTIPLE invalid states
    // simultaneously, the earliest validator in this order wins.
    // This test pins the head-vs-markers ordering: agent commits a
    // file containing all-three markers AND switches off the default
    // branch. The wrapper should report `failed:head-not-on-default`
    // (head fires first), not `failed:markers-after-agent-exit`.
    //
    // Why this matters: forensic clarity. When triaging a failed
    // distill, the outcome class points the user at the right
    // recovery action. If a future refactor swapped the order, a
    // user with a wrong-HEAD-and-markers vault would get a recovery
    // hint about `git revert HEAD` (markers) when the actual primary
    // issue is HEAD itself — misleading.
    const s = makeScaffold();
    try {
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
# (a) commit a file with all-three markers on the default branch
cat > "${s.vault}/conflict.md" <<'MARKERS'
<<<<<<< HEAD
local
=======
remote
>>>>>>> feature
MARKERS
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: with markers" >/dev/null
# (b) then switch HEAD off default. Both invariants are now violated.
git -C "${s.vault}" checkout -q -b feature-branch
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(1);
      // head-on-default fires before validate_no_markers in the
      // wrapper's dispatch.
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

  // ---- validate_no_markers pre-existing classification (CORR-1) ----------
  // The pre-distill marker snapshot lets the wrapper distinguish:
  //   - NEW marker-bearing files post-distill        → markers-after-agent-exit
  //   - Only PRE-EXISTING marker-bearing files       → pre-existing-markers
  //                                                    (NOT agent-induced)
  //   - Both new AND pre-existing                    → markers-after-agent-exit
  //                                                    (dominant signal)
  //   - Pre-existing markers cleaned up by agent     → merged-content
  //                                                    (post snapshot empty)
  //
  // Helper: stage a pre-existing-markers file in the vault BEFORE the
  // wrapper runs (commits it to the seed history so the snapshot
  // captures it before the agent's stub mutates anything).
  function stagePreExistingMarkerFile(vault: string, relPath: string): void {
    const lines = [
      "# preexisting",
      "<<<<<<< HEAD",
      "local",
      "=======",
      "remote",
      ">>>>>>> feature",
      "trailing",
      "",
    ];
    fs.writeFileSync(path.join(vault, relPath), lines.join("\n"));
    spawnSync("git", ["-C", vault, "add", relPath]);
    spawnSync("git", [
      "-C",
      vault,
      "commit",
      "-m",
      `seed: pre-existing markers in ${relPath}`,
    ]);
  }

  test("validate_no_markers PASS (CORR-1): agent CLEANS pre-existing markers → merged-content", () => {
    // Pre-existing marker file is committed before the wrapper runs.
    // The stub-agent rewrites the file to remove all three marker
    // types and commits the cleanup. Post-distill snapshot is empty
    // → validate_no_markers returns rc 0 → merged-content.
    const s = makeScaffold();
    try {
      stagePreExistingMarkerFile(s.vault, "preexisting.md");
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
cat > "${s.vault}/preexisting.md" <<'BODY'
# preexisting (cleaned)
resolved content
BODY
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: clean pre-existing markers" >/dev/null
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(0);
      expect(r.outcome).toBe("merged-content");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("validate_no_markers FAIL (CORR-1): only pre-existing markers, agent untouched → failed:pre-existing-markers", () => {
    // Pre-existing marker file is committed before the wrapper runs.
    // The stub-agent commits a different file (so VAULT_COMMIT_COUNT
    // > 0 and we reach validate_no_markers) but doesn't touch the
    // pre-existing-markers file. Post-distill snapshot lists the
    // same single file as pre-distill snapshot → rc 2 →
    // failed:pre-existing-markers.
    const s = makeScaffold();
    try {
      stagePreExistingMarkerFile(s.vault, "preexisting.md");
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
echo "# new note" > "${s.vault}/note.md"
git -C "${s.vault}" add note.md
git -C "${s.vault}" commit -m "distill: new note" >/dev/null
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:pre-existing-markers");
      // Recovery hint surfaces in the outcome sidecar (lines 2+).
      // The wrapper's salvage() emits the pre-existing-markers hint
      // pointing the user at manual fix-up.
      expect(r.outcomePath).not.toBeNull();
      const raw = fs.readFileSync(r.outcomePath as string, "utf-8");
      expect(raw).toContain("already present in the vault before");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("validate_no_markers FAIL (CORR-1): pre-existing AND new markers → failed:markers-after-agent-exit (dominant signal)", () => {
    // Pre-existing marker file is committed before the wrapper runs.
    // The stub-agent commits a SECOND file with NEW markers in a
    // different path. Post-distill snapshot lists both files;
    // pre-distill lists only the first → set diff has at least one
    // NEW marker file → rc 1 → failed:markers-after-agent-exit. The
    // agent making things worse takes priority over the pre-existing
    // file's classification.
    const s = makeScaffold();
    try {
      stagePreExistingMarkerFile(s.vault, "preexisting.md");
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
cat > "${s.vault}/new-conflict.md" <<'MARKERS'
# new
<<<<<<< HEAD
local
=======
remote
>>>>>>> branch
end
MARKERS
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: agent-induced markers" >/dev/null
`,
      );
      const r = runWrapper(s);
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:markers-after-agent-exit");
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  test("validate_no_markers FAIL (CORR-1, regression guard): no pre-existing, agent introduces markers → failed:markers-after-agent-exit", () => {
    // Regression guard: the existing FAIL behaviour for an
    // agent-induced marker file (no pre-existing markers in the
    // vault) must continue to classify as markers-after-agent-exit,
    // not pre-existing-markers. This is the test that's already in
    // the file at line ~135 in spirit; we re-assert here to cement
    // that adding the pre-distill snapshot didn't change the
    // dominant fail path.
    const s = makeScaffold();
    try {
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

  test("validate_no_markers FAIL (CORR-1 R3 / SEC-1 R3): post-distill mktemp failure → failed:internal-validator-error (NOT markers-after-agent-exit)", () => {
    // CORR-1 R3 / SEC-1 R3 cross-reviewer consensus: when the
    // post-distill snapshot's mktemp call fails (full disk,
    // locked-down TMPDIR, etc.), the wrapper used to return rc 1 from
    // validate_no_markers → caller dispatched to
    // failed:markers-after-agent-exit. That misled the user into
    // believing the validator had observed markers in the vault when
    // it had never actually scanned. Fix: distinct rc 3 →
    // failed:internal-validator-error whose recovery hint truthfully
    // says "validator could not run" instead of "markers landed in
    // the vault."
    //
    // Simulating mktemp failure cleanly: a TMPDIR override would
    // also break the agent stub (which itself calls mktemp). Instead
    // we shim mktemp via PATH — a fake mktemp that fails for the
    // post-distill template and delegates to the real mktemp for
    // every other template (including pre-distill, the agent stub's
    // own usage, and the npm/bun toolchain).
    const s = makeScaffold();
    try {
      // Build a shim dir with a fake mktemp.
      const shimDir = path.join(s.root, "shim-bin");
      fs.mkdirSync(shimDir, { recursive: true });
      const realMktemp =
        spawnSync("command", ["-v", "mktemp"], {
          encoding: "utf-8",
          shell: true,
        }).stdout.trim() ||
        // Fallback to the canonical path if `command -v` returns
        // nothing under bun's restricted PATH (rare).
        "/usr/bin/mktemp";
      const fakeMktemp = path.join(shimDir, "mktemp");
      fs.writeFileSync(
        fakeMktemp,
        `#!/usr/bin/env bash
# Fail iff the template is the post-distill marker snapshot.
# Pre-distill marker snapshot uses napkin-distill-pre-marker; agent
# stub and toolchain use unrelated templates — those delegate to
# the real mktemp.
for arg in "$@"; do
  case "$arg" in
    *napkin-distill-post-marker*)
      echo "mktemp: simulated post-distill failure" >&2
      exit 1
      ;;
  esac
done
exec ${JSON.stringify(realMktemp)} "$@"
`,
        { mode: 0o755 },
      );
      writeStubPi(
        s,
        `
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
echo "# clean note" > "${s.vault}/note.md"
git -C "${s.vault}" add note.md
git -C "${s.vault}" commit -m "distill: clean note" >/dev/null
`,
      );
      const r = runWrapper(s, {
        extraEnv: {
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        },
      });
      expect(r.exitCode).toBe(1);
      expect(r.outcome).toBe("failed:internal-validator-error");
      // Recovery hint surfaces in the outcome sidecar (lines 2+).
      // It must explicitly say the validator could NOT run — the
      // whole point of the new reason code is to avoid the
      // "markers landed in the vault" misclassification.
      expect(r.outcomePath).not.toBeNull();
      const raw = fs.readFileSync(r.outcomePath as string, "utf-8");
      expect(raw).toContain("could NOT run");
      // Anti-regression: the previous (wrong) hint pointed the user
      // at reverting the squash on the claim that markers had
      // landed. Pin that the new hint does NOT make that false
      // claim outright — it offers revert as a CONDITIONAL recovery
      // step, gated on manual inspection.
      expect(raw).toContain("manually for unresolved");
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

  test("detect_local_only DIVERGENT: origin diverges from local \u2192 failed:divergent-history (SEC-A-1, SEC-1/CORR-2)", () => {
    // Spec at "Push behavior: never force" mandates a wrapper-side
    // ancestry check. Equality alone (the pre-fix detect_local_only)
    // couldn't distinguish a fast-forward push from a divergent
    // history: in either case after the agent's push fetches back,
    // local == origin. Here we simulate divergence by giving origin
    // a history that doesn't share commits with local's main beyond
    // the seed; the helper must return rc=2 and the wrapper must
    // classify as failed:divergent-history.
    //
    // The reason code was renamed from `force-push-detected` to
    // `divergent-history` in Pass 2A: the original name implied
    // attacker action when the common cause is a teammate (or the
    // user from another clone) pushing to origin while this distill
    // ran \u2014 a non-ancestral but entirely benign event. The recovery
    // hint now leads with the normal case.
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
      expect(r.outcome).toBe("failed:divergent-history");
      // The recovery hint should mention the common (third-party-push)
      // case so users aren't misled into thinking only an attack
      // produces this outcome (SEC-1/CORR-2).
      const sidecar = fs.readFileSync(r.outcomePath ?? "", "utf-8");
      expect(sidecar).toMatch(/diverged/);
      expect(sidecar).toMatch(/teammate|another clone/i);
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

describe("distill-wrapper.sh git env exports (PR #12 CLEAN-11)", () => {
  // CLEAN-11 defense-in-depth: the wrapper exports `GIT_TERMINAL_PROMPT=0`
  // and `GIT_EDITOR=true` near its other env exports so any git op
  // launched by the agent's bash tool fails fast on credential
  // prompts and substitutes a no-op for editor invocations. Without
  // these, a future prompt revision (or an agent that runs its own
  // `git pull` / `git commit -a` / `git revert`) could open
  // core.editor on a clean auto-merge — the agent's bash has no
  // TTY, so the call hangs indefinitely or returns non-zero.
  //
  // We assert (a) the export lines are present in the script source
  // (textual contract) and (b) a child process spawned via the
  // wrapper sees the env vars set (runtime contract). The latter is
  // covered by an end-to-end stub that exits the wrapper after
  // shim-install via NAPKIN_DISTILL_HALT_AFTER_SHIM, so we don't
  // depend on the agent loop to assert env propagation.

  test("wrapper script exports GIT_TERMINAL_PROMPT=0 and GIT_EDITOR=true", () => {
    const wrapper = fs.readFileSync(DISTILL_WRAPPER_SCRIPT, "utf-8");
    expect(wrapper).toMatch(/^export GIT_TERMINAL_PROMPT=0$/m);
    expect(wrapper).toMatch(/^export GIT_EDITOR=true$/m);
  });

  test("wrapper environment propagates GIT_TERMINAL_PROMPT and GIT_EDITOR to subprocesses", () => {
    // Spawn the wrapper with a stub pi that echoes its own env to a
    // sentinel file the test inspects. If the wrapper failed to
    // export the vars, the stub would see empty values.
    const s = makeWrapperScaffold("napkin-distill-clean-11-");
    try {
      const sentinel = path.join(s.root, "agent-env-sentinel.txt");
      // Stub records its inherited env, then commits a file so the
      // wrapper's post-validation reaches a healthy `merged-content`
      // outcome. We don't care about the outcome here — only that
      // the env values landed on disk before exit.
      writePiStub(
        s,
        `
printf 'GIT_TERMINAL_PROMPT=%s\nGIT_EDITOR=%s\n' "\${GIT_TERMINAL_PROMPT-unset}" "\${GIT_EDITOR-unset}" > ${JSON.stringify(sentinel)}
git -C "${s.vault}" config user.email test@example.com
git -C "${s.vault}" config user.name test
echo "x" > "${s.vault}/x.md"
git -C "${s.vault}" add .
git -C "${s.vault}" commit -m "distill: x" >/dev/null
`,
      );
      const pathHandle = withNapkinOnPath();
      try {
        const r = runWrapperWithStub(s);
        expect(r.exitCode).toBe(0);
        const captured = fs.readFileSync(sentinel, "utf-8");
        expect(captured).toContain("GIT_TERMINAL_PROMPT=0");
        expect(captured).toContain("GIT_EDITOR=true");
      } finally {
        pathHandle.restore();
      }
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });
});
