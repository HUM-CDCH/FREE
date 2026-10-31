"""An in-process worker must finish its final database write before its fixture tears the database down."""
import threading
from concurrent.futures import ThreadPoolExecutor

import psycopg
from dbos import _dbos as dbos_runtime
from dbos._sys_db import SystemDatabase

from kei_exp.workflows import config
from tests.helpers import kei as kei_helper


def test_fixture_joins_the_executor_before_closing_its_database(database, tmp_path, monkeypatch):
    writing, release, written = threading.Event(), threading.Event(), threading.Event()
    returned_before_write = []
    original_write = SystemDatabase.update_workflow_outcome

    def delayed_write(self, *args, **kwargs):
        writing.set()
        assert release.wait(30), "fixture shutdown never released the final workflow write"
        try:
            return original_write(self, *args, **kwargs)
        finally:
            written.set()

    class ObservedExecutor(ThreadPoolExecutor):
        def shutdown(self, wait=True, *, cancel_futures=False):
            if not writing.is_set():
                return super().shutdown(wait=wait, cancel_futures=cancel_futures)
            returned = threading.Event()

            def finish_write():
                returned_before_write.append(returned.wait(1))
                release.set()

            releaser = threading.Thread(target=finish_write)
            releaser.start()
            try:
                return super().shutdown(wait=wait, cancel_futures=cancel_futures)
            finally:
                returned.set()
                releaser.join(timeout=5)
                # Even a regression must leave no orphan executor thread after the assertion fails.
                assert written.wait(30), "the final workflow write did not finish"

    monkeypatch.setattr(dbos_runtime, "ThreadPoolExecutor", ObservedExecutor)
    monkeypatch.setattr(SystemDatabase, "update_workflow_outcome", delayed_write)
    try:
        with kei_helper.launched(database, tmp_path, monkeypatch) as kei:
            kei.enqueue("deleteRuns", config.GC, "kei-gc:fixture-shutdown", {"conversions": [], "history": []})
            assert writing.wait(30), "workflow never reached final outcome persistence"
        assert returned_before_write == [False], "fixture shutdown returned while an executor write was still active"
        with psycopg.connect(database) as connection:
            assert connection.execute(
                "select status from kei_dbos.workflow_status where workflow_uuid = %s", ["kei-gc:fixture-shutdown"]
            ).fetchone() == ("SUCCESS",)
    finally:
        release.set()
