#!/bin/sh
# Studio owns operating-system state that a container starts without: the
# Secret Service its credential store talks to, and an authored database
# schema replayed before the production Node host starts.
set -eu

: "${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR must be set}"
: "${DBUS_SESSION_BUS_ADDRESS:?DBUS_SESSION_BUS_ADDRESS must be set}"
: "${DATABASE_URL:?DATABASE_URL must be set}"

install -d -m 700 "$XDG_RUNTIME_DIR"
rm -f "$XDG_RUNTIME_DIR/bus"
dbus-daemon --session --fork --address="$DBUS_SESSION_BUS_ADDRESS"

# There is no PAM desktop login in a container. Initializing the login
# collection with an empty password lets GNOME Keyring serve the Secret Service
# API that `@napi-rs/keyring` uses. Credentials live in the mounted HOME, so
# they survive a restart but not a volume removal.
printf '\n' | gnome-keyring-daemon --unlock >/dev/null
gnome-keyring-daemon --start --components=secrets >/dev/null

# Hosted startup replays the authored migration history. It never updates the
# schema directly or seeds an account; the first account is created explicitly
# through the operator CLI after this command succeeds.
pnpm --filter db db:init

exec "$@"
