"""`kei-worker worker`: take the slot, read the boot timestamp, launch DBOS, register the lanes, serve until signalled.

DBOS.launch() migrates kei_dbos and recovers this executor's pending workflows (executor `kei-<slot>`, version
`kei@1`); a crash re-executes the step that was running and reuses every checkpointed one.
Env: KEI_SYSTEM_DATABASE_URL (role kei on database free), KEI_SLOT, KEI_RUNS, KEI_LOG_LEVEL.
"""
from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import threading
from collections.abc import Callable

from dbos import DBOS

from kei_exp.workflows import boot, config, slot

logger = logging.getLogger(__name__)


def _until_signalled() -> None:
    stop = threading.Event()
    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, lambda *_: stop.set())
    stop.wait()


def serve(slot_name: str, database_url: str, *, until: Callable[[], None] = _until_signalled) -> None:
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


if __name__ == "__main__":
    main()
