"""kei-worker's startup order and the lock only a dead process releases (spec, *kei worker → Startup*)."""
import contextlib
import logging
import secrets
import subprocess
import sys

import psycopg
import pytest
from dbos import DBOS

from kei_exp import runs
from kei_exp.workflows import boot, cli, config, slot
from tests.helpers import kei as kei_helper
from tests.helpers import kei_worker
from tests.helpers import postgres as postgres_helper


@pytest.fixture(autouse=True)
def dbos_filters():
    """serve() installs its redacting filter on the process-wide `dbos` logger: no test leaves one behind."""
    logger = logging.getLogger("dbos")
    saved = list(logger.filters)
    yield
    logger.filters[:] = saved


@pytest.fixture
def lock_root(tmp_path, monkeypatch):
    monkeypatch.setattr(runs, "RUNS", tmp_path)
    return tmp_path


def test_the_lock_lives_beside_the_runs(lock_root):
    assert slot.lock_path("slot-1") == lock_root / ".worker-slot-1.lock"


def test_one_process_at_a_time_holds_a_slot(lock_root):
    with slot.hold_slot("slot-1"):
        with pytest.raises(slot.SlotTaken), slot.hold_slot("slot-1"):
            pass
        with slot.hold_slot("slot-2"):
            pass


def test_a_killed_holder_releases_and_a_stopped_one_keeps_its_slot(lock_root):
    holder = kei_worker.holder("slot-1", lock_root)
    try:
        holder.wait_started(timeout=20)
        holder.pause()
        with pytest.raises(slot.SlotTaken), slot.hold_slot("slot-1"):
            pass
        holder.kill()
        holder.reap()
        with slot.hold_slot("slot-1"):
            pass
    finally:
        if holder.process.poll() is None:
            holder.kill()
            holder.reap()


def test_the_worker_module_does_not_import_the_model_stack():
    """Importing the CLI loads no docling, torch or surya, so `serve` can take the slot before `registered` loads
    them: a second worker on a held slot is refused in a fraction of a second. The order itself is pinned below."""
    code = ("import sys, kei_exp.workflows.cli\n"
            "print(sorted({name.split('.')[0] for name in sys.modules} & {'docling', 'torch', 'surya'}))")
    loaded = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout
    assert loaded.strip() == "[]"


def test_the_worker_locks_then_reads_the_clock_then_launches_then_registers(monkeypatch):
    order: list[str] = []

    @contextlib.contextmanager
    def hold(name):
        order.append("flock")
        yield
        order.append("release")

    class FakeDBOS:
        def __init__(self, *, config):
            order.append("configure")
            assert config["executor_id"] == "kei-slot-7"

        @staticmethod
        def launch():
            order.append("launch")

        @staticmethod
        def destroy():
            order.append("destroy")

    monkeypatch.setattr(slot, "hold_slot", hold)
    monkeypatch.setattr(boot, "database_clock_ms", lambda url: order.append("clock") or 1234)
    monkeypatch.setattr(cli, "DBOS", FakeDBOS)
    monkeypatch.setattr(config, "register_queues", lambda **_: order.append("queues"))
    monkeypatch.setattr(boot, "_timestamp_ms", None)  # restored after the test: serve sets it
    cli.serve("slot-7", "postgresql://x", until=lambda: order.append("serving"),
              exit_process=lambda code: order.append(f"exit {code}"))
    # The process exits while it still holds the slot: no step thread outlives the lock (test_worker_recovery).
    assert order == ["flock", "clock", "configure", "launch", "queues", "serving", "destroy", "exit 0", "release"]
    assert boot.timestamp_ms() == 1234


def _serve_until(monkeypatch, failing: str, error: BaseException) -> list[str]:
    """serve() over a fake slot and a fake DBOS whose `failing` step ("launch" or "queues") raises `error`."""
    order: list[str] = []

    @contextlib.contextmanager
    def hold(name):
        order.append("flock")
        try:
            yield
        finally:
            order.append("release")

    def step(name):
        order.append(name)
        if name == failing:
            raise error

    class FakeDBOS:
        def __init__(self, *, config):
            order.append("configure")

        @staticmethod
        def launch():
            step("launch")

        @staticmethod
        def destroy():
            order.append("destroy")

    monkeypatch.setattr(slot, "hold_slot", hold)
    monkeypatch.setattr(boot, "database_clock_ms", lambda url: 1234)
    monkeypatch.setattr(boot, "_timestamp_ms", None)
    monkeypatch.setattr(cli, "DBOS", FakeDBOS)
    monkeypatch.setattr(config, "register_queues", lambda **_: step("queues"))
    cli.serve("slot-7", "postgresql://x", until=lambda: order.append("serving"),
              exit_process=lambda code: order.append(f"exit {code}"))
    return order


@pytest.mark.parametrize("failing", ["launch", "queues"])
def test_dbos_is_destroyed_when_launch_or_the_lanes_fail(monkeypatch, capsys, failing):
    order = _serve_until(monkeypatch, failing, RuntimeError(f"{failing} failed"))
    # Launch recovers pending workflows, so their steps may run: the process exits before it frees the slot here too.
    assert "serving" not in order and order[-3:] == ["destroy", "exit 1", "release"]
    assert capsys.readouterr().err == f"kei worker stopped: RuntimeError: {failing} failed\n"


@pytest.mark.parametrize("interrupt", [KeyboardInterrupt, SystemExit])
def test_an_interrupt_during_launch_destroys_dbos_and_exits_still_holding_the_slot(monkeypatch, capsys, interrupt):
    """A BaseException must not unwind the slot's `with` block while DBOS threads may still run steps."""
    order = _serve_until(monkeypatch, "launch", interrupt())
    assert "serving" not in order and order[-3:] == ["destroy", "exit 1", "release"]
    assert capsys.readouterr().err.startswith(f"kei worker stopped: {interrupt.__name__}")


def test_dbos_own_logs_never_print_the_database_password():
    """A handler on the `dbos` logger itself: once any DBOS instance is configured in the process, dbos stops
    propagating its records (config_logger), so caplog would see them or not depending on the test order."""
    url = "postgresql://kei:s3cr%40t-pw@db:5432/free"
    logger = logging.getLogger("dbos")
    lines: list[str] = []

    class Collect(logging.Handler):
        def emit(self, record):
            lines.append(self.format(record))
    handler, filtered, level = Collect(logging.INFO), cli.RedactingFilter(url), logger.level
    logger.addFilter(filtered)
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        try:
            raise RuntimeError(f"connection to {url} failed: password=s3cr@t-pw")
        except RuntimeError as error:
            logger.error("DBOS failed to launch:", exc_info=error)                     # _dbos.py:787
        logger.error(f"Error connecting to the DBOS system database: {url}")            # _sys_db.py:5469
        logger.info("Initializing DBOS with URL: %s", url)
    finally:
        logger.removeFilter(filtered)
        logger.removeHandler(handler)
        logger.setLevel(level)
    text = "\n".join(lines)
    assert len(lines) == 3
    assert "s3cr" not in text and "s3cr%40t-pw" not in text
    assert "DBOS failed to launch" in text and "RuntimeError" in text


def test_serve_installs_one_redacting_filter_on_the_dbos_logger_however_often_it_runs(monkeypatch):
    for _ in range(2):
        _serve_until(monkeypatch, "launch", RuntimeError("launch failed"))
    installed = [f for f in logging.getLogger("dbos").filters if isinstance(f, cli.RedactingFilter)]
    assert len(installed) == 1


def test_the_worker_refuses_to_start_without_its_database_url(monkeypatch, capsys):
    monkeypatch.delenv("KEI_SYSTEM_DATABASE_URL", raising=False)
    with pytest.raises(SystemExit) as stopped:
        cli.main(["worker"])
    assert stopped.value.code == 2 and "KEI_SYSTEM_DATABASE_URL" in capsys.readouterr().err


SYNTHETIC_PASSWORD = "sk-test-startup-password"


def _echoing(url):
    raise psycopg.OperationalError(f"connection to {url} failed: password={SYNTHETIC_PASSWORD} was refused")


@pytest.mark.parametrize(("url", "clock", "kind"), [
    (f"kei:{SYNTHETIC_PASSWORD}@db", None, "ProgrammingError"),  # psycopg quotes a malformed conninfo whole
    (f"postgresql://kei:{SYNTHETIC_PASSWORD}@127.0.0.1:1/free", None, "OperationalError"),  # refused
    (f"postgresql://kei:{SYNTHETIC_PASSWORD}@127.0.0.1:1/free", _echoing, "OperationalError"),
    (f"postgresql://kei:{SYNTHETIC_PASSWORD.replace('-', '%2D')}@127.0.0.1:1/free", _echoing, "OperationalError"),
])
def test_a_startup_error_never_prints_the_database_password(lock_root, monkeypatch, capsys, caplog, url, clock,
                                                             kind):
    if clock is not None:
        monkeypatch.setattr(boot, "database_clock_ms", clock)
    monkeypatch.setattr(boot, "_timestamp_ms", None)
    with pytest.raises(SystemExit) as stopped:
        cli.main(["worker", "--slot", "slot-9", "--database-url", url])
    output = capsys.readouterr()
    assert stopped.value.code == 1
    assert SYNTHETIC_PASSWORD not in output.err + output.out
    assert SYNTHETIC_PASSWORD not in caplog.text  # nor in any log record
    assert "%2D" not in output.err  # nor its percent-encoded spelling
    assert output.err.startswith(f"kei worker stopped: {kind}")


def test_kei_launches_in_kei_dbos_with_its_four_lanes(kei):
    for name, limit in config.QUEUES.items():
        queue = DBOS.retrieve_queue(name)
        assert (queue.global_concurrency, queue.worker_concurrency) == (limit, limit), name
    with psycopg.connect(kei.url) as connection:
        schemas = {row[0] for row in connection.execute("select schema_name from information_schema.schemata")}
    assert "kei_dbos" in schemas and "dbos" not in schemas  # kei never creates Studio's schema


def test_the_boot_timestamp_is_the_database_clock_before_launch(kei):
    assert 0 < boot.timestamp_ms() <= kei.db_now_ms()


def test_kei_launches_as_its_restricted_role_and_is_denied_on_public(database, tmp_path, monkeypatch):
    """M2's ensureKeiRole (packages/db/src/kei-role.ts) as SQL: kei has no CREATE on the database, public is revoked,
    and kei_dbos exists, owned by kei. DBOS must launch and migrate inside it."""
    role, password = f"free_test_kei_{secrets.token_hex(4)}", secrets.token_hex(16)
    owner = postgres_helper.url(database)
    with psycopg.connect(owner, autocommit=True) as connection:
        connection.execute(f"CREATE ROLE {role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT "
                           f"PASSWORD '{password}'")
        connection.execute("REVOKE ALL ON SCHEMA public FROM PUBLIC")
        connection.execute(f"CREATE SCHEMA kei_dbos AUTHORIZATION {role}")
    kei_url = postgres_helper.url(database, user=role, password=password)
    try:
        with (kei_helper.launched_url(kei_url, tmp_path, monkeypatch), psycopg.connect(kei_url) as connection,
              pytest.raises(psycopg.errors.InsufficientPrivilege)):
            connection.execute("CREATE TABLE public.kei_probe (id int)")
    finally:
        with psycopg.connect(owner, autocommit=True) as connection:
            connection.execute(f"DROP OWNED BY {role}")
            connection.execute(f"DROP ROLE {role}")
