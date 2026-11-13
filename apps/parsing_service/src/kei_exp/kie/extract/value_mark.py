"""Value marks (docs/adr/0031): where a linked value prints on its PDF page, one box per printed line inside its
Evidence Anchor's box, added to the link as `value_boxes_pt` (PDF points from the top-left of the displayed page, as
`bbox_pt` is, on the link's own page).

The one exception to "Extraction reads canonical results only": the run's own `input.pdf`, immutable and verified by
digest when the run was prepared, is read with pdfium to place a printing that canonical text already located, and for
nothing else. Nothing read from it changes a value, a link's anchor, a span or a status, and a missing or unreadable
PDF only leaves links without boxes.

A span counts code points of canonical text, which is not the PDF's (line joins, hyphens, ligatures, quotation
marks), so the value is found again among the characters under the anchor's box: never by searching for the value
alone, only where it and its surroundings print exactly once. From the PDF's own characters a placement is
deterministic; one from the page image (`scan_mark`) also depends on a reading that may fail or run out of time, so a
later placement of the same link may differ, and a snapshot, whose identity digests its links, is then another one.
"""
from __future__ import annotations

import re
import time
import unicodedata
from bisect import bisect_left
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium

from kei_exp._pdfium import pdfium_lock
from kei_exp.kie.passages import Passage

Box = tuple[float, float, float, float]

CONTEXT = 8           # folded characters of printed surroundings the match needs on each side of the value
UNDER_PT = 1.0        # a character is under an anchor box when its middle lies within this of the box
INSIDE_PT = 2.0       # every placed box lies within this of one of the anchor's boxes, or the link gets none
QUOTES = frozenset("'\"`´‘’‚‛“”„‟«»‹›")
# Two readers break and join lines differently; `passages.load` stores an undecodable NUL as U+FFFD.
DROPPED = frozenset("-\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u00ad\x00\x02\ufffd")
SAME = str.maketrans({"⁄": "/", "•": "·"})
# A block the OCR model read is placed through the PDF's text layer, which nothing ties to the image: its page must be
# in register and its value's boxes on ink (`registration`, `on_ink`), judged on the page rendered at SCALE.
SCALE = 3             # pixels per point of the rendered page
INK = 150             # a grey value under this is ink
MIN_PX = 6            # a box less high cannot be judged
UPRIGHT = 0.75        # share of the ink within half a box height above and below that must lie inside the box
GAP_PX, GAP_SHARE = 3, 0.2  # a word gap is at least this many columns, or this share of the box height, wide
TOKEN_CHARS = 4       # a token that registers a page has at least this many characters
TOKENS = 200          # at most this many tokens are judged per page, chosen evenly
JUDGED = 20           # a page is judged on at least this many tokens
REGISTERED = 0.8      # share of judged tokens on ink that registers a page
SCAN_SECONDS = 120    # what one call may spend reading page images for words (`scan_mark`)


def folded(chars: Iterable[str]) -> tuple[str, list[int]]:
    """The comparable spelling of a run of characters, and for each of its characters the index it came from: no
    white space, hyphens or NULs, ligatures unfolded (NFKC), one quotation mark."""
    out: list[str] = []
    owners: list[int] = []
    for index, char in enumerate(chars):
        for piece in unicodedata.normalize("NFKC", char.translate(SAME)):
            if piece.isspace() or piece in DROPPED:
                continue
            out.append("'" if piece in QUOTES else piece)
            owners.append(index)
    return "".join(out), owners


def value_boxes(text: str, start: int, end: int, characters: Sequence[tuple[str, Box]]) -> list[Box] | str:
    """One box per printed line for `text[start:end]` among `characters` (those under the anchor's box, in pdfium's
    order), or the reason there is none. The value with CONTEXT folded characters on each side must occur exactly once;
    while it occurs more often the surroundings double, until unique or the whole text. Where the text ends first,
    nothing else may print before, or after, under the box."""
    return _match(*folded(text), *folded(char for char, _ in characters), [box for _, box in characters], start, end)


def _match(seg: str, seg_owner: list[int], hay: str, hay_owner: list[int], boxes: Sequence[Box], start: int,
           end: int) -> list[Box] | str:
    """`value_boxes` over texts already folded, so a page's every token is matched without folding it again."""
    lo, hi = bisect_left(seg_owner, start), bisect_left(seg_owner, end)
    if lo == hi:
        return "empty"
    context = CONTEXT
    while True:
        left, right = max(0, lo - context), min(len(seg), hi + context)
        needle = seg[left:right]
        at = hay.find(needle)
        if at < 0:
            return "not printed"
        if hay.find(needle, at + 1) < 0:
            break
        if left == 0 and right == len(seg):
            return "printed twice"
        context *= 2
    if (lo - left < context and at != 0) or (right - hi < context and at + len(needle) != len(hay)):
        return "edge not anchored"
    first = at + lo - left
    return _lines(boxes[index] for index in sorted({hay_owner[i] for i in range(first, first + hi - lo)}))


def _lines(boxes: Iterable[Box]) -> list[Box]:
    """The characters' boxes joined per printed line. A character joins the current line unless it goes back behind
    the line's left edge, or is further from it than half the taller height vertically or twice it horizontally: so
    a comma, a low quotation mark or an underscore stays on its line, and a wrapped line or a new column starts anew."""
    lines: list[list[float]] = []
    for x0, y0, x1, y1 in boxes:
        if lines:
            line = lines[-1]
            taller = max(y1 - y0, line[3] - line[1])
            if (x0 >= line[0] and max(y0, line[1]) - min(y1, line[3]) <= taller / 2
                    and x0 - line[2] <= 2 * taller):
                line[1:] = [min(line[1], y0), max(line[2], x1), max(line[3], y1)]
                continue
        lines.append([x0, y0, x1, y1])
    return [(x0, y0, x1, y1) for x0, y0, x1, y1 in lines]


def _under(characters: Sequence[tuple[str, Box]], anchors: Sequence[Box]) -> list[tuple[str, Box]]:
    """The characters whose middle lies in one of the anchor's boxes."""
    return [(char, box) for char, box in characters if any(
        x0 - UNDER_PT <= (box[0] + box[2]) / 2 <= x1 + UNDER_PT
        and y0 - UNDER_PT <= (box[1] + box[3]) / 2 <= y1 + UNDER_PT for x0, y0, x1, y1 in anchors)]


def page_characters(document: pdfium.PdfDocument, number: int,
                    render: bool = False) -> tuple[list[tuple[str, Box]], np.ndarray | None] | None:
    """Every character pdfium reads on page `number` (1-based), painted or not (a scan's text layer is not), with its
    box in displayed top-left points, as `native_regions` measures it, and when `render` the page's grey image at
    SCALE pixels per point; None for a page whose rotation is not 0, whose boxes the rule was never measured on. The
    caller holds `pdfium_lock`."""
    page = document[number - 1]
    try:
        if page.get_rotation():
            return None
        textpage = page.get_textpage()
        try:
            x0, _y0, _x1, y1 = page.get_bbox()  # the displayed page in canvas space: MediaBox and CropBox
            characters = []
            for index in range(textpage.count_chars()):
                left, bottom, right, top = textpage.get_charbox(index)
                characters.append((chr(min(pdfium.raw.FPDFText_GetUnicode(textpage, index), 0x10FFFF)),
                                   (left - x0, y1 - top, right - x0, y1 - bottom)))
        finally:
            textpage.close()
        image = None
        if render:
            bitmap = page.render(scale=SCALE, grayscale=True)
            try:
                image = bitmap.to_numpy().copy()  # the bitmap's own buffer is freed with it
            finally:
                bitmap.close()
            image = image if image.ndim == 2 else image[:, :, 0]
        return characters, image
    finally:
        page.close()


def _gap_near(empty: np.ndarray, edge: int, reach: int, need: int) -> bool:
    """A run of at least `need` ink-free columns that touches [edge - reach, edge + reach]."""
    low, high = max(0, edge - reach), min(len(empty), edge + reach + 1)
    run = 0
    for column in range(max(0, low - need), min(len(empty), high + need)):
        run = run + 1 if empty[column] else 0
        if run >= need and column >= low and column - run + 1 <= high:
            return True
    return False


def on_ink(image: np.ndarray, box: Box, *, token: bool) -> bool | None:
    """Whether `box` sits on the page image's ink, or None when it is too small to judge: more than half its pixel
    columns hold ink, and UPRIGHT of the ink within half its height above and below lies inside it (a box half a line
    off fails). A whole `token` also needs a word gap at each side edge, which a box on another line's words lacks; a
    value need not, since it is not always a whole token."""
    x0, y0, x1, y1 = (int(round(value * SCALE)) for value in box)
    height = y1 - y0
    if height < MIN_PX or x1 <= x0 or (token and x1 - x0 < 2 * height) or y0 < 0 or x0 < 0 \
            or y1 > image.shape[0] or x1 > image.shape[1]:
        return None
    columns = (image[y0:y1, :] < INK).sum(axis=0)
    around = int((image[max(0, y0 - height // 2):y1 + height // 2, x0:x1] < INK).sum())
    if not (float((columns[x0:x1] > 1).mean()) > 0.5 and around > 0
            and int((image[y0:y1, x0:x1] < INK).sum()) >= UPRIGHT * around):
        return False
    if not token:
        return True
    empty, need, reach = columns <= 1, max(GAP_PX, round(GAP_SHARE * height)), round(height / 2)
    return _gap_near(empty, x0, reach, need) and _gap_near(empty, x1, reach, need)


def registration(characters: Sequence[tuple[str, Box]], image: np.ndarray, passages: Iterable[Passage]) -> str | None:
    """None when the page's text layer is in register with its image, else why not. Every whitespace-delimited token
    of TOKEN_CHARS or more in the page's OCR-read block passages (tables aside) is placed by the rule; of those placed
    as one box, at most TOKENS chosen evenly are judged, and the page is registered when JUDGED or more were judged and
    REGISTERED of them are on ink. A text layer shifted against the image puts its boxes in the gaps between lines."""
    placed: list[Box] = []
    for passage in passages:
        under = _under(characters, passage.boxes_pt or (passage.bbox_pt,))
        seg, hay = folded(passage.text), folded(char for char, _ in under)
        boxes = [box for _, box in under]
        for token in re.finditer(r"\S{%d,}" % TOKEN_CHARS, passage.text):
            found = _match(*seg, *hay, boxes, token.start(), token.end())
            if not isinstance(found, str) and len(found) == 1:
                placed += found
    chosen = placed if len(placed) <= TOKENS else [placed[i * len(placed) // TOKENS] for i in range(TOKENS)]
    verdicts = [verdict for box in chosen if (verdict := on_ink(image, box, token=True)) is not None]
    if len(verdicts) < JUDGED:
        return "too few boxes to judge"
    return None if sum(verdicts) >= REGISTERED * len(verdicts) else "page not registered"


def _wanted(link: dict, passages: Mapping[str, Passage]) -> tuple[str, list[tuple[int, int]], list[Box], bool] | None:
    """The text, the value's spans in it, the anchor's boxes and whether the OCR model read it, of a link a value mark
    is placed for (ADR 0031, "Which links"), or None: a version 1 link's `location`, a version 2 link's `spans`, a
    version 3 link's `spans` when its support is literal; each in the link's own segment; never an `input`-precision
    link or a whole table. A cell link is placed in its cell's box from the cell's own text."""
    if link.get("location"):
        spans = link["location"]["spans"]
    elif link.get("support", "literal") == "literal":  # version 2 links name no support: every one prints its value
        spans = link.get("spans")
    else:
        return None
    passage = passages.get(link["segment"])
    if not spans or passage is None or link.get("precision") == "input" or passage.precision == "input" \
            or any(span["segment"] != link["segment"] for span in spans):
        return None
    if link.get("cell"):
        cell = next((each for each in passage.table.cells if each.cell_id == link["cell"]), None) \
            if passage.table else None
        if cell is None or cell.bbox_pt is None \
                or not all(cell.start <= span["start"] < span["end"] <= cell.end for span in spans):
            return None
        return (cell.text, [(span["start"] - cell.start, span["end"] - cell.start) for span in spans], [cell.bbox_pt],
                passage.ocr)
    if passage.label == "Table" or passage.table is not None:
        return None
    return (passage.text, [(span["start"], span["end"]) for span in spans],
            list(passage.boxes_pt or (passage.bbox_pt,)), passage.ocr)


def place(wanted: tuple[str, list[tuple[int, int]], list[Box]], characters: Sequence[tuple[str, Box]]) \
        -> list[list[float]] | str:
    """The value mark's boxes, rounded, when every span is placed and every box lies inside one of the anchor's
    boxes; otherwise the reason."""
    text, spans, anchors = wanted[:3]
    under = _under(characters, anchors)
    boxes: list[Box] = []
    for start, end in spans:
        found = value_boxes(text, start, end, under)
        if isinstance(found, str):
            return found
        boxes += found
    rounded = [[round(value, 2) for value in box] for box in boxes]
    return rounded if _inside(rounded, anchors) else "outside anchor"


def _inside(boxes: Sequence[Sequence[float]], anchors: Sequence[Box]) -> bool:
    """Whether every box lies inside one of the anchor's boxes, within INSIDE_PT."""
    return all(any(x0 - INSIDE_PT <= a and y0 - INSIDE_PT <= b and c <= x1 + INSIDE_PT and d <= y1 + INSIDE_PT
                   for x0, y0, x1, y1 in anchors) for a, b, c, d in boxes)


def place_links(links: Iterable[dict], passages: Iterable[Passage], pdf: Path | None) -> Counter:
    """Places a value mark on every link of `links` it can, in place, from `pdf` (the run's `input.pdf`; None for a
    caller with no run directory). The PDF is opened once and read a page at a time, under the process-wide pdfium
    lock only while pdfium runs, for the pages the links cite; a page is rendered only where an OCR-read block is placed
    on, and its image is dropped before the next page is read. A value on a block the OCR model read is placed only on
    a registered page and only where each of its boxes is on the image's ink: its position is the text layer's, which
    may be shifted against the image. Where that places none, the block's own crop of the page image is read for its
    words (`scan_mark`), for at most SCAN_SECONDS a call; without the reader installed the link keeps what it had.
    Returns the counts the extraction logs: `spans` (links a mark is placed for), `placed`, `scan` (those of them
    placed from the page image), and every refusal by its reason: the page image's, as `scan: ...`, where it was
    read."""
    from kei_exp.kie.extract import scan_mark  # it builds on this module
    deadline = time.monotonic() + SCAN_SECONDS if scan_mark.available() else None
    passages = list(passages)
    by_id = {passage.id: passage for passage in passages}
    pages: dict[int, list[tuple[dict, tuple]]] = {}
    for link in links:
        if (wanted := _wanted(link, by_id)) is not None:
            pages.setdefault(link["page"], []).append((link, wanted))
    counts = Counter(spans=sum(map(len, pages.values())), placed=0)
    document, length = None, 0
    try:
        if pages and pdf is not None:
            try:
                with pdfium_lock:
                    document = pdfium.PdfDocument(str(pdf))
                    length = len(document)
            except Exception:  # a missing or unreadable PDF: no boxes, never a failed extraction
                document = None
        for number in sorted(pages):
            todo = pages[number]
            try:
                if document is None or not 1 <= number <= length:
                    raise ValueError(number)
                with pdfium_lock:
                    read = page_characters(document, number, render=any(wanted[3] for _, wanted in todo))
            except Exception:
                counts["pdf unreadable"] += len(todo)
                continue
            if read is None:
                counts["rotated page"] += len(todo)
                continue
            characters, image = read
            registered: str | None | bool = False  # False until the page is judged
            scan = None if deadline is None or image is None else scan_mark.Page(image, deadline)
            for link, wanted in todo:
                reason = boxes = place(wanted, characters)
                if not isinstance(boxes, str):
                    reason = None
                    if wanted[3]:
                        if registered is False:
                            registered = registration(characters, image, [
                                each for each in passages if each.page == number and each.ocr
                                and each.extent == "block" and each.label != "Table" and each.table is None])
                        reason = registered or next(
                            ("value box off the ink" for box in boxes if not on_ink(image, box, token=False)), None)
                # A block of one box the OCR model read, not a cell: the only crops the page image was measured on.
                if reason is not None and scan is not None and wanted[3] and len(wanted[2]) == 1 \
                        and not link.get("cell"):
                    try:
                        boxes = scan.place(wanted[0], wanted[1], wanted[2][0])
                    except Exception:  # as an unreadable PDF: no boxes, never a failed extraction
                        boxes = "error"
                    if not isinstance(boxes, str) and not _inside(boxes, wanted[2]):
                        boxes = "outside anchor"
                    reason = f"scan: {boxes}" if isinstance(boxes, str) else None
                    if reason is None:
                        counts["scan"] += 1
                if reason is None:
                    link["value_boxes_pt"] = boxes
                counts[reason or "placed"] += 1
    finally:
        if document is not None:
            with pdfium_lock:
                document.close()
    return counts
