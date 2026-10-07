"""The ingest artifact's hashes, and reading it back with its page images.

Contract: `docs/design/2026-09-14-kie-model-and-ingest-design.md` section 5. This is the ingest's own
identity and proof: the fingerprint that decides whether the ingest can be skipped, the digest a downstream
consumer binds to, and the loader that refuses a cache entry it cannot prove. The encoding those hashes are taken
over is `kei_exp.canonical`, a leaf every layer can agree on without importing this package. It imports no runner
and no stage module, so the stage can hash what it produced without importing the thing that runs it, and the
decision to skip or run stays with the runner.
"""

import hashlib
import struct
from pathlib import Path
from typing import Final

from pydantic import ValidationError

from kei_exp.canonical import CHUNK, Serializable, canonical_json
from kei_exp.kie.ingest_model import IngestArtifact, IngestConfig, Page
from kei_exp.kie.primitives import Sha256

# Page images are bilevel (spec 3.2); a mode `L` copy of the same pixels is not the raster a bbox is on.
PAGE_IMAGE_MODE: Final = "1"

# What ingest's `_write_png` produces, and all the verifier reads of a page image: the PNG signature and an
# `IHDR` of exactly 13 bytes (Pillow's encoder writes nothing else first), whose width, height, bit depth and
# colour type are the four values a mode `1` page has to show.
_PNG_SIGNATURE: Final = b"\x89PNG\r\n\x1a\n"
_IHDR: Final = b"\x00\x00\x00\x0dIHDR"
_HEADER_LENGTH: Final = len(_PNG_SIGNATURE) + len(_IHDR) + 13 + 4  # signature, chunk length and type, payload, CRC
_BILEVEL: Final = (1, 0)  # bit depth 1, colour type 0: how Pillow encodes mode `1`


class CacheMiss(Exception):
    """A candidate cache entry that cannot be proven, so the stage runs again (spec 5).

    Everything a stale, half-written or hand-edited run directory looks like arrives here: no artifact,
    unparseable JSON, a namespace that no longer validates, a digest that does not match the namespace it
    vouches for, a page image that is missing, holds other bytes, or is not the raster its Page describes.
    A permission error or a programming error is none of those and keeps its own diagnostic.
    """


def _sha256_json(value: Serializable) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def fingerprint(stage_version: int, effective_config: IngestConfig, pdf_sha256: Sha256) -> str:
    """The hash of the recipe ingest was asked to follow, which decides whether it can be skipped (spec 5).

    `stage_version` is the caller's constant: this module does not know the stage, and the bump rule lives
    beside the constant in the stage that owns it. The config projects itself onto its effective form as it
    serializes, so a setting that is inactive in the chosen mode cannot re-run the stage.
    """
    return _sha256_json(
        {
            "stage_version": stage_version,
            "effective_config": effective_config.model_dump(mode="json"),
            "inputs": {"pdf_sha256": pdf_sha256},
        }
    )


def output_digest(artifact: IngestArtifact) -> str:
    """The hash of what the stage produced, which is what a downstream consumer binds to (spec 5).

    The envelope is excluded because it carries this very value and the time the file was written, and the
    report because it carries timings. What remains is the output itself: the source, the effective config,
    and every page with its dimensions and image hash. Excluding by name from the whole artifact, rather than
    listing the namespace again, is what keeps a namespace field added later inside the digest.
    """
    return _sha256_json(artifact.model_dump(mode="json", exclude={"envelope", "report"}))


def seal(artifact: IngestArtifact) -> IngestArtifact:
    """The same artifact with `envelope.digest` set to its own output digest.

    A producer cannot know the digest while it is still assembling the namespace the digest is taken over, so
    it builds the envelope with a placeholder and seals the finished artifact here. The placeholder never
    reaches the hash: the envelope is not part of the projection.
    """
    envelope = artifact.envelope.model_copy(update={"digest": output_digest(artifact)})
    return artifact.model_copy(update={"envelope": envelope})


def save_ingest(artifact: IngestArtifact, path: Path) -> None:
    """Write `ingest.json`, indented so a run directory can be read. Hashing never uses this form (spec 5)."""
    path.write_text(artifact.model_dump_json(indent=2) + "\n", encoding="utf-8")


def load_ingest(path: Path) -> IngestArtifact:
    """The verified artifact at `path`, or `CacheMiss` when this candidate cannot be proven (spec 5).

    Proven means: it parses and validates as an artifact, the digest recomputed from its namespace equals the
    one the envelope claims, and every page image beside it holds the bytes its Page records. A stored digest is
    never trusted on its own, because it is the value a downstream consumer binds to: a namespace edited
    after publication would otherwise keep vouching for content it no longer holds. Whether a proven artifact
    may then be skipped — its stage version, its fingerprint — is the runner's decision.
    """
    try:
        raw = path.read_bytes()
    except FileNotFoundError as error:
        raise CacheMiss(f"no artifact at {path}") from error
    try:
        artifact = IngestArtifact.model_validate_json(raw)
    except ValidationError as error:
        raise CacheMiss(f"{path} is not a valid ingest artifact: {error}") from error
    recomputed = output_digest(artifact)
    if recomputed != artifact.envelope.digest:
        raise CacheMiss(
            f"{path} holds a namespace that digests to {recomputed}, not the "
            f"{artifact.envelope.digest} its envelope claims"
        )
    for page in artifact.pages:
        # Page images are relative to the artifact directory, which is the directory the artifact is in.
        _verify_image(path.parent / page.image, page)
    return artifact


def _verify_image(path: Path, page: Page) -> None:
    """The page image holds the recorded bytes, and those bytes begin as the bilevel PNG the Page states (spec 5).

    One handle serves both reads, so the header checked is the header of the bytes hashed. The hash proves
    the bytes are the ones ingest wrote, unless the artifact was rewritten with a recomputed digest, and an
    adversary who can do that owns the artifact (spec 5, threat model). What the header adds is the check
    that ingest wrote a page of the right shape, and what it costs is one `struct.unpack`: no decode, no
    Pillow, no process global. Pillow's PNG plugin consults the global `MAX_IMAGE_PIXELS` during APNG setup
    before the header is compared, so decoding here would either mutate that global or inherit a bound this
    caller cannot state; the write-time round trips in the ingest tests cover the corrupt-PNG case where it can
    happen. A `PermissionError` is not a stale entry and propagates.
    """
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            while chunk := handle.read(CHUNK):
                digest.update(chunk)
            if (recorded := digest.hexdigest()) != page.sha256:
                # Before the rewind: other bytes are refused as other bytes, whatever their header says.
                raise CacheMiss(f"page {page.index} image {path} hashes to {recorded}, not the {page.sha256} recorded")
            handle.seek(0)
            header = handle.read(_HEADER_LENGTH)
    except FileNotFoundError as error:
        raise CacheMiss(f"page {page.index} image {path} is missing") from error
    if len(header) < _HEADER_LENGTH or not header.startswith(_PNG_SIGNATURE + _IHDR):
        raise CacheMiss(f"page {page.index} image {path} does not begin as a PNG with a 13-byte IHDR")
    width, height, depth, colour = struct.unpack(">IIBB", header[16:26])
    if (width, height) != (page.width_px, page.height_px):
        raise CacheMiss(f"page {page.index} image {path} is {width}x{height}, not {page.width_px}x{page.height_px}")
    if (depth, colour) != _BILEVEL:
        raise CacheMiss(
            f"page {page.index} image {path} is {depth}-bit colour type {colour}, not the 1-bit greyscale of "
            f"a mode {PAGE_IMAGE_MODE!r} page"
        )
