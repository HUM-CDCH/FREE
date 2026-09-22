"""The command line of the KIE pipeline: one config file, one PDF, one run (spec 5).

Contract: `docs/superpowers/specs/2026-09-14-kie-model-and-ingest-design.md` section 5 and the canonical evidence
design §7. Vocabulary: `CONTEXT.md`. This module is the boundary where a YAML mapping becomes a `PipelineConfig`:
nothing below it ever sees a dict, so a misspelled key is refused here rather than ignored inside a stage.

Exit codes, because a caller in a shell has only these three to read:

    0  the run finished, whether the ingest ran or was skipped
    1  the run started and failed: the ingest, the run directory, or OCR
    2  the invocation was wrong: bad arguments, an unreadable file, a config that does not validate
"""

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Final

import yaml
from pydantic import ValidationError

from kei_exp.kie.model import EvidenceReport, IngestStep, PipelineConfig, RunReport
from kei_exp.kie.runner import (
    REPORT_NAME,
    RUNS_ROOT,
    RunError,
    document_dir,
    run,
    validate_run_id,
)

EXIT_OK: Final = 0
EXIT_FAILED: Final = 1
EXIT_USAGE: Final = 2


class UsageError(Exception):
    """An invocation this command refuses before any run begins: an argument, a file, or a config."""


def main(argv: Sequence[str] | None = None) -> int:
    """Run one pipeline invocation and return its exit code. `argv` is a parameter so a test can drive it."""
    args = _parse_args(argv)
    try:
        cfg = _load_config(args.config)
        pdf = _source_pdf(args.pdf)
        run_id = _run_id(args.run_id)
    except UsageError as error:
        return _fail(error, EXIT_USAGE)
    try:
        report = run(pdf, cfg, run_id=run_id, runs_root=args.runs_root)
    except (RunError, OSError) as error:
        # Every refusal the stages or the evidence reader make arrives as a `RunError`: the runner wraps them,
        # so catching those here as well would be a handler nothing can reach.
        return _fail(error, EXIT_FAILED)
    _summarise(report, args.runs_root)
    return EXIT_OK


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    """The arguments of the `run` subcommand. argparse exits 2 on its own for anything wrong here."""
    parser = argparse.ArgumentParser(prog="kie", description="Run the KIE pipeline over one scanned catalogue")
    commands = parser.add_subparsers(dest="command", required=True)
    runner = commands.add_parser("run", help="Ingest one PDF and run OCR over its book pages")
    runner.add_argument("--config", type=Path, required=True, help="Pipeline config, YAML (see configs/phase1.yaml)")
    runner.add_argument("--pdf", type=Path, required=True, help="The scanned catalogue to read")
    runner.add_argument("--run-id", help="Reuse this run directory, which is how a run resumes from its cache")
    runner.add_argument("--runs-root", type=Path, default=RUNS_ROOT,
                        help=f"Where run directories live (default: {RUNS_ROOT}); an API run's ingest is under "
                             "runs/<id>/input/ingest, so --runs-root runs --run-id <id> resumes it")
    return parser.parse_args(argv)


def _load_config(path: Path) -> PipelineConfig:
    """The config file as a validated `PipelineConfig`, or `UsageError` naming what is wrong with it.

    The parsed mapping goes no further than this function. Validating it here means an unknown key or a
    threshold out of range is a config error with a line the reader can fix, rather than a default silently
    taking its place somewhere downstream.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        # `UnicodeDecodeError` is a `ValueError`, not an `OSError`: a config in another encoding is still a
        # file this command cannot read, and exit 2 rather than a traceback.
        raise UsageError(f"the config {path} cannot be read: {error}") from error
    try:
        document = yaml.safe_load(text)
    except yaml.YAMLError as error:
        raise UsageError(f"the config {path} is not valid YAML: {error}") from error
    if not isinstance(document, dict):
        raise UsageError(f"the config {path} must hold a mapping at its top level, not {type(document).__name__}")
    try:
        return PipelineConfig.model_validate(document)
    except ValidationError as error:
        raise UsageError(f"the config {path} is not a valid pipeline config: {error}") from error


def _source_pdf(path: Path) -> Path:
    """The PDF to read. A path that is not a file is an argument error, before any run directory is made."""
    if not path.is_file():
        raise UsageError(f"the pdf {path} is not a file")
    return path


def _run_id(given: str | None) -> str | None:
    """The `--run-id` as given, refused here as an argument error rather than as a failed run.

    The rule lives with the run layout it protects, so this asks the runner and only changes what kind of
    error a person at a shell gets: nothing about the run has started when a run id is rejected.
    """
    if given is None:
        return None
    try:
        return validate_run_id(given)
    except RunError as error:
        raise UsageError(error) from error


def _summarise(report: RunReport, runs_root: Path) -> None:
    """One line for the ingest, one for OCR when it ran, and the report path, which is where
    everything this prints is also recorded."""
    print(_ingest_line(report.ingest))
    if report.ocr is not None:
        print(_ocr_line(report.ocr))
    print(f"report: {document_dir(runs_root, report.run_id, report.doc_id) / REPORT_NAME}")


def _ingest_line(step: IngestStep) -> str:
    """What the ingest did. On a skip the counts are the ones stored when it last ran; the seconds are this run's."""
    did = "skipped" if step.skipped else "ran"
    return (f"ingest: {did} in {step.seconds:.2f}s, {_plural(step.report.pages_written, 'page')} from "
            f"{_plural(step.report.spreads_read, 'spread')}")


def _ocr_line(report: EvidenceReport) -> str:
    return (f"ocr: {_plural(report.segments, 'segment')} from {_plural(report.pages_read, 'page file')}, "
            f"{len(report.rejected)} rejected, generation {report.generation}")


def _plural(count: int, noun: str) -> str:
    """A counted noun, because a summary line a person reads should not say "1 pages"."""
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def _fail(error: Exception | str, code: int) -> int:
    """Report a failure on stderr and hand its exit code back to `main`, which is the only caller."""
    print(f"kie: {error}", file=sys.stderr)
    return code
