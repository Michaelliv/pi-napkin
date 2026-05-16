#!/usr/bin/env bun
/**
 * verify-agent-prompt — replay a synthetic distill fixture against the
 * real LLM to confirm the prompt at `extensions/distill/distill-prompt.md`
 * still produces clean instruction-following on a multi-step procedure.
 *
 * This is the (b) gate from PR #12 (manual on-demand re-validation when
 * the prompt is edited or a model is rotated). CI uses bash-stub
 * fixtures under `extensions/distill/test-fixtures/agent-stubs/` instead
 * (Phase C) to avoid burning tokens.
 *
 * What it does:
 *
 *   1. Creates a tmpdir at `${TMPDIR:-/tmp}/napkin-verify-agent-prompt-XXXXXX`.
 *   2. `git init` a vault, commits a baseline `note.md`.
 *   3. Branches off `distill/verify-<short-sha>` and commits a divergent
 *      edit to `note.md` (mimicking what steps 1-6 of the real distill
 *      prompt would have produced).
 *   4. Returns to main, commits a SECOND divergent edit on the same
 *      file. Now `git merge main` from the distill branch is guaranteed
 *      to conflict — exercising the conflict-resolution code path the
 *      real prompt's step 7 instructs the agent to walk.
 *   5. Pre-populates `<tmpdir>/session.jsonl` with a synthetic
 *      user-assistant conversation on a concrete technical topic. Pi's
 *      `-p` mode appends to (rather than replaces) an existing session
 *      file, so the agent sees this prior conversation as context. The
 *      synthetic content is substantive enough that the prompt's
 *      "Be selective" gate (step 7's no-content escape hatch from PR #12
 *      Phase A Pass 2A's CLEAN-5 fix) does NOT trigger — the agent
 *      proceeds to the merge/squash/cleanup integration path.
 *   6. Builds the prompt via the bundled
 *      {@link buildDistillPrompt}, substituting the tmpdir paths.
 *   7. Invokes `pi --session $TMPDIR/session.jsonl --model $MODEL -p $PROMPT`
 *      with `NAPKIN_DISTILL_NO_RECURSE=1` so a nested distill can't
 *      re-spawn against this verification vault.
 *   8. After pi exits, runs six post-conditions on the resulting vault:
 *        a. No conflict markers in `*.md`
 *        b. Vault HEAD on default branch
 *        c. New squash commit on default branch
 *           (rev-list --count >= 2 — fixture pre-adds 1 "main edit"
 *           commit before pi runs, so >= 2 means the agent landed at
 *           least 1 squash on top of it)
 *        d. Distill branch removed (or only worktree-tracked)
 *        e. Worktree removed from `git worktree list`
 *           (V2's "no force-push attempted" is unverifiable on this
 *           remoteless fixture; this slot substitutes the design-locked
 *           post-validation requirement that the wrapper teardown left
 *           no worktree behind)
 *        f. Conflict resolution shape — `note.md` no longer has markers
 *           and at least one source version's text survived
 *
 *   Prints a PASS / FAIL summary, exits 0 on PASS, 1 on FAIL.
 *
 * Production code never runs this. The script lives outside `extensions/`
 * to avoid being mistaken for a runtime asset, and is gated on a `bun run`
 * entry point so accidental imports can't trigger live LLM calls.
 *
 * Caveats:
 *   - LLM-side variance: a single failure run is NOT a definitive
 *     verdict — instruction-following has known multi-run variance.
 *     Re-run 2-3 times before declaring a regression.
 *   - Cost: a single run is ~$0.50 of token-equivalent on Anthropic API
 *     pricing (per V2 measurement: ~162k cumulative input, 344 output).
 *     Kiro provider reports `cost: 0` (seat-billed).
 *
 * Usage:
 *   bun run verify:agent-prompt
 *   bun run verify:agent-prompt -- --model kiro/claude-sonnet-4-6
 *   bun run verify:agent-prompt -- --keep-tmpdir
 *   bun run verify:agent-prompt -- --help
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildDistillPrompt } from "../extensions/distill/distill-prompt";

interface Args {
  model: string;
  keepTmpdir: boolean;
  timeoutSecs: number;
  help: boolean;
}

const DEFAULT_MODEL = "kiro/claude-sonnet-4-6";
const DEFAULT_TIMEOUT_SECS = 300;

const HELP = `verify-agent-prompt — replay a synthetic distill fixture against the real LLM

Usage: bun run verify:agent-prompt [-- <flags>]

Flags:
  --model <provider>/<id>     Model to invoke (default: ${DEFAULT_MODEL}, or
                              read from ~/.config/napkin/config.json's vault
                              if set there).
  --timeout-secs <n>          Max wall-clock for the pi invocation (default
                              ${DEFAULT_TIMEOUT_SECS}). The wrapper's
                              \`distill.maxDurationMinutes\` is unrelated;
                              this is purely the verification harness budget.
  --keep-tmpdir               Don't rm the tmpdir on exit (forensic).
  --help, -h                  Print this and exit 0.

Notes:
  - This script invokes a real LLM. Per V2 measurement, a single run is
    ~$0.50 of token-equivalent at Anthropic API rates. Kiro provider
    bills via seat (reports $0).
  - CI does not run this — it uses bash-stub fixtures under
    extensions/distill/test-fixtures/agent-stubs/. Run this locally
    after editing extensions/distill/distill-prompt.md.

Exit codes:
  0  — All 6 post-conditions passed.
  1  — One or more post-conditions failed; see printed summary.
  2  — Setup error (mktemp failed, pi binary missing, etc.).
`;

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    model: "",
    keepTmpdir: false,
    timeoutSecs: DEFAULT_TIMEOUT_SECS,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--keep-tmpdir") args.keepTmpdir = true;
    else if (a === "--model") {
      const next = argv[i + 1];
      if (!next) throw new Error("--model requires a value");
      args.model = next;
      i++;
    } else if (a.startsWith("--model=")) {
      args.model = a.slice("--model=".length);
    } else if (a === "--timeout-secs") {
      const next = argv[i + 1];
      if (!next) throw new Error("--timeout-secs requires a value");
      args.timeoutSecs = parseTimeoutOrThrow(next);
      i++;
    } else if (a.startsWith("--timeout-secs=")) {
      args.timeoutSecs = parseTimeoutOrThrow(a.slice("--timeout-secs=".length));
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

function parseTimeoutOrThrow(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--timeout-secs must be a positive integer (got ${raw})`);
  }
  return n;
}

/**
 * Resolve the model. Priority:
 *   1. Explicit --model flag (returned as-is).
 *   2. Vault `distill.model.{provider,id}` from
 *      `<global-config-vault>/.napkin/config.json`.
 *   3. {@link DEFAULT_MODEL}.
 *
 * Step 2 reads the global napkin config (`$XDG_CONFIG_HOME/napkin/config.json`
 * or `~/.config/napkin/config.json`) for its `vault` field, then reads
 * that vault's `.napkin/config.json` for `distill.model.{provider,id}`.
 * Either step missing falls through to {@link DEFAULT_MODEL}.
 */
function resolveModel(explicit: string): string {
  if (explicit) return explicit;
  try {
    const xdg =
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const globalCfg = JSON.parse(
      fs.readFileSync(path.join(xdg, "napkin", "config.json"), "utf-8"),
    );
    let vault = globalCfg?.vault;
    if (typeof vault !== "string") return DEFAULT_MODEL;
    if (vault.startsWith("~/")) vault = path.join(os.homedir(), vault.slice(2));
    const vaultCfgPath = path.join(vault, ".napkin", "config.json");
    if (!fs.existsSync(vaultCfgPath)) return DEFAULT_MODEL;
    const vaultCfg = JSON.parse(fs.readFileSync(vaultCfgPath, "utf-8"));
    const provider = vaultCfg?.distill?.model?.provider;
    const id = vaultCfg?.distill?.model?.id;
    if (typeof provider === "string" && typeof id === "string") {
      return `${provider}/${id}`;
    }
  } catch {
    // Any read/parse error → fall through to default.
  }
  return DEFAULT_MODEL;
}

interface Fixture {
  tmpdir: string;
  vaultPath: string;
  worktreePath: string;
  branchName: string;
  defaultBranch: string;
  /** SHA of the vault's default branch BEFORE the agent ran. */
  startSha: string;
  /** Absolute path to the pre-populated session JSONL file pi will load. */
  sessionPath: string;
}

/**
 * Synthetic 6-message conversation written to `<tmpdir>/session.jsonl`
 * before pi is invoked.
 *
 * Why this exists: PR #12 Phase A Pass 2A's CLEAN-5 fix added an
 * explicit no-content escape hatch at step 7 of
 * `extensions/distill/distill-prompt.md`. If the agent decides nothing
 * in the conversation merits capturing (per the "Be selective"
 * directive), it skips merge/squash/push and exits cleanly. Without a
 * pre-populated session, pi's `-p` mode hands the agent only the prompt
 * itself — no prior conversation — and the agent (correctly) concludes
 * "no content to distill" and bails, failing post-condition (c) (squash
 * commit on default branch).
 *
 * The conversation below is a concrete debugging Q&A about Node EPIPE
 * handling on `spawnSync`. It's substantive (~600 chars of takeaway
 * material), on a single technical topic, and produces a clear
 * actionable insight an engineer would want to capture as a guide note.
 * That's enough to trip the "yes, capture" branch of "Be selective".
 *
 * Topic choice: this codebase itself uses `spawnSync` extensively
 * (including in this verification script), so the conversation reads
 * as a plausible artifact of someone working on adjacent code.
 */
const SYNTHETIC_CONVERSATION: ReadonlyArray<{
  role: "user" | "assistant";
  text: string;
}> = [
  {
    role: "user",
    text: "I'm getting intermittent EPIPE crashes in a Node script that uses spawnSync with stdio:'inherit' to invoke git inside a larger pipeline. The parent of my Node process is sometimes `head -1`. What's actually happening, and how should I handle it cleanly?",
  },
  {
    role: "assistant",
    text: "EPIPE on a spawnSync child with stdio:'inherit' means the *parent* process's stdout was closed by its downstream consumer (your `head -1`) before the child finished writing. With 'inherit', the child writes directly to the parent's fd 1 — so the broken-pipe condition propagates straight through. Three things to know:\n\n1. spawnSync surfaces this as `r.signal === 'SIGPIPE'` and `r.status === null`, not as a thrown exception. You must check `r.signal` explicitly; checking only `r.status !== 0` will miss it.\n2. Node's default SIGPIPE behavior on child processes is to terminate, which is what you want — masking SIGPIPE globally hides real bugs.\n3. If you want the parent script to exit gracefully when this happens (rather than treating it as a fatal error), branch on `r.signal === 'SIGPIPE'` and exit 0.",
  },
  {
    role: "user",
    text: "Does this also apply to spawnSync with stdio:'pipe' where I read r.stdout afterwards?",
  },
  {
    role: "assistant",
    text: "No — with stdio:'pipe', spawnSync buffers the child's stdout into r.stdout itself, and the child writes to a pipe owned by Node, not to the parent's stdout. SIGPIPE on the *parent* won't propagate to the child because there's no shared write-end. You'd only see EPIPE in the 'pipe' case if you explicitly forward r.stdout to a closed stream after spawnSync returns. The 'inherit' vs 'pipe' distinction is the key — 'inherit' shares fds, 'pipe' doesn't.",
  },
  {
    role: "user",
    text: "So what's the takeaway I should write down for next time?",
  },
  {
    role: "assistant",
    text: "Takeaway for spawnSync error handling:\n\n- Always check both `r.status` AND `r.signal`. Status alone misses signal-terminated children (SIGPIPE, SIGTERM, OOM kill).\n- With stdio:'inherit', signals from the parent's stdout consumer (e.g. `head` closing early) propagate to the child as SIGPIPE. Treat this as an expected exit, not an error.\n- With stdio:'pipe', the child is insulated from parent stdout state; EPIPE there means you misused r.stdout afterwards.\n- Don't `process.on('SIGPIPE', () => {})` to suppress it — that masks legitimate write failures elsewhere.",
  },
];

/**
 * Write a minimal but valid pi v3 session JSONL containing only the
 * synthetic conversation. Pi's session manager validates the header
 * (`type:"session", version:3`) and the parentId chain on load, then
 * appends the new prompt + assistant response when invoked with `-p`.
 *
 * Format reference: pi-coding-agent's `dist/core/session-manager.js`
 * (CURRENT_SESSION_VERSION=3, parseSessionEntries, _appendEntry).
 */
function writeSyntheticSession(sessionPath: string, cwd: string): void {
  const sessionId = randomBytes(16).toString("hex"); // simple UUID-shaped string is fine
  const baseTime = Date.parse("2026-05-15T12:00:00.000Z");
  const lines: string[] = [];

  lines.push(
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date(baseTime).toISOString(),
      cwd,
    }),
  );

  let prevId: string | null = null;
  SYNTHETIC_CONVERSATION.forEach((m, i) => {
    const id = randomBytes(4).toString("hex");
    const ts = new Date(baseTime + (i + 1) * 1000).toISOString();
    const messageBody: Record<string, unknown> = {
      role: m.role,
      content: [{ type: "text", text: m.text }],
      timestamp: baseTime + (i + 1) * 1000,
    };
    // Assistant entries get a model stamp; pi tolerates missing fields
    // here, but supplying them keeps the loader's model-resolution code
    // path consistent with what an organic session looks like.
    if (m.role === "assistant") {
      messageBody.api = "kiro-api";
      messageBody.provider = "kiro";
      messageBody.model = "claude-sonnet-4-6";
      messageBody.stopReason = "stop";
    }
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId: prevId,
        timestamp: ts,
        message: messageBody,
      }),
    );
    prevId = id;
  });

  fs.writeFileSync(sessionPath, `${lines.join("\n")}\n`);
}

/**
 * Build the synthetic vault + worktree fixture.
 *
 * Topology after this returns:
 *
 *     main:               note.md (baseline, then "main edit")
 *     distill/verify-X:   note.md (baseline, then "distill edit")
 *
 * Both branches edit the same line of note.md, so `git merge main` from
 * the distill branch hits a conflict the agent must resolve.
 */
function setupFixture(): Fixture {
  const tmpdir = fs.mkdtempSync(
    path.join(os.tmpdir(), "napkin-verify-agent-prompt-"),
  );

  const vaultPath = path.join(tmpdir, "vault");
  fs.mkdirSync(vaultPath);

  function gitVault(...args: string[]): { stdout: string; stderr: string } {
    const r = spawnSync("git", ["-C", vaultPath, ...args], {
      encoding: "utf-8",
    });
    if (r.status !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed (rc=${r.status}): ${r.stderr.trim()}`,
      );
    }
    return { stdout: r.stdout, stderr: r.stderr };
  }

  // Initialize the vault with explicit `main` so default-branch detection
  // is deterministic regardless of the user's git init.defaultBranch.
  const initRc = spawnSync("git", ["init", "-b", "main", vaultPath]);
  if (initRc.status !== 0) {
    throw new Error(`git init failed in ${vaultPath}`);
  }
  gitVault("config", "user.email", "verify@example.com");
  gitVault("config", "user.name", "verify");
  // GPG signing in CI/sandbox would silently fail; force-disable for the
  // ephemeral fixture.
  gitVault("config", "commit.gpgsign", "false");

  fs.writeFileSync(
    path.join(vaultPath, "note.md"),
    "---\ntitle: x\n---\n# baseline\n",
  );
  gitVault("add", ".");
  gitVault("commit", "-m", "verify: baseline note");

  const startSha = gitVault("rev-parse", "HEAD").stdout.trim();
  const branchName = `distill/verify-${startSha.slice(0, 8)}`;

  // Build the worktree at <tmpdir>/worktree on a new distill branch.
  const worktreePath = path.join(tmpdir, "worktree");
  gitVault("worktree", "add", "-b", branchName, worktreePath);

  // On the distill branch (in the worktree), write the "distilled" content.
  const wt = (...args: string[]) => {
    const r = spawnSync("git", ["-C", worktreePath, ...args], {
      encoding: "utf-8",
    });
    if (r.status !== 0) {
      throw new Error(
        `git -C worktree ${args.join(" ")} failed: ${r.stderr.trim()}`,
      );
    }
    return r;
  };
  wt("config", "user.email", "verify@example.com");
  wt("config", "user.name", "verify");
  wt("config", "commit.gpgsign", "false");
  fs.writeFileSync(
    path.join(worktreePath, "note.md"),
    "---\ntitle: x\n---\n# distill version\n",
  );
  wt("add", ".");
  wt("commit", "-m", "distill: verify content");

  // On main (the vault), make a divergent edit to the same file so the
  // worktree's `git merge main` will conflict.
  fs.writeFileSync(
    path.join(vaultPath, "note.md"),
    "---\ntitle: x\n---\n# main version after edit\n",
  );
  gitVault("add", ".");
  gitVault("commit", "-m", "verify: main edit");

  // Pre-populate session.jsonl with a synthetic conversation BEFORE pi
  // runs. This is the fix for the no-content-bail post-condition
  // failure introduced by Phase A Pass 2A's CLEAN-5 fix at step 7 of
  // distill-prompt.md — see SYNTHETIC_CONVERSATION docstring above.
  const sessionPath = path.join(tmpdir, "session.jsonl");
  writeSyntheticSession(sessionPath, vaultPath);

  return {
    tmpdir,
    vaultPath,
    worktreePath,
    branchName,
    defaultBranch: "main",
    startSha,
    sessionPath,
  };
}

interface PiResult {
  exitCode: number;
  signal: string | null;
  stderr: string;
}

function runPi(
  model: string,
  sessionPath: string,
  prompt: string,
  timeoutSecs: number,
): PiResult {
  const piBin = process.env.NAPKIN_DISTILL_PI_BIN || "pi";
  const r = spawnSync(
    piBin,
    ["--session", sessionPath, "--model", model, "-p", prompt],
    {
      env: {
        ...process.env,
        // Suppress recursive auto-distill in case the model has any
        // session-fork plumbing left over.
        NAPKIN_DISTILL_NO_RECURSE: "1",
      },
      stdio: ["ignore", "inherit", "pipe"],
      encoding: "utf-8",
      timeout: timeoutSecs * 1000,
      killSignal: "SIGTERM",
    },
  );
  return {
    exitCode: r.status ?? -1,
    signal: r.signal ?? null,
    stderr: r.stderr ?? "",
  };
}

interface PostConditionResult {
  name: string;
  passed: boolean;
  detail: string;
}

function assertPostConditions(f: Fixture): PostConditionResult[] {
  const results: PostConditionResult[] = [];

  // (a) No conflict markers in any tracked *.md in the vault.
  const grep = spawnSync(
    "grep",
    ["-rEnH", "^<{7} |^={7}$|^>{7} ", "--include=*.md", f.vaultPath],
    { encoding: "utf-8" },
  );
  results.push({
    name: "no conflict markers in *.md",
    passed: grep.status === 1, // grep exits 1 when no matches
    detail:
      grep.status === 1
        ? "no markers"
        : grep.status === 0
          ? `markers found:\n${grep.stdout.trim()}`
          : `grep failed (rc=${grep.status}): ${grep.stderr.trim()}`,
  });

  // (b) Vault HEAD on default branch.
  const headRef = spawnSync(
    "git",
    ["-C", f.vaultPath, "symbolic-ref", "--short", "HEAD"],
    { encoding: "utf-8" },
  );
  const head = headRef.stdout.trim();
  results.push({
    name: `vault HEAD on ${f.defaultBranch}`,
    passed: headRef.status === 0 && head === f.defaultBranch,
    detail:
      headRef.status === 0
        ? `HEAD is on '${head}'`
        : `symbolic-ref failed (detached HEAD?): ${headRef.stderr.trim()}`,
  });

  // (c) Squash commit landed on default. Count commits since startSha;
  //     1 means agent's squash, 0 means agent didn't squash, 2+ means
  //     agent committed multiple times (acceptable but logged).
  const commitCount = spawnSync(
    "git",
    ["-C", f.vaultPath, "rev-list", "--count", `${f.startSha}..HEAD`],
    { encoding: "utf-8" },
  );
  const count = Number.parseInt(commitCount.stdout.trim(), 10);
  // Note: the fixture itself adds 1 commit on main (the "main edit") so
  // the new-commits count from agent-perspective is `count - 1`.
  // Expected: count >= 2 (1 from fixture + at least 1 from agent's squash).
  results.push({
    name: "agent's squash commit landed on default",
    passed: Number.isFinite(count) && count >= 2,
    detail: Number.isFinite(count)
      ? `${count} commits since startSha (1 fixture + ${Math.max(0, count - 1)} agent)`
      : `rev-list failed: ${commitCount.stderr.trim()}`,
  });

  // (d) Distill branch removed.
  const branchList = spawnSync(
    "git",
    ["-C", f.vaultPath, "branch", "--list", f.branchName],
    { encoding: "utf-8" },
  );
  results.push({
    name: `distill branch '${f.branchName}' removed`,
    passed: branchList.stdout.trim() === "",
    detail:
      branchList.stdout.trim() === ""
        ? "removed"
        : `still present: ${branchList.stdout.trim()}`,
  });

  // (e) Worktree removed (or removable).
  const worktreeList = spawnSync(
    "git",
    ["-C", f.vaultPath, "worktree", "list", "--porcelain"],
    { encoding: "utf-8" },
  );
  const worktreeStillTracked = worktreeList.stdout
    .split("\n")
    .some((line) => line === `worktree ${f.worktreePath}`);
  results.push({
    name: `worktree at ${path.basename(f.worktreePath)} removed`,
    passed: !worktreeStillTracked,
    detail: worktreeStillTracked
      ? `worktree still tracked: ${f.worktreePath}`
      : "removed",
  });

  // (f) Conflict resolution shape — note.md exists, has no markers,
  //     and the resolved content includes content from at least one of
  //     the two source versions (sanity check that resolution didn't
  //     blank the file).
  const notePath = path.join(f.vaultPath, "note.md");
  let noteOk = false;
  let noteDetail = "";
  if (fs.existsSync(notePath)) {
    const content = fs.readFileSync(notePath, "utf-8");
    const hasMarkers =
      /^<{7} /m.test(content) ||
      /^={7}$/m.test(content) ||
      /^>{7} /m.test(content);
    const hasContent = /distill version|main version after edit|baseline/i.test(
      content,
    );
    noteOk = !hasMarkers && hasContent && content.trim().length > 0;
    noteDetail = hasMarkers
      ? "still has markers"
      : !hasContent
        ? "neither source version's text survived (file may have been blanked)"
        : `resolved (${content.trim().length} chars)`;
  } else {
    noteDetail = "note.md missing";
  }
  results.push({
    name: "note.md resolved cleanly (no markers, content preserved)",
    passed: noteOk,
    detail: noteDetail,
  });

  return results;
}

function printSummary(
  results: PostConditionResult[],
  pi: PiResult,
  fixture: Fixture,
  model: string,
  startMs: number,
): boolean {
  const wallSecs = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log("");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`verify-agent-prompt — model=${model}, wall=${wallSecs}s`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  pi exit=${pi.exitCode} signal=${pi.signal ?? "-"}`);
  console.log(`  fixture tmpdir: ${fixture.tmpdir}`);
  console.log(`  startSha: ${fixture.startSha.slice(0, 12)}`);
  console.log("");
  let allPassed = true;
  for (const r of results) {
    const mark = r.passed ? "✓" : "✗";
    if (!r.passed) allPassed = false;
    console.log(`  ${mark} ${r.name}`);
    if (!r.passed) console.log(`      ${r.detail}`);
  }
  console.log("");
  if (allPassed) {
    console.log(
      `  RESULT: PASS (${results.length}/${results.length} post-conditions)`,
    );
  } else {
    const failedCount = results.filter((r) => !r.passed).length;
    console.log(
      `  RESULT: FAIL (${failedCount}/${results.length} post-conditions failed)`,
    );
  }
  console.log("");
  return allPassed;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${(e as Error).message}\n`);
    console.error(HELP);
    return 2;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const model = resolveModel(args.model);

  // Sanity: pi binary must exist.
  const piCheck = spawnSync(
    process.env.NAPKIN_DISTILL_PI_BIN || "pi",
    ["--version"],
    { encoding: "utf-8" },
  );
  if (piCheck.error) {
    console.error(
      `error: pi binary not found on PATH (NAPKIN_DISTILL_PI_BIN unset). Install pi or set the env var.`,
    );
    return 2;
  }

  console.log(
    `verify-agent-prompt: model=${model}, timeout=${args.timeoutSecs}s`,
  );
  console.log("Setting up fixture...");
  const startMs = Date.now();
  let fixture: Fixture;
  try {
    fixture = setupFixture();
  } catch (e) {
    console.error(`error: fixture setup failed: ${(e as Error).message}`);
    return 2;
  }

  console.log(`  tmpdir: ${fixture.tmpdir}`);
  console.log(`  vault: ${fixture.vaultPath}`);
  console.log(`  worktree: ${fixture.worktreePath}`);
  console.log(`  branch: ${fixture.branchName}`);
  console.log("");

  let prompt: string;
  try {
    prompt = buildDistillPrompt({
      worktreePath: fixture.worktreePath,
      vaultPath: fixture.vaultPath,
      branchName: fixture.branchName,
      defaultBranch: fixture.defaultBranch,
    });
  } catch (e) {
    console.error(`error: buildDistillPrompt failed: ${(e as Error).message}`);
    if (!args.keepTmpdir) {
      fs.rmSync(fixture.tmpdir, { recursive: true, force: true });
    }
    return 2;
  }

  // Persist the prompt for forensic inspection.
  const promptPath = path.join(fixture.tmpdir, "prompt.md");
  fs.writeFileSync(promptPath, prompt);

  // Sanity: synthetic session must exist and be non-empty before we
  // hand it to pi. setupFixture() writes it; this is a defensive check
  // in case future refactoring breaks that ordering.
  if (
    !fs.existsSync(fixture.sessionPath) ||
    fs.statSync(fixture.sessionPath).size === 0
  ) {
    console.error(
      `error: synthetic session file missing or empty at ${fixture.sessionPath}`,
    );
    if (!args.keepTmpdir) {
      fs.rmSync(fixture.tmpdir, { recursive: true, force: true });
    }
    return 2;
  }

  console.log(
    `Invoking pi (timeout ${args.timeoutSecs}s, prompt ${prompt.length} chars, session ${fs.statSync(fixture.sessionPath).size} bytes)...`,
  );
  const pi = runPi(model, fixture.sessionPath, prompt, args.timeoutSecs);

  if (pi.signal) {
    console.error(`  pi was signaled: ${pi.signal}`);
  }
  if (pi.stderr.trim().length > 0) {
    console.error(`  pi stderr (last 500 chars):`);
    console.error(`    ${pi.stderr.slice(-500).replace(/\n/g, "\n    ")}`);
  }

  const results = assertPostConditions(fixture);
  const passed = printSummary(results, pi, fixture, model, startMs);

  if (args.keepTmpdir) {
    console.log(`  --keep-tmpdir: leaving ${fixture.tmpdir} for inspection.`);
  } else {
    fs.rmSync(fixture.tmpdir, { recursive: true, force: true });
  }

  return passed ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`fatal: ${(e as Error).stack ?? e}`);
    process.exit(2);
  });
