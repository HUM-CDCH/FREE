"""Entry reuse against the real coordination routines and real DBOS 3.1.0 processes.

A unified Catalog attempt (defaults 3) is seeded straight into `extraction_runtime` and read from a stub OpenAI server
(scripted replies, `/tokenize` with token ids, so counts are kept and reuse is active). In process, the undecorated
worker steps drive it with and without reuse: the database ends the same, only repeated lookups and publications go.
In worker processes, a SIGKILL around an entry's publication, or after a lookup in a round that reused entries, is
recovered by a fresh process (nothing kept) to the uninterrupted result; and an attempt begun by the unmodified
worker (BASELINE_SRC) is finished by this one.
"""
import inspect
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from collections import Counter
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psycopg
import pytest
from psycopg.types.json import Jsonb

from kei_exp.kie.extract import tokens
from kei_exp.kie.passages import load
from tests.helpers import catalogue
from tests.helpers import postgres as postgres_helper
from tests.test_unified_catalog import Model, SCHEMA

pytestmark = pytest.mark.postgres
SRC = Path(__file__).resolve().parents[1] / "src"
BASELINE_SRC = os.environ.get("BASELINE_SRC")  # an earlier worker's `src`, e.g. a checkout of the release before reuse
IDS = {name: f"00000000-0000-4000-8000-{n:012d}" for n, name in enumerate(
    ("extraction", "project", "selection", "attempt", "revision", "source"), 1)}
OPTIONS = {"strategy": "catalog", "unified": {"defaults": 3}}


def texts(pages, per_page):
    return [[f"{n}. Site{n}. Material: m{n}. Find: f{n} ({n % 9 + 1})."
             for n in range(page * per_page + 1, (page + 1) * per_page + 1)] for page in range(pages)]


def write_source(runs, run_id, pages):
    catalogue.write({"transcriber": "native", "pages": [{"page": n, "units": [{"index": 0, "segments": segments}]}
                                                        for n, segments in enumerate(pages, 1)]},
                    runs / run_id, generation=catalogue.GENERATION)
    (runs / run_id / "params.json").write_text("{}")
    return load(runs / run_id)


def seed(owner, run_id, ids=IDS, case=""):
    """One admitted attempt, as Studio's admission leaves it (durable-repository.ts initializeDurableExtraction)."""
    ids = {name: value[:-len(case)] + case if case else value for name, value in ids.items()}
    pin = {"runId": run_id, "generation": catalogue.GENERATION, "sourceRevisionId": ids["source"]}
    with psycopg.connect(owner, autocommit=True) as connection:
        connection.execute('''INSERT INTO extraction_runtime.head
          (id,"projectId","sourceRevisionId","sourcePin",strategy,"selectionId",intent,"attemptId",fence,
           acknowledgement,"controlVersion","pendingResume","leaseEpoch",generation,"snapshotVersion",deleted)
          VALUES (%s,%s,%s,%s,'CATALOG',%s,'RUN',%s,1,'QUEUED',0,false,0,1,0,false)''',
                           (ids["extraction"], ids["project"], ids["source"], Jsonb(pin), ids["selection"],
                            ids["attempt"]))
        connection.execute('''INSERT INTO extraction_runtime.selection
          (id,"extractionId",ordinal,"schemaRevisionId","schemaHash","schemaTree",method,resolved,digest)
          VALUES (%s,%s,1,%s,%s,%s,'{}',%s,%s)''', (ids["selection"], ids["extraction"], ids["revision"], "a" * 64,
                                                    Jsonb(SCHEMA), Jsonb({"options": OPTIONS}), "a" * 64))
        connection.execute('''INSERT INTO extraction_runtime.attempt (id,"extractionId","selectionId",fence,"workflowId")
          VALUES (%s,%s,%s,1,%s)''', (ids["attempt"], ids["extraction"], ids["selection"], "kei-extract:" + ids["attempt"]))
        connection.execute('INSERT INTO extraction_runtime."feedbackHead" (id,version) VALUES (%s,0) ON CONFLICT DO NOTHING',
                           (ids["project"],))
        manifest = {"plannerVersion": 1, "selectionId": ids["selection"], "sourceGeneration": catalogue.GENERATION,
                    "units": [], "coverage": {"snapshotId": None, "reprocessValueIds": []}}
        connection.execute('''INSERT INTO extraction_runtime.plan (id,"extractionId",generation,stage,digest,manifest)
          VALUES (gen_random_uuid(),%s,1,'historical-coverage',extraction_runtime.content_hash(%s),%s)''',
                           (ids["extraction"], Jsonb(manifest), Jsonb(manifest)))
    return ids


@contextmanager
def stub(evidence):
    """The scripted model behind an OpenAI chat endpoint, with a /tokenize that counts words and returns token ids."""
    requests, script = [], Model(evidence)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            counted = sum(len(message["content"].split()) for message in body["messages"]) + 5
            if self.path == "/tokenize":
                output = {"count": counted, "max_model_len": 32768, "tokens": list(range(counted))}
            else:
                requests.append(body)
                schema = body["response_format"]["json_schema"]["schema"]
                parsed = script(body["messages"][0]["content"], body["messages"][-1]["content"], schema)
                output = {"choices": [{"message": {"content": json.dumps(parsed)}, "finish_reason": "stop"}],
                          "usage": {"prompt_tokens": counted, "completion_tokens": 10}}
            raw = json.dumps(output).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1/chat/completions", requests
    finally:
        server.shutdown()
        server.server_close()


@contextmanager
def migrated(postgres):
    """A fresh guarded database migrated with the worker's restricted role: (owner conninfo, worker URL)."""
    fresh = postgres_helper.fresh(postgres)
    owner = next(fresh)
    coordinated = postgres_helper.coordinated(owner)
    try:
        yield owner, next(coordinated)
    finally:
        for each in (coordinated, fresh):
            next(each, None)


def state(owner, extraction=IDS["extraction"]):
    """Everything the run left that anyone reads, with each call's clock and the final record's run clock removed."""
    def clockless(output):
        return {**output, "calls": [{k: v for k, v in call.items() if k != "seconds"} for call in output.get("calls", [])]}
    with psycopg.connect(owner, autocommit=True) as connection:
        plans = connection.execute('SELECT stage,digest FROM extraction_runtime.plan WHERE "extractionId"=%s ORDER BY stage',
                                   (extraction,)).fetchall()
        captures = connection.execute('''SELECT c."unitKey",c.descriptor,c.candidates,c."feedbackVersion",
              c."reservationAttemptId",c."reservationEpoch",c."inFlight",c.invoked,i.digest,o.output
            FROM extraction_runtime.capture c LEFT JOIN extraction_runtime.input i ON i.id=c.id
            LEFT JOIN extraction_runtime.checkpoint o ON o.id=c.id WHERE c."extractionId"=%s ORDER BY c."unitKey"''',
                                      (extraction,)).fetchall()
        snapshots = connection.execute('''SELECT version,id::text,values,coverage FROM extraction_runtime.snapshot
            WHERE "extractionId"=%s ORDER BY version''', (extraction,)).fetchall()
        head = connection.execute('SELECT acknowledgement,"snapshotVersion" FROM extraction_runtime.head WHERE id=%s',
                                  (extraction,)).fetchone()
    return {"plans": plans, "head": head,
            "captures": [(*row[:8], row[8], clockless(row[9]) if row[9] else None) for row in captures],
            "snapshots": [(version, None if "diagnostics" in coverage else identity, values,
                           {k: v for k, v in coverage.items()  # the final record's digest covers its run clock
                            if "diagnostics" not in coverage or k not in ("diagnostics", "publicationDigest")})
                          for version, identity, values, coverage in snapshots]}


def records(owner, extraction=IDS["extraction"]):
    """The latest snapshot's saved values: (record, field, value)."""
    with psycopg.connect(owner, autocommit=True) as connection:
        values = connection.execute('''SELECT s.values FROM extraction_runtime.snapshot s JOIN extraction_runtime.head h
            ON h.id=s."extractionId" AND h."snapshotVersion"=s.version WHERE h.id=%s''', (extraction,)).fetchone()[0]
    return sorted((value["path"][1], value["path"][2], json.dumps(value["modelValue"], sort_keys=True))
                  for value in values if value["processing"] == "saved")


def expected_materials(pages):
    return [f"m{n}" for n in range(1, sum(len(page) for page in pages) + 1)]


def materials(owner, extraction=IDS["extraction"]):
    return [json.loads(value) for _, field, value in records(owner, extraction) if field == "material"]


def drive(monkeypatch, worker_url, url, runs, *, reuse, expire=None):
    """The worker loop (`extract_workflow`) in process, without DBOS: the undecorated steps, two calls per role at once,
    the earliest started answered first through the real begin_call/commit_output."""
    from kei_exp.kie.extract.models import DEFAULTS, EXTRACT_MODELS
    from kei_exp.workflows import config, durable_extract as worker
    from dataclasses import replace
    from kei_exp import runs as run_store
    key = next(key for key, model in EXTRACT_MODELS.items() if model.adapter == "instruct")
    monkeypatch.setitem(EXTRACT_MODELS, key, replace(EXTRACT_MODELS[key], url=url))
    monkeypatch.setitem(DEFAULTS, "fields", key)
    monkeypatch.setitem(DEFAULTS, "reasoning", key)
    monkeypatch.setattr(run_store, "RUNS", runs)
    monkeypatch.setattr(config, "CATALOG_CHUNKS", 2)
    routines, hits = Counter(), Counter()
    original = worker.CoordinationPool.call
    monkeypatch.setattr(worker.CoordinationPool, "call",
                        lambda pool, routine, *args: routines.update([routine]) or original(pool, routine, *args))
    compiled = tokens.compiled if reuse else (lambda *_: (None, None))
    monkeypatch.setattr(tokens, "compiled", lambda *args: (lambda kept: hits.update(
        ["hit" if kept[1] is not None else "miss"]) or kept)(compiled(*args)))
    plan, invoke, publish, acknowledge = (inspect.unwrap(step) for step in (
        worker.plan_next, worker.invoke_capture, worker.publish_result, worker.acknowledge))
    extraction, attempt = IDS["extraction"], IDS["attempt"]
    worker.configure(worker_url)
    try:
        running, rounds = {}, 0
        while True:
            rounds += 1
            if expire:  # calls outlasting the 30 s lease: each round's claim starts another epoch
                expire()
            work = plan(extraction, attempt)
            if "result" in work:
                publish(extraction, attempt, work["result"], work["scopes"])
                assert acknowledge(extraction, attempt, True, None) == "COMPLETED"
                return routines, hits, rounds
            for capture in work["pending"]:
                role = work["roles"][capture]
                if capture not in running and sum(each == role for each in running.values()) < 2:
                    running[capture] = role
            capture = next(iter(running))
            del running[capture]
            assert invoke(extraction, attempt, capture)["ok"]
    finally:
        worker.close_coordination()
        tokens.forget(f"{extraction}/{attempt}")


def expired(owner):
    def expire():
        with psycopg.connect(owner, autocommit=True) as connection:
            connection.execute('''UPDATE extraction_runtime.head SET "leaseUntil"=clock_timestamp()-interval '1 second'
                                  WHERE id=%s''', (IDS["extraction"],))
    return expire


@pytest.mark.parametrize("epochs", [False, True])
def test_reuse_leaves_the_coordination_database_as_it_was(postgres, tmp_path, monkeypatch, epochs):
    """With `epochs` the lease expires before every round. A finished capture then keeps the reservation epoch of its
    last lookup, the round before it was reused, not the latest; only an unfinished capture's call (finalize, begin,
    commit, fail) checks it, so that column is the one permitted difference."""
    pages = texts(3, 3)
    evidence = write_source(tmp_path / "runs", "run-reuse", pages)
    ends, counts = {}, {}
    with stub(evidence) as (url, requests):
        for reuse in (False, True):
            with migrated(postgres) as (owner, worker_url), monkeypatch.context() as patched:
                seed(owner, "run-reuse")
                made = len(requests)
                routines, hits, rounds = drive(patched, worker_url, url, tmp_path / "runs", reuse=reuse,
                                               expire=expired(owner) if epochs else None)
                ends[reuse], counts[reuse] = state(owner), (routines, hits, rounds, len(requests) - made)
                assert materials(owner) == expected_materials(pages)
    (plain, plain_hits, plain_rounds, plain_calls), (reused, reused_hits, reused_rounds, reused_calls) = counts[False], counts[True]
    assert reused_hits["hit"] > 0 and plain_hits["hit"] == 0  # reuse is active on the real path, and only there
    assert plain_rounds == reused_rounds and plain_calls == reused_calls
    # the same rows; a checkpointed capture's repeated lookup only rewrote its reservation to the same attempt
    if epochs:
        older = [(reused_row[5], plain_row[5]) for reused_row, plain_row in zip(ends[True]["captures"],
                                                                               ends[False]["captures"], strict=True)
                 if reused_row[5] != plain_row[5]]
        assert older and all(reused_epoch < plain_epoch for reused_epoch, plain_epoch in older)
        for end in ends.values():
            end["captures"] = [(*row[:5], None, *row[6:]) for row in end["captures"]]
    assert ends[True] == ends[False]
    fewer = {"publish_plan", "capture_unit", "publish_snapshot"}
    for routine in set(plain) | set(reused):
        if routine in fewer:
            assert reused[routine] <= plain[routine], routine
        elif routine != "heartbeat":  # every 5 s of wall clock
            assert reused[routine] == plain[routine], routine
    print("\nroutine baseline candidate")
    for routine in sorted(set(plain) | set(reused)):
        print(routine, plain[routine], reused[routine])
    print("compiled", dict(plain_hits), dict(reused_hits), "rounds", plain_rounds, "model calls", plain_calls)


CHILD = r'''
import json,os,signal,time
from dataclasses import replace
from pathlib import Path
from dbos import DBOS
from kei_exp.kie.extract import tokens
from kei_exp.kie.extract.models import EXTRACT_MODELS,DEFAULTS
from kei_exp.workflows import boot,config,durable_extract
from kei_exp.workflows.coordination import CoordinationPool
key=next(key for key,model in EXTRACT_MODELS.items() if model.adapter=='instruct')
EXTRACT_MODELS[key]=replace(EXTRACT_MODELS[key],url=os.environ['MODEL_URL'])
DEFAULTS.update(fields=key,reasoning=key)
config.CATALOG_CHUNKS=2
url,fault=os.environ['WORKER_URL'],os.environ.get('FAULT','')
seen={'entries':0,'reused':False}
if hasattr(tokens,'compiled'):  # the unmodified worker has no reuse to observe
    compiled=tokens.compiled
    def observed(*args):
        kept=compiled(*args)
        if kept[1] is not None:seen['reused']=True
        return kept
    tokens.compiled=observed
def die():
    Path(os.environ['CRASHED']).write_text(fault);os.kill(os.getpid(),signal.SIGKILL)
original=CoordinationPool.call
def faulted(pool,routine,*args):
    entry=routine=='publish_snapshot' and isinstance(args[-1].get('primaryScope'),list)
    if entry:seen['entries']+=1
    if fault=='before_entry_publication' and entry and seen['entries']==2:die()
    result=original(pool,routine,*args)
    if fault in('after_entry_publication','baseline_then_candidate') and entry and seen['entries']==2:die()
    if fault=='after_reused_lookup' and routine=='capture_unit' and seen['reused']:die()
    return result
CoordinationPool.call=faulted
durable_extract.configure(url)
DBOS(config=config.dbos_config(url,'entry-reuse',log_level='WARNING'))
boot.set_timestamp(boot.database_clock_ms(url))
DBOS.launch();config.register_queues(polling_interval_sec=.1)
Path(os.environ['SERVING']).touch()
while True:time.sleep(.1)
'''


def until(predicate, timeout=90):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if result := predicate():
            return result
        time.sleep(.05)
    raise AssertionError("condition timed out")


CASES = ["", "after_entry_publication", "before_entry_publication", "after_reused_lookup",
         *(["baseline_then_candidate"] if BASELINE_SRC else [])]


@pytest.mark.slow
def test_a_killed_worker_is_recovered_by_a_fresh_process_to_the_uninterrupted_result(postgres, tmp_path):
    """Each case is its own extraction in one database; the first, uninterrupted, is the reference."""
    from dbos import DBOSClient, WorkflowSerializationFormat
    pages = texts(3, 3)
    evidence = write_source(tmp_path / "runs", "run-crash", pages)
    workers, logs = [], []
    with stub(evidence) as (url, requests), migrated(postgres) as (owner, worker_url):
        def start(fault, src):
            serving = tmp_path / f"serving-{len(workers)}"
            log = open(tmp_path / f"worker-{len(workers)}.log", "w+")
            logs.append(log)
            env = {**os.environ, "PYTHONPATH": str(src), "KEI_RUNS": str(tmp_path / "runs"), "MODEL_URL": url,
                   "WORKER_URL": worker_url, "FAULT": fault, "CRASHED": str(tmp_path / "crashed"),
                   "SERVING": str(serving)}
            process = subprocess.Popen([sys.executable, "-c", CHILD], env=env, stdout=log, stderr=log)
            workers.append(process)
            until(lambda: serving.exists() or process.poll() is not None)
            if process.poll() is not None:
                log.seek(0)
                raise AssertionError(log.read())
            return process

        def stop(process):
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=20)
        client = None
        try:
            reference = None
            for index, fault in enumerate(CASES):
                ids = seed(owner, "run-crash", case=f"{index + 1:02d}")
                (tmp_path / "crashed").unlink(missing_ok=True)
                made = len(requests)
                first = start(fault, BASELINE_SRC if fault == "baseline_then_candidate" else SRC)
                if client is None:
                    client = DBOSClient(system_database_url=worker_url, dbos_system_schema="kei_dbos",
                                        application_name="kei")
                workflow = "kei-extract:" + ids["attempt"]
                client.enqueue({"workflow_name": "extractDurableV1", "queue_name": "kei-extract",
                                "application_name": "kei", "workflow_id": workflow,
                                "serialization_type": WorkflowSerializationFormat.PORTABLE},
                               {"protocol": 1, "extraction_id": ids["extraction"], "attempt_id": ids["attempt"]})

                def ended():
                    status = client.retrieve_workflow(workflow).get_status()
                    return status.status in {"SUCCESS", "ERROR"} and status
                if fault:
                    until(lambda: first.poll() is not None or (ended() and pytest.fail(f"{fault}: ended before its fault")))
                    assert first.returncode == -signal.SIGKILL and (tmp_path / "crashed").read_text() == fault
                    with psycopg.connect(owner, autocommit=True) as connection:  # the dead owner's lease, expired
                        connection.execute('''UPDATE extraction_runtime.head SET "leaseUntil"=clock_timestamp()-interval '1 second'
                                              WHERE id=%s''', (ids["extraction"],))
                    second = start("", SRC)  # a fresh process: nothing kept
                else:
                    second = first
                status = until(ended)
                assert status.status == "SUCCESS", status.error
                stop(second)
                end = state(owner, ids["extraction"])
                captures = [row for row in end["captures"]]
                assert end["head"][0] == "COMPLETED"
                assert len(captures) == sum(row[9] is not None for row in captures) == len(requests) - made, fault
                assert materials(owner, ids["extraction"]) == expected_materials(pages), fault
                saved = [(record, field, value) for record, field, value in records(owner, ids["extraction"])]
                if reference is None:
                    reference = saved
                assert saved == reference, fault
        finally:
            for process in workers:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
            for log in logs:
                log.seek(0)
                print(f"--- {log.name}\n" + "".join(re.findall(r".*(?:Error|Traceback|error).*\n", log.read()))[:4000])
                log.close()
            if client:
                client.destroy()
