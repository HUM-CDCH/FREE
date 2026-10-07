"""Where a quoted value lies in a block's own text, as raw code-point spans of canonical segments (design §2, §8).

A block's text is its primary spans in order, joined by one separator character that belongs to no segment. Matching
runs on a normalised view — NFKC per grapheme cluster, case folded, whitespace collapsed, soft hyphens dropped, and a
hyphen at a line or span break joined to a following lowercase letter — that keeps, for every normalised character,
the raw range it came from. A match maps back to raw offsets and is split at separators, so a value that crosses
segments is a list of spans and no span ever covers a separator. The normalised view is never evidence text.
"""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from decimal import Decimal

from kei_exp.kie.blocks import Span

SEPARATOR = "\n"
SOFT_HYPHEN = "­"


@dataclass(frozen=True)
class BlockText:
    text: str                                    # primary spans joined by SEPARATOR
    origins: tuple[tuple[str, int] | None, ...]  # per character: (segment id, raw offset), None for a separator

    @classmethod
    def of(cls, parts: list[tuple[str, str, Span]]) -> BlockText:
        """From (segment id, segment text, span) triples in reading order."""
        chars: list[str] = []
        origins: list[tuple[str, int] | None] = []
        for number, (segment, text, span) in enumerate(parts):
            if number:
                chars.append(SEPARATOR)
                origins.append(None)
            chars.append(text[span.start:span.end])
            origins += [(segment, offset) for offset in range(span.start, span.end)]
        return cls("".join(chars), tuple(origins))


@dataclass(frozen=True)
class _Normal:
    text: str
    ranges: tuple[tuple[int, int], ...]          # per normalised character: its raw [start, end)


def normalise(text: str) -> _Normal:
    out: list[str] = []
    ranges: list[tuple[int, int]] = []
    breaks: list[bool] = []                      # per normalised space: whether it replaced a line or span break
    index = 0
    while index < len(text):
        end = index + 1
        while end < len(text) and unicodedata.combining(text[end]):
            end += 1
        cluster = text[index:end]
        if cluster == SOFT_HYPHEN:
            pass
        elif cluster.isspace():
            if out and out[-1] == " ":
                ranges[-1] = (ranges[-1][0], end)
                breaks[-1] = breaks[-1] or "\n" in cluster
            elif out:
                out.append(" ")
                ranges.append((index, end))
                breaks.append("\n" in cluster)
        else:
            for char in unicodedata.normalize("NFKC", cluster).casefold():
                out.append(char)
                ranges.append((index, end))
                breaks.append(False)
        index = end
    # A hyphen at a break before a lowercase letter joins one word ("Groß-" / "steingrab"); an uppercase letter after
    # it keeps the hyphen, since "Nord-" / "Süd" is a compound, not a split word.
    joined_text: list[str] = []
    joined_ranges: list[tuple[int, int]] = []
    skip = 0
    for position, char in enumerate(out):
        if skip:
            skip -= 1
            continue
        after = position + 2
        if (char == "-" and position + 1 < len(out) and out[position + 1] == " " and breaks[position + 1]
                and after < len(out) and text[ranges[after][0]].islower()):
            skip = 1
            continue
        joined_text.append(char)
        joined_ranges.append(ranges[position])
    while joined_text and joined_text[-1] == " ":
        joined_text.pop()
        joined_ranges.pop()
    return _Normal("".join(joined_text), tuple(joined_ranges))


def _bounded(haystack: str, start: int, end: int) -> bool:
    before = haystack[start - 1] if start > 0 else " "
    after = haystack[end] if end < len(haystack) else " "
    return not before.isalnum() and not after.isalnum()


SIGNS = "-\u2212\u2013"  # hyphen-minus, minus, en dash: a sign, or a range between numbers


def _before(haystack: str, index: int) -> int:
    """The position of the nearest non-space character before `index`, or -1."""
    index -= 1
    while index >= 0 and haystack[index].isspace():
        index -= 1
    return index


def _whole_number(haystack: str, start: int, end: int, signed: bool) -> bool:
    """A number printed at [start, end) is the whole number there: no decimal digits continue it; after a decimal
    separator it is a fraction unless a letter precedes the separator (an abbreviation: `Nr.2`); and an unsigned value
    has no sign before it, spaced or not. A hyphen or dash is a range, not a sign, only after a number."""
    if end + 1 < len(haystack) and haystack[end] in ".," and haystack[end + 1].isdigit():
        return False
    if start >= 1 and haystack[start - 1] in ".," and (start < 2 or not haystack[start - 2].isalpha()):
        return False
    if signed:
        return True
    sign = _before(haystack, start)
    if sign < 0 or haystack[sign] not in SIGNS:
        return True
    prior = _before(haystack, sign)
    return prior >= 0 and haystack[prior].isdigit()


def _occurrences(haystack: str, needle: str, numeric: bool = False) -> list[int]:
    found, start = [], haystack.find(needle)
    while start != -1:
        end = start + len(needle)
        if _bounded(haystack, start, end) and (not numeric or _whole_number(haystack, start, end, needle[0] in SIGNS)):
            found.append(start)
        start = haystack.find(needle, start + 1)
    return found


def _spans(block: BlockText, raw_start: int, raw_end: int) -> list[Span]:
    spans: list[Span] = []
    for origin in block.origins[raw_start:raw_end]:
        if origin is None:
            continue
        segment, offset = origin
        if spans and spans[-1].segment_id == segment and spans[-1].end == offset:
            spans[-1] = Span(segment_id=segment, start=spans[-1].start, end=offset + 1)
        else:
            spans.append(Span(segment_id=segment, start=offset, end=offset + 1))
    return spans


def locate(block: BlockText, quote: str, *, within: tuple[int, int] | None = None,
           numeric: bool = False) -> list[list[Span]]:
    """Every bounded occurrence of `quote` in the block, each as raw spans; `within` restricts the search to a raw
    range of the block text, and `numeric` requires the occurrence to be a whole printed number. Several occurrences
    are alternatives, never one value."""
    needle = normalise(quote).text
    if not needle:
        return []
    view = normalise(block.text)
    found = []
    for start in _occurrences(view.text, needle, numeric):
        end = start + len(needle)
        if (start > 0 and view.ranges[start - 1] == view.ranges[start]) or \
                (end < len(view.text) and view.ranges[end] == view.ranges[end - 1]):
            continue  # part of what one source character expands to (`½` reads `1⁄2`) is not that character
        raw_start, raw_end = view.ranges[start][0], view.ranges[end - 1][1]
        if within is None or (within[0] <= raw_start and raw_end <= within[1]):
            found.append(_spans(block, raw_start, raw_end))
    return found


def raw_range(block: BlockText, spans: list[Span]) -> tuple[int, int]:
    """The block-text range a located span list covers, separators included."""
    positions = [index for index, origin in enumerate(block.origins)
                 if origin is not None and any(origin[0] == span.segment_id and span.start <= origin[1] < span.end
                                               for span in spans)]
    return positions[0], positions[-1] + 1


def forms(value: object) -> list[str]:
    """How the source may print a typed value: an integral float as its integer, a decimal with comma or point."""
    if isinstance(value, bool):
        return []
    if isinstance(value, int):
        return [str(value)]
    if isinstance(value, float):
        if value.is_integer():
            return [str(int(value))]
        text = format(Decimal(repr(value)), "f")  # the shortest exact decimal, never in exponent form or rounded
        return [text, text.replace(".", ",")]
    return [str(value)]
