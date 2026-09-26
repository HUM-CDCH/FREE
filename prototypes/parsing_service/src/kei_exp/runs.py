"""What a run is on disk: `runs/<id>/` holds `input.pdf`, `params.json` (the request `prepare_run` recorded),
`result/`, `extractions/` and, when asked for, `debug/`. `INBOX` is where Studio stages sources.

Light on purpose: the slot lock (`workflows/slot.py`) imports this module before it takes the lock, so a second
worker is refused before it loads the model stack; `execution_for` imports the conversion stages when called.

Env: KEI_RUNS (run directory, default runs), KEI_SOURCE_INBOX.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING

from kei_exp.files import load_dotenv, publish

if TYPE_CHECKING:
    from kei_exp.transcription.types import Execution

load_dotenv()
RUNS = Path(os.environ.get("KEI_RUNS", "runs"))
# Staged source PDFs Studio writes and kei reads only (the source-inbox volume, M4).
INBOX = Path(os.environ.get("KEI_SOURCE_INBOX", "source-inbox"))
# One path component: a run or extraction ID; Studio's `RUN_ID` accepts it. Match it with `fullmatch`, never `match`:
# `$` also matches before a trailing newline.
COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def now() -> str:
    return datetime.now(UTC).isoformat()  # microseconds keep runs of one second ordered


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def write_json(path: Path, data: dict) -> None:
    with publish(path) as part:
        part.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def run_id_for(workflow_id: str) -> str:
    """The run a `convert` workflow writes: derived from its ID, so a re-executed prepare_run rebuilds the same
    directory instead of orphaning one, and one path component Studio's RUN_ID accepts."""
    return "run-" + hashlib.sha256(workflow_id.encode()).hexdigest()[:24]


def directory_of(run_id: str) -> Path | None:
    """The directory of the run `run_id` names, or None when it names no run of this store.

    A run id is one path component that is not hidden (`COMPONENT`), and it must already have a `params.json`: the
    refusal lives with the layout it protects, rather than in whichever caller reports it."""
    if not COMPONENT.fullmatch(run_id):
        return None
    directory = RUNS / run_id
    return directory if (directory / "params.json").exists() else None


def execution_for(directory: Path, params: dict) -> Execution:
    """The execution a recorded run resolves to now, against the source in its own directory.

    Resolution (the transcriber, native or otherwise) is repeated at execution time rather than stored: it reads
    the PDF's own text layer, and a run that waited in the queue must be judged on what is there when it runs, not on
    what was there when it was submitted.

    `params` is the run's recorded request: what `prepare_run` returned and DBOS checkpointed, not `params.json` on
    disk. The file is a copy for humans and for `deleteRuns`; it is deliberately NOT re-read here. A run is bound to
    one result generation and one recipe fingerprint, and a recipe built from a file that anything could edit
    between attempts would feed the very drift the fingerprint check exists to catch.
    """
    from kei_exp.kie.stages.ocr import resolve  # the conversion stages load the model stack
    from kei_exp.transcription.types import DEFAULT_URL, RunParams

    pages = params.get("pages")
    request = RunParams(
        pdf=directory / "input.pdf", source_name=params.get("source_name"), model=params["model"],
        url=params.get("url") or DEFAULT_URL, cut=params.get("cut", "auto"),
        layout_model=params["layout_model"], crop_dpi=params.get("crop_dpi") or 250,
        max_image_size=params.get("max_image_size"), max_output_tokens=params.get("max_output_tokens"),
        stream=bool(params.get("stream")), pages=tuple(pages) if pages else None,
        debug_dir=directory / "debug" if params.get("debug") else None, result_dir=directory / "result",
        page_source=params.get("page_source", "pdf"),
        # The ingest runs under the run directory, as `<run>/input/ingest/`: the runner names the document by
        # the PDF's stem, and this run's PDF is `input.pdf`.
        ingest_dir=directory if params.get("page_source") == "ingest" else None, ingest=params.get("ingest"))
    return resolve(request)
