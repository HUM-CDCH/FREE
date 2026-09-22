"""The Procrastinate application and the settings a deployment slot is named by.

One slot owns one queue and one worker process (docs/job-backend.md). The worker opens this app with its async
connector; the API only ever defers, which is all `SyncPsycopgConnector` promises, so it installs a sync
connector on this same module-level app once, at startup, through `deferring_installed()`.

Env: KEI_DATABASE_URL, KEI_SLOT, KEI_ADMISSION_LIMIT.
"""
from __future__ import annotations

import os
import threading
from collections.abc import Generator
from contextlib import contextmanager

import procrastinate

from kei_exp.files import load_dotenv

load_dotenv()
DATABASE_URL = os.environ.get("KEI_DATABASE_URL", "postgresql://kei:kei@127.0.0.1:5432/kei")
SLOT = os.environ.get("KEI_SLOT", "slot-1")
ADMISSION_LIMIT = int(os.environ.get("KEI_ADMISSION_LIMIT", "32"))


def queue_of(slot: str) -> str:
    """The queue a slot serves. Ownership is the queue: a job is deferred to the queue of the slot that runs it,
    and a slot's startup reconciliation reads only that queue's interrupted jobs."""
    return f"runs-{slot}"


QUEUE = queue_of(SLOT)

app = procrastinate.App(connector=procrastinate.PsycopgConnector(conninfo=DATABASE_URL),
                        import_paths=["kei_exp.jobs.tasks"])

_deferrer: procrastinate.App | None = None
_install_lock = threading.Lock()


@contextmanager
def deferring_installed(conninfo: str = DATABASE_URL) -> Generator[procrastinate.App]:
    """Install a sync connector on the app for this process, for the block's duration.

    Entered once per process, at startup — by the API's lifespan, or by a test fixture. NOT per request:
    `App.replace_connector` mutates the shared app rather than copying it, so two callers swapping at once
    restore each other's connectors and leave the app holding a closed pool.

    The connector is installed but never opened. Every kei-exp deferral passes `connection=`, which
    `SyncPsycopgConnector` uses directly, so its pool would never be consulted and opening one would only
    hold connections the admission limit has not accounted for.
    """
    global _deferrer
    with _install_lock:
        if _deferrer is not None:
            raise RuntimeError("a deferring connector is already installed for this process")
        connector = procrastinate.SyncPsycopgConnector(conninfo=conninfo)
        context = app.replace_connector(connector)
        installed = context.__enter__()
        _deferrer = installed
    try:
        yield installed
    finally:
        # Restore under the same lock that cleared _deferrer: releasing the lock first would let a
        # caller entering the guard in that window get clobbered by this thread's delayed restore.
        with _install_lock:
            _deferrer = None
            context.__exit__(None, None, None)


def deferrer() -> procrastinate.App:
    """The app to defer through. Raises when this process never installed one, which is a wiring error."""
    if _deferrer is None:
        raise RuntimeError(
            "no deferring connector is installed; the API's lifespan (or a test fixture) installs one")
    return _deferrer
