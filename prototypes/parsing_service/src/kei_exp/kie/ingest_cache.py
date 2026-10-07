"""Recover, validate and publish the accepted ingest generation for one document.

One writer owns a document directory. Staging is never accepted as a generation;
publication proves its contents before swapping it with the previous generation.
"""

import shutil
import time
import warnings
from dataclasses import dataclass
from pathlib import Path

from kei_exp.canonical import canonical_json, sha256_file
from kei_exp.kie.artifacts import CacheMiss, fingerprint, load_ingest
from kei_exp.kie.ingest_model import IngestArtifact, IngestConfig, IngestReport
from kei_exp.kie.primitives import IngestError, Seconds, _Base
from kei_exp.kie.stages import ingest


class IngestCacheError(Exception):
    """An ingest generation could not be produced, proven or published."""


class IngestStep(_Base):
    """What one ingest call did: whether the accepted artifact was reused, this invocation's seconds, and the
    stage's own report (on a skip, the one stored when it last ran)."""

    skipped: bool
    seconds: Seconds  # this invocation, the skip check included
    report: IngestReport


@dataclass(frozen=True)
class IngestPaths:
    """The three directories the ingest can have inside a document's run directory, and its artifact (spec 5)."""

    doc_dir: Path

    @property
    def accepted(self) -> Path:
        return self.doc_dir / "ingest"

    @property
    def staging(self) -> Path:
        return self.doc_dir / "ingest.staging"

    @property
    def previous(self) -> Path:
        return self.doc_dir / "ingest.old"

    def artifact(self, generation: Path) -> Path:
        """The artifact file inside one generation, accepted, staged or superseded."""
        return generation / "ingest.json"


def ingest_step(pdf: Path, cfg: IngestConfig, doc_dir: Path,
                on_spread: ingest.OnSpread | None = None) -> tuple[IngestStep, IngestArtifact]:
    """Ingest `pdf` into its run directory, or prove the accepted artifact and skip the work (spec 5)."""
    started = time.perf_counter()
    paths = IngestPaths(doc_dir)
    try:
        _recover(paths)
        skippable = _skippable(paths, cfg, pdf)
        artifact = skippable if skippable is not None else _produce(paths, pdf, cfg, on_spread)
    except (CacheMiss, IngestError, OSError) as error:
        raise IngestCacheError(f"stage 'ingest' on {pdf.name} failed: {error}") from error
    # On a skip the stage's own report is the one stored when it last ran, and `seconds` is this invocation's.
    return IngestStep(skipped=skippable is not None, seconds=time.perf_counter() - started, report=artifact.report), artifact


def _recover(paths: IngestPaths) -> None:
    """Undo an interrupted publication, before anything is decided about the cache (spec 5).

    `ingest.old` exists only between the two renames of a publication, so finding one means an earlier run
    died between them. Which generation survives is not decided by which name it carries: the accepted
    directory is verified first and wins if it is whole, and only then is the superseded one removed, so the
    only proven generation is never discarded to tidy up. Staging is never a generation, whatever it holds:
    an interrupted stage leaves a partial directory behind, and publishing it would accept an artifact whose
    pages were never all written.
    """
    if paths.staging.exists():
        shutil.rmtree(paths.staging)
    if not paths.previous.exists():
        return
    if _proven(paths, paths.accepted) is not None:
        shutil.rmtree(paths.previous)
        return
    if _proven(paths, paths.previous) is None:
        # Neither generation can be proven, so nothing is lost by clearing the way for the run that follows.
        shutil.rmtree(paths.previous)
        return
    if paths.accepted.exists():
        shutil.rmtree(paths.accepted)
    paths.previous.rename(paths.accepted)


def _proven(paths: IngestPaths, generation: Path) -> IngestArtifact | None:
    """The artifact of one generation, or None when it cannot be proven and so is no generation at all."""
    try:
        return load_ingest(paths.artifact(generation))
    except CacheMiss:
        return None


def _skippable(paths: IngestPaths, cfg: IngestConfig, pdf: Path) -> IngestArtifact | None:
    """The accepted artifact when the whole skip rule holds for it, else None and the stage runs (spec 5).

    Every part is checked rather than trusted: `load_ingest` proves the artifact and its page images are what
    the envelope vouches for, and the comparison here proves they were produced from this recipe — this
    stage, at this version, from this configuration and these bytes.
    """
    artifact = _proven(paths, paths.accepted)
    if artifact is None:
        return None
    pdf_sha256 = sha256_file(pdf)
    recipe = fingerprint(ingest.STAGE_VERSION, cfg, pdf_sha256)
    envelope = artifact.envelope
    stamped = (envelope.stage, envelope.stage_version, envelope.fingerprint, envelope.upstream)
    # Ingest reads no upstream stage, so the upstream digests it must agree with are the empty set (spec 3.8).
    if stamped != ("ingest", ingest.STAGE_VERSION, recipe, {}):
        return None
    # The fingerprint is a claim about the recipe, and it sits in the envelope, which the digest excludes: a
    # hand-edited one would otherwise let a stale artifact skip. The config and the source hash say the same
    # thing from inside the digest, which `load_ingest` has just proven, so they are what is compared.
    if canonical_json(artifact.config) != canonical_json(cfg) or artifact.source.sha256 != pdf_sha256:
        return None
    return artifact


def _produce(paths: IngestPaths, pdf: Path, cfg: IngestConfig,
             on_spread: ingest.OnSpread | None) -> IngestArtifact:
    """Run the stage into staging, prove what it wrote there, and publish it as the accepted generation.

    The stage's returned artifact is not evidence about the files, so it is compared with the artifact loaded
    back from staging: a stage that returned more, less or other than it wrote is caught here, while the
    accepted generation is still untouched. The comparison is of the persisted form, because that is what
    "the one it wrote" means: a setting that is inactive in the chosen mode is dropped on the way out and
    comes back as its default on the way in (spec 5), so the two models differ where the two files do not.
    """
    returned = ingest.run(pdf, cfg, paths.staging, on_spread=on_spread)
    try:
        staged = load_ingest(paths.artifact(paths.staging))
    except CacheMiss as error:
        raise IngestCacheError(f"stage 'ingest' wrote an artifact for {pdf.name} that does not verify: {error}") from error
    if canonical_json(staged) != canonical_json(returned):
        raise IngestCacheError(
            f"stage 'ingest' returned an artifact for {pdf.name} that is not the one it wrote to {paths.staging}"
        )
    _publish(paths, pdf)
    return staged


def _publish(paths: IngestPaths, pdf: Path) -> None:
    """Swap the staged generation in: two renames, with the previous one put back if the second fails (spec 5).

    A reader already traversing the directory during the swap is not covered by this and is not part of the
    guarantee; a process that dies between the two renames is, because `_recover` reads the same two names on
    the next run.
    """
    superseded = paths.accepted.exists()
    if superseded:
        paths.accepted.rename(paths.previous)
    try:
        paths.staging.rename(paths.accepted)
    except OSError:
        if superseded:
            paths.previous.rename(paths.accepted)
        raise
    if superseded:
        _discard(paths, pdf)


def _discard(paths: IngestPaths, pdf: Path) -> None:
    """Remove the superseded generation, which is cleanup after the fact and not part of publication.

    The new generation is already the accepted one, so a failure here is reported and left to the next run's
    recovery, rather than undoing a publication that succeeded.
    """
    try:
        shutil.rmtree(paths.previous)
    except OSError as error:
        warnings.warn(
            f"the superseded ingest generation of {pdf.name} at {paths.previous} could not be "
            f"removed ({error}); the new one is published and the next run removes what is left",
            RuntimeWarning,
            stacklevel=2,
        )


