"""The conversion task: what it retries, what it refuses, and that a cancelled run publishes nothing.

The transcriber is the fake of tests/helpers/fake.py; no GPU and no model server.
"""
import json
import logging
import threading
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
import requests
from procrastinate.exceptions import JobAborted

from kei_exp import runs, runtime
from kei_exp.jobs import schema, store, tasks, tokens
from kei_exp.jobs.app import deferring_installed
from kei_exp.kie.stages import ocr
from kei_exp.transcription.types import ConversionError, IncompleteConversionError
from tests.helpers.fake import FakeTranscriber, registered
from tests.helpers.pdfs import text_pdf


@pytest.fixture
def prepared(database: str, tmp_path: Path, monkeypatch) -> Path:
    """A store with one admitted run whose directory holds a two-page source and its params.

    `has_native_text` is monkeypatched off: `ocr.resolve()` checks it FIRST and, for a PDF with a text layer,
    returns a NATIVE execution with `model=None` before the params' model is ever consulted — so the registered
    `FakeTranscriber` would never run and real Docling would, taking minutes and producing the wrong Markdown.
    The source built with `text_pdf` has a text layer for exactly that reason; monkeypatching the check off makes
    `resolve` honour the params' model instead. These tests are about the task's lifecycle, not about transcriber
    selection, which tests/test_convert.py already covers.
    """
    monkeypatch.setattr(ocr, "has_native_text", lambda *args, **kwargs: False)
    # _serving() checks the server whenever execution.model is not None, with no exemption for a kind that is
    # not actually served, and it is the only place that checks it at all (POST /api/runs admits a run without
    # asking any server anything). Patched here so the default "fake" model of this fixture's run clears that
    # check; test_a_served_model_is_checked_when_the_run_actually_runs re-patches it per case.
    monkeypatch.setattr(runtime, "loaded_model", lambda _url: (True, "fake/model"))
    schema.apply(database)
    store.close_pool()
    store.pool(database)
    monkeypatch.setattr(runs, "RUNS", tmp_path)
    directory = tmp_path / "run-t"
    directory.mkdir(parents=True)
    text_pdf(directory / "input.pdf", [["one"], ["two"]])
    params = {"id": "run-t", "created": runs.now(), "source_name": "input.pdf", "page_count": 2,
              "transcriber": "fake", "model": "fake", "cut": "none", "crop_dpi": 250, "layout_model": None,
              "page_source": "pdf", "max_image_size": None, "max_output_tokens": None, "stream": False,
              "pages": [1, 2], "debug": False, "url": None}
    runs.write_json(directory / "params.json", params)
    with deferring_installed(database):
        store.admit("run-t", params, slot="slot-t")
    try:
        yield directory
    finally:
        store.close_pool()


def test_a_transient_backend_failure_is_classified_for_retry() -> None:
    assert isinstance(tasks.classify(requests.ConnectionError("refused")), tasks.TransientBackendError)
    assert isinstance(tasks.classify(ConversionError("Surya failed; output not written: server unreachable")),
                      tasks.TransientBackendError)


def test_a_model_server_answering_429_or_5xx_while_it_loads_is_classified_for_retry() -> None:
    """The extraction path reaches its server over HTTP, and `raise_for_status()` (kie/extract/llm.py) is how
    its refusal arrives: a `requests.HTTPError`, which is neither a ConnectionError nor a ConversionError
    carrying one of the TRANSIENT phrases. A vLLM still loading its weights, an Ollama behind a proxy and an
    overloaded server answer 503/502/504/429 — the same condition a conversion's engine surfaces in words and
    is retried for. Every other status is about this request, not about the server's availability, and must
    not spend the retry budget: a 400 or a 422 fails the same way on the next attempt.
    """
    def answered(status: int) -> requests.HTTPError:
        return requests.HTTPError(f"{status} Error: for url http://127.0.0.1:11434/v1/chat/completions",
                                  response=SimpleNamespace(status_code=status))

    for status in (429, 502, 503, 504):
        assert isinstance(tasks.classify(answered(status)), tasks.TransientBackendError), status
    for status in (400, 401, 404, 409, 413, 422, 500, 501):
        error = answered(status)
        assert tasks.classify(error) is error, status
    unanswered = requests.HTTPError("no response was attached")  # nothing to judge: not retried
    assert tasks.classify(unanswered) is unanswered


def test_a_store_outage_is_classified_for_retry() -> None:
    """A synchronous emit or deferred token flush can raise `store.Unavailable`; it says nothing about
    the document, so it must be retried exactly like a refused model server."""
    assert isinstance(tasks.classify(store.Unavailable("connection refused")), tasks.TransientBackendError)


def test_an_incomplete_recognition_is_not_retried() -> None:
    error = IncompleteConversionError("Conversion incomplete; output not written: page 1 stopped at its cap")
    assert tasks.classify(error) is error


def test_incomplete_recognition_is_excluded_by_type_not_by_matching_the_word_in_the_message() -> None:
    """Before this fix, `classify()` kept ANY message containing the word "incomplete" out of the retried set,
    whatever its actual type — a plain `ConversionError` (not the recognition-incomplete kind) that happens to
    quote a transient phrase alongside that word would have been wrongly treated as non-transient. Classifying
    on `IncompleteConversionError`'s type instead means a `ConversionError` with the same word in its message
    is judged only by the transient phrases, unaffected by that word."""
    error = ConversionError("Surya failed; output not written: incomplete response, connection timed out")
    assert isinstance(tasks.classify(error), tasks.TransientBackendError)


def test_invalid_input_and_programming_errors_are_not_retried() -> None:
    value = ValueError("the fake transcriber does not accept stream")
    assert tasks.classify(value) is value
    bug = AttributeError("'NoneType' object has no attribute 'page'")
    assert tasks.classify(bug) is bug


def test_the_retry_strategy_retries_at_five_then_ten_seconds() -> None:
    """max_attempts counts retries (docs/job-backend.md), and the spec wants the two retries 5 s and 10 s
    apart. Assert what the strategy actually DECIDES for each attempt, not its constructor arguments: with
    Procrastinate 3.9.0's formula (`wait + linear_wait * job.attempts`, `job.attempts` counting attempts
    already finished), `RetryStrategy(max_attempts=2, linear_wait=5)` alone decides 0 s then 5 s — the linear
    term is zeroed by `job.attempts == 0` on the very first retry — not 5 s and 10 s. `wait=5` supplies the
    first delay; `linear_wait=5` then adds exactly one more `wait` per attempt already made.
    """
    strategy = tasks.convert_run.retry_strategy
    assert strategy.max_attempts == 2
    assert tasks.TransientBackendError in strategy.retry_exceptions
    error = tasks.TransientBackendError("unreachable")
    before = datetime.now(UTC)
    first = strategy.get_retry_decision(exception=error, job=SimpleNamespace(attempts=0))
    second = strategy.get_retry_decision(exception=error, job=SimpleNamespace(attempts=1))
    third = strategy.get_retry_decision(exception=error, job=SimpleNamespace(attempts=2))
    assert first is not None and second is not None
    assert 4.5 <= (first.retry_at - before).total_seconds() <= 5.5, first.retry_at
    assert 9.5 <= (second.retry_at - before).total_seconds() <= 10.5, second.retry_at
    assert third is None  # attempts=2 == max_attempts: the third failure gets no further retry


def test_the_task_converts_and_publishes_the_output(prepared: Path) -> None:
    with registered(FakeTranscriber(knobs=frozenset())):
        tasks.execute("run-t", attempt=1)
    assert (prepared / "output.md").read_text(encoding="utf-8").strip() == "complete output\n\ncomplete output"
    row = store.record("run-t")
    assert row is not None and row.finished is not None
    assert [event["type"] for event in store.events_after("run-t", -1)][-1] == "status"


def test_a_token_file_failure_before_completion_prevents_success(prepared: Path, monkeypatch):
    attempted = threading.Event()

    def disk_full(self, batch):
        attempted.set()
        raise OSError("token disk full")

    def convert_with_last_token(execution, emit):
        emit({"type": "token", "page": 1, "text": "complete output"})
        assert attempted.wait(timeout=1)
        return "complete output"

    monkeypatch.setattr(tokens.TokenLog, "append", disk_full)
    monkeypatch.setattr(tasks, "convert", convert_with_last_token)
    with registered(FakeTranscriber(knobs=frozenset())), pytest.raises(OSError, match="token disk full"):
        tasks.execute("run-t", attempt=1)
    assert not (prepared / "output.md").exists()
    saved = store.events_after("run-t", -1)
    assert all(event["type"] != "token" for event in saved)
    assert saved[-1]["status"] == "failed" and "token disk full" in saved[-1]["error"]
    assert store.record("run-t").finished is not None


def test_a_served_model_is_checked_when_the_run_actually_runs(prepared: Path, monkeypatch) -> None:
    """Admission asked no server anything; what is reachable now is what decides.

    A queued run may wait while the operator swaps the loaded model, and a run that went ahead against the
    wrong one would produce a result whose recipe names a model that never saw the pages.
    """
    # The row, not params.json: execution_for() reads the database's recorded request, so a served model is
    # simulated by updating the row admission committed, the same way a resubmission would.
    changed = {**store.record("run-t").params, "transcriber": "vlm", "model": "granite_vision",
               "repo": "ibm-granite/granite-vision-4.1-4b", "url": "http://127.0.0.1:1/v1/chat/completions"}
    with store.connection() as conn:
        conn.execute("UPDATE kei_run SET params = %s WHERE id = %s", (json.dumps(changed), "run-t"))
        conn.commit()
    monkeypatch.setattr(runtime, "loaded_model", lambda _url: (False, None))
    with pytest.raises(tasks.TransientBackendError, match="unreachable"):
        tasks.execute("run-t", attempt=1)   # unreachable is transient: the next attempt may find it back

    monkeypatch.setattr(runtime, "loaded_model", lambda _url: (True, "some/other-model"))
    with pytest.raises(ConversionError, match="has 'some/other-model' loaded"):
        tasks.execute("run-t", attempt=1)   # the wrong model is not transient: it needs an operator
    assert store.record("run-t").error is not None


def test_the_run_row_is_the_request_not_the_file(prepared: Path) -> None:
    """The recorded request is the database row; params.json is a copy and must not steer execution.

    A later increment binds a run to one result generation and refuses a changed recipe, so an execution
    that followed a mutable file could change what it produces between attempts without detection.
    """
    params = json.loads((prepared / "params.json").read_text(encoding="utf-8"))
    # A different, still-valid recipe (one page instead of the row's two) that would visibly change the
    # output were it honoured: a single "complete output" instead of two joined by a blank line.
    runs.write_json(prepared / "params.json", {**params, "pages": [1, 1]})
    with registered(FakeTranscriber(knobs=frozenset())):
        tasks.execute("run-t", attempt=1)
    # The row still says pages [1, 2]: the output must reflect that, not the file's edited range.
    assert (prepared / "output.md").read_text(encoding="utf-8").strip() == "complete output\n\ncomplete output"


def test_a_cancelled_run_publishes_nothing(prepared: Path) -> None:
    with store.connection() as conn:
        conn.execute("UPDATE kei_run SET cancel_requested = true WHERE id = 'run-t'")
        conn.commit()
    with registered(FakeTranscriber(knobs=frozenset())) as fake, pytest.raises(JobAborted):
        tasks.execute("run-t", attempt=1)
    assert fake.calls == []                       # no transcriber ran
    assert not (prepared / "output.md").exists()  # and nothing was published
    last = store.events_after("run-t", -1)[-1]
    assert (last["type"], last["status"]) == ("status", "cancelled")
    # The REPORTED status, not only the terminal event: raising JobAborted (rather than returning normally, as
    # this used to) is what makes Procrastinate record the job `aborted` instead of `succeeded` — the same
    # outcome `runs.STATUS_OF` already maps to "cancelled" for worker._abandon's own (`cancelled`) path. This
    # test drives `execute()` directly, bypassing Procrastinate's own machinery that would flip
    # `procrastinate_jobs.status`, so it asserts the kei_attempt row `_cancel` now records instead — unset
    # before this fix, and the reason `store._SELECT`'s `coalesce(a.finished, now())` would otherwise make a
    # cancelled run's duration climb forever.
    with store.connection() as conn:
        attempt = conn.execute("SELECT status, finished IS NOT NULL FROM kei_attempt "
                              "WHERE run_id = 'run-t' AND attempt = 1").fetchone()
    assert attempt == ("cancelled", True)


def test_cancellation_preserves_the_attempts_recorded_timings(prepared: Path, monkeypatch):
    def convert_then_cancel(execution, emit):
        emit({"type": "phase", "name": "ocr"})
        with store.connection() as conn:
            conn.execute("UPDATE kei_run SET cancel_requested = true WHERE id = 'run-t'")
        return "not published"

    monkeypatch.setattr(tasks, "convert", convert_then_cancel)
    with registered(FakeTranscriber(knobs=frozenset())), pytest.raises(JobAborted):
        tasks.execute("run-t", attempt=1)
    row = store.record("run-t")
    assert row.current_step is None
    assert [timing["step"] for timing in row.step_timings] == ["prepare", "ocr"]
    assert sum(timing["seconds"] for timing in row.step_timings) == pytest.approx(row.duration_seconds)
    assert not (prepared / "output.md").exists()


def test_retry_exhaustion_still_emits_a_terminal_status_event(prepared: Path, monkeypatch) -> None:
    """`convert_run` marks `execute()`'s last attempt so a transient failure gets the run's terminal status
    event even though it is classified retryable — without this, a run whose retries Procrastinate exhausted
    left no status event, and the former event stream (which stopped only on a status event) polled it
    forever."""
    def always_unreachable(execution, emit):
        raise requests.ConnectionError("refused")
    monkeypatch.setattr(tasks, "convert", always_unreachable)

    with registered(FakeTranscriber(knobs=frozenset())):  # resolve() still needs "fake" registered; convert()
        # itself is monkeypatched above and never reaches the fake transcriber's own .transcribe().
        with pytest.raises(tasks.TransientBackendError):
            tasks.execute("run-t", attempt=1, last_attempt=False)
        not_yet_terminal = store.events_after("run-t", -1)
        assert not_yet_terminal[-1]["type"] == "log"  # still retryable: no terminal event yet
        assert store.record("run-t").finished is None

        with pytest.raises(tasks.TransientBackendError):
            tasks.execute("run-t", attempt=3, last_attempt=True)
    events = store.events_after("run-t", -1)
    assert events[-1]["type"] == "status" and events[-1]["status"] == "failed"
    row = store.record("run-t")
    assert row is not None and row.finished is not None


def test_a_database_outage_during_and_after_the_conversion_still_publishes(prepared: Path, monkeypatch, caplog):
    """Computed OCR output is never thrown away because its bookkeeping could not be recorded.

    Every store call the attempt makes after the pages are converted fails here: the progress events, the
    attempt's outcome and the run's finish stamp. `output.md` is the product, and the job's own Procrastinate
    status stays the authority for the run's status, so the attempt logs what it could not record and returns.
    """
    def unavailable(*_args, **_kwargs):
        raise store.Unavailable("connection refused")

    monkeypatch.setattr(store, "append_events", unavailable)
    monkeypatch.setattr(store, "last_event_id", unavailable)
    monkeypatch.setattr(store, "attempt_finished", unavailable)
    monkeypatch.setattr(store, "finish_run", unavailable)
    with registered(FakeTranscriber(knobs=frozenset())), caplog.at_level(logging.ERROR, logger=tasks.__name__):
        tasks.execute("run-t", attempt=1)  # returns normally: nothing here is the document's fault
    assert (prepared / "output.md").read_text(encoding="utf-8").strip() == "complete output\n\ncomplete output"
    assert len(caplog.records) == 1
    assert "run-t" in caplog.text and "connection refused" in caplog.text


def test_an_unreadable_cancellation_flag_after_the_conversion_publishes_anyway(prepared: Path, monkeypatch,
                                                                               caplog):
    """The flag read between the finished conversion and `output.md` is best-effort too.

    Raising there classified as transient and converted the whole document again, spending a GPU on pages that
    were already in hand — a database failure invalidating computed OCR, which the plan's rule 5 forbids. An
    unreadable flag now means "not cancelled" for this boundary; the checks before the conversion, where
    nothing has been computed yet, still refuse to guess.
    """
    readable = store.cancel_requested
    calls = 0

    def readable_until_the_pages_are_converted(run_id):
        nonlocal calls
        calls += 1
        if calls > 2:  # the two checks before the conversion answer; the one before publishing cannot
            raise store.Unavailable("connection refused")
        return readable(run_id)

    monkeypatch.setattr(store, "cancel_requested", readable_until_the_pages_are_converted)
    with registered(FakeTranscriber(knobs=frozenset())), caplog.at_level(logging.ERROR, logger=tasks.__name__):
        tasks.execute("run-t", attempt=1)
    assert (prepared / "output.md").read_text(encoding="utf-8").strip() == "complete output\n\ncomplete output"
    assert "cancellation" in caplog.text and "run-t" in caplog.text  # the unreadable flag was really met
    row = store.record("run-t")
    assert row is not None and row.finished is not None  # and the attempt finished its bookkeeping normally
