"""`kei-worker worker`: take the slot, read the boot timestamp, launch DBOS, register the lanes, serve until signalled.

DBOS.launch() migrates kei_dbos and recovers this executor's pending workflows (executor `kei-<slot>`, version
`kei@1`); a crash re-executes the step that was running and reuses every checkpointed one.
Env: KEI_SYSTEM_DATABASE_URL (role kei on database free), KEI_SLOT, KEI_RUNS, KEI_LOG_LEVEL.
"""
from __future__ import annotations

import argparse
import logging
import os
import re
import signal
import sys
import threading
from collections.abc import Callable
from urllib.parse import unquote, urlsplit

from dbos import DBOS

from kei_exp.workflows import boot, config, slot

logger = logging.getLogger(__name__)


def _until_signalled() -> None:
    stop = threading.Event()
    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, lambda *_: stop.set())
    stop.wait()


def _exit_hard(code: int) -> None:
    logging.shutdown()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


def serve(slot_name: str, database_url: str, *, until: Callable[[], None] = _until_signalled,
          exit_process: Callable[[int], None] = _exit_hard) -> None:
    logging.basicConfig(level=os.environ.get("KEI_LOG_LEVEL", "INFO"))
    # First: a second process is refused before it imports the model stack (this module, slot and runs are light;
    # `registered` is what loads docling and torch, test_worker_boot pins it).
    with slot.hold_slot(slot_name):
        logger.info("slot %s taken by pid %s", slot_name, os.getpid())
        import kei_exp.workflows.registered  # noqa: F401 - every workflow is registered before launch
        boot.set_timestamp(boot.database_clock_ms(database_url))
        try:  # a launch or a lane registration that fails still stops DBOS's threads before the slot is released
            DBOS(config=config.dbos_config(database_url, slot_name))
            DBOS.launch()
            config.register_queues()
            logger.info("kei worker %s serving", config.executor_id(slot_name))
            until()
        finally:
            DBOS.destroy()
        # destroy() does not wait for running steps, and their threads are not daemons: returning would free the slot
        # while they write on. Exiting here, still holding it, ends them with the process, and only then does the
        # kernel free the lock (spec, *kei worker*: held for the worker's lifetime; the boot boundary relies on it).
        # Nothing is recorded after destroy, so the interrupted steps' workflows stay PENDING and recovery runs them.
        exit_process(0)


def redacted(message: str, database_url: str) -> str:
    """`message` without the database URL or its password, in any spelling a driver may quote it."""
    secrets = {database_url}
    try:
        password = urlsplit(database_url).password
    except ValueError:
        password = None
    if password:
        secrets |= {password, unquote(password)}
    for secret in sorted(secrets, key=len, reverse=True):
        message = message.replace(secret, "***")
    message = re.sub(r"(://[^:/@\s]*:)[^@\s]*@", r"\1***@", message)  # any other URL's password
    return re.sub(r"(password\s*=\s*)\S+", r"\1***", message, flags=re.IGNORECASE)  # a conninfo's


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="kei-worker", description="kei's DBOS worker")
    commands = parser.add_subparsers(dest="command", required=True)
    worker = commands.add_parser("worker", help="Run this slot's worker in the foreground")
    worker.add_argument("--slot", default=config.SLOT, help="Deployment slot: the lock file and the executor ID")
    worker.add_argument("--database-url", default=os.environ.get("KEI_SYSTEM_DATABASE_URL"))
    args = parser.parse_args(argv)
    if not args.database_url:
        parser.error("KEI_SYSTEM_DATABASE_URL (or --database-url) is required")
    try:
        serve(args.slot, args.database_url)
    except slot.SlotTaken as error:
        print(error, file=sys.stderr)
        sys.exit(1)
    except Exception as error:  # noqa: BLE001 - psycopg's message can quote the URL; a traceback would repeat it
        print(f"kei worker stopped: {type(error).__name__}: {redacted(str(error), args.database_url)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
