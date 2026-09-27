"""Windows over an oversized entry block: its primary text as source lines, grouped into consecutive windows whose
request fits the input budget.

A unit is one source line of the block's primary spans, with its raw range. `fits` is the caller's predicate over a
list of units, whether a request showing them stays within the budget, so this module neither counts tokens nor
calls a model. A unit too long for any window is cut at whitespace, then at code points; with overlap, the last unit
of a window is seen again as the first of the next. When not even one code point fits, there are no windows.
"""
from __future__ import annotations

from dataclasses import dataclass

from kei_exp.kie.model import Block


@dataclass(frozen=True)
class Unit:
    """A raw range of one segment's text: a source line of the block, or a cut piece of one."""
    segment: str
    start: int
    end: int


def units_of(block: Block, texts: dict[str, str]) -> list[Unit]:
    """The block's primary text as source lines, each with its raw range."""
    units = []
    for span in block.primary_spans:
        position = span.start
        for raw in texts[span.segment_id][span.start:span.end].split("\n"):
            start, end = position + len(raw) - len(raw.lstrip()), position + len(raw.rstrip())
            if end > start:
                units.append(Unit(span.segment_id, start, end))
            position += len(raw) + 1
    return units


def windows_of(units: list[Unit], texts: dict[str, str], fits, *, overlap: bool) -> list[list[Unit]] | None:
    """Consecutive units per window, each window's request within budget, one unit of overlap with `overlap`; a
    unit too long for any window is cut at whitespace, then at code points. None when not even one code point fits."""
    pieces: list[Unit] = []
    for unit in units:
        pieces += _cut(unit, texts, fits)
    if any(piece is None for piece in pieces):
        return None
    windows: list[list[Unit]] = []
    index = 0
    while index < len(pieces):
        window = [pieces[index]]
        while index + len(window) < len(pieces) and fits(window + [pieces[index + len(window)]]):
            window.append(pieces[index + len(window)])
        windows.append(window)
        index += len(window)
        if overlap and index < len(pieces) and len(window) > 1 and fits([window[-1], pieces[index]]):
            index -= 1  # the last unit is seen again as the start of the next window
    return windows


def _cut(unit: Unit, texts: dict[str, str], fits) -> list[Unit | None]:
    if fits([unit]):
        return [unit]
    text = texts[unit.segment]
    pieces: list[Unit | None] = []
    start = unit.start
    while start < unit.end:
        low, high, best = start + 1, unit.end, None
        while low <= high:  # the longest prefix from `start` that fits
            middle = (low + high) // 2
            if fits([Unit(unit.segment, start, middle)]):
                best, low = middle, middle + 1
            else:
                high = middle - 1
        if best is None:
            return [None]
        end = best
        if best < unit.end and (space := text.rfind(" ", start + 1, best)) > start:
            end = space  # prefer a whitespace boundary
        pieces.append(Unit(unit.segment, start, end))
        start = end
        while start < unit.end and text[start].isspace():
            start += 1
    return pieces
