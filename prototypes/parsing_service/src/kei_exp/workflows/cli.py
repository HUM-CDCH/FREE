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


class RedactingFilter(logging.Filter):
    """DBOS logs its own launch and connection failures (dbos _dbos.py:787, _sys_db.py:5469) before the worker can
    report them; driver messages there can quote the URL. Rewrite each record's message and traceback in place: the
    traceback is kept (workflow and recovery failures are logged with it for the worker's whole life), redacted."""

    def __init__(self, database_url: str) -> None:
        super().__init__()
        self._url = database_url

    def filter(self, record: logging.LogRecord) -> bool:
        if record.exc_info:  # a handler formats exc_text when exc_info is gone: hand it the redacted traceback
            record.exc_text = logging.Formatter().formatException(record.exc_info)
            record.exc_info = None
        if record.exc_text:
            record.exc_text = redacted(record.exc_text, self._url)
        record.msg, record.args = redacted(record.getMessage(), self._url), ()
        return True


def _redact_dbos_logs(database_url: str) -> None:
    """One RedactingFilter on the `dbos` logger, for this URL: a repeated serve() replaces it rather than stacking."""
    dbos_logger = logging.getLogger("dbos")
    for installed in [f for f in dbos_logger.filters if isinstance(f, RedactingFilter)]:
        dbos_logger.removeFilter(installed)
    dbos_logger.addFilter(RedactingFilter(database_url))


def serve(slot_name: str, database_url: str, *, until: Callable[[], None] = _until_signalled,
          exit_process: Callable[[int], None] = _exit_hard) -> None:
    logging.basicConfig(level=os.environ.get("KEI_LOG_LEVEL", "INFO"))
    _redact_dbos_logs(database_url)
    # First: a second process is refused before it imports the model stack (this module, slot and runs are light;
    # `registered` is what loads docling and torch, test_worker_boot pins it).
    with slot.hold_slot(slot_name):
        logger.info("slot %s taken by pid %s", slot_name, os.getpid())
        import kei_exp.workflows.registered  # noqa: F401 - every workflow is registered before launch
        boot.set_timestamp(boot.database_clock_ms(database_url))
        # From here on DBOS may run steps (launch recovers this executor's pending workflows), and destroy() does not
        # wait for them: their threads are not daemons, so returning would free the slot while they write on. Every
        # way out therefore destroys DBOS and exits still holding the slot, which ends the steps with the process;
        # only then does the kernel free the lock (spec, *kei worker*: held for the worker's lifetime; the boot
        # boundary relies on it). Nothing is recorded after destroy: the interrupted workflows stay PENDING and
        # recovery runs them.
        if config.TRACES_ENDPOINT:  # each request a model call sends becomes a span under it
            from opentelemetry.instrumentation.requests import RequestsInstrumentor
            RequestsInstrumentor().instrument()
        try:
            DBOS(config=config.dbos_config(database_url, slot_name))
            DBOS.launch()
            config.register_queues()
            logger.info("kei worker %s serving", config.executor_id(slot_name))
            until()
        except BaseException as error:  # noqa: BLE001 - an interrupt too must destroy DBOS and exit holding the slot
            try:
                DBOS.destroy()
            finally:  # a second interrupt inside destroy() must not unwind the slot's `with` either
                print(stopped(error, database_url), file=sys.stderr)
                exit_process(1)
            return  # only a test's exit_process returns
        DBOS.destroy()
        exit_process(0)


def stopped(error: BaseException, database_url: str) -> str:
    """The one line a failed worker prints: psycopg's message can quote the URL, and a traceback would repeat it."""
    return f"kei worker stopped: {type(error).__name__}: {redacted(str(error), database_url)}"


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
    except Exception as error:  # noqa: BLE001 - reported redacted, without a traceback
        print(stopped(error, args.database_url), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
