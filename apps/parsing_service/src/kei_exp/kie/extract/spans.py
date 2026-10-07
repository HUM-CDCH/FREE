"""Extraction-local choices over exact canonical ranges; no new evidence store."""
from __future__ import annotations

import re
from collections.abc import Iterator, Sequence
from dataclasses import dataclass

from kei_exp.kie.passages import Passage
from kei_exp.pagefile import TableCell

VERSION = 2
MAX_PROSE_CHARS = 500


@dataclass(frozen=True)
class SourceSpan:
    passage: Passage
    start: int
    end: int
    cell: TableCell | None = None

    @property
    def id(self) -> str:
        suffix = f"/{self.cell.cell_id}" if self.cell else f"@{self.start}:{self.end}"
        return self.passage.id + suffix

    @property
    def text(self) -> str:
        return self.passage.text[self.start:self.end]

    def shown(self) -> str:
        location = f"{self.passage.id} {self.passage.label} [{self.start}:{self.end}]"
        if self.cell:
            location += (f" cell={self.cell.cell_id} row={self.cell.row} column={self.cell.column}"
                         f" rowspan={self.cell.rowspan} colspan={self.cell.colspan} role={self.cell.role}")
        return f"{location}: {self.text!r}"


def ranges(text: str) -> Iterator[tuple[int, int]]:
    """Cover every code point once, preferring a nearby sentence or whitespace boundary."""
    start = 0
    while start < len(text):
        end = min(start + MAX_PROSE_CHARS, len(text))
        if end < len(text):
            lower = start + MAX_PROSE_CHARS // 2
            preferred = [start + m.end() for m in re.finditer(r"[.!?。！？]\s+", text[start:end])
                         if start + m.end() >= lower]
            spaces = [i + 1 for i in range(lower, end) if text[i].isspace()]
            end = preferred[-1] if preferred else spaces[-1] if spaces else end
        yield start, end
        start = end


def source_spans(passages: Sequence[Passage]) -> list[SourceSpan]:
    """Keep complete parent text selectable, plus indivisible canonical table cells.

    Parent ranges preserve non-cell text and coarse/OCR tables. Cells retain their
    exact canonical offsets even when longer than the prose cap or lacking a box.
    """
    spans = []
    for passage in passages:
        spans.extend(SourceSpan(passage, start, end) for start, end in ranges(passage.text))
        for cell in passage.table.cells if passage.table else ():
            if not 0 <= cell.start <= cell.end <= len(passage.text) or passage.text[cell.start:cell.end] != cell.text:
                raise ValueError(f"{passage.id}/{cell.cell_id}: canonical cell text/range disagree")
            if cell.text.strip():
                spans.append(SourceSpan(passage, cell.start, cell.end, cell))
    if len({span.id for span in spans}) != len(spans):
        raise ValueError("source span IDs must be unique within one generation")
    return spans
