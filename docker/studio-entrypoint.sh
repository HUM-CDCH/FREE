#!/bin/sh
# Studio owns what a container starts without: Codex's persistent home, the authored database schema replayed
# before the production Node host starts, and the database roles of the Parsing Service and of Studio itself.
set -eu

: "${CODEX_HOME:?CODEX_HOME must be set}"
: "${FREE_ADMIN_DATABASE_URL:?FREE_ADMIN_DATABASE_URL must be set}"
: "${DATABASE_URL:?DATABASE_URL must be set}"
: "${FREE_KEI_POSTGRES_PASSWORD:?FREE_KEI_POSTGRES_PASSWORD must be set}"

install -d -m 700 "$CODEX_HOME"

# Hosted startup replays the authored migration history as the administrative
# role. It never updates the schema directly or seeds an account; the first
# successful OIDC callback creates the Researcher Account just in time.
DATABASE_URL="$FREE_ADMIN_DATABASE_URL" pnpm --filter db db:init

# kei (the Parsing Service's DBOS worker) logs in with its own role, which owns only kei_dbos; Studio runs as the
# restricted role DATABASE_URL names, which owns only its own DBOS schema.
pnpm --filter db db:roles

# Studio, and every process it spawns, gets only the runtime role's URL. Container configuration (docker inspect or
# exec) still shows these values: the boundary is the server process, not the container.
unset FREE_ADMIN_DATABASE_URL FREE_KEI_POSTGRES_PASSWORD
exec "$@"
