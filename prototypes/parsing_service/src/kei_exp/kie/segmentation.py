"""The segmentation artifact: one immutable file of references, spans, roles and diagnostics per parse generation and
recipe structure, never another transcript (grounded catalogue design §7).

`<run>/segmentations/<recipe id>@<version>-<structure digest>/segmentation.json`, renamed into place. The path names
the recipe structure only, so a run converted again finds its old artifact there and refuses it on the generation;
nothing in it depends on an Extraction Schema. A loaded artifact is trusted only after every check below: the
fingerprint and digest recompute, the parse is the one in hand, every span lies inside current canonical text,
primary ownership is disjoint, and the dispositions are exactly one per non-blank line.
"""
from __future__ import annotations

import hashlib
import json
from itertools import pairwise
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from kei_exp.canonical import canonical_json
from kei_exp.files import publish
from kei_exp.kie.model import Block, Diagnostic, GlossaryEntry, HeadingEvent, Span
from kei_exp.kie.passages import Evidence
from kei_exp.kie.recipe import Recipe
from kei_exp.kie.stages.layout import lines

SEGMENTATION_VERSION = 2  # 2: reading-order disagreements leave coverage incomplete; lost native markers

Role = Literal["entry", "heading", "glossary", "reference", "figure", "excluded", "unresolved"]


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Disposition(_Base):
    """The one role of one non-blank source line. Only `entry` has an owner."""
    segment_id: str
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    role: Role
    reason: str | None = None           # excluded/unresolved: why; a section heading: its region
    block: str | None = None            # entry: the owning block
    heading: str | None = None          # heading: the heading event (None for a section heading)


class RejectedStart(_Base):
    """A start candidate that opened no block, with the role the numbering gave it and why."""
    span: Span
    label: str
    role: Literal["list_item", "exception", "ambiguous_start"]
    reason: str


class Coverage(_Base):
    complete: bool                      # no unresolved line, no open potential duplicate, no reading-order disagreement
    lines: int
    entries: int
    unresolved: int
    roles: dict[str, int]
    excluded: dict[str, int]
    potential_duplicates: int
    reading_order_issues: int           # page-file order contradicting the cut's own order: ownership is uncertain
    withheld_intentional: list[str]     # skipped segments with a recipe figure label
    withheld_failures: list[str]        # any other segment the engine did not read: processing is incomplete


class RecipeRef(_Base):
    id: str
    version: int
    structure_sha256: str


class Segmentation(_Base):
    segmentation_version: int
    fingerprint: str
    digest: str
    generation: str
    parse_digest: str
    recipe: RecipeRef
    blocks: list[Block]
    heading_events: list[HeadingEvent]
    dispositions: list[Disposition]
    rejected_starts: list[RejectedStart]
    glossary: list[GlossaryEntry]
    diagnostics: list[Diagnostic]
    coverage: Coverage


class SegmentationInvalid(Exception):
    """An artifact on disk that must not be used; the message names the check it failed."""


def fingerprint(generation: str, parse_digest: str, recipe: Recipe) -> str:
    """Over what segmentation reads: its version, the parse generation and digest, and the recipe structure."""
    return hashlib.sha256(canonical_json({
        "segmentation_version": SEGMENTATION_VERSION, "generation": generation, "digest": parse_digest,
        "structure": recipe.structure.model_dump(mode="json")})).hexdigest()


def namespace_digest(data: dict) -> str:
    """Over the artifact's content: everything but its own fingerprint and digest."""
    return hashlib.sha256(canonical_json({key: value for key, value in data.items()
                                          if key not in ("fingerprint", "digest")})).hexdigest()


def sealed(content: dict) -> Segmentation:
    """The artifact for `content` (every field but fingerprint and digest), with both computed."""
    data = dict(content)
    data["digest"] = namespace_digest(data)
    return Segmentation.model_validate(data)


def artifact_path(run_dir: Path, recipe: Recipe) -> Path:
    return run_dir / "segmentations" / f"{recipe.reference}-{recipe.structure_sha256[:16]}" / "segmentation.json"


def publish_segmentation(run_dir: Path, segmentation: Segmentation) -> Path:
    """Write the artifact by rename; a reader never sees a partial file."""
    structure = segmentation.recipe
    target = (run_dir / "segmentations" / f"{structure.id}@{structure.version}-{structure.structure_sha256[:16]}"
              / "segmentation.json")
    target.parent.mkdir(parents=True, exist_ok=True)
    with publish(target) as part:
        part.write_text(json.dumps(segmentation.model_dump(mode="json"), ensure_ascii=False, indent=1) + "\n",
                        encoding="utf-8")
    return target


def load_segmentation(run_dir: Path, evidence: Evidence, recipe: Recipe) -> Segmentation | None:
    """The published artifact for this parse and recipe, proven; None when there is none. SegmentationInvalid when
    one is there but fails any check: it is then recomputed, never repaired, and OCR is never rerun for it."""
    path = artifact_path(run_dir, recipe)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_bytes())
        artifact = Segmentation.model_validate(data)
    except (ValueError, ValidationError) as error:
        raise SegmentationInvalid(f"{path} does not parse as a segmentation: {error}") from error
    if artifact.segmentation_version != SEGMENTATION_VERSION:
        raise SegmentationInvalid(f"{path} is segmentation version {artifact.segmentation_version}")
    if (artifact.generation, artifact.parse_digest) != (evidence.generation, evidence.digest):
        raise SegmentationInvalid(f"{path} was cut from generation {artifact.generation}, not {evidence.generation}")
    if artifact.fingerprint != fingerprint(evidence.generation, evidence.digest, recipe):
        raise SegmentationInvalid(f"{path}'s fingerprint does not follow from its parse and recipe structure")
    if artifact.digest != namespace_digest(artifact.model_dump(mode="json")):
        raise SegmentationInvalid(f"{path}'s content does not hash to its digest")
    check_against(artifact, evidence, path)
    return artifact


def check_against(artifact: Segmentation, evidence: Evidence, where: Path | str) -> None:
    """Spans inside current canonical text, disjoint primary ownership, one disposition per non-blank line."""
    texts = {passage.id: passage.text for passage in (*evidence.passages, *evidence.withheld)}
    spans = [span for block in artifact.blocks for span in (*block.primary_spans, *block.context_spans)]
    spans += [span for event in artifact.heading_events for span in event.spans]
    spans += [start.span for start in artifact.rejected_starts]
    spans += [span for entry in artifact.glossary for span in (entry.key_span, entry.expansion_span)]
    for span in spans:
        if span.segment_id not in texts or span.end > len(texts[span.segment_id]):
            raise SegmentationInvalid(f"{where}: span {span.segment_id}[{span.start}:{span.end}] is not in the parse")
    identities = [(block.entry_no, block.entry_suffix) for block in artifact.blocks]
    if len(set(identities)) != len(identities):
        raise SegmentationInvalid(f"{where}: two blocks share an entry identity")
    owned: dict[str, list[tuple[int, int, str]]] = {}
    for block in artifact.blocks:
        for span in block.primary_spans:
            owned.setdefault(span.segment_id, []).append((span.start, span.end, block.id))
    for segment, ranges in owned.items():
        ranges.sort()
        for (_, end, first), (start, _, second) in pairwise(ranges):
            if start < end:
                raise SegmentationInvalid(f"{where}: {first} and {second} both own characters of {segment}")
    expected = sorted((line.segment, line.start, line.end)
                      for line in lines(sorted((*evidence.passages, *evidence.withheld),
                                               key=lambda passage: (passage.page, passage.index))))
    found = sorted((d.segment_id, d.start, d.end) for d in artifact.dispositions)
    if found != expected:
        raise SegmentationInvalid(f"{where}: the dispositions do not account for every non-blank line exactly once")
    # Every disposition is now a real line, so its characters can be read.
    ledger: dict[str, set[tuple[str, int]]] = {}
    for d in artifact.dispositions:
        if d.role == "entry":
            ledger.setdefault(d.block, set()).update(
                (d.segment_id, i) for i in range(d.start, d.end) if not texts[d.segment_id][i].isspace())
    for block in artifact.blocks:
        owned_chars = {(span.segment_id, i) for span in block.primary_spans for i in range(span.start, span.end)
                       if not texts[span.segment_id][i].isspace()}
        if owned_chars != ledger.pop(block.id, set()):
            raise SegmentationInvalid(f"{where}: {block.id}'s primary spans disagree with the lines the ledger gives it")
    if ledger:
        raise SegmentationInvalid(f"{where}: the ledger gives lines to blocks that do not exist: {sorted(ledger)}")
