#!/usr/bin/env bash
# no-distill.sh — agent decides nothing is worth capturing and exits
# 0 without producing any commits. Vault HEAD stays at startSha;
# `validate_commit_count` returns 0 ⇒ `no-content`.
#
# No env vars required; the fixture is a no-op.

set -euo pipefail
exit 0
