"""Short-lived native parser process used by the parse worker."""

from __future__ import annotations

import argparse
import datetime
import os
from pathlib import Path

from app.models.parser_output import ParserRun
from app.parsing import orchestrator
from app.parsing.orchestrator import (
    CanonicalIngestionError,
    build_canonical_generation,
)
from app.storage import paths
from app.storage.atomic_json import write_json_atomic
from app.storage.manifests import load_task_metadata
from app.workers._attempt_diagnostics import AttemptTracker
from app.workers._task_state import GENERIC_PARSING_ERROR


def _under_service(path: str) -> Path:
    resolved = Path(path).resolve()
    if not resolved.is_relative_to(paths.SERVICE_ROOT.resolve()):
        raise ValueError("Parser child paths must stay inside the parsing service.")
    return resolved


def _failure_payload(exc: Exception) -> dict[str, object]:
    if isinstance(exc, CanonicalIngestionError):
        code = exc.code
        message = exc.public_message
        parser_runs: list[ParserRun] = exc.parser_runs
    else:
        code = "parsing_failed"
        message = GENERIC_PARSING_ERROR
        parser_runs = []
    return {
        "status": "failed",
        "error_code": code,
        "public_message": message,
        "parser_runs": [run.model_dump(mode="json") for run in parser_runs],
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--task-root", required=True)
    parser.add_argument("--source-path", required=True)
    parser.add_argument("--artifact-root", required=True)
    parser.add_argument("--result-path", required=True)
    return parser


def main() -> int:
    args = _parser().parse_args()
    fixed_utc_now = os.environ.get("FREE_PARSER_REPLAY_UTC_NOW")
    if fixed_utc_now is not None:
        datetime.datetime.fromisoformat(fixed_utc_now)
        orchestrator.utc_now = lambda: fixed_utc_now
    task_root = _under_service(args.task_root)
    source_path = _under_service(args.source_path)
    artifact_root = _under_service(args.artifact_root)
    result_path = _under_service(args.result_path)
    if not source_path.is_file():
        raise ValueError("Parser child source is unavailable.")

    paths.DEFAULT_DATA_DIR = task_root
    task_dir = paths.task_dir_for(args.task_id)
    metadata = load_task_metadata(task_dir)
    tracker = AttemptTracker(task_dir, metadata)
    tracker.start()
    try:
        built = build_canonical_generation(
            args.task_id,
            source_path=source_path,
            artifact_root=artifact_root,
            phase_observer=tracker.observe,
        )
        write_json_atomic(
            result_path,
            {
                "status": "completed",
                "document": built.document.model_dump(mode="json"),
                "generation_manifest": built.generation_manifest,
            },
        )
        tracker.stop_sampling()
        return 0
    except Exception as exc:
        tracker.finish_failure(exc)
        write_json_atomic(result_path, _failure_payload(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
