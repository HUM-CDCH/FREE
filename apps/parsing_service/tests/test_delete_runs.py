"""kei `deleteRuns`: a run goes only when the conversion that writes it can no longer write (spec, *kei runs and
history*, *kei boot boundary*). Durable Extraction attempts only read runs; Studio's head pins keep those runs out of
the request."""
import hashlib
import itertools
import os
import time
from types import SimpleNamespace

import psycopg
import pytest
from dbos import DBOS

from kei_exp import runs
from kei_exp.kie import runner
from kei_exp.workflows import boot, cancel, config, contracts, durable_extract, gc
from tests.helpers import kei as kei_helper
from tests.helpers.pdfs import mask

BOOT = 1_000_000


def status(name, updated_at=None):
    return SimpleNamespace(status=name, updated_at=updated_at)


@pytest.mark.parametrize("found, expected", [
    (None, True), (status("SUCCESS"), True), (status("ERROR"), True),
    (status("CANCELLED", BOOT - 1), True), (status("CANCELLED", BOOT), False), (status("CANCELLED", BOOT + 1), False),
    (status("MAX_RECOVERY_ATTEMPTS_EXCEEDED", BOOT - 1), True),
    (status("MAX_RECOVERY_ATTEMPTS_EXCEEDED", BOOT + 1), False),
    (status("CANCELLED", None), False),
    (status("ENQUEUED"), False), (status("PENDING"), False), (status("DELAYED"), False),
])
def test_eligibility_follows_the_boot_boundary(found, expected):
    assert gc.eligible(found, BOOT) is expected


def age(directory, seconds=gc.MIN_AGE_SECONDS + 60):
    then = time.time() - seconds
    for path in [directory, *directory.rglob("*")]:
        os.utime(path, (then, then))


GC_IDS = itertools.count(1)


def delete(kei, conversions=(), history=()):
    return kei.output(enqueue_delete(kei, conversions, history))


def enqueue_delete(kei, conversions=(), history=()):
    return kei.enqueue("deleteRuns", config.GC, f"kei-gc:test-{next(GC_IDS)}",
                       {"conversions": list(conversions), "history": list(history)})


def converted(kei, workflow_id="kei-convert:ingest:p:a"):
    # Bytes of its own per conversion: bytes an earlier one converted would adopt its result, never reaching the gate.
    name = workflow_id[-1]
    sha = kei_helper.stage_pdf(kei.inbox, f"{name}.pdf", mask(every=2 + ord(name) % 32))
    kei.enqueue("convert", config.CONVERT_SMALL, workflow_id,
                kei_helper.convert_request(f"{name}.pdf", sha, model="fake", cut="none"))
    return workflow_id


def staging(kei, workflow_id):
    """A `.prepare-<run>` staging directory as a conversion stopped inside prepare_run leaves it. Written just now:
    its conversion's status alone decides, not its age."""
    directory = kei.runs / f".prepare-{runs.run_id_for(workflow_id)}"
    directory.mkdir()
    (directory / "input.pdf").write_bytes(b"%PDF-")
    return directory


def restart(kei):
    """What the next kei process reads after taking the slot (Task 9 restarts a real one)."""
    boot.set_timestamp(kei.db_now_ms())


def settled_sweep(kei):
    """A `kei-gc:` workflow that has ended: an empty deleteRuns."""
    workflow_id = enqueue_delete(kei)
    kei.output(workflow_id)
    return workflow_id


def held_attempt(kei, monkeypatch, workflow_id):
    """A live durable attempt held inside its planning (no coordination database: it plans no call and acknowledges
    a boundary once released); returns the gate."""
    gate = kei_helper.Gate()
    monkeypatch.setattr(durable_extract, "plan_next", lambda extraction, attempt: gate() or {"boundary": True})
    monkeypatch.setattr(durable_extract, "acknowledge", lambda extraction, attempt, complete, failure: "PAUSED")
    gate.hold(workflow_id)
    kei.enqueue("extractDurableV1", config.EXTRACT, workflow_id,
                {"protocol": 1, "extraction_id": workflow_id, "attempt_id": workflow_id}, priority=1)
    kei_helper.until(lambda: workflow_id in gate.entered, 30, "the live attempt")
    return gate


@pytest.fixture
def fake(monkeypatch):
    from kei_exp import runtime
    from tests.helpers.fake import registered
    gate = kei_helper.Gate()
    monkeypatch.setattr(runtime, "loaded_model", lambda url: (True, "fake/model"))
    with registered(kei_helper.BlockingTranscriber(gate)):
        yield gate
    gate.release_all()


@pytest.fixture
def conversions_returned(monkeypatch):
    """The workflow IDs whose conversion has returned or raised: after it, convert_run writes nothing more."""
    returned: set[str] = set()
    original = runner.convert

    def convert(*args, **kwargs):
        try:
            return original(*args, **kwargs)
        finally:
            returned.add(DBOS.workflow_id)
    monkeypatch.setattr(runner, "convert", convert)
    return returned


def cancelled_conversion(kei, fake, conversions_returned, workflow_id):
    """A conversion cancelled inside its native call, whose step has since stopped writing."""
    fake.hold(workflow_id)
    converted(kei, workflow_id)
    kei_helper.until(lambda: workflow_id in fake.entered, 30, "the conversion's native call")
    DBOS.cancel_workflow(workflow_id)
    fake.release(workflow_id)
    kei_helper.until(lambda: workflow_id in conversions_returned, 30, "the cancelled conversion returning")
    assert kei.wait(workflow_id).status == "CANCELLED"


def test_an_old_run_whose_conversion_succeeded_is_deleted(kei, fake):
    workflow_id = converted(kei)
    run_id = kei.output(workflow_id)["run_id"]
    age(kei.runs / run_id)
    output = delete(kei, [workflow_id])
    contracts.DeleteRunsOk.model_validate(output)
    assert output["deleted_runs"] == [run_id] and not (kei.runs / run_id).exists()
    assert output["deleted_history"] == [workflow_id] and DBOS.get_workflow_status(workflow_id) is None
    assert not list(kei.runs.glob(".deleting-*"))
    assert delete(kei, [workflow_id]) == {  # at-least-once: repeating it is harmless
        "ok": True, "deleted_runs": [run_id], "kept_runs": [], "deleted_history": [workflow_id], "kept_history": []}


def test_a_young_run_is_kept(kei, fake):
    workflow_id = converted(kei)
    run_id = kei.output(workflow_id)["run_id"]
    output = delete(kei, [workflow_id])
    assert (output["deleted_runs"], output["kept_runs"]) == ([], [run_id]) and (kei.runs / run_id).is_dir()


def test_a_run_with_a_cancelled_conversion_waits_for_a_kei_restart(kei, fake, conversions_returned, monkeypatch):
    monkeypatch.setattr(cancel, "MIN_INTERVAL", 0.0)
    workflow_id = "kei-convert:ingest:p:b"
    cancelled_conversion(kei, fake, conversions_returned, workflow_id)
    run_id = runs.run_id_for(workflow_id)
    age(kei.runs / run_id)  # after the step returned: only the boot boundary can keep the run now
    assert delete(kei, [workflow_id]) == {
        "ok": True, "deleted_runs": [], "kept_runs": [run_id], "deleted_history": [], "kept_history": [workflow_id]}
    assert (kei.runs / run_id).is_dir() and DBOS.get_workflow_status(workflow_id) is not None
    restart(kei)
    output = delete(kei, [workflow_id])
    assert output["deleted_runs"] == [run_id] and output["deleted_history"] == [workflow_id]
    assert not (kei.runs / run_id).exists() and DBOS.get_workflow_status(workflow_id) is None


def test_history_goes_only_for_workflows_that_can_no_longer_write(kei, monkeypatch):
    done, swept, live = settled_sweep(kei), settled_sweep(kei), "kei-durable:h-1:a-1"
    gate = held_attempt(kei, monkeypatch, live)
    try:
        output = delete(kei, history=[done, live, swept])
        assert (output["deleted_history"], output["kept_history"]) == ([done, swept], [live])
        assert output["deleted_runs"] == output["kept_runs"] == []  # history names no run
        assert DBOS.get_workflow_status(done) is None and DBOS.get_workflow_status(swept) is None
        assert DBOS.get_workflow_status(live) is not None
    finally:
        gate.release_all()
    kei.output(live)


def test_a_live_conversion_keeps_its_old_run(kei, fake):
    """A run whose conversion is still running is kept even when nothing in it changed for a day."""
    live = "kei-convert:ingest:p:g"
    fake.hold(live)
    converted(kei, live)
    kei_helper.until(lambda: live in fake.entered, 30, "the live conversion")
    run_id = runs.run_id_for(live)
    age(kei.runs / run_id)
    output = delete(kei, [live])
    assert (output["kept_runs"], output["kept_history"]) == ([run_id], [live]) and (kei.runs / run_id).is_dir()


def test_prepare_leftovers_go_once_their_conversion_can_no_longer_write(kei, fake, conversions_returned,
                                                                         monkeypatch):
    monkeypatch.setattr(cancel, "MIN_INTERVAL", 0.0)
    done = converted(kei, "kei-convert:ingest:p:h")
    kei.output(done)
    exceeded = converted(kei, "kei-convert:ingest:p:i")
    kei.output(exceeded)
    with psycopg.connect(kei.url, autocommit=True) as connection:  # as a fifth crash in this boot would leave it
        connection.execute("update kei_dbos.workflow_status set status = 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', "
                           "updated_at = %s where workflow_uuid = %s", (kei.db_now_ms(), exceeded))
    stopped = "kei-convert:ingest:p:j"
    cancelled_conversion(kei, fake, conversions_returned, stopped)
    live = "kei-convert:ingest:p:k"
    fake.hold(live)
    converted(kei, live)
    kei_helper.until(lambda: live in fake.entered, 30, "the live conversion")
    leftovers = {name: staging(kei, workflow_id) for name, workflow_id in
                 [("done", done), ("exceeded", exceeded), ("stopped", stopped), ("live", live),
                  ("forgotten", "kei-convert:ingest:p:gone")]}  # its history already deleted

    def left():
        return sorted(name for name, directory in leftovers.items() if directory.exists())
    output = delete(kei)
    assert output["deleted_runs"] == [] and left() == ["exceeded", "live", "stopped"]
    restart(kei)
    delete(kei)
    assert left() == ["live"]  # never a live conversion's staging


@pytest.mark.parametrize("read", ["convert", "statuses"])
def test_a_failed_status_read_deletes_nothing(kei, fake, monkeypatch, read):
    """Whichever read fails, neither the eligible run, nor the leftover staging, nor the eligible history goes."""
    conversion = converted(kei, "kei-convert:ingest:p:l")
    run_id = kei.output(conversion)["run_id"]
    age(kei.runs / run_id)
    finished = settled_sweep(kei)
    leftover = staging(kei, "kei-convert:ingest:p:gone")
    original, reads = DBOS.list_workflows, []

    def failing(**kwargs):
        kind = kwargs.get("name") or "statuses"
        reads.append(kind)
        if kind == read:
            raise psycopg.OperationalError("the database went away")
        return original(**kwargs)
    monkeypatch.setattr(gc.DBOS, "list_workflows", failing)
    gc_id = enqueue_delete(kei, [conversion], [finished])
    assert kei.wait(gc_id).status == "ERROR"
    assert read in reads
    assert (kei.runs / run_id).is_dir() and leftover.is_dir()
    assert DBOS.get_workflow_status(conversion) is not None and DBOS.get_workflow_status(finished) is not None
    assert not list(kei.runs.glob(".deleting-*"))


@pytest.mark.parametrize("broken", ["missing", "not json", "not an object", "no workflow", "walk"])
def test_an_unreadable_run_is_kept_and_stops_nothing_else(kei, fake, monkeypatch, broken):
    workflow_id = converted(kei, "kei-convert:ingest:p:n")
    run_id = kei.output(workflow_id)["run_id"]
    age(kei.runs / run_id)
    corrupt_conversion = "kei-convert:ingest:p:corrupt"  # its history already deleted; its run is still there
    corrupt = kei.runs / runs.run_id_for(corrupt_conversion)
    corrupt.mkdir()
    if broken != "missing":
        params = {"not json": "{", "not an object": "[1]", "no workflow": '{"workflow_id": 5}',
                  "walk": '{"workflow_id": "kei-convert:ingest:p:gone"}'}[broken]
        (corrupt / "params.json").write_text(params, encoding="utf-8")
    age(corrupt)
    original = gc._last_write

    def last_write(directory):
        if broken == "walk" and directory.name == corrupt.name:  # a file unreadable while the age is measured
            raise PermissionError(directory)
        return original(directory)
    monkeypatch.setattr(gc, "_last_write", last_write)
    output = delete(kei, [corrupt_conversion, workflow_id])
    assert output == {"ok": True, "deleted_runs": [run_id], "kept_runs": [corrupt.name],
                      "deleted_history": [workflow_id], "kept_history": [corrupt_conversion]}
    assert corrupt.is_dir() and not (kei.runs / run_id).exists() and DBOS.get_workflow_status(workflow_id) is None


@pytest.mark.parametrize("params", ["[1]", '"a string"', "null"])
def test_a_params_file_that_is_no_object_is_unreadable_not_a_crash(tmp_path, params):
    (tmp_path / "params.json").write_text(params, encoding="utf-8")
    with pytest.raises(ValueError, match="no object"):
        gc._writers(tmp_path)


def test_a_run_without_params_is_unreadable(tmp_path):
    with pytest.raises(FileNotFoundError, match="params.json"):
        gc._writers(tmp_path)


def test_a_run_that_cannot_be_removed_is_kept_and_stops_nothing_else(kei, fake, monkeypatch):
    stuck, gone = (converted(kei, f"kei-convert:ingest:p:{name}") for name in "rs")
    stuck_id, gone_id = (kei.output(workflow_id)["run_id"] for workflow_id in (stuck, gone))
    age(kei.runs / stuck_id)
    age(kei.runs / gone_id)
    original = gc._remove

    def remove(directory):
        if directory.name == stuck_id:
            raise PermissionError(directory)
        original(directory)
    monkeypatch.setattr(gc, "_remove", remove)
    output = delete(kei, [stuck, gone])
    assert (output["deleted_runs"], output["kept_runs"]) == ([gone_id], [stuck_id])
    assert (output["deleted_history"], output["kept_history"]) == ([gone], [stuck])
    assert (kei.runs / stuck_id).is_dir() and not (kei.runs / gone_id).exists()


def test_a_history_id_named_twice_is_deleted_once(kei):
    done = settled_sweep(kei)
    output = delete(kei, history=[done, done])
    assert (output["deleted_history"], output["kept_history"]) == ([done], [])
    assert DBOS.get_workflow_status(done) is None


def test_an_extractions_directory_names_no_writer(tmp_path):
    """Only the conversion writes a run: nothing under extractions/ keeps it."""
    (tmp_path / "params.json").write_text('{"workflow_id": "kei-convert:ingest:p:o"}', encoding="utf-8")
    (tmp_path / "extractions" / "x-5").mkdir(parents=True)
    assert gc._writers(tmp_path) == ["kei-convert:ingest:p:o"]


def test_a_conversion_id_without_its_prefix_is_an_invalid_request(kei):
    output = delete(kei, ["../x"])
    assert (output["ok"], output["code"]) == (False, "invalid_request")


def test_history_refuses_a_conversion_id(kei):
    output = delete(kei, history=["kei-convert:ingest:p:z"])
    assert output["ok"] is False and output["code"] == "invalid_request"


def test_a_conversion_names_its_run_and_both_go_together(kei, fake):
    workflow_id = converted(kei)
    run_id = kei.output(workflow_id)["run_id"]
    age(kei.runs / run_id)
    output = delete(kei, [workflow_id])
    assert output["deleted_runs"] == [run_id] and output["deleted_history"] == [workflow_id]
    assert not (kei.runs / run_id).exists() and DBOS.get_workflow_status(workflow_id) is None


def test_a_conversion_history_stays_while_its_run_stays(kei, fake):
    """Studio finds a run only through its conversion's history, so the history must outlive the run."""
    workflow_id = converted(kei, "kei-convert:ingest:p:y")
    run_id = kei.output(workflow_id)["run_id"]           # young: kept by age
    output = delete(kei, [workflow_id])
    assert (output["kept_runs"], output["kept_history"]) == ([run_id], [workflow_id])
    assert DBOS.get_workflow_status(workflow_id) is not None


def test_a_failed_conversion_leaves_a_run_that_its_conversion_names(kei, fake, monkeypatch):
    """convert_run failed after prepare_run published the run: Studio has no run ID, only the conversion."""
    monkeypatch.setattr(runner, "convert", lambda *a, **k: (_ for _ in ()).throw(ValueError("broken page")))
    workflow_id = converted(kei, "kei-convert:ingest:p:f")
    assert kei.output(workflow_id)["ok"] is False
    run_id = runs.run_id_for(workflow_id)
    assert (kei.runs / run_id).is_dir()
    age(kei.runs / run_id)
    output = delete(kei, [workflow_id])
    assert output["deleted_runs"] == [run_id] and output["deleted_history"] == [workflow_id]


def test_a_conversion_whose_run_was_never_written_loses_only_its_history(kei, fake):
    unreadable = b"%PDF-1.7\n" + b"\0" * 2048  # prepare_run refuses it before it publishes a run
    (kei.inbox / "u.pdf").write_bytes(unreadable)
    workflow_id = "kei-convert:ingest:p:u"
    kei.enqueue("convert", config.CONVERT_LARGE, workflow_id,
                kei_helper.convert_request("u.pdf", hashlib.sha256(unreadable).hexdigest(), model="fake"))
    assert kei.output(workflow_id)["code"] == "source_unreadable"
    assert not (kei.runs / runs.run_id_for(workflow_id)).exists()
    output = delete(kei, [workflow_id])
    assert output["deleted_history"] == [workflow_id] and DBOS.get_workflow_status(workflow_id) is None
