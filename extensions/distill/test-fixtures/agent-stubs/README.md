# Agent-behavior bash-stub fixtures (PR #12 Item C1)

This directory holds executable bash scripts that simulate the behavior of
`pi --session ... -p ...` (the distill agent) for integration tests in
`agent-driven-merge.test.ts`. Each fixture covers one behavior class from
the design's "Mocked-pi behaviors" testing plan (10 scripts).

## Why bash stubs?

Tests need to exercise the wrapper's full pipeline (post-validation,
salvage, outcome dispatch, sidecar emission) against representative
agent outcomes without burning real LLM tokens. Each fixture deterministically
produces the filesystem effects of one agent behavior class.

## Argument shape

The wrapper invokes `pi` as:

```
pi --session <session-fork> [--model <model>] -p <prompt>
```

Fixtures ignore positional args and read state from a small set of env
vars set by the test harness (see "Env-var contract" below). The
fixture script is referenced via `NAPKIN_DISTILL_PI_BIN=<fixture-path>`
in the test's wrapper invocation.

## Env-var contract

Set by the test harness (`runWrapperWithFixture` in `_test-helpers.ts`)
before invoking the wrapper. Each fixture reads what it needs:

| Env var                      | Meaning                                                |
|------------------------------|--------------------------------------------------------|
| `NAPKIN_STUB_VAULT`          | absolute path to the test vault (main repo)            |
| `NAPKIN_STUB_WORKTREE`       | absolute path to the distill worktree                  |
| `NAPKIN_STUB_BRANCH`         | distill branch name (e.g. `distill/abc123-1700000000`) |
| `NAPKIN_STUB_DEFAULT_BRANCH` | default branch (typically `main`)                      |

Tests that need fixture-specific knobs (e.g. timeout duration, custom
file content) pass additional `NAPKIN_STUB_*` vars and the fixture
reads them with bash defaults (`${NAPKIN_STUB_FOO:-default}`).

## Fixture index

| Fixture                          | Behavior                                                                    | Expected outcome                  |
|----------------------------------|-----------------------------------------------------------------------------|-----------------------------------|
| `clean-distill.sh`               | commits 1 file directly on default branch                                   | `merged-content`                  |
| `conflict-resolve-clean.sh`      | commits to distill branch, merges default with a conflict, resolves, squash | `merged-content`                  |
| `conflict-leave-markers.sh`      | commits a file containing all 3 marker types to default branch              | `failed:markers-after-agent-exit` |
| `no-distill.sh`                  | exits 0 without producing any commits                                       | `no-content`                      |
| `squash-skipped.sh`              | commits to distill branch but never squashes to default branch              | `no-content`                      |
| `multiple-commits-on-main.sh`    | commits 2+ times directly on default branch                                 | `merged-content`                  |
| `pushed-success.sh`              | commits and pushes to origin (requires test-side origin setup)              | `merged-content`                  |
| `push-fail-merged-local.sh`      | commits without pushing while origin exists                                 | `merged-local`                    |
| `push-fail-pull-merge-success.sh`| first push fails (origin advanced); agent recovers via pull --no-rebase     | `merged-content`                  |
| `agent-timeout.sh`               | sleeps past `maxDurationSecs` (test passes a low budget)                    | `failed:agent-timeout`            |
| `agent-crashes.sh`               | exits non-zero with diagnostic stderr                                       | `failed:agent-exit-nonzero`       |

## Adding a fixture

1. Write a self-contained `#!/usr/bin/env bash` script that reads
   `NAPKIN_STUB_*` env vars and produces the desired filesystem effect.
2. `chmod +x` the file (Phase C's commit captures the executable bit
   in git; verify with `git ls-files --stage <fixture>` showing
   `100755`).
3. Add a test in `agent-driven-merge.test.ts` that drives the wrapper
   against the new fixture and asserts the outcome class + sidecar
   contents.
4. Update the index table above.

## Relationship to inline `writePiStub` patterns

Existing tests (`wrapper-validation.test.ts`, `wrapper-salvage.test.ts`)
build their pi-stubs inline via `writePiStub(scaffold, body)` with
JS-side template-string interpolation. Those tests remain in place;
the fixtures here provide a parallel formal surface that can be
replayed without TS test-harness assistance (e.g. by a developer
debugging a wrapper change at the shell level).

A future cleanup pass (deferred to v0.2.x) may migrate the inline
stubs to call into these fixtures, but PR #12 keeps both surfaces.
