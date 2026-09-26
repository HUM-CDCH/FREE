"""kei `deleteRuns`: a run goes only when every kei workflow that writes it can no longer write (spec, *kei runs and
history*, *kei boot boundary*)."""
import itertools
import os
import time
from types import SimpleNamespace

import psycopg
import pytest
from dbos import DBOS

from kei_exp import runs
from kei_exp.kie import runner
from kei_exp.workflows import boot, cancel, config, contracts, gc
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


def delete(kei, runs_=(), history=()):
    return kei.output(enqueue_delete(kei, runs_, history))


def enqueue_delete(kei, runs_=(), history=()):
    return kei.enqueue("deleteRuns", config.GC, f"kei-gc:test-{next(GC_IDS)}",
                       {"runs": list(runs_), "history": list(history)})


def converted(kei, workflow_id="kei-convert:ingest:p:a"):
    sha = kei_helper.stage_pdf(kei.inbox, f"{workflow_id[-1]}.pdf", mask())
    kei.enqueue("convert", config.CONVERT_SMALL, workflow_id,
                kei_helper.convert_request(f"{workflow_id[-1]}.pdf", sha, model="fake", cut="none"))
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
    output = delete(kei, [run_id])
    contracts.DeleteRunsOk.model_validate(output)
    assert output["deleted_runs"] == [run_id] and not (kei.runs / run_id).exists()
    assert not list(kei.runs.glob(".deleting-*"))
    assert delete(kei, [run_id])["deleted_runs"] == [run_id]  # at-least-once: repeating it is harmless
    assert kei.steps(workflow_id) == ["resolve_models", "prepare_run", "convert_run"]  # history is only on request


def test_a_young_run_is_kept(kei, fake):
    run_id = kei.output(converted(kei))["run_id"]
    output = delete(kei, [run_id])
    assert (output["deleted_runs"], output["kept_runs"]) == ([], [run_id]) and (kei.runs / run_id).is_dir()


def test_a_run_with_a_cancelled_conversion_waits_for_a_kei_restart(kei, fake, conversions_returned, monkeypatch):
    monkeypatch.setattr(cancel, "MIN_INTERVAL", 0.0)
    workflow_id = "kei-convert:ingest:p:b"
    cancelled_conversion(kei, fake, conversions_returned, workflow_id)
    run_id = runs.run_id_for(workflow_id)
    age(kei.runs / run_id)  # after the step returned: only the boot boundary can keep the run now
    assert delete(kei, [run_id], [workflow_id]) == {
        "ok": True, "deleted_runs": [], "kept_runs": [run_id], "deleted_history": [], "kept_history": [workflow_id]}
    assert (kei.runs / run_id).is_dir() and DBOS.get_workflow_status(workflow_id) is not None
    restart(kei)
    output = delete(kei, [run_id], [workflow_id])
    assert output["deleted_runs"] == [run_id] and output["deleted_history"] == [workflow_id]
    assert not (kei.runs / run_id).exists() and DBOS.get_workflow_status(workflow_id) is None


def test_a_run_an_unfinished_extraction_reads_is_kept(kei, monkeypatch):
    """Cancelled mid-extraction, before it published anything under extractions/: nothing in the run names it, yet
    the boot boundary still protects the run (review focus 4)."""
    from kei_exp.kie.extract import run as extraction
    from kei_exp.workflows import extract as extract_workflow
    from tests.test_extract_grounded import CountingChat, WordCounter, honest
    monkeypatch.setattr(cancel, "MIN_INTERVAL", 0.0)
    gate, extraction_id, ended = kei_helper.Gate(), "kei-extract:x-9", []
    gate.hold(extraction_id)
    monkeypatch.setattr(extract_workflow, "chats_for", lambda options: CountingChat(lambda *a: gate() or honest(*a)))
    monkeypatch.setattr(extraction, "counter_for", lambda client: WordCounter())
    original = extract_workflow.extract

    def extract(*args, **kwargs):
        try:
            return original(*args, **kwargs)
        finally:
            ended.append(True)
    monkeypatch.setattr(extract_workflow, "extract", extract)
    run_id = kei_helper.converted_run(kei.runs, "kei-convert:ingest:p:c")
    kei.enqueue("extract", config.EXTRACT, extraction_id,
                kei_helper.extract_request(run_id, "20260923T000000.000000Z-fixture0"), priority=1)
    kei_helper.until(lambda: extraction_id in gate.entered, 30, "the extraction's first call")
    age(kei.runs / run_id)  # after it published the segmentation, so only the extraction can keep the run
    published = kei.runs / run_id / "extractions"
    try:
        assert not published.exists()  # nothing under the run names this extraction
        assert delete(kei, [run_id])["kept_runs"] == [run_id]   # live
        DBOS.cancel_workflow(extraction_id)
        assert delete(kei, [run_id])["kept_runs"] == [run_id]   # cancelled after boot, step still in its call
    finally:
        gate.release_all()
    kei_helper.until(lambda: ended, 30, "the cancelled extraction returning")
    assert kei.wait(extraction_id).status == "CANCELLED"
    assert not published.exists()  # it stopped at its next entry check and published nothing
    age(kei.runs / run_id)
    restart(kei)  # the restart that proves the step has stopped
    assert delete(kei, [run_id])["deleted_runs"] == [run_id]


def test_history_goes_only_for_workflows_that_can_no_longer_write(kei, fake):
    done = converted(kei, "kei-convert:ingest:p:d")
    kei.output(done)
    live = "kei-convert:ingest:p:e"
    fake.hold(live)
    converted(kei, live)
    kei_helper.until(lambda: live in fake.entered, 30, "the live conversion")
    output = delete(kei, history=[done, live])
    assert (output["deleted_history"], output["kept_history"]) == ([done], [live])
    assert DBOS.get_workflow_status(done) is None and DBOS.get_workflow_status(live) is not None


def test_a_live_conversion_keeps_its_old_run(kei, fake):
    """A run whose conversion is still running is kept even when nothing in it changed for a day."""
    live = "kei-convert:ingest:p:g"
    fake.hold(live)
    converted(kei, live)
    kei_helper.until(lambda: live in fake.entered, 30, "the live conversion")
    run_id = runs.run_id_for(live)
    age(kei.runs / run_id)
    assert delete(kei, [run_id])["kept_runs"] == [run_id] and (kei.runs / run_id).is_dir()


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


@pytest.mark.parametrize("read", ["convert", "extract", "statuses"])
def test_a_failed_status_read_deletes_nothing(kei, fake, monkeypatch, read):
    """Whichever read fails, neither the eligible run, nor the leftover staging, nor the eligible history goes."""
    run_id = kei.output(converted(kei, "kei-convert:ingest:p:l"))["run_id"]
    age(kei.runs / run_id)
    finished = converted(kei, "kei-convert:ingest:p:m")
    kei.output(finished)
    leftover = staging(kei, "kei-convert:ingest:p:gone")
    original, reads = DBOS.list_workflows, []

    def failing(**kwargs):
        kind = kwargs.get("name") or "statuses"
        reads.append(kind)
        if kind == read:
            raise psycopg.OperationalError("the database went away")
        return original(**kwargs)
    monkeypatch.setattr(gc.DBOS, "list_workflows", failing)
    gc_id = enqueue_delete(kei, [run_id], [finished])
    assert kei.wait(gc_id).status == "ERROR"
    assert read in reads
    assert (kei.runs / run_id).is_dir() and leftover.is_dir() and DBOS.get_workflow_status(finished) is not None
    assert not list(kei.runs.glob(".deleting-*"))


def test_a_run_id_that_is_not_one_path_component_is_an_invalid_request(kei):
    output = delete(kei, ["../escape"])
    assert (output["ok"], output["code"]) == (False, "invalid_request")
