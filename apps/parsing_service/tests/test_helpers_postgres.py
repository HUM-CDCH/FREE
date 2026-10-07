"""`tests/helpers/postgres.py`'s `_docker()` helper: it must never hang, even when `check=False`.

`unpause()` and the session teardown's `_docker("rm", "-f", ...)` both call `_docker(check=False)`, whose
docstring promises it never raises. "Never raises" is not "never blocks" — a Docker daemon that stops
responding would hang either call forever, leaving the session's PostgreSQL paused (or the container
un-removed) and wedging every later test that needs it. No real Docker daemon is exercised here: a fake `docker`
executable that never returns stands in for an unresponsive one.
"""
import os
import stat
import time
from pathlib import Path

import pytest

from tests.helpers import postgres as postgres_helper


@pytest.mark.parametrize("url", [
    "postgresql://postgres:secret@127.0.0.1:5432/free",
    "postgresql://postgres:secret@db.example:5432/free_test_parser",
    "postgresql://postgres:secret@127.0.0.1:5433/free_test_parser",
    "postgresql://postgres:secret@127.0.0.1/free_test_parser",
    "postgresql://kei:secret@127.0.0.1:5432/free_test_parser",
    "postgresql://postgres:secret@127.0.0.1:5432/free_test_parser?hostaddr=192.0.2.1",
    "postgresql:///free_test_parser",
])
def test_database_guard_refuses_unsafe_targets_without_connecting(url, monkeypatch):
    import psycopg

    monkeypatch.setattr(psycopg, "connect", lambda *args, **kwargs: pytest.fail("unsafe target connected"))
    with pytest.raises(ValueError, match="loopback"):
        postgres_helper.checked_conninfo(url)


def test_database_guard_accepts_an_explicit_disposable_target():
    fields = postgres_helper.checked_conninfo("postgresql://postgres:secret@127.0.0.1:5432/free_test_parser")
    assert fields["dbname"] == "free_test_parser" and fields["port"] == "5432"


def test_database_guard_pins_the_address_despite_ambient_libpq_configuration(monkeypatch):
    monkeypatch.setenv("PGHOSTADDR", "192.0.2.1")
    monkeypatch.setenv("PGPORT", "6543")
    fields = postgres_helper.checked_conninfo("postgresql://postgres:secret@localhost:5432/free_test_parser")
    assert fields["hostaddr"] == "127.0.0.1" and fields["port"] == "5432"


def test_the_url_quotes_every_reserved_character_of_the_credentials():
    from psycopg.conninfo import conninfo_to_dict

    built = postgres_helper.url("postgresql://postgres:secret@127.0.0.1:5432/free_test_parser",
                                user="kei/role", password="p/w@x:y?z#")
    fields = conninfo_to_dict(built)
    assert (fields["user"], fields["password"], fields["host"], fields["dbname"]) == \
        ("kei/role", "p/w@x:y?z#", "127.0.0.1", "free_test_parser")


def test_the_url_brackets_an_ipv6_loopback():
    from psycopg.conninfo import conninfo_to_dict

    built = postgres_helper.url("postgresql://postgres:secret@[::1]:5432/free_test_parser")
    assert "@[::1]:5432/" in built
    assert conninfo_to_dict(built)["host"] == "::1"


def _unresponsive_docker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Put a fake `docker` on PATH that sleeps far longer than any timeout this test uses."""
    fake = tmp_path / "docker"
    fake.write_text("#!/bin/sh\nsleep 30\n")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{tmp_path}{os.pathsep}{os.environ['PATH']}")


def test_docker_helper_times_out_instead_of_hanging(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _unresponsive_docker(tmp_path, monkeypatch)

    started = time.monotonic()
    result = postgres_helper._docker("unpause", "does-not-matter", timeout=0.3)
    elapsed = time.monotonic() - started

    assert elapsed < 5.0, f"a docker command with a 0.3s timeout took {elapsed:.1f}s: it hung instead"
    assert result.returncode != 0
