"""What one execution of the pipeline was told and what it did: the OCR and pipeline configuration, the evidence
report with the page segments it rejected, and the run report.

Vocabulary: `CONTEXT.md`. Contracts: `docs/superpowers/specs/2026-09-14-kie-model-and-ingest-design.md`
(sections are cited as "spec 5" below) and the canonical evidence design
(`docs/superpowers/specs/2026-09-21-canonical-evidence-design.md`, cited as "design §6"). The ingest configuration and
report the run carries are `kie.ingest_model`'s.
"""

from typing import Literal, Self

from pydantic import Field, model_validator

from kei_exp.kie.ingest_model import IngestConfig, IngestReport
from kei_exp.kie.primitives import Count, Extent, Index, IndexKey, Name, Seconds, Sha256, _Base, _unique


class OcrConfig(_Base):
    """Surya execution over the book pages produced by ingest."""

    url: str | None = None  # None uses KEI_VLLM_URL, or the local server
    cut: Literal["auto", "none"] = "auto"
    layout_model: str = "layout_heron_101"
    crop_dpi: Extent = 250
    max_image_size: Extent | None = None
    pages: tuple[Index, Index] | None = None  # inclusive PDF spread range


class PipelineConfig(_Base):
    """Ingest, then OCR. Set `ocr: null` to stop after ingest."""

    ingest: IngestConfig = Field(default_factory=IngestConfig)
    ocr: OcrConfig | None = Field(default_factory=OcrConfig)


class Rejected(_Base):
    """A page segment that could not become a segment, with its locator and the reason (design §6). It keeps its
    number in the id sequence of its unit, so ids stay positional; it is recorded, never dropped (CONTEXT.md
    invariant 5)."""

    page: Index  # the PDF page, which names the page file `pages/<page>.json`
    unit: Index
    crop: Index
    index: Count  # the position in the page file's `segments` list, as `EvidenceRef.index`
    bbox_px: tuple[float, float, float, float] | None
    reason: Literal["no_box", "empty_after_clamp"]


class EvidenceReport(_Base):
    """What the evidence loader read and produced (design §6): the generation, its content digest, the counts, and
    what could not be placed. Part of the run report; nothing else of the evidence is persisted by KIE."""

    generation: Name
    digest: Sha256
    pages_read: Count
    spreads_without_pages: list[Index]  # a page-range result: the spreads the manifest does not cover
    segments: Count
    rejected: list[Rejected]
    clamped: Count  # segments whose box the placement moved into its crop
    by_label: dict[str, Count]
    by_status: dict[str, Count]
    empty_text: Count
    overlaps: dict[IndexKey, list[tuple[Index, Index]]]  # unit -> pairs of crop ordinals whose rectangles overlap
    seconds: Seconds

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        _unique(self.spreads_without_pages, "spread without pages")
        if sum(self.by_label.values()) != self.segments or sum(self.by_status.values()) != self.segments:
            raise ValueError(f"by_label and by_status must each count the {self.segments} segments")
        return self


class IngestStep(_Base):
    """The ingest's line in the run report (spec 5): whether the accepted artifact was reused, this invocation's
    seconds, and the stage's own report (on a skip, the one stored when it last ran)."""

    skipped: bool
    seconds: Seconds  # this invocation, the skip check included
    report: IngestReport


class RunReport(_Base):
    """What one execution of the pipeline did (spec 5, design §7). `run_id` and `run_dir` name it; `Run` is
    ingest's type."""

    run_id: Name
    doc_id: Name
    seconds: Seconds
    ingest: IngestStep
    ocr: EvidenceReport | None = None  # None for an ingest-only run
