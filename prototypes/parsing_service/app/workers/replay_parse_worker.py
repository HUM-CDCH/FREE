"""Replay retained Source Documents through the complete parsing worker path."""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import os
import shutil
import subprocess
import sys
import traceback
import uuid
from pathlib import Path
from unittest.mock import patch

from app.storage import paths
from app.storage.atomic_json import read_json, write_json_atomic
from app.storage.canonical_package import assemble_task_package
from app.storage.hashing import compute_sha256
from app.storage.manifests import (
    load_task_metadata,
    read_committed_markdown,
    read_parsed_document,
    save_task_metadata,
)
from app.storage.paths import SERVICE_ROOT, task_dir_for
from app.timing import utc_now
from app.workers import parse_worker
from app.workers._attempt_diagnostics import (
    ATTEMPT_METRICS_FILENAME,
    duration_ms,
)
from app.workers._parser_supervisor import SupervisedProcess
from app.workers._task_state import new_task_metadata

_CASES = ("fresh", "after-preceding", "repeated")
_FIXED_CREATED_AT = "2000-01-01T00:00:00+00:00"
_EXPECTED_TARGET_HASHES = 4


def _source(path: str) -> Path:
    source = Path(path).resolve()
    if not source.is_file() or source.is_symlink():
        raise ValueError("Replay input must be a regular Source Document.")
    with source.open("rb") as stream:
        if stream.read(5) != b"%PDF-":
            raise ValueError("Replay input must be a PDF Source Document.")
    return source


def _output_root(value: str | None) -> Path:
    if value is None:
        timestamp = datetime.datetime.now(datetime.timezone.utc).strftime(
            "%Y%m%dT%H%M%SZ"
        )
        output = SERVICE_ROOT / "data" / "replays" / f"{timestamp}-{uuid.uuid4().hex[:8]}"
    else:
        candidate = Path(value)
        output = candidate if candidate.is_absolute() else SERVICE_ROOT / candidate
    output = output.resolve()
    if not output.is_relative_to(SERVICE_ROOT.resolve()):
        raise ValueError("Replay output must stay inside the parsing service.")
    output.mkdir(parents=True, exist_ok=True)
    return output


def _jobs(case: str, target: Path, preceding: Path) -> list[tuple[str, Path]]:
    if case == "fresh":
        return [("target", target)]
    if case == "after-preceding":
        return [("preceding", preceding), ("target", target)]
    return [("target-1", target), ("target-2", target)]


async def _run_job(
    case_dir: Path,
    tasks_dir: Path,
    index: int,
    label: str,
    source: Path,
    ocr_device: str,
) -> dict[str, object]:
    job_dir = case_dir / f"job-{index:02d}-{label}"
    source_store = job_dir / "sources"
    document_store = job_dir / "documents"
    task_id = str(uuid.uuid4())

    with (
        patch.object(paths, "DEFAULT_DATA_DIR", tasks_dir),
        patch.object(paths, "DEFAULT_SOURCE_STORE_DIR", source_store),
        patch.object(paths, "DEFAULT_DOCUMENT_STORE_DIR", document_store),
        patch.object(parse_worker, "DEFAULT_DATA_DIR", tasks_dir),
        patch.dict(
            os.environ,
            {"FREE_PARSER_REPLAY_UTC_NOW": _FIXED_CREATED_AT},
        ),
    ):
        task_dir = task_dir_for(task_id)
        task_dir.mkdir(parents=True)
        task_source = task_dir / paths.SOURCE_FILENAME
        shutil.copyfile(source, task_source)
        queued_at = utc_now()
        metadata = new_task_metadata(
            task_id=task_id,
            content_sha256=compute_sha256(task_source),
            source_name="replay.pdf",
            resolved_ocr_device=ocr_device,
            queued_at=_FIXED_CREATED_AT,
        )
        metadata["replay_label"] = label
        metadata["attempt"]["queued_at"] = queued_at
        metadata["updated_at"] = queued_at
        save_task_metadata(task_dir, metadata)

        await parse_worker.run_extraction_task(task_id)
        metadata = load_task_metadata(task_dir)
        package_sha256 = None
        package_error = None
        if metadata["status"] == "completed":
            try:
                document = read_parsed_document(task_dir)
                markdown = read_committed_markdown(task_dir, document)
                package, lease = assemble_task_package(
                    task_dir,
                    document,
                    markdown,
                    task_id=task_id,
                )
                try:
                    package_sha256 = compute_sha256(package)
                finally:
                    lease.release()
            except Exception as exc:
                package_error = type(exc).__name__

    attempt = metadata["attempt"]
    failure = attempt.get("failure")
    return {
        "label": label,
        "status": metadata["status"],
        "error_code": metadata.get("error_code"),
        "diagnostic_id": metadata["diagnostic_id"],
        "queue_delay_ms": duration_ms(
            attempt.get("queued_at"), attempt.get("started_at")
        ),
        "total_duration_ms": duration_ms(
            attempt.get("started_at"), attempt.get("finished_at")
        ),
        "phases": attempt.get("phases", {}),
        "worker": attempt.get("worker", {}),
        "failure": (
            {
                "exception_type": failure.get("exception_type"),
                "failing_phase": failure.get("failing_phase"),
            }
            if isinstance(failure, dict)
            else None
        ),
        "package_sha256": package_sha256,
        "package_error": package_error,
    }


async def _run_case(
    case: str,
    target: Path,
    preceding: Path,
    case_dir: Path,
    ocr_device: str,
) -> int:
    tasks_dir = case_dir / "tasks"
    report: dict[str, object] = {"case": case, "jobs": []}
    try:
        for index, (label, source) in enumerate(
            _jobs(case, target, preceding), start=1
        ):
            job = await _run_job(
                case_dir,
                tasks_dir,
                index,
                label,
                source,
                ocr_device,
            )
            report["jobs"].append(job)
            write_json_atomic(case_dir / "case-report.json", report)
    except Exception as exc:
        report["exception_type"] = f"{type(exc).__module__}.{type(exc).__qualname__}"
        report["traceback"] = "".join(
            traceback.format_exception(type(exc), exc, exc.__traceback__)
        )
        write_json_atomic(case_dir / "case-report.json", report)
        return 1
    return int(
        any(
            job.get("status") != "completed" or job.get("package_error") is not None
            for job in report["jobs"]
        )
    )


def _partial_jobs(case_dir: Path) -> list[dict[str, object]]:
    jobs = []
    tasks_dir = case_dir / "tasks"
    for metadata_path in sorted(tasks_dir.glob("*/metadata.json")):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            attempt = metadata["attempt"]
        except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
            continue
        worker = attempt.get("worker", {})
        try:
            metrics = read_json(
                metadata_path.parent / ATTEMPT_METRICS_FILENAME
            )
            if (
                metrics.get("diagnostic_id") == metadata.get("diagnostic_id")
                and isinstance(metrics.get("worker"), dict)
            ):
                worker = metrics["worker"]
        except (OSError, ValueError):
            pass
        jobs.append(
            {
                "label": metadata.get("replay_label"),
                "status": metadata.get("status"),
                "error_code": metadata.get("error_code"),
                "diagnostic_id": metadata.get("diagnostic_id"),
                "queue_delay_ms": duration_ms(
                    attempt.get("queued_at"), attempt.get("started_at")
                ),
                "total_duration_ms": duration_ms(
                    attempt.get("started_at"), attempt.get("finished_at")
                ),
                "current_phase": attempt.get("current_phase"),
                "phases": attempt.get("phases", {}),
                "worker": worker,
            }
        )
    return jobs


def _run_case_process(
    case: str,
    target: Path,
    preceding: Path,
    output: Path,
    ocr_device: str,
    deadline_seconds: int,
) -> dict[str, object]:
    case_dir = output / case
    case_dir.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        "-m",
        "app.workers.replay_parse_worker",
        "--_case",
        case,
        "--target",
        str(target),
        "--preceding",
        str(preceding),
        "--output-dir",
        str(output),
        "--ocr-device",
        ocr_device,
    ]
    started = datetime.datetime.now(datetime.timezone.utc)
    with (
        (case_dir / "stdout.log").open("wb") as stdout,
        (case_dir / "stderr.log").open("wb") as stderr,
    ):
        child = SupervisedProcess(
            command,
            cwd=SERVICE_ROOT,
            env={
                **os.environ,
                "FREE_PARSER_DEADLINE_SECONDS": str(deadline_seconds),
            },
            stdout=stdout,
            stderr=stderr,
        )
        deadline_exceeded = False
        case_deadline_seconds = (
            deadline_seconds * len(_jobs(case, target, preceding)) + 30
        )
        try:
            exit_code = child.process.wait(timeout=case_deadline_seconds)
        except subprocess.TimeoutExpired:
            deadline_exceeded = True
            exit_code = None
        finally:
            child.terminate_tree()
    finished = datetime.datetime.now(datetime.timezone.utc)
    report_path = case_dir / "case-report.json"
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        report = {"case": case, "jobs": _partial_jobs(case_dir)}
    if deadline_exceeded and isinstance(report.get("jobs"), list):
        known_diagnostics = {
            job.get("diagnostic_id")
            for job in report["jobs"]
            if isinstance(job, dict)
        }
        report["jobs"].extend(
            job
            for job in _partial_jobs(case_dir)
            if job.get("diagnostic_id") not in known_diagnostics
        )
    report["process_exit_code"] = exit_code
    report["deadline_exceeded"] = deadline_exceeded
    report["case_deadline_seconds"] = case_deadline_seconds
    report["process_duration_ms"] = int((finished - started).total_seconds() * 1000)
    return report


def _summary(reports: list[dict[str, object]]) -> dict[str, object]:
    target_hashes: list[str] = []
    cases = []
    for report in reports:
        jobs = report.get("jobs", [])
        case_jobs = []
        for job in jobs if isinstance(jobs, list) else []:
            if not isinstance(job, dict):
                continue
            package_hash = job.get("package_sha256")
            if isinstance(package_hash, str) and str(job.get("label", "")).startswith(
                "target"
            ):
                target_hashes.append(package_hash)
            case_jobs.append(
                {
                    "label": job.get("label"),
                    "status": job.get("status"),
                    "error_code": job.get("error_code"),
                    "queue_delay_ms": job.get("queue_delay_ms"),
                    "total_duration_ms": job.get("total_duration_ms"),
                    "phase_duration_ms": {
                        phase: details.get("duration_ms")
                        for phase, details in job.get("phases", {}).items()
                        if isinstance(details, dict)
                    },
                    "worker": job.get("worker"),
                    "package_sha256": package_hash,
                }
            )
        cases.append(
            {
                "case": report.get("case"),
                "process_exit_code": report.get("process_exit_code"),
                "deadline_exceeded": report.get("deadline_exceeded"),
                "jobs": case_jobs,
            }
        )
    return {
        "target_package_hashes_match": len(target_hashes) == _EXPECTED_TARGET_HASHES
        and len(set(target_hashes)) == 1,
        "cases": cases,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Replay the complete parse-worker and publication path."
    )
    parser.add_argument("--target", required=True)
    parser.add_argument("--preceding", required=True)
    parser.add_argument("--output-dir")
    parser.add_argument("--ocr-device", default="cpu")
    parser.add_argument(
        "--deadline-seconds",
        type=int,
        default=600,
        help="deadline budget per parse job (default: 600)",
    )
    parser.add_argument("--_case", choices=_CASES, help=argparse.SUPPRESS)
    return parser


def main() -> int:
    args = _parser().parse_args()
    if args.deadline_seconds < 1:
        raise SystemExit("--deadline-seconds must be positive")
    target = _source(args.target)
    preceding = _source(args.preceding)
    output = _output_root(args.output_dir)
    if args._case:
        return asyncio.run(
            _run_case(args._case, target, preceding, output / args._case, args.ocr_device)
        )

    reports = [
        _run_case_process(
            case,
            target,
            preceding,
            output,
            args.ocr_device,
            args.deadline_seconds,
        )
        for case in _CASES
    ]
    summary = _summary(reports)
    write_json_atomic(
        output / "replay-report.json",
        {"summary": summary, "reports": reports},
    )
    print(json.dumps({"report": str(output / "replay-report.json"), **summary}, indent=2))
    return int(
        not summary["target_package_hashes_match"]
        or any(
            report.get("process_exit_code") != 0
            or report.get("deadline_exceeded") is True
            for report in reports
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
