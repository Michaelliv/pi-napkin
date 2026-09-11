import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { findVaultPath } from "../vault-resolve.js";

interface DistillConfig {
  enabled: boolean;
  intervalMinutes: number;
  model: { provider: string; id: string };
}

interface VaultConfig {
  showStatus: boolean;
  distill: DistillConfig;
}

const MAX_DISTILL_DURATION_MS = 10 * 60 * 1000; // 10 minutes

const DEFAULT_DISTILL: DistillConfig = {
  enabled: false,
  intervalMinutes: 60,
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
};

function loadVaultConfig(vaultPath: string): VaultConfig {
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

Be selective. Only capture knowledge useful to someone working on this project later. Skip meta-discussion, tool output, and chatter.`;

/**
 * Escape a string for use in single-quoted shell arguments.
 */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Spawn a detached pi distill process that survives parent exit.
 * The shell wrapper cleans up the temp dir when pi finishes.
 * Returns the temp dir path (used as a completion marker — when it disappears, distill is done).
 */
function spawnDistill(
  sessionFile: string,
  cwd: string,
  config: DistillConfig,
): string | null {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-distill-"));

  try {
    const forkedSm = SessionManager.forkFrom(sessionFile, cwd, tmpDir);
    const forkedFile = forkedSm.getSessionFile();
    if (!forkedFile) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return null;
    }

    const piArgs = [
      "--session",
      forkedFile,
      "-p",
      "--model",
      `${config.model.provider}/${config.model.id}`,
      DISTILL_PROMPT,
    ];

    // Shell wrapper: run pi, then clean up temp dir regardless of exit code
    const escapedArgs = piArgs.map((a) => `'${shellEscape(a)}'`).join(" ");
    const cmd = `pi ${escapedArgs} >/dev/null 2>&1; rm -rf '${shellEscape(tmpDir)}'`;

    const proc = spawn("sh", ["-c", cmd], {
      cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, NAPKIN_DISTILL_NO_RECURSE: "1" },
    });
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
  let isRunning = false;

  pi.on("session_start", async (_event, ctx) => {
    const vaultPath = findVaultPath(ctx.cwd);
    if (!vaultPath) return;

    const { showStatus, distill: config } = loadVaultConfig(vaultPath);
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

    lastDistillTimestamp = Date.now();
    const intervalMs = config.intervalMinutes * 60 * 1000;

    if (ctx.hasUI && showStatus) {
      const theme = ctx.ui.theme;
      countdownHandle = setInterval(() => {
        if (isRunning) return;
        const remaining = Math.max(
          0,
          intervalMs - (Date.now() - lastDistillTimestamp),
        );
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        const display =
          mins > 0
            ? `${mins}m${secs.toString().padStart(2, "0")}s`
            : `${secs}s`;
        ctx.ui.setStatus(
          "napkin-distill",
          theme.fg("dim", `distill: ${display}`),
        );
      }, 1000);
    }

    intervalHandle = setInterval(() => {
      runDistill(ctx);
    }, intervalMs);
  });

  pi.on("session_shutdown", async () => {
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
    // No need to kill anything — detached processes survive on their own
  });

  function runDistill(ctx: {
    // biome-ignore lint/suspicious/noExplicitAny: partial ExtensionContext
    sessionManager: any;
    hasUI: boolean;
    // biome-ignore lint/suspicious/noExplicitAny: partial ExtensionContext
    ui: any;
    cwd: string;
  }) {
    if (isRunning) return;

    const vaultPath = findVaultPath(ctx.cwd);
    if (!vaultPath) return;

    const { showStatus, distill: config } = loadVaultConfig(vaultPath);
    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (!sessionFile) return;

    // Skip if session hasn't changed since last distill
    const currentSize = fs.existsSync(sessionFile)
      ? fs.statSync(sessionFile).size
      : 0;
    if (currentSize > 0 && currentSize === lastSessionSize) {
      lastDistillTimestamp = Date.now();
      return;
    }

    const tmpDir = spawnDistill(sessionFile, ctx.cwd, config);
    if (!tmpDir) {
      if (ctx.hasUI && ctx.ui.theme && showStatus) {
        ctx.ui.setStatus(
          "napkin-distill",
          ctx.ui.theme.fg("error", "✗") +
            ctx.ui.theme.fg("dim", " distill: spawn failed"),
        );
      }
      return;
    }

    isRunning = true;
    const startTime = Date.now();
    const theme = ctx.hasUI ? ctx.ui.theme : null;

    if (ctx.hasUI && theme && showStatus) {
      ctx.ui.setStatus(
        "napkin-distill",
        theme.fg("accent", "●") + theme.fg("dim", " distill"),
      );
    }

    // Poll for completion: temp dir disappears when the shell wrapper finishes
    pollHandle = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const timedOut = Date.now() - startTime > MAX_DISTILL_DURATION_MS;

      if (fs.existsSync(tmpDir) && !timedOut) {
        // Still running — update elapsed time in status bar
        if (ctx.hasUI && theme && showStatus) {
          ctx.ui.setStatus(
            "napkin-distill",
            theme.fg("accent", "●") + theme.fg("dim", ` distill ${elapsed}s`),
          );
        }
        return;
      }

      // Done or timed out
      if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
      isRunning = false;

      if (timedOut) {
        // Clean up orphaned temp dir
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (ctx.hasUI && theme) {
          if (showStatus) {
            ctx.ui.setStatus(
              "napkin-distill",
              theme.fg("error", "✗") + theme.fg("dim", " distill: timeout"),
            );
          }
          ctx.ui.notify("Distillation timed out (10m)", "error");
        }
        return;
      }

      lastDistillTimestamp = Date.now();
      lastSessionSize = currentSize;

      if (ctx.hasUI && theme) {
        if (showStatus) {
          ctx.ui.setStatus(
            "napkin-distill",
            theme.fg("success", "✓") + theme.fg("dim", ` distill ${elapsed}s`),
          );
        }
        ctx.ui.notify(`Distillation complete (${elapsed}s)`, "success");
      }
    }, 2000);
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
}
