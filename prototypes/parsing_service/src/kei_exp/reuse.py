"""Work another run already did: its verified result of the same recipe adopted, its proven ingest of the same
recipe seeded, so a second parse of the same PDF bytes with the same effective settings does not run OCR again.

Candidates are found by scanning `runs.RUNS`: no index, and no lock, so two concurrent runs of one PDF may both do
the work. A candidate is never trusted: a result must load complete with a recipe that hashes to the fingerprint
asked for, an ingest must be proven by `load_ingest`, and anything less is passed over, so at worst the work is done.
What is taken is copied (page files rewritten under this run's generation, ingest images hard-linked), so nothing
here depends on the candidate afterwards and `deleteRuns` needs no rule for it.

Reuse is as fresh as the recipe: a change to what the cut or a transcriber writes for the same inputs must bump
`RESULT_VERSION` or the text rules, as the recipe already requires, or reuse returns the earlier output. The worker
binds these to a run (`workflows/convert.py`); the standalone CLI reuses nothing.
"""
import errno
import json
import logging
import os
import shutil
from collections.abc import Iterator
from pathlib import Path

from kei_exp import pagefile, result, runs
from kei_exp.files import publish
from kei_exp.kie import artifacts
from kei_exp.kie.ingest_cache import IngestPaths
from kei_exp.kie.ingest_model import IngestConfig
from kei_exp.kie.stages import ingest

logger = logging.getLogger(__name__)


def candidates(source_sha256: str, *, own: Path) -> Iterator[Path]:
    """The other runs whose `params.json` names `source_sha256`, by name. A hidden directory (a run being prepared
    or deleted) is no run, and one whose `params.json` cannot be read is passed over."""
    for directory in sorted(runs.RUNS.iterdir()):
        if not runs.COMPONENT.fullmatch(directory.name) or directory == own:
            continue
        try:
            params = json.loads((directory / "params.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(params, dict) and params.get("source_sha256") == source_sha256:
            yield directory


def seed_ingest(doc_dir: Path, pdf_sha256: str, cfg: IngestConfig, *, own: Path) -> None:
    """Give a document directory with no accepted ingest another run's proven generation of the same recipe.

    Linked into `ingest.staging` and renamed onto the accepted name, so an interrupted seed leaves only staging,
    which the ingest's recovery removes. Nothing is decided here: `ingest_step` proves the seed against this run's
    PDF and config and skips, or runs and supersedes it.
    """
    paths = IngestPaths(doc_dir)
    if paths.accepted.exists():
        return
    wanted = artifacts.fingerprint(ingest.STAGE_VERSION, cfg, pdf_sha256)
    for run in candidates(pdf_sha256, own=own):
        donor = IngestPaths(run / doc_dir.relative_to(own)).accepted
        if not donor.is_dir():
            continue
        try:
            if artifacts.load_ingest(donor / "ingest.json").envelope.fingerprint != wanted:
                continue
            shutil.copytree(donor, paths.staging, copy_function=_link)
            paths.staging.rename(paths.accepted)
            return
        except (artifacts.CacheMiss, OSError) as error:
            shutil.rmtree(paths.staging, ignore_errors=True)
            logger.info("the ingest of run %s is not reused: %s", run.name, error)


def _link(source: str, target: str) -> None:
    """A hard link: the images are written once and never changed, and a link outlives the donor's deletion."""
    try:
        os.link(source, target)
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise
        shutil.copy2(source, target)


def adopt_result(fingerprint: str, directory: Path, *, source_sha256: str, source_name: str,
                 own: Path) -> pagefile.Result | None:
    """Publish in `directory` another run's complete result of the recipe `fingerprint` names, as a new generation;
    return its manifest, or None when no candidate's verifies.

    The loader proves the files against their manifest, not the manifest's fingerprint against its recipe, so that
    is checked here. Every page file is rewritten under the new generation, so a reference into this run's result
    resolves here alone. The manifest keeps what describes how the content was produced (recipe, fingerprint, time,
    tokens, effective settings), names this run's source, and says which run and generation it was copied from.
    """
    for run in candidates(source_sha256, own=own):
        try:
            if pagefile.read_manifest(run / "result").fingerprint != fingerprint:
                continue
            loaded = pagefile.load_result(run / "result", require_complete=True)
            if not result.fingerprint(loaded.manifest.recipe) == loaded.manifest.fingerprint == fingerprint:
                raise pagefile.ResultError(f"its recipe does not hash to the fingerprint {fingerprint}")
            generation = result.new_generation()
            entries = result.publish_pages(
                directory, (page.model_copy(update={"generation": generation}) for page in loaded.pages.values()))
            adopted = loaded.manifest.model_copy(update={
                "generation": generation, "pages": entries, "source_name": source_name,
                "digest": pagefile.result_digest({number: entry.sha256 for number, entry in entries.items()}),
                "reused_from": {"run_id": run.name, "generation": loaded.manifest.generation}})
            with publish(directory / pagefile.MANIFEST) as part:
                part.write_text(adopted.model_dump_json(indent=2) + "\n", encoding="utf-8")
        except (pagefile.ResultError, OSError) as error:
            logger.info("the result of run %s is not reused: %s", run.name, error)
            continue
        logger.info("adopted generation %s of run %s as %s", loaded.manifest.generation, run.name, generation)
        return adopted
    return None
