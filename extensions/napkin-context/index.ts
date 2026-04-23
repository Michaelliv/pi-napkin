import * as fs from "node:fs";
import * as path from "node:path";
import {
  type AgentToolResult,
  type ExtensionAPI,
  keyHint,
  type Theme,
  type ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { Markdown, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { Napkin } from "napkin-ai";
import { findVaultPath } from "../vault-resolve.js";

function loadShowStatus(vaultPath: string): boolean {
  const configPath = path.join(vaultPath, "config.json");
  if (!fs.existsSync(configPath)) return true;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return raw.showStatus !== false;
  } catch {
    return true;
  }
}

function formatKbResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  maxCollapsedLines: number,
): string {
  const output = result.content
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("\n")
    .trimEnd();
  if (!output) return "";
  const lines = output.split(/\r?\n/);
  const maxLines = options.expanded ? lines.length : maxCollapsedLines;
  const displayLines = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
  if (remaining > 0) {
    text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
  }
  return text;
}

function getNapkin(cwd: string): Napkin {
  const vaultPath = findVaultPath(cwd);
  if (!vaultPath) throw new Error("No napkin vault found");
  return new Napkin(path.dirname(vaultPath));
}

function getOverview(n: Napkin): string | null {
  try {
    const overview = n.overview();
    if (!overview) return null;

    let text = overview.context || "";
    if (overview.overview && overview.overview.length > 0) {
      text += "\n\n";
      for (const folder of overview.overview) {
        text += `${folder.path}/\n`;
        if (folder.keywords && folder.keywords.length > 0) {
          text += `  keywords: ${folder.keywords.join(", ")}\n`;
        }
        text += `  notes: ${folder.notes}\n`;
      }
    }
    return text.trim() || null;
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  let hasVault = false;

  pi.registerMessageRenderer(
    "napkin-context",
    (message, { expanded }, theme) => {
      if (!expanded) {
        const label = theme.fg("customMessageLabel", "🧻 napkin vault context");
        const hint = theme.fg("dim", " — Ctrl+O to expand");
        return new Text(label + hint, 1, 0);
      }
      return new Markdown(
        message.content,
        1,
        0,
        {
          heading: (t) => theme.fg("mdHeading", t),
          link: (t) => theme.fg("mdLink", t),
          linkUrl: (t) => theme.fg("mdLinkUrl", t),
          code: (t) => theme.fg("mdCode", t),
          codeBlock: (t) => theme.fg("mdCodeBlock", t),
          codeBlockBorder: (t) => theme.fg("mdCodeBlockBorder", t),
          quote: (t) => theme.fg("mdQuote", t),
          quoteBorder: (t) => theme.fg("mdQuoteBorder", t),
          hr: (t) => theme.fg("mdHr", t),
          listBullet: (t) => theme.fg("mdListBullet", t),
          bold: (t) => theme.bold(t),
          italic: (t) => theme.italic(t),
          strikethrough: (t) => theme.strikethrough(t),
          underline: (t) => theme.underline(t),
        },
        { color: (t) => theme.fg("customMessageText", t) },
      );
    },
  );

  pi.on("session_start", async (_event, ctx) => {
    const vaultPath = findVaultPath(ctx.cwd);
    if (!vaultPath) return;

    let n: Napkin;
    try {
      n = getNapkin(ctx.cwd);
    } catch {
      return;
    }

    const overview = getOverview(n);
    hasVault = !!overview;

    if (overview) {
      // Check if we already injected context in this session
      const alreadyInjected = ctx.sessionManager
        .getEntries()
        .some(
          (e) =>
            e.type === "custom_message" &&
            (e as { customType?: string }).customType === "napkin-context",
        );

      if (!alreadyInjected) {
        ctx.sessionManager.appendCustomMessageEntry(
          "napkin-context",
          "## Napkin vault context\n" +
            "You have access to a napkin vault (Obsidian-compatible knowledge base). " +
            "Here is the vault overview. Use the kb_search tool to find specific content, " +
            "and the kb_read tool to read files.\n\n" +
            overview,
          true,
        );
      }
    }

    if (ctx.hasUI && loadShowStatus(vaultPath)) {
      const theme = ctx.ui.theme;
      if (hasVault) {
        ctx.ui.setStatus("napkin", `🧻${theme.fg("dim", " napkin")}`);
      } else {
        ctx.ui.setStatus("napkin", theme.fg("dim", "napkin: no NAPKIN.md"));
      }
    }
  });

  // ── Tools ───────────────────────────────────────────────────────

  pi.registerTool({
    name: "kb_search",
    label: "KB Search",
    description: "Search the knowledge base for notes matching a query",
    promptSnippet: "Search the napkin vault for notes by keyword or topic",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const n = getNapkin(ctx.cwd);
      const results = n.search(params.query);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No results found." }],
          details: { results: [] },
        };
      }

      const text = results
        .map((r) => {
          let entry = `**${r.file}**`;
          if (r.snippets && r.snippets.length > 0) {
            entry += `\n${r.snippets.map((s) => `  ${s.text}`).join("\n")}`;
          }
          return entry;
        })
        .join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: { results },
      };
    },
    renderResult(result, options, theme, context) {
      const t =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      t.setText(formatKbResult(result, options, theme, 15));
      return t;
    },
  });

  pi.registerTool({
    name: "kb_read",
    label: "KB Read",
    description: "Read a file from the knowledge base",
    promptSnippet: "Read a note from the napkin vault by name or path",
    parameters: Type.Object({
      file: Type.String({ description: "File name or path to read" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const n = getNapkin(ctx.cwd);
      const result = n.read(params.file);

      return {
        content: [{ type: "text", text: result.content }],
        details: { path: result.path },
      };
    },
    renderResult(result, options, theme, context) {
      const t =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      t.setText(formatKbResult(result, options, theme, 10));
      return t;
    },
  });
}
