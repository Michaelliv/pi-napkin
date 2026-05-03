# pi-napkin

🧻 [Napkin](https://github.com/Michaelliv/napkin) integration for [pi](https://github.com/badlogic/pi-mono).

## Install

```bash
npm i -g napkin-ai
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

Both extensions use napkin-ai's built-in vault resolution. The resolution order is:

1. **Local project vault** — walk up from cwd looking for `.napkin/` (or `.obsidian/.napkin/`)
2. **Global fallback** — read `$XDG_CONFIG_HOME/napkin/config.json` (defaults to `~/.config/napkin/config.json`)
3. **Bare vault** — create a new vault at cwd as a last resort

```json
// ~/.config/napkin/config.json
{
  "vault": "~/path/to/vault"
}
```

Local project vaults take priority when present.

### Migrating from `~/.pi/agent/napkin.json`

If you previously configured your vault in `~/.pi/agent/napkin.json`, move it to the new location:

```bash
mkdir -p ~/.config/napkin
cp ~/.pi/agent/napkin.json ~/.config/napkin/config.json
```

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
