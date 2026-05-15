import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Napkin } from "@cad0p/napkin";
import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  countTrackedFiles,
  ensureVaultReadyForAutoDistill,
  LEGACY_EMBEDDED_LAYOUT_ERROR,
} from "./auto-setup";
import {
  type ActiveDistill,
  cleanupDistillWorkspace,
  cleanupStaleWorktrees,
  DistillError,
  findDistillErrorLogForBranch,
  findDistillOutcomeForBranch,
  getDistillState,
  getDistillTouchedFilesPostSquash,
  resolveDistillErrorDir,
  spawnDistillInWorktree,
} from "./distill-workspace";
import { getSessionTouchedFiles } from "./session-touched-files";
import { shouldDistillOnShutdown } from "./should-distill-on-shutdown";

export interface DistillConfig {
  enabled: boolean;
  intervalMinutes: number;
  /**
   * Hard cap on how long to poll for a distill subprocess to complete
   * before declaring it timed out and abandoning the worktree / tmp
   * target. Defaults to 10 minutes.
   *
   * Primarily a testing knob (tests set this to a few ms to exercise the
   * timeout branch without real-time delay), but also a legitimate vault
   * config for users running distill against a slow provider. Values
   * <= 0 or non-finite fall back to the 10-minute default so a bad
   * config can't disable the timeout entirely.
   */
  maxDurationMinutes?: number;
  /**
   * Whether to run a final distill at session shutdown. Defaults to `true`.
   *
   * The shutdown handler consults this via `shouldDistillOnShutdown` — if
   * false, shutdown distill is skipped even when other guards would allow it.
   * Does not affect interval distill or manual `/distill`.
   */
  onShutdown: boolean;
  model?: { provider: string; id: string };
}

export interface VaultConfig {
  showStatus: boolean;
  distill: DistillConfig;
}

/**
 * Hard cap on how long we'll poll for a distill subprocess to complete
 * before declaring it timed out and abandoning the worktree / tmp target.
 *
 * 10 minutes is the production default. Configurable per-vault via
 * `distill.maxDurationMinutes` in `.napkin/config.json` — tests set this
 * to a few milliseconds so the timeout branch is exercisable without
 * waiting 10 real minutes, and users running distill against a slow
 * provider can legitimately raise it. Values <= 0, NaN, or unset fall
 * back to the default.
 */
const DEFAULT_MAX_DISTILL_DURATION_MS = 10 * 60 * 1000;

export function getMaxDistillDurationMs(config?: DistillConfig): number {
  const minutes = config?.maxDurationMinutes;
  if (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0) {
    return minutes * 60 * 1000;
  }
  return DEFAULT_MAX_DISTILL_DURATION_MS;
}

/**
 * Custom entry type used to persist `/distill-auto-this-session` state into the
 * session file. CustomEntry (unlike CustomMessageEntry) does not participate in
 * LLM context, so we can write freely without affecting the agent.
 *
 * Schema is append-only: the `suppressed: boolean` key must remain stable so
 * new-version writers aren't shadowed by older valid entries.
 */
const SESSION_STATE_CUSTOM_TYPE = "napkin-distill-session-state";

interface SessionPauseState {
  suppressed: boolean;
}

/**
 * Extension handlers receive a `ReadonlySessionManager`, but the runtime
 * object is a full `SessionManager` with write methods. We use the cast
 * to call `appendCustomEntry` for the `/distill-auto-this-session` pause
 * state below — napkin-context applies the same pattern for
 * `appendCustomMessageEntry` (a different SessionManager method, used
 * for messages that DO participate in LLM context).
 */
interface WritableSessionShape {
  appendCustomEntry(customType: string, data?: unknown): string;
}

/**
 * Read the latest persisted pause state from the current session branch.
 *
 * Uses `getBranch()` (canonical for state restoration — see todo, summarize,
 * handoff, qna examples) so entries on abandoned branches don't leak into the
 * live branch. Stops at the first matching `customType` even on malformed
 * data to protect new-version writers from being shadowed by older entries.
 */
function readPersistedSuppressed(sm: {
  getBranch(fromId?: string): SessionEntry[];
}): boolean {
  const branch = sm.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "custom") continue;
    const custom = entry as CustomEntry<SessionPauseState>;
    if (custom.customType !== SESSION_STATE_CUSTOM_TYPE) continue;
    if (custom.data && typeof custom.data.suppressed === "boolean") {
      return custom.data.suppressed;
    }
    return false;
  }
  return false;
}

/** Append the current pause state as a CustomEntry in the session. */
function persistSuppressed(sm: unknown, suppressed: boolean): void {
  (sm as WritableSessionShape).appendCustomEntry(SESSION_STATE_CUSTOM_TYPE, {
    suppressed,
  } satisfies SessionPauseState);
}

export const DEFAULT_DISTILL: DistillConfig = {
  enabled: false,
  intervalMinutes: 60,
  maxDurationMinutes: 10,
  onShutdown: true,
};

export function loadVaultConfig(vaultPath: string): VaultConfig {
  const configPath = path.join(vaultPath, "config.json");
  if (!fs.existsSync(configPath)) {
    return { showStatus: true, distill: DEFAULT_DISTILL };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return {
      showStatus: raw.showStatus !== false,
      distill: { ...DEFAULT_DISTILL, ...(raw.distill || {}) },
    };
  } catch {
    return { showStatus: true, distill: DEFAULT_DISTILL };
  }
}

const DISTILL_PROMPT = `Distill this conversation into the napkin vault.

1. \`napkin overview\` — learn the vault structure and what exists. Read \`_about.md\` files to understand what each folder is for. These are short folder descriptions (1-2 paragraphs) explaining what kinds of notes belong there — see existing ones for style.
2. \`napkin template list\` and \`napkin template read\` — learn the note formats.
3. Identify what's worth capturing. The vault structure and templates tell you what kinds of notes belong.
4. For each note:
   a. \`napkin search\` for the topic — if a note already covers it, \`napkin append\` instead of creating a duplicate
   b. Create new notes with \`napkin create\`, following the template format; use the relevant folder path
   c. Add \`[[wikilinks]]\` to related notes
5. Append a brief summary of key activities and decisions to today's daily note in the relevant namespace (e.g. \`{namespace}/daily/YYYY-MM-DD.md\`). Follow existing patterns. Create it if it doesn't exist.

Frontmatter convention: when you create a note that replaces an older one, add
\`supersedes: ["path/to/old/note.md"]\` to its frontmatter. A future janitor will
archive the superseded note. Leave the field empty or omit it for notes that
stand alone.

Be selective. Only capture knowledge useful to someone working on this project later. Skip meta-discussion, tool output, and chatter.`;

// Inline bash script template for the legacy (git-optional) manual
// /distill path. Tainted values flow through positional `$1..$5` argv;
// the template itself is a fixed literal, never interpolated from user
// input. Same trust boundary as the worktree wrapper, without a
// separate file.
//
// Bash (not sh) because we use arrays for optional --model splicing;
// Ubuntu's /bin/sh is dash which parse-errors on `pi_args=(...)`.
const LEGACY_SPAWN_SCRIPT = `set -u
PI_BIN="$1"; SESSION="$2"; TMPDIR_ARG="$3"; PROMPT="$4"; MODEL="$5"
pi_args=(--session "$SESSION" -p "$PROMPT")
if [ -n "$MODEL" ]; then
  pi_args=(--session "$SESSION" --model "$MODEL" -p "$PROMPT")
fi
"$PI_BIN" "\${pi_args[@]}" > /dev/null 2>&1 || true
rm -rf -- "$TMPDIR_ARG"
`;

/**
 * Spawn a detached pi distill process that survives parent exit.
 * Runs `pi -p <prompt>` against a forked session, then removes the temp
 * dir. Returns the temp dir path (used as a completion marker — when it
 * disappears, distill is done).
 *
 * Used only by manual `/distill` on git-less, disabled, or legacy-embedded
 * vaults. Manual `/distill` with git + subdir layout + enabled takes the
 * worktree path. Auto-distill requires git + subdir layout unconditionally
 * (Phase C1).
 */
export function spawnDistill(
  sessionFile: string,
  cwd: string,
  config: DistillConfig,
  spawnFn: typeof spawn = spawn,
): string | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-distill-"));

  try {
    const forkedSm = SessionManager.forkFrom(sessionFile, cwd, tmpDir);
    const forkedFile = forkedSm.getSessionFile();
    if (!forkedFile) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return null;
    }

    const modelStr = config.model
      ? `${config.model.provider}/${config.model.id}`
      : "";
    const piBin = process.env.NAPKIN_DISTILL_PI_BIN ?? "pi";

    const proc = spawnFn(
      "bash",
      [
        "-c",
        LEGACY_SPAWN_SCRIPT,
        "_",
        piBin,
        forkedFile,
        tmpDir,
        DISTILL_PROMPT,
        modelStr,
      ],
      {
        cwd,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, NAPKIN_DISTILL_NO_RECURSE: "1" },
      },
    );
    proc.unref();

    return tmpDir;
  } catch {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let countdownHandle: ReturnType<typeof setInterval> | null = null;
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  let lastDistillTimestamp = Date.now();
  let lastSessionSize = 0;
  /**
   * Byte size of the session file at the moment the most recent distill
   * subprocess was successfully spawned. Separate from `lastSessionSize`
   * (which updates on completion): this tracks SPAWN so that a shutdown
   * firing between spawn-and-complete dedupes against the in-flight distill
   * without having to wait for it to finish.
   *
   * Read by `shouldDistillOnShutdown` in the session_shutdown handler
   * (guard #8). Written by `runDistill`, `runAutoDistill`, and the shutdown
   * handler itself (after a successful shutdown spawn).
   */
  let lastSpawnedSize = 0;
  let isRunning = false;
  // Session-scoped suppression of the automatic distill timer.
  // Toggled via `/distill-auto-this-session` — does NOT affect manual `/distill`.
  let autoDistillSuppressed = false;
  /**
   * Cursor into the parent session's `getEntries()` array marking the
   * point of the previous distill's completion. The next per-completion
   * overlap check (R7-PERF-2) walks entries from this cursor to the
   * current end and computes which files the parent has touched in that
   * interval; intersection with the just-completed distill's touched
   * files (`git log --name-only <startSha>..HEAD` from the main vault)
   * yields the overlap set.
   *
   * Initialised on `session_start` to `getEntries().length` (R8-CC-3 /
   * R8-PERF-3): for a fresh session this is 0; for a resumed session
   * with N pre-existing entries this is N, so the first post-resume
   * completion only walks entries added AFTER session_start — not the
   * full pre-resume history (which would surface stale notices for
   * files written in earlier pi processes whose distills already
   * landed).
   *
   * Updated on every successful distill completion (also when overlap
   * is empty) so subsequent completions only see the new slice.
   *
   * Closure-scoped (sync, no race): the per-completion path runs inside
   * the JS-side poll callback, single-threaded with everything else in
   * this extension factory.
   */
  let lastDistillCompletionMessageCursor = 0;

  // Refs captured from session_start so `/distill-auto-this-session` can refresh
  // the status bar immediately without waiting for the next countdown tick.
  //
  // `ExtensionUIContext` is pi's public UI surface (setStatus, theme, …). We keep
  // the whole thing instead of a narrow subset so future status-bar tweaks don't
  // need to widen the type — and so TS catches method renames at the pi boundary.
  type DistillUIRef = {
    hasUI: boolean;
    ui: ExtensionUIContext;
    showStatus: boolean;
    intervalMs: number;
  };
  let uiRef: DistillUIRef | null = null;

  function renderIdleStatus(): void {
    if (!uiRef?.hasUI || !uiRef.showStatus) return;
    // While a distill is in flight the poll loop owns the status bar; leave it alone.
    if (isRunning) return;
    const theme = uiRef.ui.theme;
    if (autoDistillSuppressed) {
      uiRef.ui.setStatus(
        "napkin-distill",
        theme.fg("dim", "distill: off (session)"),
      );
      return;
    }
    uiRef.ui.setStatus(
      "napkin-distill",
      theme.fg("dim", `distill: ${formatRemaining()}`),
    );
  }

  /** Formatted time until the next scheduled auto-distill, or `"—"` if unknown. */
  function formatRemaining(): string {
    if (!uiRef) return "—";
    const remaining = Math.max(
      0,
      uiRef.intervalMs - (Date.now() - lastDistillTimestamp),
    );
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    return mins > 0
      ? `${mins}m${secs.toString().padStart(2, "0")}s`
      : `${secs}s`;
  }

  pi.on("session_start", async (event, ctx) => {
    // Reset to default before any early-return paths below; the persisted state
    // (if any) is re-read further down when distill is enabled for the session.
    autoDistillSuppressed = false;

    let napkinVault: { configPath: string; contentPath: string };
    try {
      napkinVault = new Napkin(ctx.cwd).vault;
    } catch {
      return;
    }
    const vaultConfigPath = napkinVault.configPath;

    const { showStatus, distill: config } = loadVaultConfig(vaultConfigPath);
    if (!config.enabled) {
      if (ctx.hasUI && showStatus) {
        ctx.ui.setStatus(
          "napkin-distill",
          ctx.ui.theme.fg("dim", "distill: off"),
        );
      }
      return;
    }

    // Skip if this is a distill subprocess
    if (process.env.NAPKIN_DISTILL_NO_RECURSE) return;

    // Auto-init git + scaffold .gitignore/.gitattributes so subsequent
    // worktree operations have the invariants they need. Idempotent and
    // non-throwing — on failure we notify once and disable auto-distill for
    // this session rather than retrying on every interval fire.
    //
    // Scope: operate on `napkinVault.contentPath` — the vault root as
    // napkin resolves it from cwd. This is cwd-independent: when pi is
    // launched outside the vault (e.g. in another project directory),
    // findVault still resolves to the user's real vault via a global
    // config fallback at `~/.config/napkin/config.json`. Using `ctx.cwd`
    // here would scaffold `.git` in the WRONG directory and leave the
    // real vault untouched — breaking both auto-init and later worktree
    // operations that (now also correctly) target the vault.
    //
    // `setupFailed` is the load-bearing signal for the suppression logic
    // below: once setup has failed, we MUST NOT re-read the persisted
    // suppression state, because a `false` there would re-enable
    // auto-distill on a vault that isn't actually usable.
    const vaultContentPath = napkinVault.contentPath;
    let setupFailed = false;
    try {
      const setup = ensureVaultReadyForAutoDistill({
        contentPath: vaultContentPath,
        configPath: napkinVault.configPath,
      });
      if (setup.error) {
        setupFailed = true;
        if (ctx.hasUI) {
          if (setup.error === LEGACY_EMBEDDED_LAYOUT_ERROR) {
            // Legacy embedded layout (`~/.napkin/` with `config.json`
            // alongside notes, no `.napkin/` subdir). Worktree-based
            // concurrency requires the subdir layout so napkin's
            // `findVault` resolves cwd=worktree to the worktree itself.
            // README has the migration steps; point there instead of
            // duplicating them in the notify (keeps the notification
            // short enough to render cleanly in every UI surface).
            ctx.ui.notify(
              "Auto-distill requires the subdir vault layout. See README for migration, or set distill.enabled: false in vault config.json.",
              "error",
            );
          } else if (setup.conflict) {
            // G7: existing `.gitattributes` already claims `*.md merge=<X>`.
            // We refuse to scaffold so we don't silently override the
            // user's chosen driver via last-match-wins. Explain the
            // options clearly — auto-distill is off for this session, but
            // manual /distill still works.
            ctx.ui.notify(
              [
                `Auto-distill setup blocked: your .gitattributes already has a merge rule for *.md ('${setup.conflict.rule}').`,
                "Auto-distill needs its own driver to handle concurrent distill merges safely. To enable:",
                `  - Remove the conflicting rule from ${setup.conflict.file}, OR`,
                "  - Set distill.onShutdown: false in vault config.json to disable auto-distill on shutdown",
                "Manual /distill still works regardless.",
              ].join("\n"),
              "error",
            );
          } else {
            ctx.ui.notify(
              `Auto-distill setup failed: ${setup.error}. Disabling auto-distill for this session.`,
              "error",
            );
          }
        }
      } else if (setup.initialized) {
        const tracked = countTrackedFiles(vaultContentPath);
        const files = tracked >= 0 ? tracked : setup.scaffolded.length;
        if (ctx.hasUI) {
          ctx.ui.notify(
            [
              "Initialized git repo in your vault for auto-distill.",
              `Commit: 'napkin: initial vault commit (auto-distill setup)'`,
              `Files tracked: ${files}`,
              `To undo: rm -rf ${path.join(vaultContentPath, ".git")} (removes history, keeps files)`,
              "To opt out: set distill.enabled: false in vault config.json",
            ].join("\n"),
            "info",
          );
        }
      } else if (setup.scaffolded.length > 0) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Added ${setup.scaffolded.join(", ")} for auto-distill.`,
            "info",
          );
        }
      }
    } catch (err) {
      // Truly unexpected (ensureVaultReadyForAutoDistill is supposed to not
      // throw). Log + continue, worst case later operations fail gracefully.
      console.error("[napkin-distill] auto-setup threw:", err);
    }

    // Sweep out stale distill worktrees left behind by crashed pi sessions.
    // Idempotent, best-effort — never throws, never blocks session_start.
    try {
      cleanupStaleWorktrees({ contentPath: vaultContentPath });
    } catch {
      // swallow — cleanup is non-critical to session lifecycle
    }

    // Restore the per-session pause state from the session file so that
    // resuming a session retains the `/distill-auto-this-session` setting.
    //
    // BUT: when setup failed above, we must keep the safety flag ON. The
    // persisted value reflects USER intent (opted out for this session);
    // setup failure is a VAULT-level problem that should override user
    // intent for this session only — next session will re-try setup.
    if (setupFailed) {
      autoDistillSuppressed = true;
    } else {
      autoDistillSuppressed = readPersistedSuppressed(ctx.sessionManager);
    }

    lastDistillTimestamp = Date.now();
    // Initialize the per-completion overlap cursor to the current end of
    // the session entries. For a new session this is 0 (empty session);
    // for a resumed session (`reason` in {`resume`,`fork`,`startup`,...})
    // this is the prior entry count, so the FIRST distill completion in
    // the new pi process only walks entries added AFTER session_start —
    // not the full pre-resume history. Without this, a resumed session
    // with N pre-existing entries would surface stale overlap notices
    // for files written in earlier pi processes (whose distills already
    // landed on main). R8-CC-3 / R8-PERF-3.
    try {
      lastDistillCompletionMessageCursor =
        ctx.sessionManager.getEntries().length;
    } catch {
      // Best-effort: if getEntries throws (shouldn't — it's a basic
      // accessor), leave the cursor at its prior value (0 on first
      // session_start).
    }
    const intervalMs = config.intervalMinutes * 60 * 1000;

    uiRef = { hasUI: ctx.hasUI, ui: ctx.ui, showStatus, intervalMs };

    // Paint initial state immediately so a resumed paused session doesn't
    // briefly show the countdown before the first tick.
    renderIdleStatus();

    // On resume, if the session is off, surface it once via notify — the
    // status bar is easy to miss after a long gap between sessions. Fire for
    // all reasons except `"new"` (fresh sessions never match — branch is empty
    // — but explicitly exclude to keep the intent obvious) and `"reload"`
    // (would fire on every in-session config reload).
    if (
      ctx.hasUI &&
      autoDistillSuppressed &&
      (event.reason === "resume" ||
        event.reason === "fork" ||
        event.reason === "startup")
    ) {
      ctx.ui.notify(
        "Auto-distill is off for this session. Run /distill-auto-this-session on to turn on.",
        "info",
      );
    }

    if (ctx.hasUI && showStatus) {
      countdownHandle = setInterval(() => {
        // `renderIdleStatus` self-guards against in-flight distills; when off
        // it paints `distill: off (session)` (pi dedupes identical status strings).
        renderIdleStatus();
      }, 1000);
    }

    intervalHandle = setInterval(() => {
      if (autoDistillSuppressed) return;
      runAutoDistill(ctx);
    }, intervalMs);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    if (countdownHandle) {
      clearInterval(countdownHandle);
      countdownHandle = null;
    }
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
    // Reset `isRunning` so a distill that was mid-flight at shutdown doesn't
    // stick as `true` across an in-process session switch and suppress the
    // next session's status-bar rendering.
    isRunning = false;

    // ------- Final shutdown distill (Phase B Item 8) -------------------------
    //
    // Spawn one last auto-distill if the session has content that hasn't been
    // captured yet. Guards live in `shouldDistillOnShutdown` — this block
    // only assembles inputs and calls it. Any failure logs and falls through;
    // shutdown must never block.
    //
    // Intentionally AFTER the timer cleanup above: clearing intervalHandle
    // first prevents the rare race where the interval fires during shutdown
    // and we end up with two concurrent spawns on the same content.
    //
    // Config is re-read via loadVaultConfig rather than captured from
    // session_start — handler scope keeps closures small, and the cost of
    // one extra JSON parse at shutdown is negligible.
    try {
      let vaultInfo: { configPath: string; contentPath: string } | null = null;
      try {
        vaultInfo = new Napkin(ctx.cwd).vault;
      } catch {
        // No vault resolvable — skip spawn, proceed to final resets.
      }
      if (vaultInfo) {
        const { distill: config } = loadVaultConfig(vaultInfo.configPath);
        const sessionFile = ctx.sessionManager.getSessionFile?.();
        const currentSize =
          sessionFile && fs.existsSync(sessionFile)
            ? fs.statSync(sessionFile).size
            : 0;

        if (
          shouldDistillOnShutdown(
            event,
            config,
            autoDistillSuppressed,
            sessionFile,
            currentSize,
            lastSpawnedSize,
            lastSessionSize,
          )
        ) {
          // Guard: we require git for the worktree path, rooted at the
          // vault's content directory (where auto-init placed `.git`).
          // Using `ctx.cwd` here would miss the repo when pi was launched
          // outside the vault — the very bug this change fixes.
          if (
            fs.existsSync(path.join(vaultInfo.contentPath, ".git")) &&
            sessionFile
          ) {
            const modelStr = config.model
              ? `${config.model.provider}/${config.model.id}`
              : undefined;
            spawnDistillInWorktree({
              vault: vaultInfo.contentPath,
              sessionFile,
              parentCwd: ctx.cwd,
              maxDurationSecs: Math.round(
                getMaxDistillDurationMs(config) / 1000,
              ),
              model: modelStr,
            });
            // Mark this size as "spawned" so if the parent re-enters shutdown
            // (unlikely but possible with session switch), we don't duplicate.
            lastSpawnedSize = currentSize;
          }
        }
      }
    } catch (err) {
      // Never block shutdown. stderr logging only — no UI at this point.
      console.error("[napkin-distill] shutdown spawn failed:", err);
    }

    uiRef = null;
    // No need to kill anything — detached processes survive on their own
  });

  // ---------------------------------------------------------------------------
  // Overlap notice (R7-PERF-2 redesign): per-distill-completion via
  // `appendCustomMessageEntry`.
  //
  // Previous design (per-turn `before_agent_start` hook returning
  // `{ systemPrompt: event.systemPrompt + notice }`) silently broke
  // Anthropic-style prompt caching whenever the notice fired: any byte
  // change in the system block invalidates the entire cached prefix, so
  // every parent turn during overlap re-encoded the full conversation
  // history (~$0.50–$1/turn on long sessions). The original commit's
  // "cache-friendly: notice lives at the END of the system prompt"
  // rationale was based on an incorrect assumption about the cache
  // boundary.
  //
  // The redesign moves the trigger from per-turn to per-distill-
  // completion (when files actually change in the parent's view) and
  // moves the channel from system-prompt mutation to a custom session
  // message via `appendCustomMessageEntry`. Custom messages persist in
  // session history and the cache prefix stays byte-identical between
  // parent and distill subprocess turns.
  //
  // The actual completion check lives in `runDistillWith`'s success
  // path — see `postOverlapNoticeOnCompletion` below. We track
  // `lastDistillCompletionMessageCursor` in the closure to bound the
  // session-touched-files walk to messages added since the last
  // completion.
  //
  // Pure helpers (`intersectFiles`, `formatOverlapNotice`) and the
  // session-side file extraction (`getSessionTouchedFiles`) are still
  // load-bearing and unchanged — the new trigger reuses them.

  /**
   * Ctx shape shared by the two run-distill paths. Kept as a `Pick` of
   * pi's real `ExtensionContext` so the four fields we care about stay
   * in sync with pi at the type level (any rename upstream surfaces as
   * a compile error here rather than silently widening to `any`).
   */
  type RunCtx = Pick<
    ExtensionContext,
    "sessionManager" | "hasUI" | "ui" | "cwd"
  >;

  /**
   * Strategy bundle for the shared runner. Each caller (legacy or worktree)
   * supplies a preflight check, a spawn invocation, a poll-completion
   * target, and a timeout cleanup step. Everything else (config load,
   * size dedup, status-bar painting, poll loop wiring, completion
   * bookkeeping) is common.
   *
   * All strategy callbacks receive `vaultContentPath` — the vault's content
   * root as resolved by napkin, NOT `ctx.cwd`. This is what makes the
   * whole auto-distill pipeline cwd-independent: worktrees, git, and the
   * legacy spawn all target the user's actual vault even when pi is
   * launched from another directory (napkin's findVault walks up from
   * `ctx.cwd` and falls back to the global config).
   */
  interface DistillStrategy {
    /**
     * Optional pre-flight check. Return `{ ok: false, errorStatus }` to
     * short-circuit with a status-bar message, or `{ ok: true }` to
     * continue. Invoked after config load + size dedup, before spawn.
     */
    preflight?: (args: {
      ctx: RunCtx;
      vaultContentPath: string;
      theme: unknown;
    }) => { ok: true } | { ok: false; errorStatus?: string };
    /**
     * Spawn the distill subprocess. Returns `{ target }` on success — a
     * filesystem path whose disappearance marks completion. Returns null
     * to signal a spawn failure (caller paints an error in the status
     * bar).
     *
     * `onComplete` is invoked exactly once when the poller detects clean
     * completion (target gone, no timeout). The strategy uses it to do
     * post-completion bookkeeping that needs both the strategy-specific
     * spawn state (e.g. workspace handle) and the run-time `ctx`. It
     * MUST NOT throw — the caller wraps it in try/catch and swallows
     * errors so completion bookkeeping never blocks the next distill.
     * Not invoked on timeout (that uses `cleanup` instead).
     */
    spawnFn: (args: {
      ctx: RunCtx;
      vaultContentPath: string;
      vaultConfigPath: string;
      sessionFile: string;
      config: DistillConfig;
    }) => {
      target: string;
      cleanup: () => void;
      onComplete?: (ctx: RunCtx) => void;
      /**
       * Optional probe invoked when `target` disappears. Returns the
       * path to a wrapper-emitted error log when the spawn failed
       * silently (i.e. the wrapper exited non-zero before timing out
       * but after creating its forensic log). Returns null on success.
       *
       * The runner uses the result to surface a UI failure on the
       * worktree path (mirrors the timeout-surfacing pattern). Legacy
       * spawn doesn't produce error logs in this shape — omit or
       * return null.
       */
      checkFailure?: () => string | null;
      /**
       * Optional probe invoked when `target` disappears AND `checkFailure`
       * returned null (no fatal error). Returns the wrapper-emitted
       * outcome sidecar (POST-CONV-5): `{ outcomeClass, outcomePath,
       * partialMergeLogPath }` when present, null when missing.
       *
       * Missing sidecar AND missing failure log = abnormal termination
       * (SIGKILL / `set -e` / disk full / race) — the runner surfaces
       * a warn-level notification per the locked notification severity
       * contract. Legacy spawn doesn't produce outcome sidecars — omit
       * or return null.
       */
      checkOutcome?: () => {
        outcomeClass: string;
        outcomePath: string;
        partialMergeLogPath: string | null;
        /**
         * Optional recovery hint emitted by the wrapper's salvage path
         * (PR #12 A4). Surfaces in the failure notification message so
         * the user sees the recommended `git revert` / `git reflog`
         * recovery action without needing to open the error log.
         * Null on happy-path classes (merged-content, merged-local,
         * no-content) and on legacy single-line outcome sidecars.
         */
        recoveryHint: string | null;
      } | null;
    } | null;
  }

  /**
   * Per-completion overlap-notice helper (R7-PERF-2). Invoked by
   * `worktreeSpawnFn`'s `onComplete` after the wrapper's squash-merge has
   * landed and the worktree has been removed.
   *
   * Algorithm:
   *   1. Compute the just-completed distill's touched files via
   *      `git log --name-only <startSha>..HEAD` from the main vault.
   *      The squash commit brings every file the distill affected into
   *      this range. Returns [] if startSha is missing (legacy meta) or
   *      git fails — silent no-op.
   *   2. Compute the parent session's touched files since the previous
   *      distill's completion. Walk `getEntries()` from
   *      `lastDistillCompletionMessageCursor` to current end and extract
   *      write-class file ops (reuses `extractFileOpsFromMessage` via a
   *      slice-bounded `SessionEntriesSource` adapter).
   *   3. Intersect. If non-empty, post an `appendCustomMessageEntry`
   *      with `customType: "napkin-distill-overlap"`.
   *   4. Update `lastDistillCompletionMessageCursor` to the current end
   *      of the entries array — even when overlap is empty — so the
   *      next completion only walks new entries.
   *
   * Cache parity (R7-PERF-2): the notice lands as a custom session
   * message in conversation history. Both the parent's next turn and
   * any future distill subprocess (which forks the parent's session)
   * see it in identical positions in the messages array — the cached
   * prefix is preserved unconditionally, unlike the previous per-turn
   * `appendSystemPrompt` mechanism.
   *
   * Failure modes are all silent (best-effort): vault resolution fail,
   * git fail, missing startSha, missing SessionManager mutation method.
   * Completion bookkeeping must never block the next distill.
   */
  function postOverlapNoticeOnCompletion(
    ctx: RunCtx,
    vaultContentPath: string,
    startSha: string | undefined,
  ): void {
    let distillTouched: string[];
    try {
      distillTouched = getDistillTouchedFilesPostSquash(
        vaultContentPath,
        startSha,
      );
    } catch {
      // Even on error, advance the cursor below so we don't double-count
      // on the next completion.
      distillTouched = [];
    }

    let entries: readonly SessionEntry[];
    try {
      entries = ctx.sessionManager.getEntries();
    } catch {
      // Couldn't read entries — leave cursor where it is so next
      // completion retries the same window.
      return;
    }

    const { overlap, newCursor } = computeOverlapForCompletion({
      distillTouchedFiles: distillTouched,
      sessionEntries: entries,
      cursor: lastDistillCompletionMessageCursor,
    });
    // Always advance the cursor (even on empty overlap) so the next
    // completion only sees new entries.
    lastDistillCompletionMessageCursor = newCursor;

    if (overlap.length === 0) return;

    // Post the notice. SessionManager's mutation methods are not on the
    // public ReadonlySessionManager type that pi exposes via
    // ExtensionContext, so we cast through Partial<SessionManager> the
    // same way `napkin-context` does — graceful degradation if pi ever
    // tightens the readonly contract at runtime.
    const sm = ctx.sessionManager as Partial<SessionManager>;
    if (typeof sm.appendCustomMessageEntry === "function") {
      try {
        sm.appendCustomMessageEntry(
          "napkin-distill-overlap",
          formatOverlapNotice(overlap),
          true, // display: surface in TUI so the user sees what happened
        );
      } catch {
        // best-effort; cursor was already advanced above
      }
    }
  }

  /**
   * Shared runner for the two distill paths. Encodes the full lifecycle:
   *   1. Early-return if isRunning.
   *   2. Resolve vault config; bail silently if cwd isn't a vault.
   *   3. Read session file; size-dedup against lastSessionSize.
   *   4. Run strategy.preflight; short-circuit on failure.
   *   5. strategy.spawn; on failure paint error status.
   *   6. Bookkeeping: lastSpawnedSize = currentSize, isRunning = true,
   *      start polling for target disappearance.
   *   7. On completion: update lastSessionSize + lastDistillTimestamp, paint
   *      success status, notify.
   *   8. On timeout: invoke strategy's cleanup callback and paint error.
   */
  function runDistillWith(ctx: RunCtx, strategy: DistillStrategy): void {
    if (isRunning) return;

    let vaultInfo: { configPath: string; contentPath: string };
    try {
      vaultInfo = new Napkin(ctx.cwd).vault;
    } catch {
      return;
    }
    const vaultContentPath = vaultInfo.contentPath;

    const { showStatus, distill: config } = loadVaultConfig(
      vaultInfo.configPath,
    );
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (!sessionFile) return;

    // Skip if session hasn't changed since last distill.
    const currentSize = fs.existsSync(sessionFile)
      ? fs.statSync(sessionFile).size
      : 0;
    if (currentSize > 0 && currentSize === lastSessionSize) {
      lastDistillTimestamp = Date.now();
      return;
    }

    const theme = ctx.hasUI ? ctx.ui.theme : null;

    // Strategy-specific pre-flight.
    if (strategy.preflight) {
      const pre = strategy.preflight({ ctx, vaultContentPath, theme });
      if (!pre.ok) {
        if (ctx.hasUI && theme && showStatus && pre.errorStatus) {
          ctx.ui.setStatus(
            "napkin-distill",
            theme.fg("error", "✗") + theme.fg("dim", ` ${pre.errorStatus}`),
          );
        }
        return;
      }
    }

    const spawned = strategy.spawnFn({
      ctx,
      vaultContentPath,
      vaultConfigPath: vaultInfo.configPath,
      sessionFile,
      config,
    });
    if (!spawned) {
      if (ctx.hasUI && theme && showStatus) {
        ctx.ui.setStatus(
          "napkin-distill",
          theme.fg("error", "✗") + theme.fg("dim", " distill: spawn failed"),
        );
      }
      return;
    }
    const {
      target,
      cleanup: spawnCleanup,
      onComplete,
      checkFailure,
      checkOutcome,
    } = spawned;

    // Record the size we spawned on so a shutdown firing between here and
    // completion dedupes against the in-flight distill.
    lastSpawnedSize = currentSize;

    isRunning = true;
    const startTime = Date.now();

    if (ctx.hasUI && theme && showStatus) {
      ctx.ui.setStatus(
        "napkin-distill",
        theme.fg("accent", "●") + theme.fg("dim", " distill"),
      );
    }

    pollHandle = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const timedOut = Date.now() - startTime > getMaxDistillDurationMs(config);

      if (fs.existsSync(target) && !timedOut) {
        if (ctx.hasUI && theme && showStatus) {
          ctx.ui.setStatus(
            "napkin-distill",
            theme.fg("accent", "●") + theme.fg("dim", ` distill ${elapsed}s`),
          );
        }
        return;
      }

      if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
      isRunning = false;

      if (timedOut) {
        try {
          spawnCleanup();
        } catch {
          // ignore — best-effort cleanup on timeout
        }
        if (ctx.hasUI && theme) {
          if (showStatus) {
            ctx.ui.setStatus(
              "napkin-distill",
              theme.fg("error", "✗") + theme.fg("dim", " distill: timeout"),
            );
          }
          ctx.ui.notify(
            `Distillation timed out (${Math.round(getMaxDistillDurationMs(config) / 60000)}m)`,
            "error",
          );
        }
        return;
      }

      lastDistillTimestamp = Date.now();
      lastSessionSize = currentSize;

      // Wrapper-failure check (R7-SC-3). Mirrors the timeout-surfacing
      // pattern: target disappearance is the success condition, but the
      // wrapper writes a forensic log on any non-success exit (missing
      // napkin, pi subprocess error, merge-driver 3-strike, etc.). If a
      // log file matching this distill's branch is present in the
      // error dir, the run failed even though the worktree is gone.
      // Surface the failure in the UI so the user can act on it instead
      // of the run silently disappearing.
      let failureLogPath: string | null = null;
      if (checkFailure) {
        try {
          failureLogPath = checkFailure();
        } catch {
          // best-effort — if the probe throws, treat as success
          failureLogPath = null;
        }
      }

      if (failureLogPath) {
        if (ctx.hasUI && theme) {
          if (showStatus) {
            ctx.ui.setStatus(
              "napkin-distill",
              theme.fg("error", "✗") + theme.fg("dim", " distill: failed"),
            );
          }
          ctx.ui.notify(`Distillation failed: see ${failureLogPath}`, "error");
        }
        return;
      }

      // Per-completion overlap notice (R7-PERF-2). Strategy-specific
      // hook fires after target disappearance + before UI notify so any
      // session-mutation it does (e.g. appendCustomMessageEntry) lands
      // before the user-visible "distill complete" message. Wrapped to
      // never throw — completion bookkeeping must not block subsequent
      // distills.
      if (onComplete) {
        try {
          onComplete(ctx);
        } catch {
          // best-effort — swallow per the strategy contract
        }
      }

      // Outcome dispatch (POST-CONV-5). The wrapper writes a one-line
      // `*.outcome` sidecar before any successful exit-0 path; the
      // class string drives the UI severity per the locked notification
      // severity contract. See `formatOutcomeNotification` for the
      // full mapping. Strategies that don't produce sidecars (legacy
      // /distill on git-less or disabled vaults) skip this entire
      // dispatch and fall through to the default info notification.
      let outcome: {
        outcomeClass: string;
        outcomePath: string;
        partialMergeLogPath: string | null;
        recoveryHint: string | null;
      } | null = null;
      if (checkOutcome) {
        try {
          outcome = checkOutcome();
        } catch {
          outcome = null;
        }
      }

      if (ctx.hasUI && theme) {
        let level: "info" | "warning" | "error" = "info";
        let message = `Distillation complete (${elapsed}s)`;
        let statusGlyph = theme.fg("success", "✓");
        let statusText = ` distill ${elapsed}s`;

        if (checkOutcome) {
          const dispatch = formatOutcomeNotification({
            outcome,
            elapsedSec: elapsed,
            readPartialMergeLog: (p) => {
              try {
                return fs.readFileSync(p, "utf-8");
              } catch {
                return null;
              }
            },
          });
          level = dispatch.level;
          message = dispatch.message;
          statusGlyph = theme.fg(dispatch.statusKey, dispatch.statusGlyph);
          statusText = dispatch.statusText;
        }

        if (showStatus) {
          ctx.ui.setStatus(
            "napkin-distill",
            statusGlyph + theme.fg("dim", statusText),
          );
        }
        ctx.ui.notify(message, level);
      }
    }, 2000);
  }

  function runDistill(ctx: RunCtx) {
    // Manual `/distill` routing: use the worktree path only when the user
    // has opted into auto-distill (`distill.enabled=true`), git is
    // available, AND the vault uses the subdir layout. Otherwise fall
    // back to the legacy tmpdir spawn, which has zero git side effects.
    //
    // `distill.enabled=false` means the user opted out of auto-distill's
    // infrastructure (including `.gitattributes` rewrites). Worktree
    // spawn calls `registerMergeDriver()` which writes git config; legacy
    // path doesn't.
    //
    // Legacy-embedded layout (`configPath === contentPath`) forces the
    // same fallback: the worktree path silently corrupts on that layout
    // because napkin's `findVault` from cwd=<worktree> walks past the
    // worktree and resolves to the real `~/.napkin/` via global config
    // fallback. Distill writes land on the real vault, worktree stays
    // empty, concurrency guarantee degrades to zero. README covers the
    // subdir migration; auto-distill refuses this layout at session_start.
    //
    // Cross-session concurrency caveat: the legacy fallback has no
    // worktree isolation — two concurrent `/distill` calls on a git-less,
    // disabled, or legacy-embedded vault race on napkin writes. With
    // git + enabled + subdir layout, both manual and auto paths serialize
    // through the merge driver.
    runDistillWith(ctx, {
      spawnFn: (args) => {
        const gitPresent = fs.existsSync(
          path.join(args.vaultContentPath, ".git"),
        );
        // Legacy-embedded detection matches the predicate in
        // `ensureVaultReadyForAutoDistill` (keep the two gates in lockstep).
        const isLegacyEmbedded = args.vaultConfigPath === args.vaultContentPath;
        if (gitPresent && args.config.enabled && !isLegacyEmbedded) {
          return worktreeSpawnFn(args);
        }
        return legacySpawnFn(args);
      },
    });
  }

  /**
   * Worktree-backed auto-distill path — used by the interval timer and the
   * shutdown handler (Item 8). Concurrency-safe via per-distill git
   * worktrees: each call spawns a detached wrapper that operates on its
   * own branch, so overlapping distills (interval + shutdown, or multiple
   * pi sessions on the same vault) merge serially on main via the LLM
   * merge driver.
   */
  function runAutoDistill(ctx: RunCtx) {
    runDistillWith(ctx, {
      preflight: ({ vaultContentPath }) => {
        // Auto-distill requires the vault to be a git repo. Phase C1
        // auto-init wires this at session_start; we surface a one-shot
        // status-bar hint here for belt-and-braces.
        if (!fs.existsSync(path.join(vaultContentPath, ".git"))) {
          return { ok: false, errorStatus: "distill: needs git" };
        }
        return { ok: true };
      },
      spawnFn: worktreeSpawnFn,
    });
  }

  /**
   * Legacy tmpdir spawn strategy. Forks the session under `$TMPDIR` and
   * runs `pi -p` detached; cleanup is a plain `rmSync`. No git, no
   * concurrency coordination. Only used by manual `/distill` as a
   * fallback for vaults without `.git/`.
   *
   * Vault resolution note: the spawned `pi -p` instance runs with
   * `cwd = vaultContentPath`, which is already resolved by napkin
   * (cwd-independent via `new Napkin(ctx.cwd).vault`). The distill
   * subprocess itself calls `napkin` commands that walk up from their
   * cwd, so targeting `vaultContentPath` ensures they hit the user's
   * real vault regardless of where pi was originally launched. This
   * matches the pre-worktree behavior where the session operated
   * directly on the vault root — no isolation, napkin-from-cwd only.
   */
  function legacySpawnFn(args: {
    ctx: RunCtx;
    vaultContentPath: string;
    vaultConfigPath: string;
    sessionFile: string;
    config: DistillConfig;
  }): { target: string; cleanup: () => void } | null {
    const { vaultContentPath, sessionFile, config } = args;
    const tmpDir = spawnDistill(sessionFile, vaultContentPath, config);
    if (!tmpDir) return null;
    return {
      target: tmpDir,
      cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
    };
  }

  /**
   * Worktree spawn strategy. Creates a per-distill git worktree off the
   * vault's default branch, runs the detached wrapper that merges back
   * via the LLM merge driver + squash. Concurrency-safe across sessions.
   *
   * Shared by `runDistill` (when git is available) and `runAutoDistill`.
   * A `DistillError` from the workspace layer (branch collision, fork
   * failure, invalid HEAD, merge driver missing) is caught and rendered
   * as an error status; the shared runner treats a null return as a
   * spawn failure and skips the poll loop.
   */
  function worktreeSpawnFn(args: {
    ctx: RunCtx;
    vaultContentPath: string;
    vaultConfigPath: string;
    sessionFile: string;
    config: DistillConfig;
  }): {
    target: string;
    cleanup: () => void;
    onComplete?: (ctx: RunCtx) => void;
    checkFailure?: () => string | null;
    checkOutcome?: () => {
      outcomeClass: string;
      outcomePath: string;
      partialMergeLogPath: string | null;
      recoveryHint: string | null;
    } | null;
  } | null {
    const { ctx: c, vaultContentPath, sessionFile, config } = args;
    try {
      const modelStr = config.model
        ? `${config.model.provider}/${config.model.id}`
        : undefined;
      const result = spawnDistillInWorktree({
        vault: vaultContentPath,
        sessionFile,
        parentCwd: c.cwd,
        maxDurationSecs: Math.round(getMaxDistillDurationMs(config) / 1000),
        model: modelStr,
      });
      // Capture startSha so the completion handler can diff post-squash
      // against the main vault's HEAD. The wrapper removes the worktree
      // (including meta.json) before completion fires, so we have to
      // capture it here on the JS side.
      const startSha = result.workspace.startSha;
      // Same for the branch suffix and error dir — needed by the
      // failure-surfacing probe (R7-SC-3) since the worktree is gone
      // by the time we look.
      const branchShort = result.workspace.branchName.replace(/^distill\//, "");
      const errorDir = resolveDistillErrorDir(vaultContentPath);
      return {
        target: result.workspace.worktreePath,
        cleanup: () => {
          try {
            cleanupDistillWorkspace(vaultContentPath, result.workspace);
          } catch {
            // ignore
          }
        },
        onComplete: (rctx) => {
          postOverlapNoticeOnCompletion(rctx, vaultContentPath, startSha);
        },
        checkFailure: () => findDistillErrorLogForBranch(errorDir, branchShort),
        checkOutcome: () => findDistillOutcomeForBranch(errorDir, branchShort),
      };
    } catch (err) {
      const theme = c.hasUI ? c.ui.theme : null;
      const { showStatus } = loadVaultConfig(
        new Napkin(c.cwd).vault.configPath,
      );
      if (c.hasUI && theme && showStatus) {
        const msg =
          err instanceof DistillError
            ? "distill: setup failed"
            : "distill: spawn failed";
        c.ui.setStatus(
          "napkin-distill",
          theme.fg("error", "✗") + theme.fg("dim", ` ${msg}`),
        );
      }
      return null;
    }
  }

  pi.registerCommand("distill", {
    description: "Distill conversation knowledge into the vault",
    handler: async (_args, ctx) => {
      if (isRunning) {
        if (ctx.hasUI) ctx.ui.notify("Distill already running", "warning");
        return;
      }
      lastSessionSize = 0; // bypass size check
      runDistill(ctx);
    },
  });

  pi.registerCommand("distill-auto-this-session", {
    description: "Pause/resume auto-distill for this session (on|off|status)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const needle = prefix.toLowerCase();
      const values = ["on", "off", "status"];
      const items = values
        .filter((v) => v.startsWith(needle))
        .map((v) => ({ value: v, label: v }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      // Detect when distill is disabled in the vault config so we can warn that
      // toggling the session flag has no effect.
      let vaultDistillEnabled = false;
      try {
        const vaultConfigPath = new Napkin(ctx.cwd).vault.configPath;
        vaultDistillEnabled = loadVaultConfig(vaultConfigPath).distill.enabled;
      } catch {
        // No vault — treat as disabled at vault level.
      }

      const vaultDisabledHint =
        "distill is disabled in vault config — set distill.enabled=true in .napkin/config.json";

      function describeState(suppressed: boolean): string {
        if (suppressed) return "Auto-distill is off for this session";
        return `Auto-distill is on for this session (next run in ${formatRemaining()})`;
      }

      let nextSuppressed: boolean;
      switch (arg) {
        case "":
          nextSuppressed = !autoDistillSuppressed;
          break;
        case "on":
          nextSuppressed = false;
          break;
        case "off":
          nextSuppressed = true;
          break;
        case "status": {
          if (!ctx.hasUI) return;
          if (!vaultDistillEnabled) {
            ctx.ui.notify(vaultDisabledHint, "warning");
            return;
          }
          ctx.ui.notify(describeState(autoDistillSuppressed), "info");
          return;
        }
        default:
          if (ctx.hasUI) {
            ctx.ui.notify(
              "Usage: /distill-auto-this-session [on|off|status]",
              "warning",
            );
          }
          return;
      }

      const wasSuppressed = autoDistillSuppressed;
      autoDistillSuppressed = nextSuppressed;

      // Persist state changes to the session file so the setting survives pi
      // restart and session resume. No-ops don't touch the session — otherwise
      // repeated invocations would bloat the file with identical entries.
      if (wasSuppressed !== nextSuppressed) {
        persistSuppressed(ctx.sessionManager, nextSuppressed);
      }

      // When re-enabling, reset the timer so the next run respects a full
      // interval instead of firing immediately if we were already past it.
      if (wasSuppressed && !nextSuppressed) {
        lastDistillTimestamp = Date.now();
      }

      renderIdleStatus();

      if (!ctx.hasUI) return;

      if (!vaultDistillEnabled) {
        ctx.ui.notify(vaultDisabledHint, "warning");
        return;
      }

      if (wasSuppressed === nextSuppressed) {
        ctx.ui.notify(describeState(nextSuppressed), "info");
        return;
      }

      if (nextSuppressed) {
        ctx.ui.notify("Auto-distill off for this session", "info");
      } else {
        ctx.ui.notify(
          `Auto-distill on for this session (next run in ${formatRemaining()})`,
          "info",
        );
      }
    },
  });

  // ---------------------------------------------------------------------------
  // /distill-status and napkin_distill_status
  //
  // Shared state: both surfaces read the exact same data (active worktrees +
  // unmerged branches) via module-level `collectDistillStatus`. The command
  // formats it for humans via `formatDistillStatus`; the tool returns the
  // JSON shape for the agent via `distillStatusToJson`. The formatters are
  // module-level + exported so tests can verify their output without wiring
  // a full mock `ExtensionAPI`.
  // ---------------------------------------------------------------------------

  /**
   * Resolve the main vault path from a command/tool `ctx`. Returns null when
   * no vault can be resolved (ctx.cwd isn't inside a napkin vault) — callers
   * surface a user-facing message in that case.
   */
  function resolveVaultPath(cwd: string): string | null {
    try {
      return new Napkin(cwd).vault.contentPath;
    } catch {
      return null;
    }
  }

  pi.registerCommand("distill-status", {
    description: "Show active auto-distill processes for the current vault",
    handler: async (_args, ctx) => {
      const vaultPath = resolveVaultPath(ctx.cwd);
      if (!vaultPath) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "No napkin vault resolved from current directory.",
            "warning",
          );
        }
        return;
      }

      const { active, unmerged } = collectDistillStatus(vaultPath);
      const msg = formatDistillStatus(active, unmerged);

      if (ctx.hasUI) {
        ctx.ui.notify(msg, "info");
      } else {
        // Headless pi: surface via stdout so `pi -p /distill-status ...` works.
        console.log(msg);
      }
    },
  });

  // Parallel pi tool: the LLM can query the same state the human gets from
  // /distill-status. Used by agents to decide whether to back off from
  // vault edits while a background distill is in flight (see also the
  // per-distill-completion overlap notice posted via
  // `appendCustomMessageEntry` once the distill finishes).
  pi.registerTool({
    name: "napkin_distill_status",
    label: "Napkin distill status",
    description:
      "Returns JSON listing active napkin distill subprocesses and unmerged distill branches for the current vault. Useful for checking if background vault writes are in progress before the agent makes concurrent edits.",
    promptSnippet:
      "Inspect in-flight napkin distill subprocesses before editing vault files.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const vaultPath = resolveVaultPath(ctx.cwd);
      if (!vaultPath) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "no vault in cwd" }),
            },
          ],
          details: { vault: null, active: [], unmerged: [] },
        };
      }
      const { active, unmerged } = collectDistillStatus(vaultPath);
      const json = distillStatusToJson(active, unmerged);
      return {
        content: [{ type: "text", text: json }],
        details: { vault: vaultPath, active, unmerged },
      };
    },
  });
}

/**
 * Gather the shared status payload consumed by both `/distill-status` and
 * `napkin_distill_status`. Empty arrays on any error (no git, git failure)
 * — status surfaces must never throw.
 *
 * Exported for unit tests. Callers pass the MAIN vault content path (not a
 * worktree). Both inspectors return [] when `.git/` is absent.
 */
export function collectDistillStatus(vaultPath: string): {
  active: ActiveDistill[];
  unmerged: string[];
} {
  return getDistillState({ contentPath: vaultPath });
}

/**
 * Format the `/distill-status` human-readable string. Pure function; exported
 * for unit tests.
 *
 * Output shape (matches the spec "Output format" block in shutdown-distill.md):
 *
 *   Active distills (N):
 *     [PID] Xs  branch=distill/abc-123  session=<basename>
 *     ...
 *   Unmerged branches (M):
 *     distill/xyz-456  (no active process)
 *
 * Zero-active case collapses to the single line `"No active distills."`
 * when there are also zero unmerged branches; otherwise the Unmerged block
 * still renders so the user can see lingering refs.
 */
export function formatDistillStatus(
  active: ActiveDistill[],
  unmerged: string[],
): string {
  const lines: string[] = [];
  if (active.length === 0) {
    lines.push("No active distills.");
  } else {
    lines.push(`Active distills (${active.length}):`);
    for (const d of active) {
      const elapsed = `${Math.floor(d.elapsedMs / 1000)}s`;
      const session =
        d.sessionPath !== null ? path.basename(d.sessionPath) : "unknown";
      const liveness = d.alive ? "" : " (dead)";
      lines.push(
        `  [${d.pid}] ${elapsed}  branch=${d.branch}  session=${session}${liveness}`,
      );
    }
  }

  if (unmerged.length > 0) {
    lines.push(`Unmerged branches (${unmerged.length}):`);
    for (const b of unmerged) {
      lines.push(`  ${b}  (no active process)`);
    }
  }

  return lines.join("\n");
}

/**
 * Serialise the same `(active, unmerged)` payload that `/distill-status`
 * renders to a JSON string for the `napkin_distill_status` pi tool. Pure
 * function; exported for unit tests.
 *
 * Return shape (see shutdown-distill.md — `/distill-status` command):
 *   {
 *     "active": [
 *       {
 *         pid: number,         // -1 when meta.json is unreadable
 *         branch: string,
 *         elapsedSeconds: number,
 *         session: string|null, // basename of parent session .jsonl
 *         alive: boolean,
 *         startedAt: string|null,
 *         startSha?: string,
 *       }
 *     ],
 *     "unmerged": ["distill/xyz-456", ...]
 *   }
 *
 * `session` is the basename of the parent session file (matching the
 * human-readable formatter) — the full path isn't useful to the agent and
 * would leak $HOME. `elapsedSeconds` is an integer (floor).
 *
 * `alive` and `startSha` are retained because they materially change how
 * the agent should interpret an entry (dead distills are candidates for
 * manual cleanup; `startSha` is a forensic hint for recovery).
 *
 * Shape is stable: new keys may be added, existing keys MUST NOT be renamed
 * or repurposed without a version bump.
 */
export function distillStatusToJson(
  active: ActiveDistill[],
  unmerged: string[],
): string {
  const payload = {
    active: active.map((d) => ({
      pid: d.pid,
      branch: d.branch,
      elapsedSeconds: Math.floor(d.elapsedMs / 1000),
      session: d.sessionPath !== null ? path.basename(d.sessionPath) : null,
      alive: d.alive,
      startedAt: d.startedAt,
      startSha: d.startSha,
    })),
    unmerged,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Compute the intersection of session-touched paths and distill-touched
 * paths. Matching is layered:
 *   1. Exact equality (the canonical case).
 *   2. Symmetric suffix — tolerates absolute session paths
 *      (`/home/user/.napkin/notes/foo.md`) against worktree-relative
 *      distill paths (`notes/foo.md`) without depending on which side
 *      is which.
 *   3. Basename equality — last-resort heuristic for the rare case
 *      where neither path is a suffix of the other (e.g. an absolute
 *      session path against a worktree-relative distill path that
 *      lives under a different subtree). This produces a known
 *      false-positive shape: two unrelated `README.md`s in different
 *      subtrees match. Accepted because the overlap notice is
 *      non-destructive (it surfaces a warning to the agent, doesn't
 *      modify files); the basename-collision test in
 *      `overlap-injection.test.ts` documents the trade-off.
 *
 * Exported for unit tests. Output is sorted so the overlap notice is
 * deterministic across runs.
 */
export function intersectFiles(
  session: ReadonlySet<string>,
  distill: ReadonlySet<string>,
): string[] {
  if (session.size === 0 || distill.size === 0) return [];

  const hits = new Set<string>();
  for (const d of distill) {
    for (const s of session) {
      if (
        d === s ||
        d.endsWith(`/${s}`) ||
        s.endsWith(`/${d}`) ||
        path.basename(d) === path.basename(s)
      ) {
        // Prefer the distill-side (worktree-relative) path for display;
        // it's shorter and scoped to the vault.
        hits.add(d);
      }
    }
  }
  return [...hits].sort();
}

/**
 * Format the overlap notice posted as a custom session message when
 * the parent session and a just-completed distill have written to the
 * same file(s).
 *
 * Leading `\n\n` separates it from any surrounding content so it can't
 * accidentally run into the last word of whatever the tail looks like.
 * The warning glyph (⚠️) catches the agent's attention; agents trained
 * on markdown treat it as a signal.
 *
 * Text is deliberately short (~45 tokens): the notice is posted via
 * `appendCustomMessageEntry` (R7-PERF-2 redesign) so it persists in
 * session history and forks cleanly into distill subprocess sessions.
 * Cache parity is preserved unconditionally vs the previous per-turn
 * `appendSystemPrompt` mechanism.
 */
export function formatOverlapNotice(overlapFiles: string[]): string {
  if (overlapFiles.length === 0) return "";
  const list = overlapFiles.join(", ");
  return (
    "\n\n\u26a0\ufe0f Background napkin distill is editing files you've also " +
    `touched: ${list}. Recent writes to these files may be overwritten or ` +
    "merged automatically at distill completion; consider re-reading before " +
    "further edits."
  );
}

/**
 * Pure helper for the POST-CONV-5 outcome-sidecar dispatch. Maps the
 * wrapper's exit-0 outcome class (or its absence) to the UI severity +
 * notification text. Caller (runDistillWith) applies theme styling +
 * dispatches to `ctx.ui.notify` / `ctx.ui.setStatus`.
 *
 * Inputs:
 *   - `outcome`: the parsed sidecar (`{ outcomeClass, partialMergeLogPath }`)
 *               or null when no sidecar exists at all (abnormal termination).
 *   - `elapsedSec`: wall-clock seconds since spawn, used in the
 *                  default success message (`merged-content`).
 *   - `readPartialMergeLog`: optional reader injected for testability.
 *                            Returns the log content as a string, or
 *                            null on read failure. Production passes
 *                            an `fs.readFileSync` wrapper.
 *
 * Outputs `{ level, message, statusKey, statusText }` per class:
 *   merged-content   → info  / "Distillation complete (Ns)"
 *   no-content       → warn  / "Distillation ran but saved no content"
 *   partial-merge    → warn  / "Distillation: partial merge — N file(s) reverted to main; see <log>"
 *   <unknown>        → warn  / defensive class string
 *   missing sidecar  → warn  / "Distillation terminated abnormally — no outcome record"
 *
 * `statusKey` maps to the theme's `fg(severity, glyph)` palette:
 *   success | warning | error.
 *
 * Exported for unit tests; production wiring lives in `runDistillWith`.
 */
export function formatOutcomeNotification(args: {
  outcome: {
    outcomeClass: string;
    partialMergeLogPath: string | null;
    recoveryHint: string | null;
  } | null;
  elapsedSec: number;
  readPartialMergeLog?: (path: string) => string | null;
}): {
  level: "info" | "warning" | "error";
  message: string;
  statusKey: "success" | "warning" | "error";
  statusGlyph: string;
  statusText: string;
} {
  const { outcome, elapsedSec, readPartialMergeLog } = args;
  if (!outcome) {
    return {
      level: "warning",
      message: "Distillation terminated abnormally — no outcome record",
      statusKey: "warning",
      statusGlyph: "⚠",
      statusText: " distill: abnormal",
    };
  }
  switch (outcome.outcomeClass) {
    case "merged-content":
      return {
        level: "info",
        message: `Distillation complete (${elapsedSec}s)`,
        statusKey: "success",
        statusGlyph: "✓",
        statusText: ` distill ${elapsedSec}s`,
      };
    case "merged-local":
      // PR #12: agent landed content on main but origin wasn't reached
      // (push failed, network down, or origin moved and the agent gave
      // up rather than loop indefinitely). Local main is ahead of
      // origin/<default>. User must push manually or wait for the next
      // distill's push to carry both forward. Surface as `warning` per
      // the locked notification severity contract.
      return {
        level: "warning",
        message: `Distillation complete locally; not pushed to origin (${elapsedSec}s)`,
        statusKey: "warning",
        statusGlyph: "⚠",
        statusText: " distill: local-only",
      };
    case "no-content":
      return {
        level: "warning",
        message: "Distillation ran but saved no content",
        statusKey: "warning",
        statusGlyph: "⚠",
        statusText: " distill: no content",
      };
    case "partial-merge": {
      let revertedCount = 0;
      if (outcome.partialMergeLogPath && readPartialMergeLog) {
        const content = readPartialMergeLog(outcome.partialMergeLogPath);
        if (content) {
          revertedCount = content
            .split("\n")
            .filter((line) => /\breverted '/.test(line)).length;
        }
      }
      const message = outcome.partialMergeLogPath
        ? `Distillation: partial merge — ${revertedCount} file${revertedCount === 1 ? "" : "s"} reverted to main; see ${outcome.partialMergeLogPath}`
        : "Distillation: partial merge — some files reverted to main";
      return {
        level: "warning",
        message,
        statusKey: "warning",
        statusGlyph: "⚠",
        statusText: " distill: partial",
      };
    }
    default: {
      // PR #12: `failed:<reason>` carries a reason code identifying
      // which validator tripped (markers-after-agent-exit,
      // pre-existing-markers, head-not-on-default, agent-exit-nonzero,
      // agent-timeout, divergent-history). Surface as `error` with the
      // reason in
      // the message so the user can diagnose without opening the
      // error log first.
      //
      // PR #12 A4: when the wrapper's salvage path emitted a recovery
      // hint into the outcome sidecar (lines 2+), append it to the
      // notification message so the user sees the recommended
      // `git revert` / `git reflog` recovery action inline.
      if (outcome.outcomeClass.startsWith("failed:")) {
        const reason = outcome.outcomeClass.slice("failed:".length);
        const message = outcome.recoveryHint
          ? `Distillation failed: ${reason} — ${outcome.recoveryHint}`
          : `Distillation failed: ${reason}`;
        return {
          level: "error",
          message,
          statusKey: "error",
          statusGlyph: "✗",
          statusText: ` distill: ${reason}`,
        };
      }
      return {
        level: "warning",
        message: `Distillation: unrecognised outcome '${outcome.outcomeClass}'`,
        statusKey: "warning",
        statusGlyph: "⚠",
        statusText: " distill: unknown outcome",
      };
    }
  }
}

/**
 * Pure helper for the per-distill-completion overlap-notice mechanism
 * (R7-PERF-2). Stateless: given the just-completed distill's touched
 * files, the parent session's entries, and the cursor of the previous
 * completion, returns the overlap and the new cursor value to advance
 * to.
 *
 * Caller is expected to:
 *   1. Persist the new cursor (`newCursor`) into closure state, even
 *      when overlap is empty — otherwise the next completion re-walks
 *      the same window.
 *   2. If overlap is non-empty, post it via `appendCustomMessageEntry`
 *      (or otherwise notify the agent).
 *
 * The session walk is bounded to `entries.slice(cursor)` so each
 * completion only considers messages added since the previous
 * completion. Cursor 0 means "start of session" — the first completion
 * compares against everything the parent has done so far.
 *
 * Exported for unit tests; production wiring lives in
 * `postOverlapNoticeOnCompletion` inside the extension factory.
 */
export function computeOverlapForCompletion(args: {
  distillTouchedFiles: readonly string[];
  sessionEntries: readonly SessionEntry[];
  cursor: number;
}): { overlap: string[]; newCursor: number } {
  const { distillTouchedFiles, sessionEntries, cursor } = args;
  const newCursor = sessionEntries.length;

  if (distillTouchedFiles.length === 0) {
    return { overlap: [], newCursor };
  }

  // Slice-bounded walk: only consider entries added since the previous
  // completion's cursor. `getSessionTouchedFiles` accepts any
  // `SessionEntriesSource` (`{ getEntries(): SessionEntry[] }`) so we
  // adapt the slice on the fly.
  const slice = sessionEntries.slice(cursor);
  const sessionTouched = getSessionTouchedFiles({
    getEntries: () => slice as SessionEntry[],
  });
  if (sessionTouched.size === 0) {
    return { overlap: [], newCursor };
  }

  const overlap = intersectFiles(sessionTouched, new Set(distillTouchedFiles));
  return { overlap, newCursor };
}
