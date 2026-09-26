#!/bin/sh
# Studio owns operating-system state that a container starts without: the
# Secret Service its credential store talks to, Codex's persistent home, and an
# authored database schema replayed before the production Node host starts.
set -eu

: "${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR must be set}"
: "${DBUS_SESSION_BUS_ADDRESS:?DBUS_SESSION_BUS_ADDRESS must be set}"
: "${CODEX_HOME:?CODEX_HOME must be set}"
: "${DATABASE_URL:?DATABASE_URL must be set}"
: "${FREE_KEI_POSTGRES_PASSWORD:?FREE_KEI_POSTGRES_PASSWORD must be set}"

install -d -m 700 "$XDG_RUNTIME_DIR" "$CODEX_HOME"
rm -f "$XDG_RUNTIME_DIR/bus"
dbus-daemon --session --fork --address="$DBUS_SESSION_BUS_ADDRESS"

# There is no PAM desktop login in a container. Initializing the login
# collection with an empty password lets GNOME Keyring serve the Secret Service
# API that `@napi-rs/keyring` uses. Credentials live in the mounted HOME, so
# they survive a restart but not a volume removal.
printf '\n' | gnome-keyring-daemon --unlock >/dev/null
gnome-keyring-daemon --start --components=secrets >/dev/null

# Hosted startup replays the authored migration history. It never updates the
# schema directly or seeds an account; the first successful OIDC callback
# creates the Researcher Account just in time.
pnpm --filter db db:init

# kei (the Parsing Service's DBOS worker from M3) logs in with its own role, which owns only kei_dbos.
pnpm --filter db db:kei-role

exec "$@"
