"""kei-worker's startup order and the lock only a dead process releases (spec, *kei worker → Startup*)."""
import contextlib
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


def test_the_lock_is_taken_before_the_model_stack_is_imported():
    """A second worker on a held slot is refused in a fraction of a second, not after loading docling and torch."""
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
    cli.serve("slot-7", "postgresql://x", until=lambda: order.append("serving"))
    assert order == ["flock", "clock", "configure", "launch", "queues", "serving", "destroy", "release"]
    assert boot.timestamp_ms() == 1234


def test_the_worker_refuses_to_start_without_its_database_url(monkeypatch, capsys):
    monkeypatch.delenv("KEI_SYSTEM_DATABASE_URL", raising=False)
    with pytest.raises(SystemExit) as stopped:
        cli.main(["worker"])
    assert stopped.value.code == 2 and "KEI_SYSTEM_DATABASE_URL" in capsys.readouterr().err


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
