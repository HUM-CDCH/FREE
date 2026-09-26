#!/bin/sh
# Studio owns what a container starts without: Codex's persistent home, the authored database schema replayed
# before the production Node host starts, and the Parsing Service's restricted database role.
set -eu

: "${CODEX_HOME:?CODEX_HOME must be set}"
: "${DATABASE_URL:?DATABASE_URL must be set}"
: "${FREE_KEI_POSTGRES_PASSWORD:?FREE_KEI_POSTGRES_PASSWORD must be set}"

install -d -m 700 "$CODEX_HOME"

# Hosted startup replays the authored migration history. It never updates the
# schema directly or seeds an account; the first successful OIDC callback
# creates the Researcher Account just in time.
pnpm --filter db db:init

# kei (the Parsing Service's DBOS worker from M3) logs in with its own role, which owns only kei_dbos.
pnpm --filter db db:kei-role

exec "$@"
