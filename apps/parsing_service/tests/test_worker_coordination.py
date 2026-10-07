"""Real-process test databases install the same protocol and restricted role as Studio startup."""
import psycopg
import pytest

from kei_exp.workflows.coordination import CoordinationPool

pytestmark = pytest.mark.postgres


def test_real_worker_bootstrap_keeps_runtime_permissions_and_checks_protocol(database, coordination_database):
    pool = CoordinationPool(coordination_database)
    try:
        pool.ready()
        with psycopg.connect(coordination_database, autocommit=True) as worker:
            assert worker.execute("SELECT current_user").fetchone()[0].startswith("free_test_parsing_")
            for statement in (
                "SELECT count(*) FROM public.extraction",
                "SELECT count(*) FROM extraction_runtime.head",
                "SELECT extraction_runtime.content_hash('{}'::jsonb)",
            ):
                with pytest.raises(psycopg.errors.InsufficientPrivilege):
                    worker.execute(statement)
            worker.execute("CREATE TABLE kei_dbos.permission_probe (id integer)")
        with psycopg.connect(database, autocommit=True) as owner:
            owner.execute("UPDATE extraction_runtime.protocol SET version = 2 WHERE id = 1")
        with pytest.raises(ValueError, match="incompatible Extraction coordination protocol"):
            pool.ready()
    finally:
        pool.close()
