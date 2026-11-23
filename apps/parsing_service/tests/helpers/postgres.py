"""Caller-provisioned disposable PostgreSQL for service tests; no implicit stack startup.

PARSING_TEST_DATABASE_URL must identify postgres on loopback:5432 and a free_test_* database.
Each test gets its own free_test_parsing_* database.
"""
import json
import os
import re
import secrets
import subprocess
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest


@dataclass(frozen=True)
class Server:
    """A running postgres:17: the conninfo to its maintenance database."""
    conninfo: str


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
    yield Server(conninfo)


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


def coordinated(database: str) -> Iterator[str]:
    """Migrate one disposable database and give its real worker the production restricted role.

    Node owns the application migrations and role allowlist. No coordination or
    workflow registration is replaced, so a child worker exercises its normal
    unconditional protocol check before launching DBOS.
    """
    import psycopg
    from psycopg import sql
    from psycopg.conninfo import make_conninfo

    # Guard before invoking Node or opening the administrative cleanup connection.
    database = make_conninfo(**checked_conninfo(database))
    role = f"free_test_parsing_{secrets.token_hex(6)}"
    password = secrets.token_hex(24)
    root = Path(__file__).resolve().parents[4]
    try:
        result = subprocess.run(
            ["pnpm", "--filter", "db", "exec", "tsx", "src/parsing-coordination-fixture.ts"],
            cwd=root, input=json.dumps({"databaseUrl": url(database), "role": role, "password": password}),
            capture_output=True, text=True, timeout=120, check=False,
        )
        if result.returncode:
            raise RuntimeError("Parsing Service coordination fixture bootstrap failed; install Node dependencies first")
        yield url(database, user=role, password=password)
    finally:
        # Dependent fixtures stop every child/client before this runs. Roles are
        # cluster-wide, so remove ownership and the unique role before fresh()
        # drops this database. Never touch the deployment's kei role.
        with psycopg.connect(database, autocommit=True) as connection:
            if connection.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", [role]).fetchone():
                connection.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(role)))
                connection.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role)))
