"""The slot queue's tasks: one conversion job per run, one extraction job per request, retried only for
transient backend failures.

What is retried and what is not is a judgement about the failure, not about the caller: a model server that
refused the connection may answer the next attempt, while a page the model truncated, a PDF that will not parse
and a bug in this code will fail again identically, and retrying them only spends a GPU. The classification is
`kei_exp.failures.classify`, and it is the only place that decides.

Cancellation is cooperative, as Procrastinate's task contract requires: the flag is `kei_run.cancel_requested`,
and this task reads it before the expensive stages and before it publishes.
"""
from __future__ import annotations

import logging

from procrastinate import RetryStrategy
from procrastinate.exceptions import JobAborted

from kei_exp import failures, runs, runtime
from kei_exp.failures import TransientBackendError
from kei_exp.files import publish
from kei_exp.jobs import store
from kei_exp.jobs.app import QUEUE, app
from kei_exp.jobs.events import DurableEmit
from kei_exp.kie.extract.models import Router, chats_for
from kei_exp.kie.extract.run import ExtractRequest, Options, extract, publish_extraction
from kei_exp.kie.runner import convert
from kei_exp.transcription.types import ConversionError

logger = logging.getLogger(__name__)

def classify(error: BaseException) -> BaseException:
    """`failures.classify`, plus the store outage only this backend meets (deleted with it)."""
    if isinstance(error, store.Unavailable):
        return TransientBackendError(str(error))
    return failures.classify(error)


def execute(run_id: str, attempt: int, *, last_attempt: bool = False) -> None:
    """One attempt at a run, with no Procrastinate in sight so that a test can call it directly.

    `last_attempt` is the caller's to know, not this function's to guess: `convert_run` reads it off
    `context.job.attempts` and the task's own retry strategy. When it is true, a transient failure gets the
    run's terminal status event exactly like a non-retryable one, because Procrastinate will not schedule
    another attempt either way — without this, a run that exhausted its retries left no terminal event, and
    every subscriber's `/events` stream (and, before that fix, this same run's own row) waited for one forever.
    """
    row = store.record(run_id)
    if row is None:
        raise ValueError(f"no run {run_id} in this store")
    directory = runs.RUNS / run_id
    emit = DurableEmit(run_id, attempt)
    store.attempt_started(run_id, attempt, row.job_id or 0)
    try:
        if store.cancel_requested(run_id):
            _cancel(run_id, attempt, emit)
        execution = runs.execution_for(directory, row.params)
        _serving(execution)
        if store.cancel_requested(run_id):  # resolution reads the PDF; the flag may have arrived meanwhile
            _cancel(run_id, attempt, emit)
        markdown = convert(execution, emit=emit)
        emit.flush()  # include the final token batch and any timer failure before publishing output.md
        if _cancelled_after_conversion(run_id, attempt):  # acknowledged: publish nothing further
            _cancel(run_id, attempt, emit)
        with publish(directory / "output.md") as part:
            part.write_text(markdown, encoding="utf-8")
    except JobAborted:
        raise  # _cancel() above already reported this attempt as cancelled; do not report it as failed too
    except Exception as error:
        message = str(error) if isinstance(error, (ValueError, ConversionError)) else f"{type(error).__name__}: {error}"
        classified = classify(error)
        retryable = isinstance(classified, TransientBackendError) and not last_attempt
        try:
            store.attempt_finished(run_id, attempt, "failed", message)
            if not retryable:
                _end(run_id, attempt, emit, "failed", message)
            else:
                emit({"type": "log", "text": f"Attempt {attempt} failed and will be retried: {message}"})
                emit.flush()
        except Exception as bookkeeping_error:  # noqa: BLE001 - recording the failure must never hide it
            logger.error("run %s attempt %s: could not record the failure (%s); the original error was: %s",
                        run_id, attempt, bookkeeping_error, message)
        raise classified from error
    else:
        try:
            store.attempt_finished(run_id, attempt, "succeeded", None)
            _end(run_id, attempt, emit, "done", None)
        except store.Unavailable as error:
            # The pages are converted and output.md is published: this attempt succeeded, whatever the store
            # can be told about it. Procrastinate's own job status is the authority `runs.STATUS_OF` reads for
            # the run's status (GET /api/runs/{id}), and raising here would only throw the output away and
            # spend a GPU converting it again.
            logger.error("run %s attempt %s: converted and published, but could not record the outcome (%s)",
                        run_id, attempt, error)
    finally:
        emit.close()


def _serving(execution) -> None:
    """Refuse a served execution whose model server is not there, or is holding something else.

    This is the only place the server is checked. Admission deliberately does not: a queued run may wait while
    the operator swaps the loaded model or restarts it, so an answer given at submission says nothing about the
    attempt, and a model outage that refused submissions would stop valid documents from even being queued.
    Unreachable is transient and another attempt may find it back; the wrong model is not, and needs an
    operator rather than a retry.
    """
    if execution.model is None:
        return
    reachable, repo = runtime.loaded_model(execution.url)
    if not reachable:
        raise TransientBackendError(f"the model server at {execution.url} is unreachable")
    if repo != execution.repo:
        raise ConversionError(f"the model server has {repo!r} loaded, not the {execution.repo!r} this run needs")


def _cancelled_after_conversion(run_id: str, attempt: int) -> bool:
    """The cancellation flag at the one boundary where the pages are already converted: best-effort.

    Everything this attempt was asked to compute is in hand here, and only `output.md` is missing. A store that
    cannot answer is not a reason to throw that away and spend a GPU converting the document again, so an
    unreadable flag means "not cancelled" and the run is published and finished. A cancellation that arrived
    during the conversion is then simply not acknowledged by this attempt. The checks before the conversion
    stay strict: there is nothing computed to lose, and an unreadable flag there may still retry the attempt.
    """
    try:
        return store.cancel_requested(run_id)
    except store.Unavailable as error:
        logger.error("run %s attempt %s: could not read the cancellation flag once the pages were converted "
                    "(%s); publishing the output this attempt produced", run_id, attempt, error)
        return False


def _end(run_id: str, attempt: int, emit: DurableEmit, status: str, error: str | None) -> None:
    """The run's own terminal event, then its stamp: a subscriber that sees the event finds the run finished."""
    emit({"type": "status", "status": status, "error": error})
    emit.flush()
    store.finish_run(run_id)


def _cancel(run_id: str, attempt: int, emit: DurableEmit) -> None:
    """Report a cooperative cancellation and never return: raises so Procrastinate marks the job `aborted`.

    Returning normally here, as this used to, left Procrastinate to mark the job `succeeded` — a run cancelled
    through this path and one abandoned by `worker._abandon`'s startup reconciliation (which sets the job
    `cancelled` directly) would then disagree on the reported status. `runs.STATUS_OF` already maps both
    `aborted` and `cancelled` to "cancelled", so raising `JobAborted` here brings this path's outcome in line
    with the other one's. `execute` starts the attempt before any cancellation check; finishing it here
    preserves the elapsed time and phase boundaries already recorded.
    """
    store.attempt_finished(run_id, attempt, "cancelled", None)
    _end(run_id, attempt, emit, "cancelled", None)
    raise JobAborted("cancelled")


@app.task(name="convert_run", queue=QUEUE, pass_context=True,
          retry=RetryStrategy(max_attempts=2, wait=5, linear_wait=5, retry_exceptions={TransientBackendError}))
def convert_run(context, run_id: str) -> None:
    """One run. `context.job.attempts` counts the attempts already finished, so this one is that plus one.

    `last_attempt` tells `execute` whether Procrastinate would retry a transient failure of this attempt at
    all: `RetryStrategy.get_retry_decision` refuses once `job.attempts >= max_attempts`, using this same
    (pre-attempt) `context.job.attempts`, so the two must agree on the comparison.
    """
    max_attempts = convert_run.retry_strategy.max_attempts
    execute(run_id, attempt=context.job.attempts + 1,
           last_attempt=max_attempts is None or context.job.attempts >= max_attempts)


def chat_for(options: Options) -> Router:
    """The chat completions an extraction talks to: per role, the run's choice of the deployment's models."""
    return chats_for(options)


def execute_extraction(extraction_id: str) -> None:
    """One extraction, with no Procrastinate in sight so that a test can call it directly.

    A transient model-server failure is raised classified, exactly like a conversion's, so the task's retry
    strategy applies; the stages are idempotent and the artifact is rewritten whole. Anything else (no complete
    result to read, a result rewritten since admission, an unreadable model reply, a malformed request) fails
    the extraction directly.

    The generation is the row's, not the directory's: what is on disk when this attempt runs may be a later
    parse of the same source, and extracting from it would answer a client's request with evidence into a
    generation it was never told about.
    """
    row = store.extraction(extraction_id)
    if row is None:
        raise ValueError(f"no extraction {extraction_id} in this store")
    directory = runs.RUNS / row.run_id
    try:
        request = ExtractRequest.model_validate(row.request)
        result = extract(directory, request, chat_for(request.options), generation=row.generation)
        publish_extraction(directory, extraction_id, result)
    except Exception as error:
        message = str(error) if isinstance(error, ValueError) else f"{type(error).__name__}: {error}"
        classified = classify(error)
        try:
            store.extraction_finished(extraction_id, message)
        except Exception as bookkeeping_error:  # noqa: BLE001 - recording the failure must never hide it
            logger.error("extraction %s: could not record the failure (%s); the original error was: %s",
                         extraction_id, bookkeeping_error, message)
        raise classified from error
    try:
        store.extraction_finished(extraction_id, None)
    except store.Unavailable as error:  # the artifact exists; the job's own status says the rest
        logger.error("extraction %s finished but its row could not be stamped: %s", extraction_id, error)


@app.task(name="extract_run", queue=QUEUE, pass_context=True,
          retry=RetryStrategy(max_attempts=2, wait=5, linear_wait=5, retry_exceptions={TransientBackendError}))
def extract_run(context, extraction_id: str) -> None:
    execute_extraction(extraction_id)
