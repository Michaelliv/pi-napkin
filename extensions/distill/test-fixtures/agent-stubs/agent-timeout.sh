#!/usr/bin/env bash
# agent-timeout.sh — agent sleeps past the wrapper's `maxDurationSecs`
# budget. The wrapper's `timeout(1) --foreground -k <grace> <budget>`
# fires SIGTERM at the budget boundary; this fixture exits cleanly
# on SIGTERM (no trap), letting the wrapper classify rc=124 as
# `failed:agent-timeout`.
#
# A separate test in `wrapper-validation.test.ts` covers the SIGTERM-
# resistant variant (escalates to SIGKILL after grace).
#
# No env vars required. Test must pass `maxDurationSecs: "1"`.

set -euo pipefail
sleep 30
