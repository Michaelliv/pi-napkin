Your distill content lives in the git worktree at {{worktreePath}}. Use `git -C {{worktreePath}}` for all git operations there — your shell cwd is NOT the worktree. Edit files in the worktree by absolute path under `{{worktreePath}}/...` (or `cd {{worktreePath}}` first if your tool supports it).

For the distill-content phase (steps 1-6), edit files only inside `{{worktreePath}}`; do not edit files under `{{vaultPath}}`. Writing distill content to `{{vaultPath}}` directly bypasses the worktree's isolation and causes the merge in steps 7-8 to silently include none of your changes. The integration phase (steps 7-9) explicitly runs `git -C {{vaultPath}}` commands to squash and push — those are correct and required, not a violation of this rule.

Distill this conversation into the napkin vault, then integrate your changes back into the main vault yourself. The wrapper that invoked you will only validate the result; it will NOT run merge, squash, push, or cleanup on your behalf.

1. `napkin overview` — learn the vault structure and what exists. Read `_about.md` files to understand what each folder is for. These are short folder descriptions (1-2 paragraphs) explaining what kinds of notes belong there — see existing ones for style.
2. `napkin template list` and `napkin template read` — learn the note formats.
3. Identify what's worth capturing. The vault structure and templates tell you what kinds of notes belong.
4. For each note:
   a. `napkin search` for the topic — if a note already covers it, `napkin append` instead of creating a duplicate
   b. Create new notes with `napkin create`, following the template format; use the relevant folder path
   c. Add `[[wikilinks]]` to related notes
5. Append a brief summary of key activities and decisions to today's daily note in the relevant namespace (e.g. `{namespace}/daily/YYYY-MM-DD.md`). Follow existing patterns. Create it if it doesn't exist.
6. Frontmatter convention: when you create a note that replaces an older one, add `supersedes: ["path/to/old/note.md"]` to its frontmatter. A future janitor will archive the superseded note. Leave the field empty or omit it for notes that stand alone.

Be selective. Only capture knowledge useful to someone working on this project later. Skip meta-discussion, tool output, and chatter.

7. Integrate with main. If you decided nothing in this conversation merits capturing (per "Be selective" above), skip steps 7-9 entirely and exit — the wrapper will classify this as `no-content` and surface a warning to the user. Otherwise, from the worktree at {{worktreePath}}, commit your distilled content first if you haven't already:

       git -C {{worktreePath}} add -A
       git -C {{worktreePath}} commit -m "distill: <one-line summary>"

   Then merge {{defaultBranch}} into your distill branch:

       git -C {{worktreePath}} merge --no-edit {{defaultBranch}}

   `--no-edit` accepts git's auto-generated merge commit message non-interactively; without it, git would open `core.editor` on a clean auto-merge and your bash tool (which has no TTY) would hang or fail.

   If conflicts arise, you will see files with standard `<<<<<<<`, `=======`, `>>>>>>>` markers. Resolve each by editing the file in place to produce the correct merged content. Use the conversation history above to inform your choices — you have full context on what content you intended to add. Once all markers are gone:

       git -C {{worktreePath}} add .
       git -C {{worktreePath}} commit --no-edit

   If `git -C {{worktreePath}} merge --no-edit {{defaultBranch}}` reports "Already up to date" (no merge commit), that's fine — proceed.

8. Squash to main. From the main vault at {{vaultPath}}, switch to the default branch and squash-merge your branch:

       git -C {{vaultPath}} checkout {{defaultBranch}}
       git -C {{vaultPath}} merge --squash {{branchName}}
       git -C {{vaultPath}} commit -m "distill: <one-line summary of what you captured>"

   Use `--squash` to keep main's history linear (one commit per distill). If `git merge --squash` produces no staged changes (e.g. your distill content was already on main), skip the commit step — there's nothing new to land.

9. Push if origin exists. Check `git -C {{vaultPath}} remote -v`. If `origin/{{defaultBranch}}` is configured, push your changes:

       git -C {{vaultPath}} push origin {{defaultBranch}}

   If push fails because the remote moved, recover with pull-merge-push (NOT pull-rebase):

       git -C {{vaultPath}} pull --no-rebase origin {{defaultBranch}}
       git -C {{vaultPath}} push origin {{defaultBranch}}

   `--no-rebase` forces merge semantics regardless of any global `pull.rebase` config the user may have set.

   NEVER use `--force` or `--force-with-lease`. If push fails for any reason and you cannot recover, stop — do not loop indefinitely. The wrapper will detect local-only state and surface a warning to the user.

Report progress concisely as you go. Stop when steps 1-9 are complete.
