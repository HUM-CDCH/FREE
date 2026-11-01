"""A guard failure follows the real fenced checkpoint and Retry policy."""
import inspect
from uuid import uuid4

import psycopg
import pytest

from kei_exp.kie.extract.durable import CapturePlanner, NeedsCall
from kei_exp.workflows import durable_extract as worker
from kei_exp.workflows.coordination import CoordinationPool, Lease
from tests.test_captured_repetition import Stream, item
from tests.test_durable_entry_reuse_postgres import IDS, seed
from tests.test_extract_grounded import WordCounter

pytestmark = pytest.mark.postgres


def test_guarded_retry_keeps_sibling_checkpoint_and_stops_split(database, coordination_database, monkeypatch):
    seed(database, "fixture")
    provider = {"key": "nuextract", "adapterVersion": 1, "adapter": "nuextract", "model": "test",
                "url": "http://127.0.0.1:1/v1/chat/completions", "timeout": 1, "maxTokens": 256}
    configuration = {"models": {"fields": provider, "reasoning": provider},
                     "options": {"strategy": "catalog", "unified": {"defaults": 3}},
                     "planner": 1, "protocols": {"calls": 1, "source": "document"}}
    schema = {"type": "object", "properties": {"value": {"type": "string"}}}
    pool = CoordinationPool(coordination_database)
    try:
        with Lease(pool, IDS["extraction"], IDS["attempt"]) as lease:
            lease.call("resolve_selection", configuration)
            lease.state["effective"] = configuration
            planner = CapturePlanner(lease, {"fields": WordCounter()})
            chat = worker.chat_for(provider)
            for record in (0, 1):
                with pytest.raises(NeedsCall):
                    planner.complete(chat, stage="entry", record=record, system="read", user="anchor",
                                     schema=schema, max_tokens=256)
            captures = list(planner.pending)
        class SuccessfulStream(Stream):
            def iter_lines(self):
                for line in super().iter_lines():
                    yield line.replace(b'"prompt_tokens":12', b'"prompt_tokens":7')
        responses = [SuccessfulStream(['{"value":"saved"}']), Stream(["["] + [item() + ","] * 100),
                     Stream(["["] + [item() + ","] * 100)]
        posted = []
        def post(*args, **kwargs):
            posted.append(kwargs["json"])
            return responses[len(posted) - 1]
        monkeypatch.setattr("kei_exp.kie.extract.captured_provider.requests.post", post)
        monkeypatch.setattr(worker, "drop_stale_counts", lambda *args, **kwargs: None)
        worker.configure(coordination_database)
        invoke = inspect.unwrap(worker.invoke_capture)
        try:
            assert invoke(IDS["extraction"], IDS["attempt"], captures[0])["ok"]
            assert not invoke(IDS["extraction"], IDS["attempt"], captures[1])["ok"]
            with psycopg.connect(database, autocommit=True) as db:
                failure = db.execute('SELECT output,recoverable,recovery FROM extraction_runtime."callFailure" WHERE "captureId"=%s',
                                     (captures[1],)).fetchone()
                assert failure[0]["calls"][0]["finish"] is None and failure[1:] == (False, None)
                assert db.execute('SELECT intent FROM extraction_runtime.head WHERE id=%s', (IDS["extraction"],)).fetchone()[0] == "PAUSE"
                assert db.execute('SELECT count(*) FROM extraction_runtime.capture WHERE "extractionId"=%s',
                                  (IDS["extraction"],)).fetchone()[0] == 2
                retry = str(uuid4())
                db.execute('INSERT INTO extraction_runtime.attempt (id,"extractionId","selectionId",fence,"workflowId") VALUES (%s,%s,%s,2,%s)',
                           (retry, IDS["extraction"], IDS["selection"], "test:" + retry))
                db.execute('UPDATE extraction_runtime.head SET intent=\'RUN\',"attemptId"=%s,fence=2,"leaseUntil"=NULL WHERE id=%s',
                           (retry, IDS["extraction"]))
            assert invoke(IDS["extraction"], retry, captures[0])["ok"]
            assert not invoke(IDS["extraction"], retry, captures[1])["ok"]
            assert len(posted) == 3 and posted[1] == posted[2]
            with psycopg.connect(database) as db:
                assert db.execute('SELECT count(*) FROM extraction_runtime.checkpoint WHERE id=%s', (captures[0],)).fetchone()[0] == 1
                assert db.execute('SELECT count(*) FROM extraction_runtime."callFailure" WHERE "captureId"=%s', (captures[1],)).fetchone()[0] == 2
        finally:
            worker.close_coordination()
    finally:
        pool.close()
