"""Value marks on a scan (docs/adr/0031, "Scanned pages from the page image"): where no text layer places a value in
a block the OCR model read, the block's crop of the rendered page is read once more, by Tesseract, only to learn
where its words print. Canonical text stays the only text: the second reading never changes a value, a span or a
link's anchor, and where the two readings disagree at the value the link keeps its block mark.

A value is placed only where its letters occur once in each reading and every alignment of the two within one edit
of the best maps it and its surroundings, unchanged, to the same words, and then on those words' own measured boxes:
whole printed words, one box each. No box is interpolated, split or joined, and no occurrence is chosen by position.
"""
from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import time
from bisect import bisect_left
from itertools import accumulate, pairwise
from pathlib import Path
from typing import NamedTuple

import numpy as np
from PIL import Image

from kei_exp.kie.extract.value_mark import CONTEXT, SCALE, folded

Pixels = tuple[int, int, int, int]

SLACK = 1             # every alignment within this many edits of the best must place the value alike
MARGIN_PX = 6         # the crop reaches this far beyond the block's box
PAD_PX = 48           # the crop's border, in its own paper tone: a white one on a grey page reads as one blot
GROW_PX = 1           # a word's box grows by this on each side: Tesseract's boxes shave the outermost ink
NARROWER = 0.9        # the marks together cover less than this share of the crop
MARKS = 64            # the most boxes a link carries (Studio's contract)
LONGEST = 4000        # folded characters of a block, or of its reading, that are aligned
LANGUAGES = "eng+dan+deu+fra"
SECONDS = 30          # one reading's limit
KEPT = 512            # readings kept between the partial and final placements of an extraction


class Word(NamedTuple):
    text: str
    box: Pixels             # in the crop's pixels
    line: tuple[int, ...]   # the reader's own line identity


def _disorder(words: list[Word], size: tuple[int, int]) -> str | None:
    """Why `words` are not in the order of their places, left to right along each line and line under line, or None.
    Middles are compared, not edges: the boxes of neighbouring words and lines often touch or nest, and a value beside
    such a touch is refused on its own (`Scan.place`), not its whole block. Two columns read row by row pass: nothing
    here shows that the block is one column, so `Scan._words` never relies on it."""
    width, height = size
    lines: list[list[Word]] = []
    seen = set()
    for word in words:
        x0, y0, x1, y1 = word.box
        if not (0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height):
            return "word outside the crop"
        if not lines or word.line != lines[-1][0].line:
            if word.line in seen:
                return "lines out of order"
            seen.add(word.line)
            lines.append([])
        lines[-1].append(word)
    lowest = None
    for line in lines:
        if any(b.box[0] + b.box[2] <= a.box[0] + a.box[2] for a, b in pairwise(line)) \
                or max(word.box[1] for word in line) >= min(word.box[3] for word in line):
            return "words out of order"
        middles = [word.box[1] + word.box[3] for word in line]
        if lowest is not None and min(middles) <= lowest:
            return "lines out of order"
        lowest = max(middles)
    return None


def _distances(a: str, b: np.ndarray) -> np.ndarray:
    """The edit distance of every prefix of `a` to every prefix of `b` (code points), at unit costs. No distance
    passes LONGEST, so sixteen bits hold every sum of two."""
    reach = np.arange(len(b) + 1, dtype=np.int16)
    rows = np.empty((len(a) + 1, len(b) + 1), dtype=np.int16)
    rows[0] = reach
    for i, char in enumerate(a, 1):
        row = rows[i]
        row[0] = i
        np.minimum(rows[i - 1, 1:] + 1, rows[i - 1, :-1] + (b != ord(char)), out=row[1:])
        np.minimum.accumulate(row - reach, out=row)  # a run of insertions: row[j] = min over k <= j of row[k] + j - k
        row += reach
    return rows


def _spelled(texts: list[str]) -> tuple[str, list[int], list[int]]:
    """The folded spelling of `texts` joined, and where each of them starts and ends in it."""
    each = [folded(text)[0] for text in texts]
    ends = list(accumulate(map(len, each)))
    return "".join(each), [end - len(one) for end, one in zip(ends, each)], ends


def _twice(text: str, letters: str) -> bool:
    """Whether `letters` occur in `text` more than once, overlapping included."""
    return text.find(letters, text.find(letters) + 1) >= 0


class Scan:
    """A block's canonical `text` beside the `words` a reader placed on its crop of `size` pixels."""

    def __init__(self, text: str, words: list[Word], size: tuple[int, int]):
        self.text, self.words, self.size = text, words, size
        self.seg, self.owner = folded(text)
        self.ocr, self.starts, self.ends = _spelled([word.text for word in words])
        self._tables: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None
        if not words or not self.seg or not self.ocr:
            self.refusal: str | None = "nothing read"
        elif max(len(self.seg), len(self.ocr)) > LONGEST:
            self.refusal = "block too long"
        else:
            self.refusal = _disorder(words, size)

    def _aligned(self, left: int, right: int) -> int | str:
        """Where `seg[left:right]` starts in the reading, when every alignment of the two texts within SLACK edits
        of the best maps each of its characters, unchanged, to the same character of the reading; else why not. An
        edit is allowed on a path when the best prefix before it and the best suffix after it stay within the budget,
        so no path is enumerated."""
        seg, n, m = self.seg, len(self.seg), len(self.ocr)
        if self._tables is None:
            codes = np.array([ord(char) for char in self.ocr], dtype=np.int32)
            self._tables = codes, _distances(seg, codes), _distances(seg[::-1], codes[::-1])[::-1, ::-1]
        codes, before, after = self._tables  # after[i, j]: seg[i:] against ocr[j:]
        budget = int(before[n, m]) + SLACK
        mapped: list[int] = []
        for i in range(left, right + 1):
            if (left < i < right or i == 0 == left or i == n == right) \
                    and (before[i, :-1] + 1 + after[i, 1:] <= budget).any():
                return "read differently"  # something else is read inside it, or before or after a text edge
            if i == right:
                break
            if (before[i] + 1 + after[i + 1] <= budget).any():
                return "read differently"  # a character of it can go unread
            same = codes == ord(seg[i])
            onto = np.flatnonzero(before[i, :-1] + ~same + after[i + 1, 1:] <= budget)
            if len(onto) != 1 or not same[onto[0]]:
                return "read differently"
            mapped.append(int(onto[0]))
        if mapped != list(range(mapped[0], mapped[0] + right - left)):
            return "read differently"
        if (left == 0 and mapped[0] != 0) or (right == n and mapped[-1] != m - 1):
            return "edge not anchored"
        return mapped[0]

    def _words(self, start: int, end: int) -> list[int] | str:
        """The words that print `text[start:end]`, or why they are not known. The value's folded letters must occur
        once in the text and once in the reading, inside a longer word and across words included: aligned text cannot
        tell two printings of the same letters apart when the readers took the block in different orders, and a reader
        that breaks words apart differently can make a word of either, so a value whose letters repeat is never chosen
        by position."""
        if not 0 <= start < end <= len(self.text):
            return "empty"
        lo, hi = bisect_left(self.owner, start), bisect_left(self.owner, end)
        if lo == hi:
            return "empty"
        if _twice(self.seg, self.seg[lo:hi]):
            return "printed twice"
        left = max(0, lo - CONTEXT)
        at = self._aligned(left, min(len(self.seg), hi + CONTEXT))
        if isinstance(at, str):
            return at
        if _twice(self.ocr, self.seg[lo:hi]):
            return "printed twice"
        first = at + lo - left
        last = first + hi - lo
        chosen = [index for index, (begin, finish) in enumerate(zip(self.starts, self.ends))
                  if begin < last and finish > first]
        # Whole printed words only: a word's box says nothing of where a comma or a syllable inside it ends.
        tokens = [token for token in re.finditer(r"\S+", self.text) if token.start() < end and token.end() > start]
        if not chosen or self.starts[chosen[0]] != first or self.ends[chosen[-1]] != last \
                or tokens[0].start() != start or tokens[-1].end() != end \
                or "".join(self.text[start:end].split()) != "".join(self.words[index].text for index in chosen):
            return "not whole words"
        return chosen

    def place(self, spans: list[tuple[int, int]]) -> list[Pixels] | str:
        """One box per printed word of the value, in the crop's pixels, or the reason there is none: each word's
        own box grown by GROW_PX, inside the crop, clear of every other word's box."""
        if self.refusal is not None:
            return self.refusal
        chosen: list[int] = []
        for start, end in spans:
            found = self._words(start, end)
            if isinstance(found, str):
                return found
            chosen += found
        if len(set(chosen)) != len(chosen):
            return "spans overlap"
        if len(chosen) > MARKS:
            return "too many words"
        width, height = self.size
        boxes: list[Pixels] = []
        for index in chosen:
            x0, y0, x1, y1 = self.words[index].box
            x0, y0, x1, y1 = box = (x0 - GROW_PX, y0 - GROW_PX, x1 + GROW_PX, y1 + GROW_PX)
            if x0 < 0 or y0 < 0 or x1 > width or y1 > height:
                return "at the crop's edge"
            if any(other not in chosen and max(x0, a) < min(x1, c) and max(y0, b) < min(y1, d)
                   for other, (_, (a, b, c, d), _) in enumerate(self.words)):
                return "touches another word"
            boxes.append(box)
        if sum((x1 - x0) * (y1 - y0) for x0, y0, x1, y1 in boxes) >= NARROWER * width * height:
            return "not narrower than its block"
        return boxes


def available() -> bool:
    """Whether the reader is installed. Without it nothing here runs and every link keeps what it had."""
    return shutil.which("tesseract") is not None


def read(crop: np.ndarray, seconds: float = SECONDS) -> list[Word] | None:
    """The words Tesseract reads on the grey image `crop`, in its order, or None when it fails or runs out of
    `seconds`. The crop gets a border in its own paper tone (the lower median of its outermost ring)."""
    ring = np.concatenate([crop[0], crop[-1], crop[1:-1, 0], crop[1:-1, -1]])
    tone = int(np.sort(ring)[(len(ring) - 1) // 2])
    png = io.BytesIO()
    Image.fromarray(np.pad(crop, PAD_PX, constant_values=tone)).save(png, format="PNG")
    try:
        done = subprocess.run(
            ["nice", "-n", "10", "tesseract", "stdin", "stdout", "--oem", "1", "--psm", "6", "-l", LANGUAGES,
             "--dpi", str(72 * SCALE), "tsv"], input=png.getvalue(), capture_output=True, timeout=seconds,
            env={**os.environ, "OMP_THREAD_LIMIT": "1"})  # one thread: conversions share the processor
        if done.returncode:
            return None
        words = []
        for row in done.stdout.decode("utf-8").splitlines()[1:]:
            cells = row.split("\t")
            if cells[0] == "5" and cells[11].strip():  # a word; its box is left, top, width, height
                left, top, width, height = (int(cell) for cell in cells[6:10])
                words.append(Word(cells[11], (left - PAD_PX, top - PAD_PX, left + width - PAD_PX,
                                              top + height - PAD_PX), tuple(int(cell) for cell in cells[1:5])))
        return words
    except (OSError, subprocess.TimeoutExpired, ValueError, IndexError):
        return None


_READINGS: dict[tuple[str, int, Pixels], list[Word]] = {}


class Page:
    """One rendered page of a run's PDF, whose blocks are read at most once each (`_READINGS` keeps a reading for
    the extraction's later placements) and until `deadline` (`time.monotonic`)."""

    def __init__(self, pdf: Path, number: int, image: np.ndarray, deadline: float):
        self.pdf, self.number, self.image, self.deadline = str(pdf), number, image, deadline
        self.scans: dict[tuple[Pixels, str], Scan | str] = {}

    def _scan(self, text: str, anchor: tuple[float, float, float, float]) -> tuple[Pixels, Scan | str]:
        x0, y0, x1, y1 = (round(value * SCALE) for value in anchor)
        height, width = self.image.shape
        crop = (max(0, x0 - MARGIN_PX), max(0, y0 - MARGIN_PX), min(width, x1 + MARGIN_PX), min(height, y1 + MARGIN_PX))
        if (crop, text) not in self.scans:
            words = _READINGS.get((self.pdf, self.number, crop))
            if words is None and crop[0] < crop[2] and crop[1] < crop[3]:
                left = self.deadline - time.monotonic()
                if left <= 0:
                    return crop, "out of time"  # not remembered: a later placement may have time
                words = read(self.image[crop[1]:crop[3], crop[0]:crop[2]], min(SECONDS, left))
                if words is not None:
                    if len(_READINGS) >= KEPT:
                        _READINGS.clear()
                    _READINGS[self.pdf, self.number, crop] = words
            self.scans[crop, text] = "not read" if words is None else Scan(
                text, words, (crop[2] - crop[0], crop[3] - crop[1]))
        return crop, self.scans[crop, text]

    def place(self, text: str, spans: list[tuple[int, int]],
              anchor: tuple[float, float, float, float]) -> list[list[float]] | str:
        """The value's boxes in page points, rounded as every value mark's are, or the reason there is none."""
        crop, scan = self._scan(text, anchor)
        boxes = scan if isinstance(scan, str) else scan.place(spans)
        if isinstance(boxes, str):
            return boxes
        return [[round((crop[0] + x0) / SCALE, 2), round((crop[1] + y0) / SCALE, 2),
                 round((crop[0] + x1) / SCALE, 2), round((crop[1] + y1) / SCALE, 2)] for x0, y0, x1, y1 in boxes]
