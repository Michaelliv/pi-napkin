/**
 * Unit tests for the distill prompt loader (PR #12 Item A1).
 *
 * The loader reads `extensions/distill/distill-prompt.md` and substitutes
 * four template placeholders. These tests cover:
 *   - happy path: returns string with placeholders substituted
 *   - empty input: throws (non-empty contract)
 *   - missing placeholder: throws when .md doesn't contain a required token
 *   - .md content invariants: 10 step markers + key prohibitive directives
 *     ("never use --force", "pull-merge", "do not loop indefinitely")
 *
 * Test isolation (CI-A-5): tests that exercise template error paths
 * (missing placeholder, empty file) write a degraded copy into a
 * per-test tmpdir and call `buildDistillPromptFromFile(<tmpdir-path>)`
 * — the shipped `.md` is never mutated. A regression-guard test at the
 * end of the file checksums the shipped `.md` to assert no test wrote
 * to the canonical path. Public-API callers (most tests) keep using
 * `buildDistillPrompt(inputs)` against the shipped artifact unchanged.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildDistillPrompt,
  buildDistillPromptFromFile,
  DISTILL_PROMPT_PATH,
} from "./distill-prompt";

const SAMPLE_INPUTS = {
  worktreePath: "/tmp/distill-worktree-abc123",
  vaultPath: "/home/user/.napkin/notes",
  branchName: "distill/abc123-1700000000000",
  defaultBranch: "main",
};

describe("buildDistillPrompt — placeholder substitution", () => {
  test("returns a non-empty string with all placeholders substituted", () => {
    const result = buildDistillPrompt(SAMPLE_INPUTS);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain(SAMPLE_INPUTS.worktreePath);
    expect(result).toContain(SAMPLE_INPUTS.vaultPath);
    expect(result).toContain(SAMPLE_INPUTS.branchName);
    expect(result).toContain(SAMPLE_INPUTS.defaultBranch);
    // No leftover unresolved placeholders.
    expect(result).not.toContain("{{worktreePath}}");
    expect(result).not.toContain("{{vaultPath}}");
    expect(result).not.toContain("{{branchName}}");
    expect(result).not.toContain("{{defaultBranch}}");
  });

  test("substitutes the same placeholder in multiple positions", () => {
    // {{worktreePath}} appears more than once in the template (in the
    // worktree-isolation prefix AND in step 7 / step 10). All occurrences
    // must be replaced — replaceAll, not replace.
    const result = buildDistillPrompt(SAMPLE_INPUTS);
    const occurrences = result.split(SAMPLE_INPUTS.worktreePath).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

describe("buildDistillPrompt — full-document snapshot (regression guard, PR #12 C3)", () => {
  // The other describe blocks in this file assert specific substrings
  // (10 step markers, prohibitive directives, the worktree-isolation
  // prefix). Those are good for catching the named invariants but they
  // can't catch unintended drift in the surrounding prose — a
  // copy-edit that softens "never use --force" to "avoid using --force"
  // would still pass the substring asserts but might change agent
  // behavior subtly.
  //
  // The snapshot below pins the FULL rendered prompt at known sample
  // inputs. Any intentional prompt edit will require updating the
  // snapshot file (`bun test -u`) and the diff is reviewable.
  //
  // Snapshot file: extensions/distill/__snapshots__/distill-prompt.test.ts.snap
  // (Bun's default location, sibling to the test file.)

  test("rendered prompt matches snapshot at canonical inputs", () => {
    const rendered = buildDistillPrompt(SAMPLE_INPUTS);
    expect(rendered).toMatchSnapshot();
  });
});

describe("buildDistillPrompt — input validation", () => {
  for (const key of [
    "worktreePath",
    "vaultPath",
    "branchName",
    "defaultBranch",
  ] as const) {
    test(`throws when '${key}' is empty`, () => {
      const bad = { ...SAMPLE_INPUTS, [key]: "" };
      expect(() => buildDistillPrompt(bad)).toThrow(
        new RegExp(`'${key}' must be a non-empty string`),
      );
    });
  }

  // SEC-A-5: control characters in any input would inject prose into
  // the agent's prompt (newline = step boundary breakout). The validator
  // rejects the full \x00–\x1F + \x7F range; we sample the most
  // dangerous representatives plus a few less obvious ones to catch a
  // regex regression that narrowed the range.
  for (const key of [
    "worktreePath",
    "vaultPath",
    "branchName",
    "defaultBranch",
  ] as const) {
    for (const [label, ch] of [
      ["NUL (\\x00)", "\x00"],
      ["newline (\\n)", "\n"],
      ["CR (\\r)", "\r"],
      ["tab (\\t)", "\t"],
      ["BEL (\\x07)", "\x07"],
      ["ESC (\\x1b)", "\x1b"],
      ["DEL (\\x7f)", "\x7f"],
    ] as const) {
      test(`throws when '${key}' contains ${label}`, () => {
        const bad = { ...SAMPLE_INPUTS, [key]: `prefix${ch}suffix` };
        expect(() => buildDistillPrompt(bad)).toThrow(
          new RegExp(`'${key}' contains control characters`),
        );
      });
    }
  }

  // SEC-A-5: placeholder-syntax collisions. A vault path containing
  // `{{worktreePath}}` would silently re-substitute on a second pass.
  for (const key of [
    "worktreePath",
    "vaultPath",
    "branchName",
    "defaultBranch",
  ] as const) {
    for (const collide of ["{{worktreePath}}", "prefix{{", "suffix}}"]) {
      test(`throws when '${key}' contains placeholder syntax (${JSON.stringify(collide)})`, () => {
        const bad = { ...SAMPLE_INPUTS, [key]: collide };
        expect(() => buildDistillPrompt(bad)).toThrow(
          new RegExp(`'${key}' contains placeholder-syntax characters`),
        );
      });
    }
  }

  // SEC-A-5 (regression guard): realistic, valid inputs must still pass.
  // Spaces in paths, slashes in branch names, hyphens / dots / tildes
  // are all common shapes the validator MUST NOT reject.
  test("accepts realistic paths with spaces, hyphens, dots", () => {
    const inputs = {
      worktreePath: "/Users/alice/My Vault/.cache/napkin-distill/abc/dist",
      vaultPath: "/Users/alice/My Vault/notes",
      branchName: "distill/abc-123-1700000000000",
      defaultBranch: "main",
    };
    expect(() => buildDistillPrompt(inputs)).not.toThrow();
  });

  test("accepts branch names with slashes (e.g. feat/foo)", () => {
    // Distill branches are always `distill/<hex>-<epoch>` but the
    // validator must also pass a hypothetical default-branch name like
    // `release/2026-q1`. Slashes are not control chars and not
    // mustache delimiters; the regex must not regress to forbid them.
    const inputs = {
      ...SAMPLE_INPUTS,
      defaultBranch: "release/2026-q1",
      branchName: "distill/feat-foo-1700000000000",
    };
    expect(() => buildDistillPrompt(inputs)).not.toThrow();
  });
});

describe("buildDistillPrompt — template error paths", () => {
  // CI-A-5: these tests exercise the loader's template-error branches
  // (missing placeholder, empty file). Earlier versions of this suite
  // mutated the shipped `.md` in place, which polluted the bundled
  // artifact between runs and risked committing test residue. We now
  // write the degraded template into a per-test-suite tmpdir and call
  // `buildDistillPromptFromFile(<tmpdir-path>)` — the seam exists
  // exactly so this test no longer touches the shipped file.

  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-prompt-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("throws when a required placeholder is missing from the template", () => {
    // Write a template with only 3 of the 4 placeholders.
    const incomplete =
      "Worktree at {{worktreePath}}, vault at {{vaultPath}}, branch {{branchName}}. (no defaultBranch)";
    const fakePath = path.join(tmpDir, "missing-placeholder.md");
    fs.writeFileSync(fakePath, incomplete, "utf-8");
    expect(() => buildDistillPromptFromFile(fakePath, SAMPLE_INPUTS)).toThrow(
      /missing required placeholder '\{\{defaultBranch\}\}'/,
    );
  });

  test("throws when the template is empty", () => {
    const fakePath = path.join(tmpDir, "empty.md");
    fs.writeFileSync(fakePath, "", "utf-8");
    expect(() => buildDistillPromptFromFile(fakePath, SAMPLE_INPUTS)).toThrow(
      /is empty/,
    );
  });

  test("throws when the template file is missing", () => {
    // Bonus coverage for the read-failure branch — not previously
    // exercised because the shipped path always existed.
    const fakePath = path.join(tmpDir, "does-not-exist.md");
    expect(() => buildDistillPromptFromFile(fakePath, SAMPLE_INPUTS)).toThrow(
      /failed to read prompt template/,
    );
  });
});

describe("buildDistillPromptFromFile — path-injection seam (CI-A-5)", () => {
  // Smoke test for the public seam: a tmpdir copy of the shipped .md
  // produces the same output as the default `buildDistillPrompt` call.
  // This locks the seam in: future refactors that would silently drop
  // the override (e.g. caching the path at module load) break this test.

  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-prompt-seam-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("buildDistillPromptFromFile against a copy returns same output as buildDistillPrompt", () => {
    const copyPath = path.join(tmpDir, "distill-prompt.md");
    fs.copyFileSync(DISTILL_PROMPT_PATH, copyPath);
    const fromDefault = buildDistillPrompt(SAMPLE_INPUTS);
    const fromCopy = buildDistillPromptFromFile(copyPath, SAMPLE_INPUTS);
    expect(fromCopy).toBe(fromDefault);
  });
});

describe("distill-prompt.md — content invariants", () => {
  // Read the template directly (bypass the loader's substitution) so we
  // assert on the source-of-truth shape, not on a particular substitution.
  const template = fs.readFileSync(DISTILL_PROMPT_PATH, "utf-8");

  test("template is non-empty", () => {
    expect(template.length).toBeGreaterThan(0);
  });

  test("template contains all 4 required placeholders", () => {
    expect(template).toContain("{{worktreePath}}");
    expect(template).toContain("{{vaultPath}}");
    expect(template).toContain("{{branchName}}");
    expect(template).toContain("{{defaultBranch}}");
  });

  test("template contains all 10 numbered step markers", () => {
    // We assert on `<n>.` at line-start (Markdown ordered-list shape) so
    // that a stray `1.` inside a sentence doesn't false-positive. The
    // 6th step is the frontmatter convention paragraph (numbered to
    // keep step counts aligned with the design spec).
    for (let n = 1; n <= 10; n++) {
      const stepHeader = new RegExp(`^${n}\\.`, "m");
      expect(template).toMatch(stepHeader);
    }
  });

  test("template prohibits force-push", () => {
    // Per design.md "Push behavior: never force". The .md must contain
    // explicit prohibitive language so the agent doesn't invent a
    // recovery path that calls `--force` or `--force-with-lease`.
    expect(template).toMatch(/--force/);
    expect(template).toMatch(/--force-with-lease|NEVER use `--force`/);
  });

  test("template prefers pull-merge over pull-rebase on push contention", () => {
    // Per design.md "Pull-merge, not pull-rebase". The .md must mention
    // pull-merge as the recovery path; "rebase" should appear only in
    // the prohibitive context (or not at all).
    expect(template).toMatch(/pull-merge/i);
  });

  test("template tells the agent not to loop indefinitely on push failure", () => {
    // Per design.md "Push behavior" agent-policy section.
    expect(template).toMatch(/do not loop indefinitely/i);
  });

  test("template contains the worktree-isolation cwd contract from POST-R6-CACHE", () => {
    // Per design.md "Open questions" → "Worktree-isolation prompt prefix
    // from POST-R6-CACHE: keep". The opening lines must spell out the
    // cwd contract: agent's shell cwd is PARENT_CWD, NOT the worktree,
    // so git ops must use `git -C {{worktreePath}}`. Replaces the
    // pre-fix "You are running in an isolated git worktree at..."
    // wording (CLEAN-A-2 / CLEAN-A-3) which falsely claimed cwd was
    // the worktree.
    expect(template).toMatch(/git -C \{\{worktreePath\}\}/);
    expect(template).toMatch(/your shell cwd is NOT the worktree/i);
  });

  test("step 7 uses `git -C {{worktreePath}}` for all git operations (CLEAN-A-2)", () => {
    // Step 7 commits + merges from inside the worktree. Bare
    // `git merge` / `git add -A` / `git commit -m` would run against
    // PARENT_CWD (the agent's actual shell cwd) and either corrupt the
    // parent project repo or fail. Every git invocation in step 7
    // must be qualified with `-C {{worktreePath}}`.
    const lines = template.split("\n");
    const start = lines.findIndex((l) => /^7\. /.test(l));
    expect(start).toBeGreaterThan(-1);
    // Step 7 ends where step 8 begins.
    const end = lines.findIndex((l, i) => i > start && /^8\. /.test(l));
    expect(end).toBeGreaterThan(start);
    const step7 = lines.slice(start, end).join("\n");

    // Each git operation in step 7 must use `git -C {{worktreePath}}`.
    expect(step7).toMatch(/git -C \{\{worktreePath\}\} add -A/);
    expect(step7).toMatch(/git -C \{\{worktreePath\}\} commit -m/);
    expect(step7).toMatch(
      /git -C \{\{worktreePath\}\} merge --no-edit \{\{defaultBranch\}\}/,
    );
    expect(step7).toMatch(/git -C \{\{worktreePath\}\} add \./);
    expect(step7).toMatch(/git -C \{\{worktreePath\}\} commit --no-edit/);

    // No bare git invocations on a line by themselves (after stripping
    // leading whitespace). The conflict-marker prose contains the
    // word "git" inside backticks, which is fine; what we forbid is a
    // command line like `       git merge {{defaultBranch}}`.
    const codeLines = step7.split("\n").filter((l) => /^\s{4,}git\b/.test(l));
    for (const codeLine of codeLines) {
      expect(codeLine).toMatch(/git -C \{\{worktreePath\}\}/);
    }
  });

  test("step 7 merge uses --no-edit to avoid TTY-editor hang (CLEAN-11)", () => {
    // Round 2 regression: without `--no-edit`, `git merge` on a clean
    // auto-merge (non-fast-forward) opens core.editor for the merge
    // commit message. The agent's bash tool has no TTY, so the editor
    // call hangs or returns non-zero — the agent then retries blindly
    // or aborts the distill. The prompt MUST pass `--no-edit` so git
    // accepts its auto-generated message non-interactively.
    expect(template).toMatch(
      /git -C \{\{worktreePath\}\} merge --no-edit \{\{defaultBranch\}\}/,
    );
    // No bare `git -C {{worktreePath}} merge {{defaultBranch}}` on a
    // line by itself (without --no-edit). Use a negative lookahead to
    // catch a regression that would silently drop the flag.
    expect(template).not.toMatch(
      /git -C \{\{worktreePath\}\} merge \{\{defaultBranch\}\}/,
    );
  });

  test("step 7 has an explicit no-content branch that skips to step 10 (CLEAN-5)", () => {
    // Round 2 finding: if the agent decided nothing in the conversation
    // merits capturing (per the "Be selective" directive), running step
    // 7's `git commit -m "distill: ..."` would fail with `nothing to
    // commit, working tree clean` and the agent would interpret that
    // as an error. The prompt must explicitly tell the agent how to
    // exit cleanly in the no-content case: skip steps 7-9 and jump
    // straight to step 10 cleanup. The wrapper's commit-count
    // validator then classifies the run as `no-content` (a warning,
    // not a failure).
    const lines = template.split("\n");
    const start = lines.findIndex((l) => /^7\. /.test(l));
    const end = lines.findIndex((l, i) => i > start && /^8\. /.test(l));
    const step7 = lines.slice(start, end).join("\n");
    expect(step7).toMatch(/nothing in this conversation merits capturing/i);
    expect(step7).toMatch(/skip steps 7-9/i);
    expect(step7).toMatch(/step 10/);
  });

  test("prefix scopes the vault-path prohibition to file-edit phase (CLEAN-4)", () => {
    // Round 2 regression: Pass 1A's CLEAN-A-2 fix introduced an opening
    // paragraph that read "Do NOT mix worktree files with the main
    // vault path" without scope, which contradicts steps 8-10's
    // explicit `git -C {{vaultPath}}` operations. A literalist agent
    // could refuse to run step 8's squash-merge against `{{vaultPath}}`.
    // The prefix must distinguish (1) the distill-content phase
    // (steps 1-6, edits go to the worktree only) from (2) the
    // integration phase (steps 7-10, git commands against
    // `{{vaultPath}}` are correct and required).
    expect(template).toMatch(/steps 1-6/);
    expect(template).toMatch(/steps 7-10/);
    // The integration-phase clause must explicitly call out
    // `git -C {{vaultPath}}` as legitimate, not a violation.
    expect(template).toMatch(/git -C \{\{vaultPath\}\}/);
  });

  test("step 9 pull recovery uses --no-rebase (SEC-A-6)", () => {
    // The agent's pull recovery must override any global
    // `pull.rebase=true` config the user may have set. Without
    // `--no-rebase`, a rebase silently rewrites the recovery commit
    // shape and breaks the design's "linear forensic record" promise.
    expect(template).toMatch(
      /git -C \{\{vaultPath\}\} pull --no-rebase origin \{\{defaultBranch\}\}/,
    );
    // No bare `git pull origin` (without --no-rebase) anywhere in the
    // template, so the agent can't be tempted to copy a flagless variant.
    expect(template).not.toMatch(
      /git -C \{\{vaultPath\}\} pull origin \{\{defaultBranch\}\}(?!.*--no-rebase)/m,
    );
  });
});

describe("distill-prompt.md — shipped artifact is unmodified by tests (CI-A-5)", () => {
  // Regression guard: the test suite must NEVER write to the shipped
  // .md. Earlier revisions of distill-prompt.test.ts mutated the file
  // in place during template-error tests, polluting the bundled
  // artifact between runs and risking committing test residue. After
  // the path-injection seam refactor, all mutating tests target a
  // tmpdir copy via `buildDistillPromptFromFile`. We capture the
  // shipped .md's hash at suite start and re-check at the end of this
  // describe block (which Bun runs after the prior describes per
  // file-order). If the hash drifts, a future test has reintroduced
  // direct mutation — fail loudly.
  //
  // Note: this isn't a perfect guard (the file could be mutated and
  // restored between the two reads), but in practice the prior
  // pattern was "mutate, finally restore on the SAME test", which
  // would still leak if the test crashed before the finally. The
  // refactor eliminates the mutation pattern entirely; this test is
  // the canary that catches regressions.

  const expectedHash = createHash("sha256")
    .update(fs.readFileSync(DISTILL_PROMPT_PATH))
    .digest("hex");

  test("shipped distill-prompt.md sha256 is stable across the suite", () => {
    const currentHash = createHash("sha256")
      .update(fs.readFileSync(DISTILL_PROMPT_PATH))
      .digest("hex");
    expect(currentHash).toBe(expectedHash);
  });
});
