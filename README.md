# pi-napkin

🧻 [Napkin](https://github.com/Michaelliv/napkin) integration for [pi](https://github.com/badlogic/pi-mono).

## Install

```bash
npm i -g @shiftlabs/napkin
pi install npm:pi-napkin
```

## What you get

### Extensions

**napkin-context** — On session start, injects the vault overview into the agent's context. Registers two tools:

- `kb_search` — Search the vault by keyword or topic
- `kb_read` — Read a note from the vault by name or path

**napkin-distill** — Automatic knowledge distillation. Runs on a timer (default: 60 min), forks the conversation, and uses a cheap model to extract structured notes into the vault. `/distill` triggers it manually.

### Skill

The `napkin` skill gives the agent full CLI reference for napkin — all commands, flags, and patterns.

## Vault resolution

Both extensions resolve the vault in this order:

1. **Local project vault** — walk up from cwd looking for `.napkin/`
2. **Global fallback** — read `~/.pi/agent/napkin.json` for a default vault path

```json
// ~/.pi/agent/napkin.json
{
  "vault": "~/.pi/agent/kb"
}
```

Local project vaults take priority when present.

## Distillation config

Enable distillation in the vault's `.napkin/config.json`:

```bash
napkin --vault ~/.pi/agent/kb config set --key distill.enabled --value true
```

| Setting | Default | Description |
|---------|---------|-------------|
| `distill.enabled` | `false` | Enable automatic distillation |
| `distill.intervalMinutes` | `60` | Timer interval |
| `distill.model.provider` | `"anthropic"` | Model provider |
| `distill.model.id` | `"claude-sonnet-4-6"` | Model for distillation |

## License

MIT
