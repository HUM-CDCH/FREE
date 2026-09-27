"""Recovery across real kei-worker processes: a killed worker's replacement recovers its workflow and re-executes only
the step that was running; a stopped worker keeps its slot; a crash between a publication and its checkpoint leaves
one consistent result (spec, *kei worker*, *Rules → Domain writes are idempotent*). No test in this module launches
DBOS in the test process: that would be a second executor on the same queues."""
import fcntl
import hashlib
import json
import os
import signal
import subprocess
import sys
import time

import pytest
from dbos import DBOSClient

from kei_exp import runs
from kei_exp.workflows import config
from tests.helpers import catalogue, kei_worker
from tests.helpers import kei as kei_helper
from tests.helpers import postgres as postgres_helper
from tests.helpers.pdfs import mask
from tests.test_delete_runs import age

pytestmark = pytest.mark.slow


@pytest.fixture
def site(database, tmp_path):
    paths = {name: tmp_path / name for name in ("runs", "inbox", "control")}
    for path in paths.values():
        path.mkdir()
    workers: list[kei_worker.WorkerProcess] = []
    keis: list[kei_helper.Kei] = []

    def start(crash_after=None):
        worker = kei_worker.spawn("slot-1", database_url=postgres_helper.url(database), runs_root=paths["runs"],
                                  inbox=paths["inbox"], control=paths["control"], crash_after=crash_after)
        workers.append(worker)
        worker.wait_serving()
        return worker

    def kei():
        """A portable client on this database, as tests/helpers/kei.py's; never a DBOS launch in this process."""
        if not keis:  # kei_dbos exists only once a worker has launched
            url = postgres_helper.url(database)
            keis.append(kei_helper.Kei(url, DBOSClient(system_database_url=url, dbos_system_schema=config.SCHEMA,
                                                       application_name=config.APP_NAME),
                                       paths["runs"], paths["inbox"]))
        return keis[0]
    try:
        yield paths, start, kei, postgres_helper.url(database)
    finally:
        for number, worker in enumerate(workers, 1):
            worker.shutdown()
            print(f"--- worker {number} (exit {worker.process.returncode}) ---\n{''.join(worker.log)}")  # on failure
        for each in keis:
            each.client.destroy()


def final(kei, workflow_id, timeout=180):
    """The workflow's terminal status, read through the client (Kei.wait reads through an in-process DBOS)."""
    return kei_helper.until(lambda: (s := kei.client.retrieve_workflow(workflow_id).get_status()).status in
                            kei_helper.TERMINAL and s, timeout, f"{workflow_id} ending")


def steps(kei, workflow_id):
    return [step["function_name"] for step in kei.client.list_workflow_steps(workflow_id)]


def crashed(worker, control, kind):
    """The worker died of the SIGKILL it sent itself right after publishing `kind`, and not of anything else."""
    kei_helper.until(lambda: worker.process.poll() is not None, 120, f"the crash after the {kind}")
    assert worker.process.returncode == -signal.SIGKILL, "".join(worker.log)
    assert (control / "crashed").read_text() == kind


def test_a_killed_worker_is_replaced_and_its_conversion_recovered(site):
    paths, start, kei, _ = site
    first = start()
    sha = kei_helper.stage_pdf(paths["inbox"], "a.pdf", mask())
    workflow_id = "kei-convert:ingest:p:a"
    kei().enqueue("convert", config.CONVERT_SMALL, workflow_id,
                  kei_helper.convert_request("a.pdf", sha, model="fake", cut="none"))
    kei_helper.until(lambda: (paths["control"] / "started-1").exists(), 120, "the conversion's native call")
    first.kill()
    start()
    kei_helper.until(lambda: (paths["control"] / "started-2").exists(), 120, "the recovered native call")
    (paths["control"] / "release").touch()
    status = final(kei(), workflow_id)
    assert status.status == "SUCCESS" and status.output["ok"] is True
    assert status.executor_id == "kei-slot-1"
    assert steps(kei(), workflow_id) == ["resolve_models", "prepare_run", "convert_run"]  # each recorded once
    assert sorted(path.name for path in paths["control"].glob("started-*")) == ["started-1", "started-2"]
    assert kei().row(workflow_id)["recovery_attempts"] == 2  # the first worker's dequeue, then the recovery


def test_a_conversion_past_its_recovery_attempts_keeps_its_run_until_the_next_kei_restart(site):
    """A native call from the exhausted worker may still be writing; only its next boot proves it cannot."""
    paths, start, kei, _ = site
    sha = kei_helper.stage_pdf(paths["inbox"], "m.pdf", mask())
    workflow_id = "kei-convert:ingest:p:m"
    worker = start()
    kei().enqueue("convert", config.CONVERT_SMALL, workflow_id,
                  kei_helper.convert_request("m.pdf", sha, model="fake", cut="none"))
    for attempt in range(1, config.MAX_RECOVERY_ATTEMPTS + 2):
        if kei().row(workflow_id)["status"] == "MAX_RECOVERY_ATTEMPTS_EXCEEDED":
            break
        kei_helper.until(lambda: (paths["control"] / f"started-{attempt}").exists(),
                         120, f"native call {attempt}")
        worker.kill()
        worker = start()
    assert final(kei(), workflow_id).status == "MAX_RECOVERY_ATTEMPTS_EXCEEDED"
    run_id = runs.run_id_for(workflow_id)
    age(paths["runs"] / run_id)

    def delete_through(gc_id):
        kei().enqueue("deleteRuns", config.GC, gc_id, {"conversions": [workflow_id], "history": []})
        result = final(kei(), gc_id)
        assert result.status == "SUCCESS"
        return result.output

    first = delete_through("kei-gc:max-1")
    assert first["kept_runs"] == [run_id] and first["kept_history"] == [workflow_id]
    worker.kill()
    start()
    second = delete_through("kei-gc:max-2")
    assert second["deleted_runs"] == [run_id] and second["deleted_history"] == [workflow_id]
    assert not (paths["runs"] / run_id).exists()


def slot_is_free(path) -> bool:
    """Whether another process could take the slot now; never keeps it."""
    handle = os.open(path, os.O_RDWR)
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False
    else:
        return True
    finally:
        os.close(handle)


def test_a_terminated_worker_exits_before_its_slot_is_free_and_its_conversion_is_recovered(site):
    """A deploy's SIGTERM mid-step: DBOS.destroy() does not wait for the step's thread, so the worker must exit while it
    still holds its slot. Otherwise a replacement could take the slot, read a later boot timestamp and let deleteRuns
    remove a run the old step is still writing (spec, *kei worker*, the boot boundary)."""
    paths, start, kei, _ = site
    lock = paths["runs"] / ".worker-slot-1.lock"
    first = start()
    sha = kei_helper.stage_pdf(paths["inbox"], "a.pdf", mask())
    workflow_id = "kei-convert:ingest:p:a"
    kei().enqueue("convert", config.CONVERT_SMALL, workflow_id,
                  kei_helper.convert_request("a.pdf", sha, model="fake", cut="none"))
    kei_helper.until(lambda: (paths["control"] / "started-1").exists(), 120, "the conversion's native call")
    assert not slot_is_free(lock)
    first.terminate()  # the native call is still waiting for `release`, which never comes
    free_while_running = 0
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        free = slot_is_free(lock)  # asked first: a process that exits in between is not counted as running
        if first.process.poll() is not None:
            break
        free_while_running += free
        time.sleep(0.01)
    assert free_while_running == 0, "the slot was free while the terminated worker still ran"
    assert first.process.returncode == 0, "".join(first.log)  # it exited, its step still in its native call
    assert slot_is_free(lock)
    assert kei().client.retrieve_workflow(workflow_id).get_status().status == "PENDING"  # nothing recorded after destroy
    start()
    kei_helper.until(lambda: (paths["control"] / "started-2").exists(), 120, "the recovered native call")
    (paths["control"] / "release").touch()
    status = final(kei(), workflow_id)
    assert status.status == "SUCCESS" and status.output["ok"] is True
    assert steps(kei(), workflow_id) == ["resolve_models", "prepare_run", "convert_run"]
    assert kei().row(workflow_id)["recovery_attempts"] == 2


def test_a_stopped_worker_keeps_its_slot_and_gets_no_replacement(site):
    paths, start, _, url = site
    running = start()
    running.pause()
    try:
        refused = subprocess.run(
            [sys.executable, "-m", "kei_exp.workflows.cli", "worker", "--slot", "slot-1", "--database-url", url],
            env={**os.environ, "KEI_RUNS": str(paths["runs"])}, capture_output=True, text=True, timeout=120,
            check=False)
        assert refused.returncode != 0
        assert "slot slot-1 is held by another process" in refused.stdout + refused.stderr
    finally:
        running.resume()


def test_an_extraction_killed_after_publishing_its_artifact_recovers_to_one_artifact(site):
    paths, start, kei, _ = site
    crashing = start(crash_after="artifact")
    run_id = kei_helper.converted_run(paths["runs"], "kei-convert:ingest:p:x")
    workflow_id = "kei-extract:x-1"
    kei().enqueue("extract", config.EXTRACT, workflow_id, kei_helper.extract_request(run_id, catalogue.GENERATION),
                  priority=config.PRIORITY_INTERACTIVE)
    crashed(crashing, paths["control"], "artifact")
    artifact = paths["runs"] / run_id / "extractions" / "x-1" / "result.json"
    first_started = json.loads(artifact.read_text())["started"]  # published before the crash, never checkpointed
    start()
    status = final(kei(), workflow_id)
    assert status.status == "SUCCESS" and status.output["ok"] is True
    assert json.loads(artifact.read_text())["started"] != first_started  # the step ran again and republished
    assert status.output["artifact_sha256"] == hashlib.sha256(artifact.read_bytes()).hexdigest()
    assert [p.name for p in (paths["runs"] / run_id / "extractions").iterdir()] == ["x-1"]
    assert [p.name for p in (paths["runs"] / run_id / "extractions" / "x-1").iterdir()] == ["result.json"]
    assert not list((paths["runs"] / run_id).rglob("*.part"))
    assert steps(kei(), workflow_id) == ["extract_run"]
    assert kei().row(workflow_id)["recovery_attempts"] == 2


def test_a_conversion_killed_after_publishing_its_result_recovers_to_the_published_generation(site):
    paths, start, kei, _ = site
    (paths["control"] / "release").touch()
    crashing = start(crash_after="result")
    sha = kei_helper.stage_pdf(paths["inbox"], "b.pdf", mask())
    workflow_id = "kei-convert:ingest:p:b"
    kei().enqueue("convert", config.CONVERT_SMALL, workflow_id,
                  kei_helper.convert_request("b.pdf", sha, model="fake", cut="none"))
    crashed(crashing, paths["control"], "result")
    run = paths["runs"] / runs.run_id_for(workflow_id)
    first = json.loads((run / "result" / "result.json").read_text())["generation"]  # published, never checkpointed
    assert [path.name for path in paths["control"].glob("started-*")] == ["started-1"]
    start()
    status = final(kei(), workflow_id)
    assert status.status == "SUCCESS" and status.output["ok"] is True
    assert (paths["control"] / "started-2").exists()  # convert_run ran again
    manifest = json.loads((run / "result" / "result.json").read_text())
    assert manifest["generation"] != first
    assert status.output["generation"] == manifest["generation"]
    assert [path.name for path in paths["runs"].iterdir() if not path.name.startswith(".worker-")] == [run.name]
    assert not list(run.rglob("*.part"))
    assert steps(kei(), workflow_id) == ["resolve_models", "prepare_run", "convert_run"]
    assert kei().row(workflow_id)["recovery_attempts"] == 2
