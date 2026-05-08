# napkin-distill

Pi extension that automatically distills knowledge from conversations into your napkin vault.

## How it works

1. Runs on a configurable interval (default: 60 minutes)
2. Checks if the conversation changed since last distill
3. Sends the new conversation to a model
4. The model extracts structured notes using your vault's templates
5. Notes are written directly into the vault

## Setup

Enable distill in your vault config:

```bash
napkin config set --key distill.enabled --value true
```

Or edit `.napkin/config.json` directly:

```json
{
  "distill": {
    "enabled": true,
    "intervalMinutes": 60,
    "model": {
      "provider": "anthropic",
      "id": "claude-sonnet-4-6"
    }
  }
}
```

## Configuration

All distill settings live in `.napkin/config.json` under the `distill` key:

| Field | Default | Description |
|-------|---------|-------------|
| `distill.enabled` | `false` | Enable automatic distillation |
| `distill.intervalMinutes` | `60` | How often to check for new content |
| `distill.model.provider` | `"anthropic"` | LLM provider |
| `distill.model.id` | `"claude-sonnet-4-6"` | Model for distillation |


## Manual trigger

Use `/distill` in pi to manually trigger distillation of the full conversation.

## Turn off for this session

`/distill-auto-this-session` turns auto-distill off or on for the current session only. Manual `/distill` still works regardless.

| Invocation | Effect |
|------------|--------|
| `/distill-auto-this-session` | Toggle (on ↔ off) |
| `/distill-auto-this-session on` | Turn auto-distill on |
| `/distill-auto-this-session off` | Turn auto-distill off |
| `/distill-auto-this-session status` | Report current state and time to next run |

### Status bar indicator

| Display | Meaning |
|---------|---------|
| `distill: 59m30s` | Auto-distill is on — countdown to next run |
| `distill: off (session)` | Auto-distill is off for this session |
| `distill: off` | Distill is disabled at the vault level (`distill.enabled=false`) |
| `● distill 12s` | A distillation is currently running |

### Persistence

The off/on state is written into the session file as a `CustomEntry` (it does not enter the LLM context). Resuming the same session with `pi --session <path>` — or picking it from the session list — restores the state. Other sessions (and new sessions) are unaffected.

On resume, a brief notification reminds you when auto-distill is still off, so you don't lose track of it.

Turning auto-distill back on resets the countdown so the next run respects the full interval instead of firing immediately.

Persistent vault-wide opt-out still lives in `.napkin/config.json` (`distill.enabled`).

### Notes

- `/distill-auto-this-session off` does **not** interrupt a distillation already in flight. It only suppresses future scheduled runs.
- If `distill.enabled` is `false` in the vault config, the command warns that the session flag has no effect — enable distill in the vault config first.
- Forking a session with auto-distill off carries the state forward (the CustomEntry is copied with the rest of the session). Run `/distill-auto-this-session on` in the fork to turn it back on.
