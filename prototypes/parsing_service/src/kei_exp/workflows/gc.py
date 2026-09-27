"""kei `deleteRuns`: remove the run directories and kei workflow history Studio's collectGarbage found unreferenced.

Studio decides what is unreferenced; kei never reads Studio's schemas. Studio names conversions; kei derives their runs
(runs.run_id_for), so a run whose conversion failed after prepare_run published it is found too. kei rechecks its own
workflows: a run goes only when every kei workflow that writes it has ended and can no longer write, and nothing in it
was written for 24 h. A conversion's history goes only once its run is gone, because that history is the only index
through which Studio can name the run; other kei history Studio names goes once its workflow can no longer write.
SUCCESS and ERROR ended with their steps. CANCELLED (explicit or deadline) and MAX_RECOVERY_ATTEMPTS_EXCEEDED can
leave a native step writing until the kei process that ran it exits: such a workflow counts only once its updated_at
(database clock) precedes this process's boot timestamp (boot.py). Every status is read before anything is deleted,
so a failed read deletes nothing and ends the workflow ERROR; Studio's next schedule asks again.
"""
from __future__ import annotations

import logging
import shutil
import time
from pathlib import Path

from dbos import DBOS, WorkflowSerializationFormat
from pydantic import ValidationError

from kei_exp import runs
from kei_exp.workflows import boot
from kei_exp.workflows.contracts import EXTRACT_PREFIX, DeleteRunsInput, DeleteRunsOk, failure

logger = logging.getLogger(__name__)
ENDED = frozenset({"SUCCESS", "ERROR"})
STOPPED = frozenset({"CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"})
LIVE = ("ENQUEUED", "PENDING", "DELAYED")
MIN_AGE_SECONDS = 24 * 3600
PREPARE, DELETING = ".prepare-", ".deleting-"  # convert.prepare_run's staging; a run being removed
UNREADABLE = (OSError, ValueError)  # a corrupt params.json, a file gone during the walk


def eligible(status, boot_ms: int) -> bool:
    """Whether a kei workflow can no longer write. An absent one (history already deleted) cannot."""
    if status is None or status.status in ENDED:
        return True
    if status.status in STOPPED:
        return status.updated_at is not None and status.updated_at < boot_ms
    return False


def _may_write(name: str, boot_ms: int, *, load_input: bool) -> list:
    """The `name` workflows that may still write: live, or stopped at or after this boot."""
    found = DBOS.list_workflows(name=name, status=[*LIVE, *STOPPED], load_input=load_input, load_output=False)
    return [status for status in found if not eligible(status, boot_ms)]


def _run_named(status) -> str | None:
    """The run an `extract` workflow's input names; None for an input that names none (it fails validation)."""
    args = (status.input or {}).get("args") or ()
    request = args[0] if args else None
    return request.get("run_id") if isinstance(request, dict) else None


def _still_extracting(boot_ms: int) -> set[str]:
    """Runs an `extract` workflow that may still write reads. It may not have published anything under the run yet,
    so the run directory cannot tell."""
    return {run_id for status in _may_write("extract", boot_ms, load_input=True)
            if (run_id := _run_named(status)) is not None}


def _still_converting(boot_ms: int) -> set[str]:
    """Runs a `convert` workflow that may still write prepares: its `.prepare-<run>` staging is still in use."""
    return {runs.run_id_for(status.workflow_id) for status in _may_write("convert", boot_ms, load_input=False)}


def _writers(directory: Path) -> list[str]:
    """The kei workflows that wrote this run: its conversion (params.json) and every published extraction."""
    params = runs.read_json(directory / "params.json")
    if not isinstance(params, dict):
        raise ValueError("params.json holds no object")  # noqa: TRY004 - bad file content, as for bad JSON
    workflow_id = params.get("workflow_id")
    if workflow_id is not None and not isinstance(workflow_id, str):
        raise ValueError("params.json names no workflow")
    found = [workflow_id] if workflow_id else []
    extractions = directory / "extractions"
    if extractions.is_dir():
        found += [f"{EXTRACT_PREFIX}{entry.name}" for entry in sorted(extractions.iterdir()) if entry.is_dir()]
    return found


def _last_write(directory: Path) -> float:
    # Directory mtimes suffice: kei writes every file of a run by publish-by-rename (files.publish, the renamed result
    # and extraction directories), and creating the sibling and renaming it both change the directory's mtime. A
    # writer that may still be inside a long write is caught by its status, not by this age.
    return max(path.stat().st_mtime for path in [directory, *directory.rglob("*")] if path.is_dir())


def _statuses(workflow_ids: list[str]) -> dict:
    if not workflow_ids:
        return {}
    return {status.workflow_id: status
            for status in DBOS.list_workflows(workflow_ids=workflow_ids, load_input=False, load_output=False)}


def _remove(directory: Path) -> None:
    """Gone once renamed; an OSError means the run is still in place. What the removal leaves behind is swept by the
    next execution."""
    doomed = runs.RUNS / f"{DELETING}{directory.name}"  # hidden: runs.directory_of refuses it at once
    directory.rename(doomed)
    shutil.rmtree(doomed, ignore_errors=True)
    if doomed.exists():
        logger.warning("run %s is deleted; part of %s is left for the next deleteRuns", directory.name, doomed.name)


def _unreadable(run_id: str) -> None:
    logger.warning("keeping run %s: its directory could not be read", run_id)


@DBOS.step(name="delete_runs")
def delete_runs(request: dict) -> dict:
    boot_ms = boot.timestamp_ms()
    conversions = list(dict.fromkeys(request["conversions"]))
    history = list(dict.fromkeys(request["history"]))
    run_of = {conversion: runs.run_id_for(conversion) for conversion in conversions}
    requested = list(dict.fromkeys(run_of.values()))
    # Read every status first. The staging directories are listed before the conversions are read: one created later
    # belongs to a conversion that is live now, and is never in this list. A run whose directory cannot be read is
    # kept and never stops the others: Studio asks for it again on every schedule.
    staged = sorted(runs.RUNS.glob(f"{PREPARE}*"))
    converting, extracting = _still_converting(boot_ms), _still_extracting(boot_ms)
    writers, unreadable = {}, set()
    for run_id in requested:
        if (runs.RUNS / run_id).exists():
            try:
                writers[run_id] = _writers(runs.RUNS / run_id)
            except UNREADABLE:
                unreadable.add(run_id)
    statuses = _statuses(sorted({*history, *conversions, *(wid for found in writers.values() for wid in found)}))
    young = time.time() - MIN_AGE_SECONDS

    # Then delete. A run already gone was removed by an earlier execution of this step, or never written.
    for leftover in runs.RUNS.glob(f"{DELETING}*"):  # renamed by an earlier execution that stopped mid-removal
        shutil.rmtree(leftover, ignore_errors=True)
    for leftover in staged:
        if leftover.name.removeprefix(PREPARE) not in converting:
            logger.info("removing %s, left by a conversion that can no longer write", leftover.name)
            shutil.rmtree(leftover, ignore_errors=True)
    deleted_runs, kept_runs = [], []
    for run_id in requested:
        if run_id in unreadable:
            _unreadable(run_id)
            kept_runs.append(run_id)
            continue
        if run_id in writers:
            if run_id in extracting or not all(eligible(statuses.get(wid), boot_ms) for wid in writers[run_id]):
                kept_runs.append(run_id)  # a kei workflow may still write it; checked before the walk below
                continue
            try:
                recent = _last_write(runs.RUNS / run_id) > young
            except UNREADABLE:
                _unreadable(run_id)
                kept_runs.append(run_id)
                continue
            if recent:
                kept_runs.append(run_id)
                continue
            try:
                _remove(runs.RUNS / run_id)
            except OSError:
                logger.warning("keeping run %s: it could not be removed", run_id)
                kept_runs.append(run_id)
                continue
        deleted_runs.append(run_id)
    deleted_history = [wid for wid in history if eligible(statuses.get(wid), boot_ms)]
    # A conversion's history is its run's only index (Studio never derives a run ID), so it goes only once the run is.
    deleted_history += [conversion for conversion in conversions
                        if not (runs.RUNS / run_of[conversion]).exists() and eligible(statuses.get(conversion), boot_ms)]
    kept_history = [wid for wid in [*history, *conversions] if wid not in deleted_history]
    if deleted_history:
        DBOS.delete_workflows(deleted_history)
    logger.info("deleted runs %s, kept runs %s; deleted history %s, kept history %s",
                deleted_runs, kept_runs, deleted_history, kept_history)
    return DeleteRunsOk(ok=True, deleted_runs=deleted_runs, kept_runs=kept_runs, deleted_history=deleted_history,
                        kept_history=kept_history).model_dump()


@DBOS.workflow(name="deleteRuns", serialization_type=WorkflowSerializationFormat.PORTABLE)
def delete_runs_workflow(request: dict) -> dict:
    try:
        parsed = DeleteRunsInput.model_validate(request)
    except ValidationError as error:
        return failure("invalid_request", str(error), retryable=False)
    return delete_runs(parsed.model_dump())
