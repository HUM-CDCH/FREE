"""`tests/helpers/postgres.py`: the disposable-database guard and the URLs it builds."""

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
