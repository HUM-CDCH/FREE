"""kei's lanes: a cancelled step keeps its lane's slot and only its lane's; deadlines behave like cancels; priority
orders kei-extract, where durable Extraction attempts run; a large and a small conversion share one process without
sharing state (spec, *Cancellation →
Physical capacity*, *Queues, deadlines*, *kei worker → Two conversions in one process*; M0R 4)."""
import json
import threading
import time

import pytest
from dbos import DBOS

from kei_exp import runs, runtime
from kei_exp.failures import KeiFailure
from kei_exp.kie import runner
from kei_exp.models import MODELS, Model
from kei_exp.transcription.surya import settings_for
from kei_exp.transcription.types import DEFAULT_URL
from kei_exp.workflows import cancel, config, durable_extract, gc
from tests.helpers import kei as kei_helper
from tests.helpers.contracts import convert_timeout_ms
from tests.helpers.fake import registered
from tests.helpers.pdfs import mask

# Longer than a held step needs to reach its gate after dequeue on a loaded host, so the deadline fires inside the
# native-like call and never before it.
DEADLINE_MS = 4000


def surya_settings(models) -> set[str]:
    return {json.dumps(settings_for(DEFAULT_URL, record.max_new_tokens, record.params), sort_keys=True)
            for record in models.values() if record.kind == "surya"}


def test_every_surya_record_makes_configure_set_the_same_process_global_values():
    assert len(surya_settings(MODELS)) <= 1, (
        "two Surya records set different process-global settings (surya.py configure); give Surya per-call "
        "settings before two conversions can run in one process (spec, *Two conversions in one process*)")


def test_the_surya_check_bites_on_a_second_record_with_other_settings():
    second = {**MODELS, "surya_b": Model("datalab-to/surya-ocr-2", kind="surya", max_new_tokens=4096,
                                          params={"SURYA_GUIDED_LAYOUT": False})}
    assert len(surya_settings(second)) == 2


@pytest.fixture
def lanes(kei, monkeypatch):
    """Blocking doubles on every lane, keyed by workflow ID through one gate: the OCR call (convert lanes), a durable
    attempt's planning (kei-extract: it plans no call and acknowledges a boundary, with no coordination database) and
    deleteRuns' first status read (kei-gc)."""
    gate = kei_helper.Gate()
    monkeypatch.setattr(runtime, "loaded_model", lambda url: (True, "fake/model"))
    monkeypatch.setattr(durable_extract, "plan_next", lambda extraction, attempt: gate() or {"boundary": True})
    monkeypatch.setattr(durable_extract, "acknowledge", lambda extraction, attempt, complete, failure: "PAUSED")
    still_converting = gc._still_converting
    monkeypatch.setattr(gc, "_still_converting", lambda boot_ms: gate() or still_converting(boot_ms))
    run_id = kei_helper.converted_run(kei.runs, "kei-convert:ingest:fixture:run")
    with registered(kei_helper.BlockingTranscriber(gate)):
        try:
            yield kei, gate, run_id
        finally:
            gate.release_all()


def job(kei, lane, workflow_id, run_id, *, timeout_ms=None, priority=None):
    """One job on `lane` through Kei.enqueue: a one-page conversion, a durable attempt or an empty deleteRuns."""
    if lane in (config.CONVERT_LARGE, config.CONVERT_SMALL):
        name = f"{workflow_id.rsplit(':', 1)[-1]}.pdf"
        sha = kei_helper.stage_pdf(kei.inbox, name, mask(every=7 + len(name)))
        return kei.enqueue("convert", lane, workflow_id,
                           kei_helper.convert_request(name, sha, model="fake", cut="none"), timeout_ms=timeout_ms)
    if lane == config.EXTRACT:
        return kei.enqueue("extractDurableV1", lane, workflow_id,
                           {"protocol": 1, "extraction_id": workflow_id, "attempt_id": workflow_id},
                           priority=priority or config.PRIORITY_INTERACTIVE, timeout_ms=timeout_ms)
    return kei.enqueue("deleteRuns", lane, workflow_id, {"conversions": [], "history": []}, timeout_ms=timeout_ms)


PREFIX = {config.CONVERT_LARGE: "kei-convert:", config.CONVERT_SMALL: "kei-convert:",
          config.EXTRACT: "kei-durable:", config.GC: "kei-gc:"}


@pytest.mark.parametrize("lane", list(config.QUEUES))
def test_a_cancelled_step_keeps_its_lanes_slot_and_only_its_lanes(lanes, lane):
    kei, gate, run_id = lanes
    blockers = [f"{PREFIX[lane]}{lane}-b{n}" for n in range(config.QUEUES[lane])]
    for blocker in blockers:
        gate.hold(blocker)
        job(kei, lane, blocker, run_id)
    kei_helper.until(lambda: all(b in gate.entered for b in blockers), 30, "every slot of the lane busy")
    victim, follower = blockers[0], f"{PREFIX[lane]}{lane}-follower"
    DBOS.cancel_workflow(victim)
    job(kei, lane, follower, run_id)
    others = {other: job(kei, other, f"{PREFIX[other]}{lane}-other-{other}", run_id)
              for other in config.QUEUES if other != lane}
    for other, workflow_id in others.items():
        assert kei.wait(workflow_id, timeout=30).status == "SUCCESS", other  # the other lanes keep running
    time.sleep(1.5)  # a negative check: load can only make the follower later, never earlier
    assert kei.status(victim).status == "CANCELLED" and victim not in gate.left  # cancelled, its step still inside
    assert kei.status(follower).status == "ENQUEUED" and follower not in gate.entered
    gate.release(victim)
    assert kei.wait(follower, timeout=30).status == "SUCCESS"
    assert gate.entered[follower] >= gate.left[victim]
    assert kei.status(victim).status == "CANCELLED"


def test_a_cancelled_conversion_stops_at_its_next_check_and_holds_its_lane_until_it_returns(lanes, monkeypatch):
    """A real conversion cancelled through DBOS inside its native call: once the call returns, the conversion stops
    at its next cooperative check (the transcriber's next event), publishes nothing, and only then frees its lane."""
    kei, gate, run_id = lanes
    monkeypatch.setattr(cancel, "MIN_INTERVAL", 0.0)  # every event checks: "the next check" is the next event
    ended: dict[str, tuple[float, BaseException | None]] = {}
    convert = runner.convert

    def spied(*args, **kwargs):  # a spy, not a double: the real pipeline runs
        try:
            result = convert(*args, **kwargs)
        except BaseException as error:
            ended[DBOS.workflow_id] = (time.monotonic(), error)
            raise
        ended[DBOS.workflow_id] = (time.monotonic(), None)
        return result
    monkeypatch.setattr(runner, "convert", spied)
    victim, follower = "kei-convert:live-cancel", "kei-convert:live-cancel-follower"
    gate.hold(victim)
    job(kei, config.CONVERT_SMALL, victim, run_id)
    kei_helper.until(lambda: victim in gate.entered, 30, "the conversion's native call")
    DBOS.cancel_workflow(victim)
    job(kei, config.CONVERT_SMALL, follower, run_id)
    time.sleep(1.0)  # a negative check: load can only make the follower later, never earlier
    assert kei.status(victim).status == "CANCELLED" and victim not in ended
    assert kei.status(follower).status == "ENQUEUED" and follower not in gate.entered  # the lane is still occupied
    gate.release(victim)
    kei_helper.until(lambda: victim in ended, 30, "the cancelled conversion returning")
    returned_at, error = ended[victim]
    assert isinstance(error, KeiFailure) and error.code == "cancelled", error
    assert not (kei.runs / runs.run_id_for(victim) / "result").exists()  # stopped before publishing
    assert kei.wait(follower, timeout=30).status == "SUCCESS"
    assert gate.entered[follower] >= returned_at
    assert (kei.runs / runs.run_id_for(follower) / "result" / "result.json").is_file()
    assert kei.status(victim).status == "CANCELLED"


@pytest.mark.parametrize("lane", [config.CONVERT_LARGE, config.CONVERT_SMALL, config.EXTRACT])
def test_a_deadline_cancels_like_a_cancel_and_the_slot_waits_for_the_step(lanes, lane):
    kei, gate, run_id = lanes
    fillers = [f"{PREFIX[lane]}dl-{lane}-fill{n}" for n in range(config.QUEUES[lane] - 1)]
    for filler in fillers:
        gate.hold(filler)
        job(kei, lane, filler, run_id)
    timed = f"{PREFIX[lane]}dl-{lane}"
    gate.hold(timed)
    before = kei.db_now_ms()
    job(kei, lane, timed, run_id, timeout_ms=DEADLINE_MS)
    kei_helper.until(lambda: timed in gate.entered, 30, "the timed step")
    assert kei.wait(timed, timeout=30).status == "CANCELLED"
    after = kei.db_now_ms()
    row = kei.row(timed)
    assert before <= row["updated_at"] <= after + 1  # stamped from the database clock
    assert row["workflow_timeout_ms"] == DEADLINE_MS and timed not in gate.left  # the deadline fired inside the step
    follower = f"{PREFIX[lane]}dl-{lane}-follower"
    job(kei, lane, follower, run_id)
    time.sleep(1.0)  # a negative check: load can only make the follower later, never earlier
    assert kei.status(follower).status == "ENQUEUED" and follower not in gate.entered
    gate.release(timed)
    assert kei.wait(follower, timeout=30).status == "SUCCESS"
    assert gate.entered[follower] >= gate.left[timed]


def test_a_deadline_counts_from_dequeue_and_is_the_enqueuers_budget(lanes):
    kei, gate, run_id = lanes
    blocker = "kei-convert:dq-blocker"
    gate.hold(blocker)
    job(kei, config.CONVERT_LARGE, blocker, run_id)
    kei_helper.until(lambda: blocker in gate.entered, 30, "the blocker")
    queued, budget_ms = "kei-convert:dq-queued", 10_000  # room for its own three steps once dequeued
    enqueued_ms = kei.db_now_ms()
    job(kei, config.CONVERT_LARGE, queued, run_id, timeout_ms=budget_ms)
    time.sleep(budget_ms / 1000 + 1)  # longer than its budget, still ENQUEUED
    row = kei.row(queued)
    assert (row["status"], row["workflow_deadline_epoch_ms"]) == ("ENQUEUED", None)
    gate.release(blocker)
    assert kei.wait(queued, timeout=30).status == "SUCCESS"
    # Set at dequeue: an enqueue-relative deadline would lie before enqueued_ms + budget_ms, and would have fired.
    assert kei.row(queued)["workflow_deadline_epoch_ms"] > enqueued_ms + budget_ms
    book = job(kei, config.CONVERT_LARGE, "kei-convert:dq-book", run_id, timeout_ms=convert_timeout_ms(40))
    assert kei.row(book)["workflow_timeout_ms"] == 816_000  # deadlines.json's 40-page budget
    assert kei.wait(book, timeout=30).status == "SUCCESS"


def test_kei_extract_runs_priority_1_before_10_with_fifo_ties(lanes):
    kei, gate, run_id = lanes
    blockers = ["kei-durable:prio-b0", "kei-durable:prio-b1"]
    for blocker in blockers:
        gate.hold(blocker)
        job(kei, config.EXTRACT, blocker, run_id)
    kei_helper.until(lambda: all(b in gate.entered for b in blockers), 30, "both extraction slots busy")
    order_in = [("prio-10a", 10), ("prio-10b", 10), ("prio-1a", 1), ("prio-10c", 10), ("prio-1b", 1)]
    for name, priority in order_in:
        job(kei, config.EXTRACT, f"kei-durable:{name}", run_id, priority=priority)
        time.sleep(0.02)  # distinct enqueue times for the FIFO ties
    gate.release(blockers[0])  # one slot frees; the other stays held
    for name, _ in order_in:
        assert kei.wait(f"kei-durable:{name}", timeout=60).status == "SUCCESS", name
    # One slot runs them one at a time, so the order of their planning is the order they started.
    started = sorted((gate.entered[f"kei-durable:{name}"], name) for name, _ in order_in)
    assert [name for _, name in started] == ["prio-1a", "prio-1b", "prio-10a", "prio-10b", "prio-10c"]


class Overlapping(kei_helper.BlockingTranscriber):
    """Waits in its native call until the other conversion is in its own, when a barrier is set."""
    barrier: threading.Barrier | None = None

    def transcribe(self, execution, crops, emit):
        if self.barrier is not None:
            self.barrier.wait()
        return super().transcribe(execution, crops, emit)


def comparable(kei, output) -> dict:
    directory = kei.runs / output["run_id"] / "result"
    manifest = json.loads((directory / "result.json").read_text())
    pages = {name: {k: v for k, v in json.loads((directory / "pages" / f"{name}.json").read_text()).items()
                    if k != "generation"} for name in manifest["pages"]}
    kept = {k: v for k, v in manifest.items() if k not in ("generation", "digest", "started", "seconds", "pages")}
    return {"manifest": kept, "pages": pages}


def test_a_large_and_a_small_conversion_in_one_worker_produce_the_manifests_each_produces_alone(kei, monkeypatch):
    monkeypatch.setattr(runtime, "loaded_model", lambda url: (True, "fake/model"))
    fake = Overlapping(kei_helper.Gate())
    book = kei_helper.stage_pdf(kei.inbox, "book.pdf", mask(every=7))
    small = kei_helper.stage_pdf(kei.inbox, "small.pdf", mask(every=11))

    def convert(lane, workflow_id, name, sha):  # with a debug report, so the pair transcribes rather than adopts
        return kei.enqueue("convert", lane, workflow_id,
                           kei_helper.convert_request(name, sha, model="fake", cut="none", debug=True))
    with registered(fake):
        alone = [kei.output(convert(config.CONVERT_LARGE, "kei-convert:alone-book", "book.pdf", book)),
                 kei.output(convert(config.CONVERT_SMALL, "kei-convert:alone-small", "small.pdf", small))]
        fake.barrier = threading.Barrier(2, timeout=30)  # passes only if both are converting at once
        together = [convert(config.CONVERT_LARGE, "kei-convert:pair-book", "book.pdf", book),
                    convert(config.CONVERT_SMALL, "kei-convert:pair-small", "small.pdf", small)]
        together = [kei.output(workflow_id) for workflow_id in together]
    assert [comparable(kei, o) for o in together] == [comparable(kei, o) for o in alone]
    assert len({o["run_id"] for o in [*alone, *together]}) == 4  # each conversion has its own run directory
