/**
 * Distill prompt loader.
 *
 * The agent-driven distill prompt lives as markdown at
 * `extensions/distill/distill-prompt.md`, with template placeholders the
 * wrapper resolves at spawn time. This module reads that .md at runtime,
 * substitutes the placeholders, and returns the resolved string for the
 * wrapper to pass to `pi -p`.
 *
 * Why markdown + a loader (PR #12 design — "DISTILL_PROMPT location"):
 *   - Easier to edit / iterate the prompt without touching code
 *   - Markdown rendering in editors makes the prompt readable as prose
 *   - Snapshot tests assert prompt content directly against the .md
 *   - Bundled with npm publish via `package.json` `files` entry
 *
 * The loader is strict on placeholder coverage: every required placeholder
 * MUST be present in the .md OR the loader throws. This protects against
 * silent drift where a refactor renames a placeholder in the .md but
 * leaves the TS-side input shape intact, sending an unresolved
 * `{{worktreePath}}` literal to the agent. Per the methodology guide's
 * never-deferrable categories, "stale references to renamed concepts" are
 * a fix-now class — failing fast at load time keeps them out of agent
 * prompts entirely.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const _here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the distill prompt markdown file. */
export const DISTILL_PROMPT_PATH: string = path.join(
  _here,
  "distill-prompt.md",
);

/**
 * Inputs to {@link buildDistillPrompt}. All four placeholders MUST be
 * provided; passing an empty string is disallowed because that would
 * produce an agent prompt with `git merge ` (empty branch name) or
 * `cd ` (empty path) — silent corruption rather than fail-fast.
 */
export interface DistillPromptInputs {
  /** Absolute path to the per-distill git worktree. Substituted for `{{worktreePath}}`. */
  worktreePath: string;
  /** Absolute path to the main vault (the worktree's parent repo). Substituted for `{{vaultPath}}`. */
  vaultPath: string;
  /** Distill branch name, e.g. `distill/abc123-1700000000000`. Substituted for `{{branchName}}`. */
  branchName: string;
  /** Vault's default mainline branch (`main`, `master`, ...). Substituted for `{{defaultBranch}}`. */
  defaultBranch: string;
}

/**
 * Required placeholders the .md template must contain. Order matches the
 * order they appear in the template; the validator below iterates this
 * list to surface a precise diagnostic when one is missing.
 */
const REQUIRED_PLACEHOLDERS = [
  "{{worktreePath}}",
  "{{vaultPath}}",
  "{{branchName}}",
  "{{defaultBranch}}",
] as const;

/**
 * Validate a single substitution input. Used for every field of
 * {@link DistillPromptInputs}. Hard rejects:
 *
 *   1. Non-string / empty string — silent prompt corruption (e.g.
 *      `git merge ` with empty branch name) is worse than a loud
 *      validation throw.
 *   2. ASCII control characters (NUL, BEL, BS, TAB, LF, CR, ESC, DEL,
 *      …; the `\x00–\x1F` and `\x7F` ranges). A `\n` in
 *      `worktreePath` would inject a newline into the agent's prompt,
 *      letting an attacker who controls a single field break out of
 *      one prompt-step and inject prose into another (prompt-
 *      injection class). NUL bytes truncate strings on most C-side
 *      consumers (the wrapper's `printf`, `git`'s argv parsing). TAB
 *      isn't strictly malicious but its inclusion in agent prompts
 *      breaks the `git -C "<tab>worktree"` quoting we rely on.
 *   3. Mustache-style `{{` or `}}` runs — collide with the
 *      placeholder syntax this loader uses. A vault path that
 *      contained `{{worktreePath}}` would silently re-substitute
 *      itself on a second pass; even though we don't multi-pass
 *      today, defending the input shape lets future refactors of
 *      the substitution loop stay safe.
 *
 * Defense-in-depth (SEC-A-5): the JS-side caller already controls
 * three of the four inputs (`worktreePath`, `branchName`,
 * `defaultBranch` come from `createDistillWorkspace` /
 * `detectDefaultBranch` which produce well-formed strings).
 * `vaultPath` originates from the user's config but is
 * `path.resolve`d before reaching here. So the realistic threat
 * surface is narrow — but the validator is cheap, the failure mode
 * is "throw with a clear message", and a future caller that bypasses
 * the helpers (or a malformed config) would otherwise let bad input
 * reach the agent prompt.
 *
 * Slashes (`/`), spaces, hyphens, dots, and underscores are all
 * allowed: `feat/foo` branch names and `~/My Vault/notes` paths must
 * pass.
 */
function validateInput(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `buildDistillPrompt: input '${name}' must be a non-empty string (got ${JSON.stringify(value)})`,
    );
  }
  // Reject ASCII control chars (\x00–\x1F and \x7F). A literal `\n`
  // in any input would break out of the prompt step it's embedded
  // in — classic prompt-injection. JSON.stringify the value in the
  // error so the offending char is visible (escaped) in the message.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control chars IS the validator's job
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw new Error(
      `buildDistillPrompt: input '${name}' contains control characters; reject (got ${JSON.stringify(value)})`,
    );
  }
  // Reject placeholder-syntax collisions. A vault path that contained
  // `{{worktreePath}}` would silently re-substitute on a second pass
  // — defense-in-depth for future refactors of the substitution loop.
  if (value.includes("{{") || value.includes("}}")) {
    throw new Error(
      `buildDistillPrompt: input '${name}' contains placeholder-syntax characters '{{' or '}}' (got ${JSON.stringify(value)})`,
    );
  }
}

/**
 * Read a distill prompt markdown template from `promptPath` and
 * substitute placeholders. The path-injected core of the loader.
 *
 * Test seam (CI-A-5): production callers should use
 * {@link buildDistillPrompt}, which delegates to this helper with
 * {@link DISTILL_PROMPT_PATH}. Tests that need to exercise template
 * error paths (missing placeholder, empty template) point this at a
 * tmpdir copy of the .md so the shipped artifact is never mutated.
 *
 * @throws Error if the .md file is missing, empty, or omits any required
 *         placeholder. Throws if any input value is empty (per the
 *         {@link DistillPromptInputs} contract).
 *
 * Pure function aside from the .md read: the loader does not cache, so
 * tests that mutate the file (or replace it via mocked fs) see the
 * fresh contents on each call. The .md is small (a few KB); re-reading
 * it on each spawn is cheap relative to the agent task itself (60s+).
 */
export function buildDistillPromptFromFile(
  promptPath: string,
  inputs: DistillPromptInputs,
): string {
  for (const [key, value] of Object.entries(inputs)) {
    validateInput(key, value);
  }

  let template: string;
  try {
    template = fs.readFileSync(promptPath, "utf-8");
  } catch (err) {
    throw new Error(
      `buildDistillPrompt: failed to read prompt template at ${promptPath}: ${(err as Error).message}`,
    );
  }
  if (template.length === 0) {
    throw new Error(
      `buildDistillPrompt: prompt template at ${promptPath} is empty`,
    );
  }

  for (const placeholder of REQUIRED_PLACEHOLDERS) {
    if (!template.includes(placeholder)) {
      throw new Error(
        `buildDistillPrompt: prompt template at ${promptPath} is missing required placeholder '${placeholder}'`,
      );
    }
  }

  // Map placeholder → input key. Keep this aligned with REQUIRED_PLACEHOLDERS
  // so the missing-placeholder error and the substitution loop never drift.
  const substitutions: Array<[string, string]> = [
    ["{{worktreePath}}", inputs.worktreePath],
    ["{{vaultPath}}", inputs.vaultPath],
    ["{{branchName}}", inputs.branchName],
    ["{{defaultBranch}}", inputs.defaultBranch],
  ];

  let result = template;
  for (const [placeholder, value] of substitutions) {
    // String#replaceAll on each placeholder; values are not regex-special
    // because they're filesystem paths or branch names. Even if a path
    // contained a `$` or `\`, replaceAll on a literal string (not regex)
    // is escape-safe.
    result = result.replaceAll(placeholder, value);
  }

  return result;
}

/**
 * Read the shipped distill prompt markdown and substitute placeholders.
 * Public API — production callers should use this. Delegates to
 * {@link buildDistillPromptFromFile} with the bundled .md path.
 *
 * @throws Error if the .md file is missing, empty, or omits any required
 *         placeholder. Throws if any input value is empty (per the
 *         {@link DistillPromptInputs} contract).
 */
export function buildDistillPrompt(inputs: DistillPromptInputs): string {
  return buildDistillPromptFromFile(DISTILL_PROMPT_PATH, inputs);
}
