"""What a run is on disk, and the two projections that turn it into what a viewer reads.

A run lives under `runs/<id>/`: its `input.pdf`, its `params.json` (what it was asked for), its `debug/` and
`result/` and, for a run recorded before the durable job backend, its `status.json` and `events.jsonl`. Since
that backend, a run's live status, its events and its timing come from `kei_exp.jobs.store` instead — this
module owns only the files, and the two summaries (`summary_of` for a database run, `summary` for a file-only
one) that project either kind into the one shape `kei_exp.api` serves. Nothing here imports the store: a caller
with no database and no psycopg (a CLI, a batch conversion) must be able to import this module regardless.

Env: KEI_RUNS (run directory, default runs).
"""
from __future__ import annotations

import json
import math
import os
import re
import secrets
from datetime import UTC, datetime
from pathlib import Path

from kei_exp.cut import DEFAULT_LAYOUT_MODEL
from kei_exp.files import load_dotenv, publish
from kei_exp.kie.stages.ocr import resolve
from kei_exp.transcription.types import DEFAULT_URL, Execution, RunParams

load_dotenv()
RUNS = Path(os.environ.get("KEI_RUNS", "runs"))
# Staged source PDFs Studio writes and kei reads only (the source-inbox volume, M4).
INBOX = Path(os.environ.get("KEI_SOURCE_INBOX", "source-inbox"))
TERMINAL = ("done", "failed")
STATUS_OF = {"todo": "queued", "doing": "running", "succeeded": "done", "failed": "failed",
             "cancelled": "cancelled", "aborted": "cancelled"}
UNRECORDED = "Run ended without a recorded status (it was recorded before the job backend, and its API died)"
# One path component: a run or extraction ID; Studio's `RUN_ID` accepts it.
COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def now() -> str:
    return datetime.now(UTC).isoformat()  # microseconds keep runs of one second ordered


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def write_json(path: Path, data: dict) -> None:
    with publish(path) as part:
        part.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def new_id(model: str) -> str:
    return f"{datetime.now(UTC).strftime('%Y%m%d-%H%M%S')}-{model}-{secrets.token_hex(2)}"


def directory_of(run_id: str) -> Path | None:
    """The directory of the run `run_id` names, or None when it names no run of this store.

    A run id is one path component that is not hidden, and it must already have a `params.json`: the refusal
    lives with the layout it protects, rather than in whichever caller reports it."""
    if "/" in run_id or run_id.startswith("."):
        return None
    directory = RUNS / run_id
    return directory if (directory / "params.json").exists() else None


def execution_for(directory: Path, params: dict) -> Execution:
    """The execution a recorded run resolves to now, against the source in its own directory.

    Resolution (the transcriber, native or otherwise) is repeated at execution time rather than stored: it reads
    the PDF's own text layer, and a run that waited in the queue must be judged on what is there when it runs,
    not on what was there when it was submitted.

    `params` is the run's recorded request: the database row that admission committed, not `params.json` on
    disk. The file is a convenience copy for humans and for runs recorded before this backend existed; it is
    deliberately NOT re-read here. A run is bound to one result generation and one recipe fingerprint, and a
    resumed attempt that resolved to a different fingerprint must fail loudly rather than silently produce a
    mixed result — a recipe built from a file that anything could edit between attempts would defeat that
    check, since the drift the check exists to catch would instead be what feeds it.
    """
    pages = params.get("pages")
    request = RunParams(
        pdf=directory / "input.pdf", source_name=params.get("source_name"), model=params.get("model") or "surya",
        url=params.get("url") or DEFAULT_URL, cut=params.get("cut", "auto"),
        layout_model=params.get("layout_model") or DEFAULT_LAYOUT_MODEL, crop_dpi=params.get("crop_dpi") or 250,
        max_image_size=params.get("max_image_size"), max_output_tokens=params.get("max_output_tokens"),
        stream=bool(params.get("stream")), pages=tuple(pages) if pages else None,
        debug_dir=directory / "debug" if params.get("debug") else None, result_dir=directory / "result",
        page_source=params.get("page_source", "pdf"),
        # The ingest runs under the run directory, as `<run>/input/ingest/`: the runner names the document by
        # the PDF's stem, and this run's PDF is `input.pdf`.
        ingest_dir=directory if params.get("page_source") == "ingest" else None, ingest=params.get("ingest"))
    return resolve(request)


def run_tokens(directory: Path) -> tuple[int | None, int | None]:
    """The accepted result's `tokens` totals, each side on its own; absence is not a measured zero."""
    try:
        report = read_json(directory / "result" / "result.json")
    except (OSError, ValueError):
        return None, None
    tokens = report.get("tokens") if isinstance(report, dict) else None
    if not isinstance(tokens, dict):
        return None, None
    input_tokens, output_tokens = tokens.get("input"), tokens.get("output")
    return (input_tokens if type(input_tokens) is int and input_tokens >= 0 else None,
            output_tokens if type(output_tokens) is int and output_tokens >= 0 else None)


def _legacy_duration(status: dict) -> float | None:
    """Recover only trustworthy timezone-aware wall-clock intervals from older runs."""
    try:
        started = datetime.fromisoformat(status["started"])
        finished = datetime.fromisoformat(status["finished"])
        if started.utcoffset() is None or finished.utcoffset() is None:
            return None
        seconds = (finished - started).total_seconds()
        return seconds if math.isfinite(seconds) and seconds >= 0 else None
    except (KeyError, TypeError, ValueError, OverflowError):
        return None


def _params_summary(params: dict, directory: Path) -> dict:
    """The fields of a summary that come from what the run was asked for, shared by both kinds of run."""
    return {
        "id": directory.name, "created": params.get("created"),
        "transcriber": params.get("transcriber"), "model": params.get("model"),
        "cut": params.get("cut"), "crop_dpi": params.get("crop_dpi"), "layout_model": params.get("layout_model"),
        "source_name": params.get("source_name"), "pages": params.get("pages"),
        "page_count": params.get("page_count"), "page_source": params.get("page_source", "pdf"),
        "has_output": (directory / "output.md").exists(),
    }


def summary_of(row) -> dict:
    """A run of the store, projected into the shape the viewer already reads.

    `row` is duck-typed (a `kei_exp.jobs.store.RunRow`, but this module never imports that module).
    Its fields come from the newest attempt and the job serving it. Both elapsed time and step timings are
    persisted by the worker, so the API can read them during execution and after either process restarts.
    """
    directory = RUNS / row.id
    input_tokens, output_tokens = run_tokens(directory)
    status = "cancelling" if row.cancel_requested and row.job_status in ("todo", "doing") \
        else STATUS_OF.get(row.job_status or "", "unknown")
    return {
        **_params_summary(row.params, directory),
        "status": status, "error": row.error if status == "failed" else None,
        "duration_seconds": row.duration_seconds, "step_timings": row.step_timings, "current_step": row.current_step,
        "input_tokens": input_tokens, "output_tokens": output_tokens,
    }


def summary(directory: Path) -> dict | None:
    """A run of the files alone: everything recorded before the job backend. Never rewritten."""
    if not is_legacy(directory):
        return None
    params = read_json(directory / "params.json")
    if not params:
        return None
    status = read_json(directory / "status.json")
    if status.get("status") not in TERMINAL:  # its API died and never wrote a finish; say so rather than hang
        status = {**status, "status": "failed", "error": UNRECORDED}
    if "input_tokens" not in status and "output_tokens" not in status:
        input_tokens, output_tokens = run_tokens(directory)
    else:
        input_tokens, output_tokens = status.get("input_tokens"), status.get("output_tokens")
    return {
        **_params_summary(params, directory),
        "status": status.get("status", "unknown"), "error": status.get("error"),
        "duration_seconds": (status.get("duration_seconds") if status.get("duration_seconds") is not None
                             else _legacy_duration(status)),
        "step_timings": status.get("step_timings"), "current_step": None,
        "input_tokens": input_tokens, "output_tokens": output_tokens,
    }


def is_legacy(directory: Path) -> bool:
    """Only the old backend wrote these files; params.json alone also belongs to durable admissions."""
    return (directory / "status.json").is_file() or (directory / "events.jsonl").is_file()
