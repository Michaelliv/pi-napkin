# pi-napkin

🧻 [Napkin](https://github.com/cad0p/napkin) integration for [pi](https://github.com/badlogic/pi-mono).

Gives a pi agent first-class access to an Obsidian-compatible knowledge vault, with automatic knowledge distillation that safely captures conversation context into notes as you work.

## Install

pi-napkin depends on the [`@cad0p/napkin`](https://github.com/cad0p/napkin) CLI. Install it first:

```bash
npm install -g @cad0p/napkin
# or: bun add -g @cad0p/napkin
```

Then install the pi-napkin extension:

```bash
pi install npm:@cad0p/pi-napkin
```

### Requirements

- **bash 4+** — the auto-distill wrapper uses bash arrays, `local -n`, and other bash-4 features. macOS ships bash 3.2 by default; install a newer one via `brew install bash` (the wrapper resolves bash via its `#!/usr/bin/env bash` shebang, so it picks up homebrew's bash if `brew` is on `PATH`).
- **`timeout(1)` from coreutils** — used to bound the agent's wall-clock budget (`distill.maxDurationMinutes`). Linux distros ship it as `timeout`; macOS ships it as `gtimeout` after `brew install coreutils`. The wrapper detects either binary and falls back fast with a helpful error if neither is present.
- **git 2.20+** — needed for `git worktree`, `merge-base --is-ancestor`, and `symbolic-ref --short HEAD`.
- **A `pi` configured with at least one model provider** — auto-distill spawns `pi -p` against the model in `distill.model.{provider,id}`. Manual `/distill` reuses the parent session's provider.

<details>
<summary>Pre-release / dev installs</summary>

- Pre-release (calver snapshots from `main`, published to npm `@next` on every push):

  ```bash
  pi install npm:@cad0p/pi-napkin@next
  ```

  pi pins npm installs with an explicit tag or version — `pi update` won't auto-bump this. Re-run the install to pick up newer `@next` builds.

- Install from source for local development:

  ```bash
  pi install git:github.com/cad0p/pi-napkin
  ```

</details>

## What you get

Two pi extensions, one skill, two slash commands, one agent tool.

### Extensions

| Extension | What it does |
|---|---|
| `napkin-context` | On session start, injects the vault overview into the agent's context. Registers `kb_search` + `kb_read` tools. |
| `napkin-distill` | Automatic knowledge distillation. Runs on a timer and at shutdown, forks the conversation, and asks a cheap model to extract structured notes into the vault. |

### Skill

The [`napkin` skill](skills/napkin/SKILL.md) gives the agent a full CLI reference — all commands, flags, and patterns.

### Slash commands

- `/distill` — Trigger a manual distill now. Works in any vault; does not require git.
- `/distill-auto-this-session` — Turn the automatic timer off / on for the current session. Persists across pi restarts.
- `/distill-status` — Show active background distill processes for the current vault.

### Agent tool

- `napkin_distill_status` — JSON version of `/distill-status`, for the agent to query programmatically before making concurrent vault edits.

## Auto-distill requires subdir vault layout

Auto-distill (interval + shutdown) uses git worktrees for concurrency safety.
That requires the vault to use napkin's **subdir layout** — the config in a
`.napkin/` subdir distinct from the content root:

```
my-vault/
  .napkin/
    config.json    ← napkin config here, with `"vault": { "root": ".." }`
  NAPKIN.md
  changelog/
  daily/
  …
```

`napkin init` creates this layout by default, so freshly created vaults work out
of the box. If your vault uses the **legacy embedded layout** (config at
`<vault>/config.json` with no `.napkin/` subdir, where `configPath ===
contentPath`), you'll see a migration notification at session start and
auto-distill will be disabled for the session. Legacy layout continues to
work for manual `/distill` (which doesn't need concurrency safety) and for
napkin CLI commands generally — only auto-distill requires the subdir
layout.

### Why

Worktree-based concurrency relies on the worktree having a `.napkin/`
subdir post-checkout, so the wrapper's `git add -A` + `git commit` +
`git merge --squash` operations on the worktree see the isolated
vault layout. On a subdir-layout vault, the branch tracks
`.napkin/config.json`, so every checked-out worktree has the
`.napkin/` subdir. On a legacy-embedded vault, the branch has no
`.napkin/` subdir at all (`.napkin/` IS the vault), so the worktree
has nothing to operate on — the wrapper would silently produce empty
commits, and the per-distill napkin shim's `--vault $WORKTREE` would
point at a directory napkin doesn't recognize as a vault. The
concurrency guarantee silently degrades to nothing.

### Where worktrees live

Active distill worktrees are placed under
`$XDG_CACHE_HOME/napkin-distill/<vault-hash>/<id>/` (typically
`~/.cache/napkin-distill/…`), outside your vault. `<vault-hash>` is
`sha256(contentPath).slice(0, 16)` so worktrees from multiple vaults never
collide. External placement avoids:

- **Cloud-sync pollution** — OneDrive/Dropbox don't respect `.gitignore`;
  in-vault worktrees would upload tens of MB per distill spawn.
- **Filesystem-walker pollution** — Obsidian plugins and `find` descend
  into worktrees and see N full vault copies for N concurrent distills.
- **Autocommit-cron noise** — gitlinks can surface in `git status` under
  some command sequences; external placement eliminates the surface.

Inspect active distills with `/distill-status`. If you ever need to nuke
all distill state for a vault (stuck lock, etc.):

```bash
rm -rf ~/.cache/napkin-distill/<hash>/
```

Safe — anything valuable is either already committed to main or was
never going to commit.

### Migration from legacy layout

```bash
# From your vault directory (e.g. ~/.napkin or wherever configPath == contentPath)
mkdir .napkin
mv config.json .napkin/config.json
# Edit .napkin/config.json and add at the top level:
#   "vault": { "root": ".." }
# After editing, reload pi (or /quit and restart).
```

Verify with `napkin vault --json` — the `path` field should point at
`<vault>/.napkin/` (that's the new configPath) and napkin should still
find all your notes.

## Vault resolution

Both extensions use napkin's built-in vault resolution. The resolution order is:

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

## Auto-distill

Auto-distill is the core feature. It runs in the background without prompting the user, periodically forking your pi session and asking a cheap model to extract knowledge into the vault. It's off by default.

### Enable it

```bash
napkin --vault ~/path/to/vault config set --key distill.enabled --value true
```

Or edit `<vault>/.napkin/config.json` directly:

```jsonc
{
  "distill": {
    "enabled": true,
    "intervalMinutes": 60,
    "onShutdown": true,
    "model": { "provider": "kiro", "id": "claude-sonnet-4-6" }
  }
}
```

### Config keys

| Setting | Default | Description |
|---|---|---|
| `distill.enabled` | `false` | Master switch. When false, nothing auto-distill related happens. |
| `distill.intervalMinutes` | `60` | Timer interval. |
| `distill.maxDurationMinutes` | `10` | Maximum wall-clock duration a detached distill subprocess is allowed before the parent's poll loop declares it stuck and force-cleans its worktree. Values `<= 0` or non-finite silently fall back to the 10-minute default so a bad config can't disable the timeout entirely. Lower this for short-session vaults where a 10-minute hang is unacceptable; raise it for vaults with large merge windows or slow providers. |
| `distill.onShutdown` | `true` | Also run a final distill at pi shutdown, to capture anything the interval missed. |
| `distill.model.provider` | `"anthropic"` | Model provider for the distill subprocess. |
| `distill.model.id` | `"claude-sonnet-4-6"` | Model ID. Prefer a cheap, fast model — distill is automated, not interactive. |

### How it works

When enabled, on session start the extension:

1. Runs `ensureVaultReadyForAutoDistill` on the vault (see below) — git-inits if needed and scaffolds `.gitignore`.
2. Sweeps stale distill worktrees left by crashed pi instances (`cleanupStaleWorktrees`).
3. Arms a timer (`intervalMinutes`) that spawns a detached `pi -p` subprocess on tick.
4. On shutdown (unless `distill.onShutdown` is false or the session file is already captured), spawns one final distill.

Each distill subprocess gets its own isolated copy of the vault via `git worktree add`. See [Concurrency](#concurrency) below.

The distill subprocess runs a prompt that asks the model to:
- Learn the vault structure via `napkin overview` and `_about.md` files
- Read the templates via `napkin template list`
- Search for existing notes on a topic before creating duplicates
- Create or append to notes as appropriate
- Add `[[wikilinks]]` to related notes
- Tag superseded notes with `supersedes: ["path/to/old.md"]` frontmatter for a future janitor to archive

### Auto-init on first use

When you enable `distill.enabled: true` on a vault that isn't a git repo, pi-napkin auto-initializes it on the next session start:

1. Runs `git init`.
2. Scaffolds `.gitignore` (excludes `.napkin/distill/` — the per-worktree session fork). Distill worktrees themselves live outside the vault (see [Where worktrees live](#where-worktrees-live)), so `.gitignore` doesn't need to exclude them. No `.gitattributes` is written — the agent-driven merge architecture has no driver to register.
3. Commits everything as `napkin: initial vault commit (auto-distill setup)`.
4. Notifies you once, with instructions to undo (`rm -rf <vault>/.git`) or opt out (`distill.enabled: false`).

Auto-distill requires git **and** the subdir vault layout (see [Auto-distill requires subdir vault layout](#auto-distill-requires-subdir-vault-layout)). Manual `/distill` requires neither — it just spawns a detached `pi -p` with the session forked to a temp dir, no worktree.

### Running an auto-distill loop

Once configured, nothing further is required: open any pi session in a directory under the vault and the timer arms automatically. You'll see a `distill: Xm..s` countdown in the status bar and a one-time notice when a distill begins, completes, or fails.

To pause for the current session only (e.g., you're drafting sensitive content you don't want captured):

```
/distill-auto-this-session off
```

Toggles back on with `/distill-auto-this-session on`. State persists across pi restarts of that same session.

## Concurrency

Running multiple pi sessions against the same vault (for example, autonomous agent fleets spawning many sessions in parallel) or having Obsidian open while a distill is running would race on file writes. pi-napkin uses git worktrees to make this safe.

### Worktree per distill

Each auto-distill invocation (interval fire or shutdown) creates its own temporary branch and worktree under `$XDG_CACHE_HOME/napkin-distill/<vault-hash>/<branch-suffix>/` (typically `~/.cache/napkin-distill/…`). pi runs at the **parent session's cwd** (not the worktree) so the system prompt's `Current working directory:` line stays byte-identical to the parent's, preserving prompt-cache hits. Vault writes from the agent's bash tool are routed back to the worktree by a per-distill napkin shim at `<worktree>/.napkin/distill/bin/napkin` that injects `--vault <worktree>` into every napkin invocation. See [Where worktrees live](#where-worktrees-live) for why the worktree dir is external to the vault.

### How distill resolves conflicts

The distill agent owns the full lifecycle: produce content → merge default branch into the distill branch → squash to default → push to origin (if configured) → clean up. The wrapper does NOT invoke a per-file merge driver; the model that wrote the content also resolves any conflicts that surface when the worktree is reconciled with main.

Flow:

1. **Wrapper** sets up the worktree, installs the per-distill napkin shim, and spawns one `pi -p $PROMPT` invocation under `timeout ${maxDurationMinutes}m`. The prompt instructs the agent to walk steps 1–10 (distill → merge → squash → push → cleanup).
2. **Agent** distills content into the worktree, then runs `git -C <worktree> merge --no-edit <default>`. If conflicts surface, it edits each file in place using the conversation history as context.
3. **Agent** squash-merges into the vault's default branch (`git -C <vault> merge --squash <distill-branch>` then `git commit`).
4. **Agent** pushes to `origin/<default>` if origin is configured. On non-fast-forward failures it recovers via `git pull --no-rebase origin <default>` then re-pushes. It NEVER uses `--force` or `--force-with-lease`.
5. **Wrapper** post-validates: no conflict markers in tracked `*.md`, vault HEAD on default branch, push (if attempted) didn't rewrite shared history. Writes an outcome sidecar and force-cleans the worktree + distill branch.

The full prompt template lives at `extensions/distill/distill-prompt.md`. The wrapper bounds the agent's wall-clock with `timeout(1)`; everything else (retry policy, network handling, conflict-resolution shape) is the agent's call.

### Outcome classes

Each distill produces a sidecar at `<vault>/.napkin/distill/errors/<timestamp>-<pid>-<branch>.outcome` whose first line is a machine-readable class:

| Class | When | UI severity |
|---|---|---|
| `merged-content` | Agent produced content, integrated, squashed, and pushed to origin (or origin not configured). | info ✓ |
| `merged-local` | Agent integrated + squashed, but origin/`<default>` is configured AND local `<default>` is ahead of `origin/<default>` (push didn't land). | warning ⚠ — "distilled but not pushed" |
| `no-content` | Agent produced nothing (genuine no-op — selective filter), or committed to the distill branch but skipped squash (default branch never moved). | warning ⚠ |
| `failed:<reason>` | Wrapper validation rejected the agent's output, or the agent didn't complete. | error ✗ |

Known `failed:<reason>` codes:

| Reason | Meaning | Recovery |
|---|---|---|
| `markers-after-agent-exit` | Conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`) found in tracked `*.md` files that the agent did not have at distill start. The agent left an unfinished merge. | The squash commit may already be on `<default>`. Inspect with `git show HEAD`, then `git revert HEAD --no-edit` to undo cleanly. The dangling distill branch is recoverable from `git reflog` for ~2 weeks. |
| `pre-existing-markers` | Markers were present in the same files BEFORE the agent ran. Validation refuses to misattribute them. | Resolve the pre-existing markers in the vault yourself, then re-run distill. |
| `internal-validator-error` | The wrapper's post-distill marker validator could NOT run (e.g. `mktemp` failed because of a full disk or locked-down `TMPDIR`), so the vault was never scanned after the agent exited. | Inspect the vault manually for unresolved `<<<<<<< / ======= / >>>>>>>` markers before relying on the squash commit. If clean, the squash is keepable; otherwise `git -C <vault> revert HEAD --no-edit`. Distill content is recoverable from `git reflog` for ~90 days. |
| `head-not-on-default` | Vault HEAD is not on the default branch after the agent exited (detached HEAD or different branch). | Manually `git checkout <default>` after confirming nothing is in flight. The distill branch lives in `git reflog` if you want to recover its content. |
| `divergent-history` | After the agent's push, `origin/<default>` and local `<default>` diverged in a way that doesn't look like a fast-forward (unexpected; benign third-party push or — defensively — a force-push). | Inspect `origin/<default>` vs local. If a teammate landed a commit during distill, `git pull --no-rebase` to integrate. |
| `agent-exit-nonzero` | The agent's `pi -p` invocation exited non-zero with no other diagnostic. | See the error log next to the sidecar for the agent's stderr. |
| `agent-timeout` | `timeout(1)` killed the agent after `distill.maxDurationMinutes` minutes. | Bump `distill.maxDurationMinutes` if your conversations routinely produce long distills, or check the error log for what the agent was doing when it timed out. |

A missing sidecar AND missing error log means the wrapper itself was killed before writing either (SIGKILL, OOM). The JS-side poller surfaces this as "distill terminated abnormally".

### Salvage when validation fails

The salvage path is deliberately narrow: the wrapper janitors the **worktree and distill branch**, never the main vault's commit history. If validation fails:

- Force-remove the worktree (`git worktree remove --force` + path-safety guard, falling back to `rm -rf` only if the worktree path is a descendant of the resolved cache root).
- Force-delete the distill branch (`git branch -D`).
- Write a `failed:<reason>` sidecar with a recovery hint that points at the corrupt squash commit if one landed on `<default>`.
- Exit 1.

The wrapper deliberately does NOT `git reset --hard` or otherwise rewrite the vault's commit history. If the agent's squash landed corrupt content, the user's `git revert HEAD --no-edit` (forward-only) is preferred over a destructive reset that could clobber concurrent edits the user made between distill spawn and validation. The recovery hint in the failed sidecar names the exact command.

### Linear history

Successful distill lifecycles produce exactly one squash commit on `main`, with a one-line summary the agent generates from the distill content. This keeps history clean and makes it easy to revert a bad distill with `git revert <sha>`.

## Agent visibility

When a background distill completes a squash-merge that touches files you've also written this session, pi-napkin posts a one-line notice into the conversation as a custom session message so the agent knows its recent writes may have been merged or overwritten:

```
⚠️ Background napkin distill is editing files you've also touched: notes/foo.md.
Recent writes to these files may be overwritten or merged automatically at distill
completion; consider re-reading before further edits.
```

Key properties:
- **Trigger**: per distill completion (when the wrapper's squash-merge has landed and the worktree is gone), not per agent turn. Files actually changing in the parent's view is the right moment to surface the overlap.
- **Channel**: posted via `appendCustomMessageEntry` with `customType: "napkin-distill-overlap"`. Lives in session history (so distill subprocesses inherit it cleanly via session-fork) and is displayed in the TUI so you see it too.
- **Cache parity**: custom messages land at the END of the message array, so Anthropic-style prompt caching's prefix stays byte-identical. The notice itself becomes a one-time cache write rather than the recurring cache-bust the previous per-turn `appendSystemPrompt` mechanism produced.
- **Frequency**: bounded by the per-distill-completion trigger — typically ~5–12 messages/day for an active session, only when actual file overlap exists.
- **Cursor**: each completion only considers entries added since the previous completion. On a fresh session this starts at 0; on a resumed session it starts at the pre-resume entry count, so resume doesn't surface stale notices for files written in earlier pi processes.

The session-touched-files detector reimplements pi's internal `extractFileOpsFromMessage` (not exported from pi) and tracks `write`, `edit`, and bash-redirection-style writes. A companion version-check test (`session-touched-files.version-check.test.ts`) pins pi's upstream utility so we get an explicit test failure if pi renames / removes it.

## Vault setup

### New vault

```bash
mkdir my-vault && cd my-vault
napkin init
```

Then edit `.napkin/config.json` to set `distill.enabled: true`. On first pi session in the vault, auto-distill will auto-init git for you.

### Existing Obsidian vault

Just `cd` into it and run `pi`. napkin will detect `.obsidian/` and treat it as a vault. The `.napkin/` config dir lives alongside `.obsidian/`.

If you want auto-distill on an existing Obsidian vault:

1. Set `distill.enabled: true` in `.napkin/config.json` (create the file if missing).
2. Start a pi session in the vault.
3. On session start, pi-napkin prompts to auto-init git if the vault isn't already one.

If your vault IS already a git repo (common for "vault as project"), pi-napkin just adds the `.gitignore` scaffold and moves on.

## Troubleshooting

### "No vault in cwd"

Some command or tool couldn't resolve a vault from the current directory. Either:
- Run from a directory under a vault (any ancestor with `.napkin/` or `.obsidian/`)
- Set the global fallback in `~/.config/napkin/config.json`
- Pass `--vault <path>` to the napkin CLI

### Auto-distill stopped working

Check `/distill-status` to see if there are stale / dead worktrees. The next session start will sweep them automatically (`cleanupStaleWorktrees`). If that doesn't help, nuke the per-vault cache dir:

```bash
rm -rf ~/.cache/napkin-distill/<vault-hash>/
# Or, if you're not sure which hash matches your vault, the nuclear option:
rm -rf ~/.cache/napkin-distill/
```

Safe — anything valuable is either already committed to main or was never going to commit.

### Distill keeps failing (`failed:<reason>`)

Outcome sidecar: `<vault>/.napkin/distill/errors/<ISO-timestamp>-<pid>-<branch-hash>.outcome`. First line is the class string (`failed:<reason>`); remaining lines are a human-readable recovery hint.

Companion error log (if produced): `<ISO-timestamp>-<pid>-<branch-hash>.log` — wrapper diagnostics + the agent's stderr.

See the [Outcome classes](#outcome-classes) table for what each `<reason>` means and the recommended recovery action. Common patterns:

- `agent-timeout` recurring → bump `distill.maxDurationMinutes` (default 10) or investigate what's taking the agent so long. Log shows the last tool calls before SIGTERM.
- `markers-after-agent-exit` → the agent's squash commit may already be on `<default>` with literal `<<<<<<<` markers in tracked files. The recovery hint in the sidecar names the exact `git revert HEAD --no-edit` command.
- `agent-exit-nonzero` → check the model provider (rate limits, auth refresh, network). The agent's stderr is in the `.log` file.
- `divergent-history` → a teammate likely landed a commit on `origin/<default>` while the agent's distill ran. `git pull --no-rebase` to integrate.

### "vault not a git repo" / "legacy embedded layout"

Auto-distill requires **git** and the **subdir vault layout**. If you see:

- `vault not a git repo` — either set `distill.enabled: true` and let pi-napkin auto-init git for you on next session, run `git init` in the vault root manually, or disable auto-distill with `distill.enabled: false`.
- `legacy embedded layout` — follow the [migration steps](#migration-from-legacy-layout). Auto-distill stays off for this session; manual `/distill` works regardless.

Manual `/distill` works without git and works on any vault layout.

### Testing hooks

The distill wrapper (`extensions/distill/scripts/distill-wrapper.sh`) reads several environment variables that exist solely to make integration tests deterministic. Production code never sets them; documenting here so future maintainers know they exist and what they do, and so a future-you grepping for one of these names can land on this section.

| Variable | Purpose |
|---|---|
| `NAPKIN_DISTILL_PI_BIN` | Override the `pi` binary path. Integration tests under `extensions/distill/test-fixtures/agent-stubs/` point this at a bash stub that simulates a specific agent behavior class (clean-distill, conflict-resolve-clean, agent-timeout, etc.) so the wrapper completes its lifecycle without contacting a real LLM. |
| `NAPKIN_DISTILL_SKIP_PI=1` | Skip BOTH the napkin shim install AND the `pi` invocation. Used by tests that pre-stage file changes manually and only want to exercise the wrapper's lifecycle (validation, salvage, sidecar emission). |
| `NAPKIN_DISTILL_NO_RECURSE=1` | Exported by the wrapper into the agent's environment so a nested `pi` won't auto-distill recursively. Tests sometimes set it directly to suppress recursion when invoking the wrapper from inside another distill. |
| `NAPKIN_DISTILL_HALT_AFTER_META=1` | Halt right after rewriting `meta.json`'s pid to the wrapper's pid. Lets tests inspect the updated meta without the cleanup trap wiping the worktree. Clears the `EXIT` trap so cleanup is skipped — caller is responsible for tearing down the worktree afterwards. |
| `NAPKIN_DISTILL_HALT_AFTER_SHIM=1` | Halt right after the per-distill napkin shim is installed at `<worktree>/.napkin/distill/bin/napkin`. Lets tests inspect the shim contents and PATH injection without the cleanup trap firing. |
| `NAPKIN_DISTILL_FORCE_CLEANUP=1` | Force the salvage / cleanup path to run unconditionally (even on success). Used to test salvage idempotency. |
| `NAPKIN_DISTILL_TIMEOUT_KILL_GRACE_SECS=<n>` | Override the `timeout(1) -k` grace window (default 30s) — the delay between SIGTERM and SIGKILL when the agent exceeds `distill.maxDurationMinutes`. Used to keep timeout tests fast. |

Production never sets any of these. If you find one in your environment by accident, `unset` it and re-run — the wrapper falls back to its normal behaviour automatically.

## Migration from PR #11

pi-napkin v0.1.x shipped an LLM-backed git merge driver (`.napkin-distill-merge`). PR #12 (v0.2.x) deleted the driver entirely; the agent now resolves its own conflicts as part of the distill task. New vaults set up by v0.2+ never see the driver. Existing v0.1.x vaults retain inert fragments that are safe to leave in place but cleaner to remove:

```bash
# In each existing vault that ran v0.1.x distill:
git config --local --remove-section merge.napkin-distill-merge 2>/dev/null || true

# Edit <vault>/.gitattributes and remove this line if present:
#   *.md merge=napkin-distill-merge
```

Why manual: PR #12 deliberately avoids automatic migration. The orphaned `.gitattributes` rule falls back to git's built-in merge driver once the script is gone (the rule becomes inert, not harmful), so the cost of automating cleanup outweighs the benefit for a project with a small user base. New vaults aren't affected.

## Maintenance

### Verifying the agent prompt against a real LLM

CI uses bash-stub fixtures (`extensions/distill/test-fixtures/agent-stubs/`) to cover the agent-behavior space without burning tokens. For ad-hoc re-validation that a real model still walks the prompt cleanly — for instance after editing `extensions/distill/distill-prompt.md` — run:

```bash
bun run verify:agent-prompt
```

The script (`scripts/verify-agent-prompt.ts`) creates a tmpdir vault, builds the distill prompt with synthetic paths, invokes `pi -p` against the model named in `~/.config/napkin/config.json` (or whatever your global napkin config points at), and asserts the wrapper's documented post-conditions (see the script header for the full six-item list: no conflict markers, HEAD on default branch, agent's squash commit landed, distill branch removed, worktree removed, conflicted note resolved cleanly). Exits 0 on PASS, 1 on FAIL. Manual-only — not in CI.

## Future: builder-deleter

Next major feature: a "builder-deleter" janitor that acts on the `supersedes:` frontmatter convention that auto-distill already writes. When a note lists `supersedes: ["old/note.md"]`, the janitor archives the superseded file. Threshold-triggered to avoid running on every distill, git gc as the safety net. Design pending.

## License

MIT
