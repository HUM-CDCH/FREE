"""A finished parse run's canonical result as extraction sees it: passages in reading order, named by identity.

Extraction never reparses the PDF (plan B rule 4). It reads `result/result.json` and the page files through
`pagefile.load_result`, which proves they belong together, and projects every readable segment into a `Passage`
named `p{page}_s{index}`: the physical PDF page and the segment's position in that page file's `segments` list.
That name is the evidence identity every extracted value points at; it holds for the generation it was read from
and means nothing outside it. FREE derives its anchor ids from the same pair.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from kei_exp.pagefile import ResultError, load_result


class EvidenceUnavailable(Exception):
    """The run has no complete canonical result to extract from; the message says why."""


@dataclass(frozen=True)
class Passage:
    """One readable segment: its identity, its page, its text and where it sits on the page (top-left points)."""
    id: str
    page: int
    index: int
    text: str
    label: str
    bbox_pt: tuple[float, float, float, float]
    extent: str                        # block: the engine's own box; input: the whole input, deliberately coarse


@dataclass(frozen=True)
class Evidence:
    run_id: str
    generation: str
    digest: str
    source_name: str
    page_count: int
    passages: tuple[Passage, ...]      # pages ascending, then page-file order: the reading order

    def by_id(self, passage_id: str) -> Passage:
        for passage in self.passages:
            if passage.id == passage_id:
                return passage
        raise KeyError(passage_id)


def load(run_dir: Path) -> Evidence:
    """The run's result, verified and projected. Only complete results are extracted from: a truncated page
    would make every value read from it unverifiable."""
    try:
        loaded = load_result(run_dir / "result", require_complete=True)
    except ResultError as error:
        raise EvidenceUnavailable(str(error)) from error
    passages: list[Passage] = []
    for number in sorted(loaded.pages):
        for index, segment in enumerate(loaded.pages[number].segments):
            if segment.status != "ok" or not segment.text.strip():
                continue
            passages.append(Passage(id=f"p{number}_s{index}", page=number, index=index, text=segment.text,
                                    label=segment.label, bbox_pt=tuple(segment.bbox_pt), extent=segment.extent))
    manifest = loaded.manifest
    return Evidence(run_id=run_dir.name, generation=manifest.generation, digest=manifest.digest,
                    source_name=manifest.source_name, page_count=manifest.page_count, passages=tuple(passages))


def text_of(passages: Sequence[Passage]) -> str:
    """The passages' text in order, one blank line between them: what a model is shown."""
    return "\n\n".join(passage.text.strip() for passage in passages)
