"""Caller-provisioned disposable PostgreSQL for service tests; no implicit stack startup.

PARSING_TEST_DATABASE_URL must identify postgres on loopback:5432 and a free_test_* database.
Each test gets its own free_test_parsing_* database. Container pause tests additionally require
PARSING_TEST_POSTGRES_CONTAINER naming an isolated container labelled free.test=parsing.
"""
import os
import re
import secrets
import subprocess
from collections.abc import Iterator
from dataclasses import dataclass

import pytest


@dataclass(frozen=True)
class Server:
    """A running postgres:17: the conninfo to its maintenance database, and the id of the container serving
    it — for the rare test that needs to act on the real server (`docker pause`/`unpause`) rather than just
    connect to it."""
    conninfo: str
    container_id: str


def _docker(*args: str, check: bool = False, timeout: float = 30.0) -> subprocess.CompletedProcess[str]:
    """Run a docker command, bounded so an unresponsive daemon cannot hang the caller forever.

    A `check=False` timeout behaves like a failed command (nonzero returncode, no exception raised) to match
    this helper's existing `check=False` contract: `unpause()` promises it never raises, and "never raises" is
    not "never blocks" — a `check=True` timeout still raises, matching subprocess.run's own contract for
    check=True.
    """
    try:
        return subprocess.run(["docker", *args], capture_output=True, text=True, check=check, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        if check:
            raise
        return subprocess.CompletedProcess(["docker", *args], returncode=1, stdout="", stderr=str(error))


def pause(container_id: str) -> subprocess.CompletedProcess[str]:
    """Freeze every process in the container (`docker pause`) without stopping or removing it."""
    return _docker("pause", container_id)


def unpause(container_id: str) -> None:
    """Resume a paused container (`docker unpause`). Best-effort and silent: safe to call unconditionally from
    a `finally`, including one that runs after a failed assertion — a paused PostgreSQL left behind would wedge
    every later test in the session, so this must never itself raise."""
    try:
        _docker("unpause", container_id)
    except OSError:
        pass


def checked_conninfo(value: str) -> dict[str, str]:
    """Refuse non-disposable destinations before opening an administrative connection."""
    from psycopg import ProgrammingError
    from psycopg.conninfo import conninfo_to_dict

    try:
        fields = conninfo_to_dict(value)
    except (ProgrammingError, ValueError):
        raise ValueError("invalid PARSING_TEST_DATABASE_URL") from None
    loopback = {"127.0.0.1", "localhost", "::1"}
    if (fields.get("host") not in loopback or fields.get("port") != "5432"
            or fields.get("user") != "postgres" or not re.fullmatch(r"free_test_[A-Za-z0-9_]+", fields.get("dbname", ""))
            or fields.get("hostaddr", fields.get("host")) not in loopback or "service" in fields):
        raise ValueError("parsing tests require postgres on loopback port 5432 with a free_test_* database")
    # libpq otherwise inherits PGHOSTADDR (or a service file's hostaddr) even with an explicit host.
    fields["hostaddr"] = "::1" if fields["host"] == "::1" else "127.0.0.1"
    return fields


def url(conninfo: str, *, user: str | None = None, password: str | None = None) -> str:
    """The guarded target as a postgresql:// URL, which DBOS and psycopg both take."""
    from urllib.parse import quote
    fields = checked_conninfo(conninfo)
    user, password = user or fields["user"], password if password is not None else fields.get("password", "")
    host = f"[{fields['hostaddr']}]" if ":" in fields["hostaddr"] else fields["hostaddr"]
    credentials = f"{quote(user, safe='')}:{quote(password, safe='')}"
    return f"postgresql://{credentials}@{host}:{fields['port']}/{fields['dbname']}"


def server() -> Iterator[Server]:
    """Use the caller's explicitly configured test database; never start or remove a container."""
    import psycopg
    from psycopg.conninfo import make_conninfo

    conninfo = os.environ.get("PARSING_TEST_DATABASE_URL", "")
    if not conninfo:
        raise pytest.UsageError("set PARSING_TEST_DATABASE_URL to a disposable loopback free_test_* database")
    conninfo = make_conninfo(**checked_conninfo(conninfo))
    with psycopg.connect(conninfo, autocommit=True) as connection:
        connection.execute("SELECT 1")
    container = os.environ.get("PARSING_TEST_POSTGRES_CONTAINER", "")
    if container:
        inspected = _docker("inspect", "--format", '{{ index .Config.Labels "free.test" }}', container, check=True)
        if inspected.stdout.strip() != "parsing":
            raise ValueError("outage tests require an isolated container labelled free.test=parsing")
    yield Server(conninfo, container)


def fresh(maintenance: str) -> Iterator[str]:
    """Create and remove one guarded free_test_* database per test on the caller's disposable server."""
    import psycopg
    from psycopg import sql
    from psycopg.conninfo import make_conninfo

    fields = checked_conninfo(maintenance)
    maintenance = make_conninfo(**fields)
    name = f"free_test_parsing_{secrets.token_hex(6)}"
    with psycopg.connect(maintenance, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    try:
        yield make_conninfo(**{**fields, "dbname": name})
    finally:
        with psycopg.connect(maintenance, autocommit=True) as connection:
            connection.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(name)))
