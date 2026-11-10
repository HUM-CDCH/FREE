"""Value marks placed from the page image (ADR 0031, "Scanned pages from the page image"): the rule over readings
this file lays out, whose every word's place is therefore known; its alignment against every alignment enumerated;
the reader over a canned Tesseract result; and `place_links` on a scan with no text layer, with a reader that
answers from the generator's positions and, where Tesseract is installed, with Tesseract itself.
"""
import io
import random
import shutil
import subprocess

import numpy as np
import pypdfium2 as pdfium
import pytest
from PIL import Image

from kei_exp.kie.extract import scan_mark
from kei_exp.kie.extract.scan_mark import GROW_PX, MARGIN_PX, PAD_PX, Scan, Word
from kei_exp.kie.extract.value_mark import SCALE, place_links
from kei_exp.pagefile import PageTable, TableCell
from tests.test_value_mark import ADVANCE, PARAGRAPH, around, assert_at, block, located, write_pdf


def lay(lines: list[str], x: int = 20) -> list[Word]:
    """Each line's words on a grid: 10 pixels a character, 20 high, a line every 30."""
    words = []
    for number, line in enumerate(lines):
        at = x
        for text in line.split():
            words.append(Word(text, (at, 20 + 30 * number, at + 10 * len(text), 40 + 30 * number), (1, 1, 1, number + 1)))
            at += 10 * len(text) + 10
    return words


def scan(text: str, lines: list[str] | None = None, words: list[Word] | None = None) -> Scan:
    words = lay(lines or [text]) if words is None else words
    return Scan(text, words, (max(word.box[2] for word in words) + 20, max(word.box[3] for word in words) + 20))


def span(text: str, value: str, nth: int = 0) -> tuple[int, int]:
    start = -1
    for _ in range(nth + 1):
        start = text.index(value, start + 1)
    return start, start + len(value)


def grown(words: list[Word], *texts: str) -> list[tuple[int, int, int, int]]:
    """The boxes of the words spelled `texts`, each grown as a mark is."""
    return [(x0 - GROW_PX, y0 - GROW_PX, x1 + GROW_PX, y1 + GROW_PX)
            for text in texts for x0, y0, x1, y1 in [next(word.box for word in words if word.text == text)]]


LINES = ["opening abcdefgh amber ijklmnop closing", "second line holds xy ) and more", "third ending words are here"]
TEXT = " ".join(LINES)


# --- which words print the value -------------------------------------------------------------------------------------

def test_a_value_is_placed_on_its_own_words_one_box_each():
    words = lay(LINES)
    assert scan(TEXT, LINES).place([span(TEXT, "amber")]) == grown(words, "amber")
    assert scan(TEXT, LINES).place([span(TEXT, "closing second")]) == grown(words, "closing", "second")  # two lines
    assert scan(TEXT, LINES).place([span(TEXT, "opening"), span(TEXT, "third")]) == grown(words, "opening", "third")


@pytest.mark.parametrize("read, value, reason", [
    ("opaning abcdefgh amber ijklmnop closing", "amber", None),  # an error far from the value
    ("opening abcdefgx amber ijklmnop closing", "amber", "read differently"),  # in its surroundings
    ("opening abcdefgh arnber ijklmnop closing", "amber", "read differently"),  # in the value
    ("opening abcdefgh ijklmnop closing", "amber", "read differently"),  # not read at all
    ("zzz opening abcdefgh amber ijklmnop closing", "amber", None),  # a word more, away from its surroundings
    ("opening zzz abcdefgh amber ijklmnop closing", "amber", "read differently"),  # against them: one edit shifts them
    ("opening abcdefgh amber zzz ijklmnop closing", "amber", "read differently"),  # inside them
    ("opening abcdefgh amber ijk lmnop closing", "amber", None),  # a neighbour read as two words
    ("opening abcdefgh am ber ijklmnop closing", "amber", None),  # the value read as two words: both are its
    ("opening abcdefghamber ijklmnop closing", "amber", "not whole words"),  # run into its neighbour
])
def test_the_two_readings_may_differ_only_away_from_the_value(read, value, reason):
    text = "opening abcdefgh amber ijklmnop closing"
    found = scan(text, [read]).place([span(text, value)])
    assert found == reason if reason else found == grown(lay([read]), *("am", "ber") if "am ber" in read else (value,))


@pytest.mark.parametrize("text, value", [
    ("opening abcdefgh amber, ijklmnop closing", "amber"),  # its comma is in the word's box
    ('opening abcdefgh "amber" ijklmnop closing', "amber"),
    ("opening abcdefgh amber ijklmnop closing", "mber"),
    ("opening abcdefgh amber ijklmnop closing", "amber ijkl"),
])
def test_a_value_that_is_not_whole_printed_words_is_refused(text, value):
    assert scan(text).place([span(text, value)]) == "not whole words"
    whole = text.split()[2]
    assert scan(text).place([span(text, whole)]) == grown(lay([text]), whole)  # with its punctuation it is placed


def test_a_word_broken_at_a_line_end_is_placed_only_with_its_hyphen():
    lines = ["opening abcdefgh radio-", "carbon ijklmnop closing"]
    text = "opening abcdefgh radiocarbon ijklmnop closing"  # canonical text joined the word
    assert scan(text, lines).place([span(text, "radiocarbon")]) == "not whole words"  # the hyphen's ink is not its
    kept = " ".join(lines)  # canonical text kept the hyphen: the value prints as both words, hyphen and all
    assert scan(kept, lines).place([span(kept, "radio- carbon")]) == grown(lay(lines), "radio-", "carbon")


@pytest.mark.parametrize("text, lines", [
    ("prologue abcdefgh red ijklmnop bridge qrstuvwx red yzabcdef epilogue", None),  # other surroundings
    ("prologue abcdefgh red ijklmnop bridge abcdefgh red ijklmnop epilogue", None),  # the same
    ("prologue abcdefgh red ijklmnop bridge abcdefgh red ijklmnop epilogue",
     ["prologue bridge abcdefgh red ijklmnop epilogue"]),  # one of them not read
    ("prologue abcdefgh red ijklmnop epilogue",
     ["prologue abcdefgh red ijklmnop abcdefgh red ijklmnop epilogue"]),  # one of them not in the text
])
def test_a_value_printed_twice_is_never_chosen_by_position(text, lines):
    for nth in range(text.count(" red ")):
        assert scan(text, lines).place([span(text, "red", nth)]) in ("printed twice", "read differently")


def test_two_printings_at_swapped_places_under_one_spelling_are_refused():
    """Two columns in one box, the text by columns and the reader by rows, the second line of the first column and
    the first of the second printing the same words: both readings are one string, so nothing in them tells the two
    printings apart. Only a value printed once is placed."""
    text = "left one aaaa abcdefgh amber ijklmnop abcdefgh amber ijklmnop right two bbbb"
    rows = ["left one aaaa abcdefgh amber ijklmnop", "abcdefgh amber ijklmnop right two bbbb"]
    assert [scan(text, rows).place([span(text, "amber", nth)]) for nth in (0, 1)] == ["printed twice"] * 2
    assert scan(text, rows).place([span(text, "one")]) == grown(lay(rows), "one")


def test_the_same_letters_inside_a_longer_word_are_another_printing():
    """Two columns in one box, the text by columns and the reader by rows. The right column prints `a42b`, which the
    reader breaks into three words; the left prints `a 42 b`, which it runs into one. Both readings are one string
    and each has `42` as a whole word once, at the other's place: only letters that occur once are safe."""
    text = "L a 42 b a42b R"
    words = [Word("L", (10, 20, 20, 40), (1, 1, 1, 1)), Word("a", (100, 20, 110, 40), (1, 1, 1, 1)),
             Word("42", (113, 20, 133, 40), (1, 1, 1, 1)), Word("b", (136, 20, 146, 40), (1, 1, 1, 1)),
             Word("a42b", (10, 70, 70, 90), (1, 1, 1, 2)), Word("R", (140, 70, 150, 90), (1, 1, 1, 2))]
    assert Scan(text, words, (180, 110)).place([span(text, "42")]) == "printed twice"
    text = "opening hundred abcdefgh red ijklmnop closing"
    assert scan(text).place([span(text, "red", 1)]) == "printed twice"
    assert scan(text).place([span(text, "hundred")]) == grown(lay([text]), "hundred")


def test_two_numbers_read_as_each_other_are_refused():
    text = "opening abcdefgh 42 ijklmnop separator abcdefgh 43 ijklmnop closing"
    read = ["opening abcdefgh 43 ijklmnop separator abcdefgh 42 ijklmnop closing"]
    assert [scan(text, read).place([span(text, value)]) for value in ("42", "43")] == ["read differently"] * 2


def test_spans_are_placed_only_together_and_never_twice_on_a_word():
    read = [LINES[0].replace("amber", "amher"), *LINES[1:]]
    assert scan(TEXT, read).place([span(TEXT, "opening"), span(TEXT, "amber")]) == "read differently"
    assert scan(TEXT, LINES).place([span(TEXT, "abcdefgh amber"), span(TEXT, "amber ijklmnop")]) == "spans overlap"
    assert scan(TEXT, LINES).place([(5, 5)]) == scan(TEXT, LINES).place([(0, 999)]) == "empty"


def test_a_link_carries_at_most_the_boxes_studio_reads():
    text = " ".join(f"w{n:03d}" for n in range(80))
    lines = [" ".join(text.split()[n:n + 10]) for n in range(0, 80, 10)]
    assert len(scan(text, lines).place([span(text, " ".join(text.split()[5:69]))])) == scan_mark.MARKS
    assert scan(text, lines).place([span(text, " ".join(text.split()[5:70]))]) == "too many words"


# --- where the reading cannot be trusted ----------------------------------------------------------------------------

def test_a_touch_between_boxes_refuses_the_value_beside_it_not_its_block():
    words = lay(LINES)
    xy, bracket = (next(i for i, word in enumerate(words) if word.text == text) for text in ("xy", ")"))
    x0, y0, x1, y1 = words[xy].box
    words[bracket] = Word(")", (x1 - 4, y0 - 5, x1 + 8, y1 + 5), words[bracket].line)  # tall, over its neighbour's tail
    assert scan(TEXT, words=words).place([span(TEXT, "amber")]) == grown(words, "amber")
    assert scan(TEXT, words=words).place([span(TEXT, "xy")]) == "touches another word"
    assert scan(TEXT, words=words).place([span(TEXT, ")")]) == "touches another word"
    assert scan(TEXT, words=words).place([span(TEXT, "holds xy ) and")]) == grown(words, "holds", "xy", ")", "and")
    words[bracket] = Word(")", (x0 + 12, y0 + 2, x1 - 2, y1 - 2), words[bracket].line)  # inside it, further right
    assert scan(TEXT, words=words).place([span(TEXT, "amber")]) == grown(words, "amber")
    assert scan(TEXT, words=words).place([span(TEXT, "xy")]) == "touches another word"


def reordered(change) -> list[Word]:
    words = lay(LINES)
    change(words)
    return words


def swap(words): words[5], words[6] = words[6], words[5]
def lines_swapped(words): words[:] = words[5:12] + words[:5] + words[12:]
def interleaved(words): words[4], words[5] = words[5], words[4]
def nested(words): words[6] = Word("line", (words[5].box[0] + 5, 52, words[5].box[0] + 25, 68), words[6].line)
def off_its_line(words): words[7] = Word("holds", (140, 71, 190, 78), words[7].line)
def outside(words): words[0] = Word("opening", (-1, 20, 90, 40), words[0].line)


@pytest.mark.parametrize("change, reason", [
    (swap, "words out of order"), (lines_swapped, "lines out of order"), (interleaved, "lines out of order"),
    (nested, "words out of order"), (off_its_line, "words out of order"), (outside, "word outside the crop")])
def test_a_reading_that_is_not_one_column_in_order_refuses_its_block(change, reason):
    assert scan(TEXT, words=reordered(change)).place([span(TEXT, "third")]) == reason


def test_lines_whose_boxes_overlap_are_in_order_by_their_middles():
    words = lay(LINES)
    more = next(i for i, word in enumerate(words) if word.text == "more")
    words[more] = Word("more", (*words[more].box[:1], 38, *words[more].box[2:]), words[more].line)  # into line one
    assert scan(TEXT, words=words).place([span(TEXT, "third")]) == grown(words, "third")


def test_a_mark_stays_inside_the_crop_and_narrower_than_it():
    assert Scan("amber", [Word("amber", (0, 20, 50, 40), (1, 1, 1, 1))], (200, 60)).place([(0, 5)]) \
        == "at the crop's edge"
    assert Scan("amber", [Word("amber", (2, 2, 98, 98), (1, 1, 1, 1))], (100, 100)).place([(0, 5)]) \
        == "not narrower than its block"
    assert Scan("amber", [], (100, 100)).place([(0, 5)]) == "nothing read"
    long = "ab " * (scan_mark.LONGEST // 2 + 1)
    assert Scan(long, [Word("ab", (2, 2, 9, 9), (1, 1, 1, 1))], (100, 100)).place([(0, 2)]) == "block too long"


# --- the alignment against every alignment, enumerated ---------------------------------------------------------------

def enumerated(a: str, b: str, left: int, right: int) -> int | None:
    """Where a[left:right] starts in b when every alignment within one edit of the best maps it there unchanged, by
    walking every such alignment; None otherwise."""
    def walk(i, j, cost, steps, budget):
        if cost > budget:
            return
        if i == len(a) and j == len(b):
            yield cost, steps
            return
        if i < len(a) and j < len(b):
            yield from walk(i + 1, j + 1, cost + (a[i] != b[j]), steps + [("=" if a[i] == b[j] else "x", i, j)], budget)
        if i < len(a):
            yield from walk(i + 1, j, cost + 1, steps + [("d", i, j)], budget)
        if j < len(b):
            yield from walk(i, j + 1, cost + 1, steps + [("i", i, j)], budget)
    row = list(range(len(b) + 1))
    for i, char in enumerate(a, 1):
        row = [i] + [min(row[j] + 1, row[j - 1] + (char != b[j - 1])) for j in range(1, len(b) + 1)]
        for j in range(1, len(b) + 1):
            row[j] = min(row[j], row[j - 1] + 1)
    best = row[-1]
    onto: dict[int, set[int]] = {}
    for _, steps in walk(0, 0, 0, [], best + 1):
        for kind, i, j in steps:
            if kind in "dx" and left <= i < right:
                return None
            if kind == "i" and (left < i < right or i == 0 == left or i == len(a) == right):
                return None
            if kind == "=" and left <= i < right:
                onto.setdefault(i, set()).add(j)
    places = [onto.get(i, set()) for i in range(left, right)]
    if any(len(place) != 1 for place in places):
        return None
    mapped = [next(iter(place)) for place in places]
    if mapped != list(range(mapped[0], mapped[0] + right - left)) or (left == 0 and mapped[0] != 0) \
            or (right == len(a) and mapped[-1] != len(b) - 1):
        return None
    return mapped[0]


def test_the_alignment_agrees_with_every_alignment_enumerated():
    rng = random.Random(31)
    placed = 0
    for _ in range(400):
        a = "".join(rng.choice("ab") for _ in range(rng.randint(1, 7)))
        b = "".join(rng.choice("ab") for _ in range(rng.randint(1, 7))) if rng.random() < 0.5 else a
        left = rng.randrange(len(a))
        right = rng.randint(left + 1, len(a))
        subject = Scan(a, [Word(b, (1, 1, 9, 9), (1, 1, 1, 1))], (10, 10))
        found = subject._aligned(left, right)
        want = enumerated(a, b, left, right)
        assert (None if isinstance(found, str) else found) == want, (a, b, left, right)
        placed += want is not None
    assert placed > 50  # the comparison is not of refusals alone


# --- the reader ------------------------------------------------------------------------------------------------------

HEADER = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
ROWS = ("1\t1\t0\t0\t0\t0\t0\t0\t300\t200\t-1\t\n4\t1\t1\t1\t1\t0\t60\t58\t150\t20\t-1\t\n"
        "5\t1\t1\t1\t1\t1\t60\t58\t50\t20\t96.1\tFound\n5\t1\t1\t1\t1\t2\t120\t60\t30\t18\t91.0\t1962,\n"
        "5\t1\t1\t1\t2\t1\t60\t90\t40\t20\t12.0\t \n")


def reading(monkeypatch, stdout: bytes = (HEADER + ROWS).encode(), code: int = 0, error: Exception | None = None):
    calls = []

    def run(command, **given):
        calls.append((command, given))
        if error:
            raise error
        return subprocess.CompletedProcess(command, code, stdout, b"")
    monkeypatch.setattr(subprocess, "run", run)
    return calls


def test_the_reader_gives_tesseracts_words_in_the_crops_own_pixels(monkeypatch):
    calls = reading(monkeypatch)
    crop = np.full((100, 200), 180, dtype=np.uint8)  # a grey page
    crop[40:60, 20:120] = 20
    crop[0, 0] = 255
    assert scan_mark.read(crop) == [Word("Found", (60 - PAD_PX, 58 - PAD_PX, 110 - PAD_PX, 78 - PAD_PX), (1, 1, 1, 1)),
                                    Word("1962,", (120 - PAD_PX, 60 - PAD_PX, 150 - PAD_PX, 78 - PAD_PX), (1, 1, 1, 1))]
    command, given = calls[0]
    assert command[command.index("tesseract"):] == ["tesseract", "stdin", "stdout", "--oem", "1", "--psm", "6", "-l",
                                                    scan_mark.LANGUAGES, "--dpi", str(72 * SCALE), "tsv"]
    sent = np.asarray(Image.open(io.BytesIO(given["input"])))
    assert sent.shape == (100 + 2 * PAD_PX, 200 + 2 * PAD_PX) and (sent[PAD_PX:-PAD_PX, PAD_PX:-PAD_PX] == crop).all()
    assert sent[0, 0] == sent[-1, -1] == sent[70, 3] == 180  # the border is the page's tone, not white


@pytest.mark.parametrize("given", [
    {"code": 1}, {"error": subprocess.TimeoutExpired("tesseract", 30)}, {"error": FileNotFoundError("nice")},
    {"stdout": (HEADER + "5\t1\t1\t1\t1\t1\tsixty\t58\t50\t20\t96\tFound\n").encode()},
    {"stdout": (HEADER + "5\t1\t1\n").encode()}])
def test_a_reading_that_fails_is_no_reading(monkeypatch, given):
    reading(monkeypatch, **given)
    assert scan_mark.read(np.full((100, 200), 255, dtype=np.uint8)) is None


def test_a_reading_of_no_words_is_an_empty_one(monkeypatch):
    reading(monkeypatch, HEADER.encode())
    assert scan_mark.read(np.full((100, 200), 255, dtype=np.uint8)) == []


# --- place_links on a scan with no text layer ------------------------------------------------------------------------

def scan_run(tmp_path, texts: list[str]):
    """A run whose `input.pdf` is a picture of `texts` in Courier Bold with no text layer, the one block the OCR
    model read on it, and the words a reader finds on that block's crop: where the generator printed them."""
    lines = [(72, 100 + 14 * n, text) for n, text in enumerate(texts)]
    with pdfium.PdfDocument(str(write_pdf(tmp_path / "ink.pdf", [lines], font=b"Courier-Bold"))) as document:
        image = document[0].render(scale=SCALE, grayscale=True).to_numpy()
    pdf = write_pdf(tmp_path / "input.pdf", [[]], scan=image if image.ndim == 2 else image[:, :, 0])
    passage = block(" ".join(texts), lines, ocr=True)
    left, top = (round(value * SCALE) - MARGIN_PX for value in passage.bbox_pt[:2])
    words = []
    for number, (x, y, text) in enumerate(lines):
        at = 0
        for token in text.split():
            at = text.index(token, at)
            words.append(Word(token, (round((x + ADVANCE * at) * SCALE) - left, round((y - 8) * SCALE) - top,
                                      round((x + ADVANCE * (at + len(token))) * SCALE) - left,
                                      round((y + 2) * SCALE) - top), (1, 1, 1, number + 1)))
            at += len(token)
    return pdf, passage, words


@pytest.fixture
def reader(monkeypatch):
    """Stands in for Tesseract: `reader.words` is what it reads, `reader.crops` what it was shown."""
    class Reader:
        words: list[Word] | None = None
        crops: list[tuple[int, int]] = []

    def read(crop, seconds=scan_mark.SECONDS):
        Reader.crops.append(crop.shape)
        return Reader.words
    Reader.crops = []
    monkeypatch.setattr(scan_mark, "available", lambda: True)
    monkeypatch.setattr(scan_mark, "read", read)
    monkeypatch.setattr(scan_mark, "_READINGS", {})
    return Reader


def test_a_value_on_a_scan_with_no_text_layer_is_placed_from_the_page_image(tmp_path, reader):
    pdf, passage, reader.words = scan_run(tmp_path, PARAGRAPH)
    link, late, twice = located(passage, "1962"), located(passage, "Ostia"), located(passage, "the")
    assert place_links([link, late, twice], [passage], pdf) == {
        "spans": 3, "placed": 1, "scan": 1, "scan: not whole words": 1, "scan: printed twice": 1}
    (box,) = link["value_boxes_pt"]
    assert_at(box, 72, 142, 5, 9)
    assert all(isinstance(value, float) and round(value, 2) == value for value in box)
    assert "value_boxes_pt" not in late and "value_boxes_pt" not in twice  # they keep their block's mark
    x0, y0, x1, y1 = around([(72, 100 + 14 * n, text) for n, text in enumerate(PARAGRAPH)])
    assert reader.crops == [(round(y1 * SCALE) - round(y0 * SCALE) + 2 * MARGIN_PX,
                             round(x1 * SCALE) - round(x0 * SCALE) + 2 * MARGIN_PX)]  # the block's crop, read once


def test_a_block_is_read_once_for_an_extractions_every_placement(tmp_path, reader):
    pdf, passage, reader.words = scan_run(tmp_path, PARAGRAPH)
    for _ in range(3):  # a partial publication, another, the final result
        assert place_links([located(passage, "1962")], [passage], pdf) == {"spans": 1, "placed": 1, "scan": 1}
    assert len(reader.crops) == 1


def test_a_reading_that_fails_or_runs_out_of_time_keeps_the_blocks_mark(tmp_path, reader, monkeypatch):
    pdf, passage, words = scan_run(tmp_path, PARAGRAPH)
    link = located(passage, "1962")
    assert place_links([link], [passage], pdf) == {"spans": 1, "placed": 0, "scan: not read": 1}
    monkeypatch.setattr("kei_exp.kie.extract.value_mark.SCAN_SECONDS", 0)
    reader.words = words
    assert place_links([link], [passage], pdf) == {"spans": 1, "placed": 0, "scan: out of time": 1}
    assert "value_boxes_pt" not in link and len(reader.crops) == 1  # a failed reading is not kept, and none is begun late


def test_a_mark_reaching_beyond_its_anchor_is_never_written(tmp_path, reader, monkeypatch):
    """The crop reaches no further than a mark may, so only a narrower allowance shows the check."""
    pdf, passage, words = scan_run(tmp_path, PARAGRAPH)
    x0, _, x1, y1 = words[0].box
    reader.words = [Word("Trench", (x0, 1, x1, y1), words[0].line), *words[1:]]  # up into the crop's margin
    monkeypatch.setattr("kei_exp.kie.extract.value_mark.INSIDE_PT", 1.0)
    link = located(passage, "Trench")
    assert place_links([link], [passage], pdf) == {"spans": 1, "placed": 0, "scan: outside anchor": 1}
    assert "value_boxes_pt" not in link


def test_only_a_one_box_block_the_ocr_model_read_is_read_from_the_page_image(tmp_path, reader):
    pdf, passage, reader.words = scan_run(tmp_path, PARAGRAPH)
    native = block(passage.text, [(72, 100 + 14 * n, text) for n, text in enumerate(PARAGRAPH)])
    assert place_links([located(native, "1962")], [native], pdf) == {"spans": 1, "placed": 0, "not printed": 1}
    split = block(passage.text, [], ocr=True, boxes=(passage.bbox_pt, (300.0, 400.0, 500.0, 450.0)))
    assert place_links([located(split, "1962")], [split], pdf) == {"spans": 1, "placed": 0, "not printed": 1}
    cell = TableCell(cell_id="r0_c0", row=0, column=0, rowspan=1, colspan=1, role=None, text="1962", start=0, end=4,
                     bbox_pt=passage.bbox_pt)
    table = block("1962", [], ocr=True, label="Table", boxes=(passage.bbox_pt,),
                  table=PageTable(rows=1, columns=1, cells=[cell], producer="test"))
    assert place_links([located(table, "1962", cell="r0_c0")], [table], pdf) == {
        "spans": 1, "placed": 0, "not printed": 1}
    assert reader.crops == []


def test_without_the_reader_a_scan_keeps_what_the_text_layer_gave(tmp_path, monkeypatch):
    pdf, passage, _ = scan_run(tmp_path, PARAGRAPH)
    monkeypatch.setattr(scan_mark, "available", lambda: False)
    monkeypatch.setattr(scan_mark, "read", lambda *_: pytest.fail("no reader is installed"))
    assert place_links([located(passage, "1962")], [passage], pdf) == {"spans": 1, "placed": 0, "not printed": 1}


@pytest.mark.skipif(shutil.which("tesseract") is None, reason="Tesseract is not installed")
def test_tesseract_itself_places_a_value_on_a_scan_with_no_text_layer(tmp_path, monkeypatch):
    """The whole path with the real reader, as the service's image runs it: a wrong box fails, never a missing one
    that the rule refuses."""
    monkeypatch.setattr(scan_mark, "_READINGS", {})
    pdf, passage, _ = scan_run(tmp_path, PARAGRAPH)
    printed = {"1962": [(142, 5, 9)], "plaster": [(114, 22, 29)], "Trench four": [(100, 0, 6), (100, 7, 11)]}
    links = {value: located(passage, value) for value in (*printed, "Ostia")}
    counts = place_links(list(links.values()), [passage], pdf)
    assert counts["spans"] == 4 and counts["scan"] == counts["placed"] >= 1 and "scan: not read" not in counts
    assert "value_boxes_pt" in links["1962"] and "value_boxes_pt" not in links["Ostia"]  # its full stop is the word's
    for value, places in printed.items():
        boxes = links[value].get("value_boxes_pt", [])
        assert len(boxes) in (0, len(places)), value
        for box, (y, start, end) in zip(boxes, places):
            assert_at(box, 72, y, start, end)
