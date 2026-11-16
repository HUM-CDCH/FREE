from __future__ import annotations

from typing import Any

from kei_exp.kie.blocks import Span
from kei_exp.kie.extract.acceptance import Outcome


def place(record: dict, path: tuple, value: Any) -> None:
    """Sets `value` at `path` inside `record`, creating the objects and list slots on the way."""
    target: Any = record
    for step, following in zip(path, (*path[1:], None), strict=True):
        if following is None:
            if isinstance(target, list):
                target.extend([None] * (step + 1 - len(target)))
            target[step] = value
            return
        container = [] if isinstance(following, int) else {}
        if isinstance(target, list):
            target.extend([None] * (step + 1 - len(target)))
            target[step] = target[step] if target[step] is not None else container
        else:
            target.setdefault(step, container)
        target = target[step]


def spans_json(spans: list[Span]) -> list[dict]:
    """Spans as the artifact writes them."""
    return [{"segment": span.segment_id, "start": span.start, "end": span.end} for span in spans]


def _raw(spans: list[Span], texts: dict) -> str:
    return "".join(texts[span.segment_id].text[span.start:span.end] for span in spans)


def evidence_link(outcome: Outcome, texts: dict) -> dict:
    """The artifact's `evidence` entry for an accepted outcome; `texts` maps segment IDs to passages."""
    first = texts[outcome.spans[0].segment_id]
    cells = [cell for cell in first.table.cells if cell.bbox_pt is not None
             and all(span.segment_id == first.id and cell.start <= span.start < span.end <= cell.end
                     for span in outcome.spans)] if first.table and not outcome.alternatives else []
    cell = cells[0] if len(cells) == 1 else None
    return {"path": list(outcome.path), "segment": first.id, "page": first.page,
            "bbox_pt": list(cell.bbox_pt if cell else first.bbox_pt), "cell": cell.cell_id if cell else None,
            "spans": spans_json(outcome.spans), "alternatives": [spans_json(spans) for spans in outcome.alternatives],
            "precision": "cell" if cell else first.precision, "raw": _raw(outcome.spans, texts)}
