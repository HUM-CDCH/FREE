"""Value marks (ADR 0031) placed on PDFs this file writes, so where each value prints comes from the generator.

The pages are set in Courier, whose every glyph advances 600/1000 em, so character `i` of a line printed at `x`
occupies [x + 6i, x + 6i + 6) at 10 pt: `assert_at` holds every box to that place (a box one character off, or on
another line, fails), never to what pdfium reports. A Courier fi ligature is one glyph in one advance. reportlab is
not installed in this service's dev environment, so the PDFs are written by hand (`write_pdf`).
"""
import json
import logging
import zlib
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
import pytest

from kei_exp.kie.extract import run, unified
from kei_exp.kie.extract.acceptance import Outcome
from kei_exp.kie.extract.assembly import link_json
from kei_exp.kie.extract.catalog_result import evidence_link
from kei_exp.kie.extract.grounding import _Candidate, _link, _location
from kei_exp.kie.extract.value_mark import CONTEXT, folded, on_ink, place, place_links, value_boxes
from kei_exp.kie.blocks import Span
from kei_exp.kie.passages import Evidence, Passage, load
from kei_exp.pagefile import PageTable, TableCell
from tests.helpers import catalogue
from tests.test_durable_extraction import MemoryLease, finish, linked_while_running
from tests.test_extract_grounded import CountingChat
from tests.test_extract_stages import SCHEMA
from tests.test_unified_catalog import Model, request as unified_request

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "contracts" / "value-mark-link.json").read_text())
SIZE, ADVANCE, HEIGHT = 10.0, 6.0, 792.0  # Courier at 10 pt on a US Letter page
LIGATURE = "\xae"  # StandardEncoding's fi, the built-in encoding of the standard Courier


def write_pdf(path: Path, pages: list[list[tuple[float, float, str]]], rotate: int = 0,
              scan: np.ndarray | None = None, font: bytes = b"Courier") -> Path:
    """One page per list of lines `(x, baseline from the page's top, text)`, in Courier 10 pt. With `scan` (a grey
    image) every page is a scan: the image covers it and the lines are an invisible text layer (render mode 3)."""
    objects: list[bytes] = [b"<< /Type /Catalog /Pages 2 0 R >>", b"",
                            b"<< /Type /Font /Subtype /Type1 /BaseFont /%s >>" % font]
    if scan is not None:
        data = zlib.compress(np.ascontiguousarray(scan, dtype=np.uint8).tobytes())
        objects.append(b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray "
                       b"/BitsPerComponent 8 /Filter /FlateDecode /Length %d >>\nstream\n%s\nendstream"
                       % (scan.shape[1], scan.shape[0], len(data), data))
    kids = []
    for lines in pages:
        stream = b"q 612 0 0 %g 0 0 cm /Im0 Do Q\n" % HEIGHT if scan is not None else b""
        escaped = [(x, y, text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")) for x, y, text in lines]
        stream += b"".join(b"BT %d Tr /F1 %g Tf %g %g Td (%s) Tj ET\n" % (
            0 if scan is None else 3, SIZE, x, HEIGHT - y, text.encode("latin-1")) for x, y, text in escaped)
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
        objects.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 %g] /Rotate %d /Resources << /Font "
                       b"<< /F1 3 0 R >>%s >> /Contents %d 0 R >>" % (
                           HEIGHT, rotate, b" /XObject << /Im0 4 0 R >>" if scan is not None else b"", len(objects)))
        kids.append(len(objects))
    objects[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % k for k in kids), len(kids))
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    path.write_bytes(bytes(out))
    return path


def around(lines) -> tuple[float, float, float, float]:
    """The block box a parser would give these lines: their advance cells, from ascender to descender."""
    return (min(x for x, _, _ in lines) - 1, min(y for _, y, _ in lines) - SIZE,
            max(x + ADVANCE * len(text) for x, _, text in lines) + 1, max(y for _, y, _ in lines) + 3)


def assert_at(box, x: float, y: float, start: int, end: int) -> None:
    """`box` covers characters [start, end) of the line printed at (x, y), and nothing beside them."""
    left, right = x + ADVANCE * start, x + ADVANCE * end
    assert left - 0.5 <= box[0] <= left + 2.5 and right - 2.5 <= box[2] <= right + 0.5, (box, left, right)
    assert y - SIZE <= box[1] < box[3] <= y + 3, (box, y)


def block(text: str, lines, *, pid: str = "p1_s0", boxes=None, **extra) -> Passage:
    page, index = (int(part) for part in pid[1:].split("_s"))
    boxes = boxes or (around(lines),)
    return Passage(id=pid, page=page, index=index, text=text, label=extra.pop("label", "Text"), bbox_pt=boxes[0],
                   extent="block", boxes_pt=boxes if len(boxes) > 1 else None, **extra)


def located(passage: Passage, value: str, nth: int = 0, cell: str | None = None) -> dict:
    """A version 1 (Article) link locating the `nth` printing of `value` in `passage`."""
    start = -1
    for _ in range(nth + 1):
        start = passage.text.index(value, start + 1)
    return {"path": ["records", 0, "site"], "segment": passage.id, "page": passage.page,
            "bbox_pt": list(passage.bbox_pt), "verbatim": True, "hits": 1, "linked_by": "model", "cell": cell,
            "precision": "cell" if cell else "segment",
            "location": {"spans": [{"segment": passage.id, "start": start, "end": start + len(value)}], "raw": value}}


def marked(tmp_path, pages, passage, link, rotate=0):
    """The link after placing it on the PDF of `pages`, and the counts."""
    counts = place_links([link], [passage], write_pdf(tmp_path / "input.pdf", pages, rotate))
    return link.get("value_boxes_pt"), counts


# --- the gate cases ------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("text, value", [("Charcoal gave a radiocarbon date of 1962.", "radiocarbon"),
                                         ("Charcoal gave a radio-carbon date of 1962.", "radio-carbon")])
def test_a_value_broken_by_a_hyphen_at_a_line_end_gets_one_box_per_line(tmp_path, text, value):
    lines = [(72, 100, "Charcoal gave a radio-"), (72, 114, "carbon date of 1962.")]
    passage = block(text, lines)
    boxes, counts = marked(tmp_path, [lines], passage, located(passage, value))
    assert len(boxes) == 2 and counts == {"spans": 1, "placed": 1}
    assert_at(boxes[0], 72, 100, 16, 21)  # the hyphen is not the value's
    assert_at(boxes[1], 72, 114, 0, 6)
    boxes, _ = marked(tmp_path, [lines], passage, located(passage, "1962"))
    assert len(boxes) == 1
    assert_at(boxes[0], 72, 114, 15, 19)


def test_a_paragraph_printed_in_two_columns_is_placed_in_both_of_its_boxes(tmp_path):
    first = [(72, 100, "The survey of 1971 found"), (72, 114, "a harbour wall at Cedar")]
    second = [(320, 100, "Bay and a slipway near"), (320, 114, "the old quay.")]
    text = "The survey of 1971 found a harbour wall at Cedar Bay and a slipway near the old quay."
    passage = block(text, first + second, boxes=(around(first), around(second)))
    boxes, _ = marked(tmp_path, [first + second], passage, located(passage, "Cedar Bay"))
    assert len(boxes) == 2
    assert_at(boxes[0], 72, 114, 18, 23)
    assert_at(boxes[1], 320, 100, 0, 3)
    # Its first box alone does not print "Bay": every box of the block is the anchor.
    alone = block(text, first + second, boxes=(around(first),))
    assert marked(tmp_path, [first + second], alone, located(alone, "Cedar Bay")) == (None, {"spans": 1, "placed": 0,
                                                                                            "not printed": 1})


def test_a_passage_keeps_every_box_its_segment_is_printed_in(tmp_path):
    first, second = (11.0, 361.0, 96.0, 391.0), (106.0, 11.0, 191.0, 41.0)
    run_dir = catalogue.write({"transcriber": "native", "pages": [{"page": 1, "units": [{"index": 0, "segments": [
        {"text": "merged across a column", "bbox_pt": first, "boxes_pt": [first, second]},
        {"text": "in one place", "bbox_pt": second}]}]}]}, tmp_path)
    merged, single = load(run_dir).passages
    assert merged.boxes_pt == (first, second) and single.boxes_pt is None


@pytest.mark.parametrize("nth, y", [(0, 100), (1, 114)])
def test_a_repeated_phrase_is_told_apart_by_growing_its_surroundings(tmp_path, nth, y):
    lines = [(72, 100, "Find one: in the old red pot sherd lay here."),
             (72, 114, "Find two: in the old red pot sherd lay here.")]
    text = " ".join(line for _, _, line in lines)
    seg = folded(text)[0]
    at = seg.index("pot", seg.index("pot") + 1) if nth else seg.index("pot")
    assert seg.count(seg[at - CONTEXT:at + 3 + CONTEXT]) == 2  # the case needs more than CONTEXT
    passage = block(text, lines)
    boxes, _ = marked(tmp_path, [lines], passage, located(passage, "pot", nth))
    assert len(boxes) == 1
    assert_at(boxes[0], 72, y, 25, 28)


def test_a_value_printed_twice_with_the_same_surroundings_is_refused(tmp_path):
    lines = [(72, 100, "Height 12 cm."), (72, 114, "Height 12 cm.")]
    passage = block("Height 12 cm.", lines)
    assert marked(tmp_path, [lines], passage, located(passage, "12")) == (None, {"spans": 1, "placed": 0,
                                                                                 "printed twice": 1})


@pytest.mark.parametrize("text, value, start, end", [
    ("Soil from the field at Ostia.", "field", 14, 18),
    ("Soil from the \ufb01eld at Ostia.", "\ufb01eld", 14, 18),  # canonical text keeping the ligature
    ("Soil from the field at Ostia.", "the", 10, 13),  # beside it: the ligature is in its surroundings
    ("Soil from the field at Ostia.", "at", 19, 21)])
def test_a_ligature_in_or_beside_the_value_is_unfolded(tmp_path, text, value, start, end):
    lines = [(72, 100, f"Soil from the {LIGATURE}eld at Ostia.")]  # one glyph, one advance, for "fi"
    passage = block(text, lines)
    boxes, _ = marked(tmp_path, [lines], passage, located(passage, value))
    assert len(boxes) == 1
    assert_at(boxes[0], 72, 100, start, end)


def test_a_rotated_page_is_refused(tmp_path):
    lines = [(72, 100, "Found in 1962 at Ostia.")]
    passage = block("Found in 1962 at Ostia.", lines)
    assert marked(tmp_path, [lines], passage, located(passage, "1962"), rotate=90) == (
        None, {"spans": 1, "placed": 0, "rotated page": 1})


def test_a_table_cell_is_placed_in_its_own_box_from_its_own_text(tmp_path):
    lines = [(72, 100, "Depth  1.20 m"), (72, 114, "Width  1.20 m")]
    text = "Depth 1.20 m Width 1.20 m"
    cells = [TableCell(cell_id=f"r{row}_c{column}", row=row, column=column, rowspan=1, colspan=1, role=None,
                       text=text[start:end], start=start, end=end,
                       bbox_pt=around([(72 + ADVANCE * first, y, text[start:end])]))
             for row, y, spans in ((0, 100, ((0, 5, 0), (6, 12, 7))), (1, 114, ((13, 18, 0), (19, 25, 7))))
             for column, (start, end, first) in enumerate(spans)]
    table = PageTable(rows=2, columns=2, cells=cells, producer="test")
    passage = block(text, lines, label="Table", table=table)
    link = located(passage, "1.20", 1, cell="r1_c1") | {"bbox_pt": list(cells[3].bbox_pt)}
    boxes, _ = marked(tmp_path, [lines], passage, link)
    assert len(boxes) == 1
    assert_at(boxes[0], 72, 114, 7, 11)
    # A link to the whole table is never placed: it is not even counted.
    assert marked(tmp_path, [lines], passage, located(passage, "1.20")) == (None, {"spans": 0, "placed": 0})


def test_a_page_with_no_text_is_refused(tmp_path):
    passage = block("Found in 1962.", [(72, 100, "Found in 1962.")])
    assert marked(tmp_path, [[]], passage, located(passage, "1962")) == (None, {"spans": 1, "placed": 0,
                                                                               "not printed": 1})


@pytest.mark.parametrize("value, start, end", [("Amphora", 0, 7), ("12", 13, 15)])
def test_a_value_at_the_very_start_or_end_of_its_block_is_placed(tmp_path, value, start, end):
    neighbour = (72, 86, "Room 3.")  # another block, outside this one's box
    lines = [(72, 100, "Amphora 4 of 12")]
    passage = block("Amphora 4 of 12", lines)
    boxes, _ = marked(tmp_path, [[neighbour, *lines]], passage, located(passage, value))
    assert len(boxes) == 1
    assert_at(boxes[0], 72, 100, start, end)


def test_a_block_whose_box_covers_a_neighbours_characters_at_its_edge_is_refused(tmp_path):
    neighbour = (72, 86, "Room 3.")
    lines = [(72, 100, "Amphora 4 of 12")]
    x0, _, x1, y1 = around(lines)
    passage = block("Amphora 4 of 12", lines, boxes=((x0, 76.0, x1, y1),))  # reaches up over the neighbour
    assert marked(tmp_path, [[neighbour, *lines]], passage, located(passage, "Amphora")) == (
        None, {"spans": 1, "placed": 0, "edge not anchored": 1})


@pytest.mark.parametrize("value, start, end", [("AB_12", 5, 10), ("7,5", 17, 20), ("AB_12, then 7,5", 5, 20)])
def test_a_low_glyph_stays_on_its_line(tmp_path, value, start, end):
    lines = [(72, 100, "Code AB_12, then 7,5 kg.")]
    passage = block("Code AB_12, then 7,5 kg.", lines)
    boxes, _ = marked(tmp_path, [lines], passage, located(passage, value))
    assert len(boxes) == 1
    assert_at(boxes[0], 72, 100, start, end)


# --- the rule's own refusals ---------------------------------------------------------------------------------------

def characters(text: str) -> list[tuple[str, tuple[float, float, float, float]]]:
    return [(char, (6.0 * i, 0.0, 6.0 * i + 5, 7.0)) for i, char in enumerate(text)]


def test_the_value_is_never_found_alone():
    assert value_boxes("lot 12", 4, 6, characters("12")) == "not printed"  # its surroundings are not
    assert value_boxes("12 lots", 0, 2, characters("x12 lots")) == "edge not anchored"
    assert value_boxes("lot 12", 4, 6, []) == "not printed"
    assert value_boxes("lot -", 4, 5, [("-", (0.0, 0.0, 5.0, 7.0))]) == "empty"


def test_a_box_beyond_its_anchor_is_never_written():
    # The character's middle is under the anchor, its glyph far wider.
    assert place(("12", [(0, 2)], [(10.0, 0.0, 20.0, 10.0)]),
                 [("1", (5.0, 0.0, 15.0, 10.0)), ("2", (15.0, 0.0, 26.0, 10.0))]) == "outside anchor"


# --- a block the OCR model read: its text layer is checked against the page image ----------------------------------

PARAGRAPH = ["Trench four yielded several bronze fibulae and", "a fragment of painted plaster from the west",
             "wall, together with charcoal that gave a date", "near 1962 according to the original survey",
             "notes kept by the excavation team at Ostia.", "Pottery from the upper layers was mostly local",
             "coarse ware, with some imported amphorae and", "lamps whose stamps name three distinct workshops."]


def scanned(tmp_path: Path, texts: list[str], shift: float = 0.0, transcriber: str = "surya") -> Evidence:
    """A run whose `input.pdf` is a scan of `texts` (its ink an image of them in Courier Bold) under an invisible text
    layer `shift` points higher, and its evidence: one block over the printed lines, in a crop of the OCR model's
    result (a `native` result has no crop)."""
    lines = [(72, 100 + 14 * n, text) for n, text in enumerate(texts)]
    with pdfium.PdfDocument(str(write_pdf(tmp_path / "ink.pdf", [lines], font=b"Courier-Bold"))) as document:
        image = document[0].render(scale=3, grayscale=True).to_numpy()
    (tmp_path / "run").mkdir()
    write_pdf(tmp_path / "run" / "input.pdf", [[(x, y - shift, text) for x, y, text in lines]],
              scan=image if image.ndim == 2 else image[:, :, 0])
    return load(catalogue.write({"transcriber": transcriber, "size_pt": [612.0, 792.0], "pages": [{"page": 1, "units": [
        {"index": 0, "crops": [{"bbox_pt": [36.0, 36.0, 576.0, 756.0], "segments": [
            {"text": " ".join(texts), "bbox_pt": around(lines)}]}]}]}]}, tmp_path / "run"))


def test_a_value_box_is_judged_on_the_ink_inside_it_and_a_token_also_on_its_word_gaps():
    image = np.full((60, 180), 255, dtype=np.uint8)
    image[30:45, 30:120] = 0  # a word of ink, 30 x 5 points at SCALE 3, with white on every side
    assert on_ink(image, (10, 10, 40, 15), token=True) is True
    assert on_ink(image, (10, 10, 40, 15), token=False) is True
    assert on_ink(image, (10, 7.5, 40, 12.5), token=False) is False  # half a line up
    assert on_ink(image, (25, 10, 55, 15), token=False) is False  # half of it beside the ink
    assert on_ink(image, (14, 10, 36, 15), token=False) is True  # a value inside a word
    assert on_ink(image, (14, 10, 36, 15), token=True) is False  # no word gap at its sides
    assert on_ink(image, (10, 10, 40, 11.5), token=False) is None  # under MIN_PX high
    assert on_ink(image, (10, 10, 18, 15), token=True) is None  # a token less than twice as wide as high


def test_a_value_on_a_scan_whose_text_layer_is_in_register_is_placed(tmp_path):
    evidence = scanned(tmp_path, PARAGRAPH)
    assert evidence.passages[0].ocr and evidence.passages[0].crop is not None
    link = located(evidence.passages[0], "1962")
    assert place_links([link], evidence.passages, tmp_path / "run" / "input.pdf") == {"spans": 1, "placed": 1}
    assert_at(link["value_boxes_pt"][0], 72, 142, 5, 9)


@pytest.mark.parametrize("shift", [14.0, 7.0])  # one line up, half a line up
def test_a_value_on_a_scan_whose_text_layer_is_shifted_is_refused(tmp_path, shift):
    link = located((evidence := scanned(tmp_path, PARAGRAPH, shift)).passages[0], "1962")
    assert place_links([link], evidence.passages, tmp_path / "run" / "input.pdf") == {
        "spans": 1, "placed": 0, "page not registered": 1}
    assert "value_boxes_pt" not in link


def test_a_scan_with_too_few_tokens_to_judge_is_refused(tmp_path):
    link = located((evidence := scanned(tmp_path, ["Found near 1962 at Ostia by the survey team."])).passages[0],
                   "1962")
    assert place_links([link], evidence.passages, tmp_path / "run" / "input.pdf") == {
        "spans": 1, "placed": 0, "too few boxes to judge": 1}


def test_a_block_read_from_the_pdfs_own_text_is_never_checked_against_the_image(tmp_path):
    """The same shifted page, read natively: the text layer is the block's own text, placed where it prints."""
    evidence = scanned(tmp_path, PARAGRAPH, 14.0, transcriber="native")
    assert not evidence.passages[0].ocr and evidence.passages[0].crop is None
    link = located(evidence.passages[0], "1962")
    assert place_links([link], evidence.passages, tmp_path / "run" / "input.pdf") == {"spans": 1, "placed": 1}
    assert_at(link["value_boxes_pt"][0], 72, 128, 5, 9)


@pytest.mark.parametrize("pdf", [None, "missing.pdf", "garbage.pdf"])
def test_no_readable_pdf_means_no_boxes_never_a_failure(tmp_path, pdf):
    (tmp_path / "garbage.pdf").write_bytes(b"%PDF-1.4 not a pdf")
    passage = block("Found in 1962.", [(72, 100, "Found in 1962.")])
    link = located(passage, "1962")
    assert place_links([link], [passage], pdf and tmp_path / pdf) == {"spans": 1, "placed": 0, "pdf unreadable": 1}
    assert "value_boxes_pt" not in link


def test_only_links_that_print_their_value_in_their_own_segment_are_placed(tmp_path):
    lines = [(72, 100, "Found in 1962 at Ostia.")]
    passage = block("Found in 1962 at Ostia.", lines)
    spans = [{"segment": "p1_s0", "start": 9, "end": 13}]
    base = {"segment": "p1_s0", "page": 1, "cell": None, "precision": "segment"}
    links = [base | {"spans": spans},  # version 2
             base | {"spans": spans, "support": "literal"},  # version 3, literal
             base | {"spans": spans, "support": "supporting"},  # does not print the value
             base | {"spans": spans, "precision": "input"},  # no box to draw in
             base | {"spans": [{"segment": "p1_s1", "start": 0, "end": 4}]},  # another segment's span
             base | {"location": None}]  # an Article link without a location
    assert place_links(links, [passage], write_pdf(tmp_path / "input.pdf", [lines])) == {"spans": 2, "placed": 2}
    assert [("value_boxes_pt" in link) for link in links] == [True, True, False, False, False, False]
    assert_at(links[0]["value_boxes_pt"][0], 72, 100, 9, 13)


def test_several_spans_are_placed_only_together(tmp_path):
    lines = [(72, 100, "Hill 7, Valley 9 and Ridge 4.")]
    passage = block("Hill 7, Valley 9 and Ridge 4.", lines)
    span = lambda start, end: {"segment": "p1_s0", "start": start, "end": end}
    both = {"segment": "p1_s0", "page": 1, "spans": [span(0, 4), span(21, 26)]}
    lost = {"segment": "p1_s0", "page": 1, "spans": [span(0, 4), span(5, 5)]}
    write_pdf(tmp_path / "input.pdf", [lines])
    assert place_links([both, lost], [passage], tmp_path / "input.pdf") == {"spans": 2, "placed": 1, "empty": 1}
    assert_at(both["value_boxes_pt"][0], 72, 100, 0, 4)
    assert_at(both["value_boxes_pt"][1], 72, 100, 21, 26)
    assert "value_boxes_pt" not in lost


# --- the shared contract -------------------------------------------------------------------------------------------

def test_a_placed_link_serialises_in_the_shared_contract(tmp_path):
    lines = [(34, 112, "Survey site:  Cedar Bay")]
    passage = block("Survey site:  Cedar Bay", lines, pid="p1_s3")
    pdf = write_pdf(tmp_path / "input.pdf", [lines])
    article = link_json(_link(("records", 0, "site_name"), _Candidate(passage), True, 1, "model",
                              _location(_Candidate(passage), "Cedar Bay")))
    without = dict(article)
    found = unified._Found(("find_year",), "Cedar Bay", "Cedar Bay", 0, spans=[Span(segment_id="p1_s3", start=14,
                                                                                    end=23)], support="literal")
    version3 = unified._link(found, 0, {passage.id: passage})
    place_links([article, version3], [passage], pdf)
    assert list(article) == list(FIXTURE["article"])
    for link, shape in ((article, FIXTURE["article"]), (version3, FIXTURE["unified"])):
        assert set(json.loads(json.dumps(link))) == set(shape) and list(link)[-1] == "value_boxes_pt"
        assert all(len(box) == 4 and all(isinstance(v, float) and round(v, 2) == v for v in box)
                   for box in link["value_boxes_pt"])
        assert_at(link["value_boxes_pt"][0], 34, 112, 14, 23)
    assert list(without) == list(FIXTURE["without"])  # absent when nothing was placed, never null or empty


# --- the wiring seam: every link the service publishes ---------------------------------------------------------------

def source(tmp_path, texts: list[str], *, pages: bool) -> tuple[Path, Evidence]:
    """A run directory whose `input.pdf` prints each text on one line, each on its own page or one page."""
    printed = [[(72, 100, text)] for text in texts] if pages else [[(72, 100 + 40 * n, text)
                                                                    for n, text in enumerate(texts)]]
    write_pdf(tmp_path / "input.pdf", printed)
    placed = [block(text, [line], pid=f"p{n + 1}_s0" if pages else f"p1_s{n}")
              for n, (text, line) in enumerate(zip(texts, (line for page in printed for line in page)))]
    return tmp_path, Evidence(run_id="run-v", generation="g1", digest="d1", source_name="source.pdf",
                              page_count=len(printed), passages=tuple(placed))


def assert_marked(links, evidence: Evidence) -> None:
    """Every link has a value mark exactly where its spans print: each text is one line at (72, 100 + 40n)."""
    for link in links:
        passage = evidence.by_id(link["segment"])
        spans = (link.get("location") or link)["spans"]
        y = 100 + 40 * passage.index
        assert len(link["value_boxes_pt"]) == len(spans), link
        for box, span in zip(link["value_boxes_pt"], spans):
            assert_at(box, 72, y, span["start"], span["end"])


def test_article_links_carry_their_value_marks_while_running_and_when_final(tmp_path, caplog):
    run_dir, evidence = source(tmp_path, ["1. Hill 1827.", "2. Valley 1828."], pages=False)
    request = run.ExtractRequest(schema=SCHEMA, options={"strategy": "article"})

    def answer(system, user, schema):
        if "### Claims" in user:
            return {claim: shape["enum"][0] for claim, shape in schema["properties"].items()}
        return {"site": "Hill", "year": 1827}
    lease = MemoryLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
    with caplog.at_level(logging.INFO, logger="kei_exp.kie.extract.run"):
        result = finish(lease, CountingChat(answer), lambda router, counter: run.dispatch(
            run_dir, evidence, request, router, counter={"fields": counter, "reasoning": counter}))
    running, final = linked_while_running(lease)
    producers = [each["producer"] for links in (*running.values(), *final.values()) for each in links]
    assert running and {tuple(link["path"]) for link in producers} >= {("records", 0, "site"), ("records", 0, "year")}
    assert_marked(producers, evidence)
    assert_marked(result["evidence"], evidence)
    assert "value marks: 2 links with spans, 2 placed, refused {}" in caplog.messages
    # Without a run directory (tests, experiments) the same extraction simply has none.
    lease = MemoryLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
    result = finish(lease, CountingChat(answer), lambda router, counter: run.dispatch(
        None, evidence, request, router, counter={"fields": counter, "reasoning": counter}))
    assert result["evidence"] and not any("value_boxes_pt" in link for link in result["evidence"])


def test_unified_catalog_links_carry_their_value_marks_while_running_and_when_final(tmp_path):
    run_dir, evidence = source(tmp_path, ["1. Hill. Material: gold.", "2. Valley. Material: flint."], pages=True)
    request = unified_request()
    lease = MemoryLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
    result = finish(lease, CountingChat(Model(evidence)), lambda router, counter: run.dispatch(
        run_dir, evidence, request, router, counter=counter))
    running, final = linked_while_running(lease)
    producers = [each["producer"] for links in (*running.values(), *final.values()) for each in links]
    literal = [link for link in producers if link["support"] == "literal"]
    assert running and {link["raw"] for link in literal} >= {"Hill", "gold", "Valley", "flint"}
    assert_marked(literal, evidence)
    assert_marked([link for link in result["evidence"] if link["support"] == "literal"], evidence)
    assert not any("value_boxes_pt" in link for link in producers if link["support"] != "literal")


def test_recipe_catalog_links_carry_their_value_marks(tmp_path, monkeypatch):
    """The recipe Catalog publishes links only with its result, which `dispatch` places."""
    run_dir, evidence = source(tmp_path, ["1. Hill. Urne.", "2. Valley. Axt."], pages=False)
    passages = {passage.id: passage for passage in evidence.passages}
    links = [evidence_link(Outcome("accepted", ("records", n, "site"), raw, spans=[Span(segment_id=pid, start=3,
                                   end=3 + len(raw))], linked_by="key"), passages, {})
             for n, (pid, raw) in enumerate((("p1_s0", "Hill"), ("p1_s1", "Valley")))]
    monkeypatch.setattr(run.grounded, "extract", lambda *_, **__: {"records": [{}, {}], "evidence": links})
    request = run.ExtractRequest.model_validate({
        "schema": {"recordDescription": "An entry", "schemaNodes": [{"id": "s", "name": "site", "type": "string"}]},
        "options": {"strategy": "catalog", "catalog": {"recipe": "numbered-catalogue-de@1"}}})
    result = run.dispatch(run_dir, evidence, request, CountingChat(lambda *_: {}))
    assert_marked(result["evidence"], evidence)
