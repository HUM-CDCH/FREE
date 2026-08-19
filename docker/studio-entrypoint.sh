#!/bin/sh
# Studio owns two pieces of operating-system state that a container starts
# without: the Secret Service its credential store talks to, and a `free`
# database matching this branch's contract.
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

# `db:update` applies the contract itself rather than replaying migration
# history, which is what a disposable local database needs: it converges an
# empty volume and a drifted one alike, is a no-op once the schema matches, and
# leaves existing rows in place. `db:init` replays migrations instead, and this
# branch's committed history no longer satisfies the contract.
pnpm --filter db db:update

exec "$@"
