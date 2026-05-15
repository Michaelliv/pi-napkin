#!/usr/bin/env bash
# agent-crashes.sh — agent exits non-zero with diagnostic stderr.
# Simulates a real-world pi crash (network blip, internal error,
# OOM-on-startup, etc.). Wrapper captures stderr into the error log
# and dispatches `failed:agent-exit-nonzero`.
#
# No env vars required.

set +e
echo "stub agent: simulated crash" >&2
exit 7
