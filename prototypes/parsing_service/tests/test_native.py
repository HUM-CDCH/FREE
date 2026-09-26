"""Native PDF text (kei_exp.transcription.native), with no vLLM server: the text-layer classification of whole PDFs
and selected ranges, the page-bound Docling pipeline that keeps a paragraph hyphenated across a page break, the
per-block provenance a born-digital page publishes — its branches over a hand-built document that needs no
conversion, its geometry over the fixture's own pages — and the native path through resolve(), the worker's
conversion steps and the CLI, which must neither start a server nor cut nor OCR anything.

Two full conversions of the eight-page digital fixture run here, the worker steps' and the CLI's, tens of seconds of
docling on CPU each; the CLI's result directory is a module-scoped fixture, so the geometry assertions add one
conversion to this module, not one per test."""
import hashlib
import json
import re
import unicodedata
from html import unescape
from pathlib import Path
from unittest.mock import patch

import pypdfium2 as pdfium
import pytest
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline
from docling_core.types.doc import (
    BoundingBox,
    ContentLayer,
    CoordOrigin,
    DocItemLabel,
    DoclingDocument,
    GroupLabel,
    ProvenanceItem,
    Size,
    TableCell,
    TableData,
)
from PIL import Image

import kei_exp.convert as conversion
from kei_exp import runs, runtime
from kei_exp.geometry import CropTransform
from kei_exp.kie.stages import ocr
from kei_exp.kie.stages.ocr import TRANSCRIBERS, resolve
from kei_exp.models import DEFAULT_OCR_MODEL, MODELS
from kei_exp.pagefile import read_manifest, read_page
from kei_exp.result import _segments  # the seam rule an empty block list feeds: one coarse segment, never none
from kei_exp.transcription.native import blocks_of, has_native_text
from kei_exp.transcription.types import PageRecord, RunParams
from kei_exp.workflows import convert as workflow
from tests.helpers import kei as kei_helper
from tests.helpers.pdfs import text_pdf


def _words(text: str) -> str:
    """Text as one line of comparable words: composed, without the marks pdfium leaves at a hyphenated break."""
    return " ".join(unicodedata.normalize("NFKC", text).replace("\x02", "").replace("­", "").split())


def _opening(markdown: str) -> str:
    """How a page's accepted Markdown opens, as words: its first line without its heading, list or table marker
    and without Markdown's own escaping, which the segments' text does not carry."""
    line = next((line for line in markdown.splitlines() if line.strip()), "")
    return _words(unescape(re.sub(r"^[#\->*|\s]+", "", line)).replace("\\", ""))


@pytest.fixture(scope="module")
def font() -> Path | None:
    """A TrueType font installed on this machine, when there is one: text_pdf keeps a soft hyphen only with it."""
    fonts = [directory for directory in (Path("/usr/share/fonts"), Path.home() / ".fonts") if directory.is_dir()]
    return next((path for directory in fonts
                 for name in ("DejaVuSans.ttf", "NotoSans-Regular.ttf", "LiberationSans-Regular.ttf")
                 for path in directory.rglob(name)), None)


@pytest.fixture
def mixed_pdf(digital_pdf, scan_pdf, tmp_path) -> Path:
    """The first page of the digital fixture followed by the first page of the scan."""
    path = tmp_path / "mixed.pdf"
    with (
        pdfium.PdfDocument.new() as mixed,
        pdfium.PdfDocument(str(digital_pdf)) as native_pdf,
        pdfium.PdfDocument(str(scan_pdf)) as scanned_pdf,
    ):
        mixed.import_pages(native_pdf, pages=[0])
        mixed.import_pages(scanned_pdf, pages=[0])
        mixed.save(path)
    return path


def test_the_fixture_pdfs_are_a_digital_pdf_and_a_scan(digital_pdf, scan_pdf):
    assert has_native_text(digital_pdf) and not has_native_text(scan_pdf)


@pytest.mark.live_model
def test_a_paragraph_hyphenated_across_a_page_break_stays_on_its_pages_hyphen_included(font, tmp_path):
    # A paragraph hyphenated across a page break: Docling's standard pipeline merges it into one item whose
    # provenance charspans are two characters off where the join dropped the hyphen (docling 2.127), so the native
    # transcriber runs a pipeline that never merges across pages and each page's text is exactly what it prints,
    # hyphen included. With a TrueType font at hand, a soft hyphen (Docling's other split-word join) is covered too.
    prose = ["carries a paragraph of ordinary prose that", "runs on for a few lines before the page ends"]
    fixture = [["The first page " + prose[0], prose[1], "in the middle of a word, printed as Rechenzent-"],
               ["rum and the second page " + prose[0], prose[1],
                "in the middle of a word, at a soft hyphen: Rechenzent­"],
               ["rum and the third page " + prose[0], "closes the paragraph on a last line."]]
    if font is None:
        print("No TrueType font found: the second page break is checked at a hard hyphen too")
        fixture[1][-1] = fixture[1][-1].replace("­", "-")
    text_pdf(tmp_path / "hyphen.pdf", fixture, font)
    options = PdfPipelineOptions(do_ocr=False, force_backend_text=True)
    plain = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_cls=StandardPdfPipeline,
                                                                                pipeline_options=options)})
    spanning = [sorted({prov.page_no for prov in item.prov})
                for item in plain.convert(tmp_path / "hyphen.pdf").document.texts
                if len({prov.page_no for prov in item.prov}) > 1]
    assert spanning == [[1, 2, 3]], spanning  # the fixture is a real merge case: one item over the three pages
    native = TRANSCRIBERS["native"].transcribe(resolve(RunParams(pdf=tmp_path / "hyphen.pdf", model="surya")), None,
                                               lambda event: None)
    assert [record.source_page for record in native.pages] == [1, 2, 3] and native.incomplete is None, \
        native.incomplete
    for record, lines in zip(native.pages, fixture):
        assert " ".join(record.text.split()) == " ".join(lines), (record.source_page, record.text)
        assert " ".join(record.markdown.split()) == " ".join(lines), (record.source_page, record.markdown)


def test_a_native_page_cannot_make_a_following_scanned_page_disappear(mixed_pdf):
    # A native page cannot make a following scanned page disappear; selected ranges are classified separately.
    assert not has_native_text(mixed_pdf)
    assert has_native_text(mixed_pdf, (1, 1))
    assert not has_native_text(mixed_pdf, (2, 2))


def test_a_page_sized_raster_with_some_embedded_text_still_takes_the_scan_path(digital_pdf, tmp_path):
    # A page-sized raster with some embedded text must still take the scan path.
    with pdfium.PdfDocument(str(digital_pdf)) as overlay:
        page = overlay[0]
        bitmap = pdfium.PdfBitmap.from_pil(Image.new("RGB", (8, 8), "white"))
        image = pdfium.PdfImage.new(overlay)
        image.set_bitmap(bitmap)
        width, height = page.get_size()
        image.set_matrix(pdfium.PdfMatrix(width, 0, 0, height, 0, 0))
        page.insert_obj(image)
        page.gen_content()
        overlay.save(tmp_path / "overlay.pdf")
        bitmap.close()
        page.close()
    assert not has_native_text(tmp_path / "overlay.pdf")


def test_resolve_makes_the_execution_choice_once_following_the_selected_range(digital_pdf, scan_pdf, mixed_pdf):
    # resolve() makes the execution choice once: native text for the digital PDF, the record's transcriber for the
    # scan and for a mixed selection, following the selected page range; a native execution carries no model,
    # server, cut or image knob, whatever the request asked for.
    assert resolve(RunParams(pdf=digital_pdf, model="surya")).transcriber == "native"
    assert resolve(RunParams(pdf=scan_pdf, model="surya")).transcriber == "surya"
    assert resolve(RunParams(pdf=mixed_pdf, model="surya")).transcriber == "surya"
    assert resolve(RunParams(pdf=mixed_pdf, model="surya", pages=(1, 1))).transcriber == "native"
    assert resolve(RunParams(pdf=mixed_pdf, model="surya", pages=(2, 2))).transcriber == "surya"
    native = resolve(RunParams(pdf=digital_pdf, model="surya", pages=(2, 3), max_image_size=800, crop_dpi=300))
    assert (native.model, native.repo, native.url, native.cut, native.layout_model, native.crop_dpi) == \
        (None, None, None, "none", None, None)
    assert native.max_image_size is None and native.stream is False and native.pages == (2, 3)


@pytest.mark.live_model
def test_the_native_worker_run_reads_the_pdf_without_a_server_a_cut_or_ocr(digital_pdf, tmp_path, monkeypatch):
    # The real native path must work without checking, starting, or calling the OCR server or cutter. The run asks
    # for no model, as Studio does when the researcher chose none: kei's default OCR model is what prepare_run
    # records, and the conversion's own resolution is what finds the text layer and runs natively — with no model,
    # so it never queries a server. The steps are called directly, as `convert` calls them: no DBOS, no database.
    monkeypatch.setattr(runs, "RUNS", tmp_path / "runs")
    monkeypatch.setattr(runs, "INBOX", tmp_path / "inbox")
    staged = runs.INBOX / "project-1" / "attempt-1.pdf"
    staged.parent.mkdir(parents=True)
    staged.write_bytes(digital_pdf.read_bytes())
    sha = hashlib.sha256(staged.read_bytes()).hexdigest()
    workflow_id = "kei-convert:ingest:project-1:attempt-1"
    requested = kei_helper.convert_request("project-1/attempt-1.pdf", sha, source_name=digital_pdf.name,
                                           debug=True)  # this test reads the debug report
    default = MODELS[DEFAULT_OCR_MODEL]
    with (
        patch.object(runtime, "loaded_model", side_effect=AssertionError("native PDF queried vLLM")),
        patch.object(ocr, "cut_pages", side_effect=AssertionError("native PDF was raster-cut")),
        patch.object(TRANSCRIBERS[default.kind], "transcribe", side_effect=AssertionError("native PDF used OCR")),
    ):
        params = workflow.prepare_run(workflow_id, requested, workflow.resolve_models(None, None))
        directory = runs.RUNS / params["id"]
        execution = runs.execution_for(directory, params)
        # The recorded request is what was asked for (the default model and cut); the execution is what runs.
        assert (params["transcriber"], params["model"], params["cut"]) == (default.kind, DEFAULT_OCR_MODEL, "auto")
        assert params["workflow_id"] == workflow_id and "extraction" not in params
        assert execution.transcriber == "native" and execution.pdf == directory / "input.pdf"
        assert execution.model is None and execution.cut == "none"
        output = workflow.convert_run(workflow_id, params)
    assert output["ok"] and output["run_id"] == params["id"] and output["page_count"] == params["page_count"]
    manifest = json.loads((directory / "result" / "result.json").read_text(encoding="utf-8"))
    assert manifest["source_name"] == digital_pdf.name
    assert manifest["recipe"]["source_sha256"] == params["source_sha256"] == sha
    # Page evidence comes from the claimed page: no word ending a page's text is printed only on the next
    # page and none opening it only on the previous one (pdfium's own text layer), so a paragraph Docling
    # merged across a page break is split back to its pages.
    word = re.compile(r"[^\W\d_]{5,}")

    def printed_words(text: str) -> set[str]:  # as pdfium reads them, joined across a hyphenated break
        text = unicodedata.normalize("NFKC", text)
        # pdfium marks a hyphen it read at a line break with \x02; a soft hyphen is invisible print
        return set(word.findall(text)) | set(word.findall(re.sub(r"[\x02­]|-\s*[\r\n]+\s*", "", text)))

    with pdfium.PdfDocument(str(digital_pdf)) as pdf:
        printed = {n + 1: printed_words(pdf[n].get_textpage().get_text_bounded()) for n in range(len(pdf))}
    for number, words in printed.items():
        page = json.loads((directory / "result" / "pages" / f"{number}.json").read_text(encoding="utf-8"))
        found = word.findall(" ".join(segment["text"] for segment in page["segments"]))
        leaked = [w for w in found[-25:] if w not in words and w in printed.get(number + 1, set())] + \
                 [w for w in found[:25] if w not in words and w in printed.get(number - 1, set())]
        assert not leaked, (number, leaked)
    report = json.loads((directory / "debug/report.json").read_text())
    assert report["transcriber"] == "native" and report["model"] is None and report["url"] is None
    assert report["cut"] == "none" and report["tokens"] == {"input": 0, "output": 0}
    assert report["layout_model"] is None
    assert len(report["pages"]) == params["page_count"]


@pytest.fixture
def synthetic() -> DoclingDocument:
    """A document built by hand, with one of every kind of item `blocks_of` decides about, so its branches are
    covered without a conversion: a running header and a page number on Docling's FURNITURE layer, text needing
    HTML escaping, a heading, a label it does not map, a table with a caption, a document index, and a bare
    picture. Page 2 exists and holds nothing; page 3 does not exist."""
    document = DoclingDocument(name="synthetic")
    for number in (1, 2):
        document.add_page(page_no=number, size=Size(width=200.0, height=400.0))

    def at(top: float, bottom: float, page_no: int = 1) -> ProvenanceItem:  # bottom-left, as Docling reports PDFs
        return ProvenanceItem(page_no=page_no, charspan=(0, 0),
                              bbox=BoundingBox(l=10, t=top, r=190, b=bottom, coord_origin=CoordOrigin.BOTTOMLEFT))

    cells = [TableCell(text=text, start_row_offset_idx=0, end_row_offset_idx=1,
                       start_col_offset_idx=column, end_col_offset_idx=column + 1)
             for column, text in enumerate(("x", "y"))]
    data = TableData(num_rows=1, num_cols=2, table_cells=cells)
    # The furniture the PDF pipeline files every running header and footer under, in the document order Docling
    # yields it: the header opens the page, the page number closes it.
    document.add_text(label=DocItemLabel.PAGE_HEADER, text="Beier, Catalogue", prov=at(398, 392),
                      content_layer=ContentLayer.FURNITURE)
    document.add_text(label=DocItemLabel.TEXT, text="a & b <c>", prov=at(390, 370))
    document.add_heading(text="Head", level=1, prov=at(360, 350))
    document.add_text(label=DocItemLabel.REFERENCE, text="Bibliography", prov=at(340, 330))  # not in BLOCK_LABELS
    caption = document.add_text(label=DocItemLabel.CAPTION, text="Table 1: counts", prov=at(320, 310))
    document.add_table(data=data, prov=at(300, 200), caption=caption)
    document.add_table(data=data, prov=at(190, 120), label=DocItemLabel.DOCUMENT_INDEX)
    document.add_picture(prov=at(110, 20))
    document.add_text(label=DocItemLabel.PAGE_FOOTER, text="7", prov=at(14, 6),
                      content_layer=ContentLayer.FURNITURE)
    return document


def test_blocks_of_carries_every_item_that_holds_evidence_and_nothing_twice(synthetic):
    blocks = blocks_of(synthetic, 1)
    # The bare picture holds no evidence and is left out; the caption is serialised inside the table's own HTML,
    # so publishing the caption item as well would put that text on the page twice.
    assert [block["label"] for block in blocks] == ["PageHeader", "Text", "SectionHeader", "reference", "Table",
                                                    "TableOfContents", "PageFooter"]
    header, text, heading, unmapped, table, index, footer = blocks
    assert text["html"] == "<p>a &amp; b &lt;c&gt;</p>"  # a text item is its text, escaped, in a paragraph
    assert heading["html"] == "<p>Head</p>" and unmapped["html"] == "<p>Bibliography</p>"
    assert "<table" in table["html"] and "Table 1: counts" in table["html"]  # the caption stays in the table
    assert "<table" in index["html"]
    for block in blocks:  # Docling reports no per-item confidence, and no item of a native page is an error
        assert (block["confidence"], block["error"], block["skipped"]) == (None, False, False)
    # Bottom-left provenance becomes the page's top-left points: the first item sits at the top of a 400 pt page.
    assert text["bbox"] == [10.0, 10.0, 190.0, 30.0] and table["bbox"] == [10.0, 100.0, 190.0, 200.0]
    assert header["bbox"] == [10.0, 2.0, 190.0, 8.0] and footer["bbox"] == [10.0, 386.0, 190.0, 394.0]


def test_a_native_page_publishes_its_running_header_and_page_number(synthetic):
    """Docling's PDF pipeline files every PAGE_HEADER and PAGE_FOOTER item under the FURNITURE content layer,
    which `iterate_items` leaves out unless it is asked for. Left out, a born-digital page published no running
    header, no running footer and no page number, while the same page scanned publishes Surya's `PageHeader`
    blocks — two evidence sets for one page, against "one consumer mapping serves both paths". A catalogue's
    running header is evidence a record may inherit from (docs/plan.md stage 8), so it is published, in the
    document order Docling yields it, under the same Surya-vocabulary labels as the rest.
    """
    blocks = blocks_of(synthetic, 1)
    labelled = {block["label"]: block["html"] for block in blocks}
    assert labelled["PageHeader"] == "<p>Beier, Catalogue</p>" and labelled["PageFooter"] == "<p>7</p>"
    # In document order, not appended after the body: the header opens the page and the page number closes it.
    labels = [block["label"] for block in blocks]
    assert labels[0] == "PageHeader" and labels[-1] == "PageFooter"


def test_a_page_docling_found_nothing_on_keeps_its_one_coarse_segment(synthetic):
    # No block means no `blocks` key on the record, and `result._segments` then writes the one coarse segment
    # that says so: the whole input's box, `extent: "input"`, never a fabricated per-item box.
    assert blocks_of(synthetic, 2) == []   # a page of the document with no item on it
    assert blocks_of(synthetic, 3) == []   # a page Docling could not build at all
    record = PageRecord(page=1, region=None, image=None, seconds=None, input_tokens=0, output_tokens=0, stop=None,
                        capped=False, payload={}, stats={}, markdown="", text="", incomplete=None, source_page=2)
    (segment,) = _segments(0, None, record, CropTransform(0.0, 0.0, 1.0, 1.0, None), lambda box: box,
                           (0.0, 0.0, 200.0, 400.0))
    assert segment.extent == "input" and segment.bbox_px is None and segment.bbox_pt == (0.0, 0.0, 200.0, 400.0)


def test_a_numbered_list_item_keeps_its_printed_marker_from_the_source_text():
    """Docling strips a list item's printed marker from `text` and keeps the PDF's own characters in `orig`. A
    catalogue's entry numbers are such markers, so the block publishes `orig`: the printed "31." is source text,
    never a number derived from the item's position. An item whose source carries no marker stays as it is."""
    document = DoclingDocument(name="list")
    document.add_page(page_no=1, size=Size(width=200.0, height=400.0))
    group = document.add_group(label=GroupLabel.LIST, name="list")

    def at(top: float, bottom: float) -> ProvenanceItem:
        return ProvenanceItem(page_no=1, charspan=(0, 0),
                              bbox=BoundingBox(l=10, t=top, r=190, b=bottom, coord_origin=CoordOrigin.BOTTOMLEFT))
    document.add_list_item(text="Oak: an urn.", orig="31. Oak: an urn.", marker="31.", enumerated=True,
                           prov=at(390, 380), parent=group)
    document.add_list_item(text="Brook: an axe.", orig="Brook: an axe.", marker="", prov=at(370, 360), parent=group)
    assert [block["html"] for block in blocks_of(document, 1)] == ["<p>31. Oak: an urn.</p>", "<p>Brook: an axe.</p>"]


@pytest.fixture(scope="module")
def native_result(recorded_digital_pdf, tmp_path_factory) -> Path:
    """One real native run over the whole digital fixture, written as an accepted result directory: no model
    server, no database, no cut. Module-scoped, because docling over the eight pages is this module's slow part."""
    directory = tmp_path_factory.mktemp("native-result")
    with patch("sys.argv", ["kei-exp", str(recorded_digital_pdf), "--model", "surya",
                            "--result-dir", str(directory / "result"), "--output-dir", str(directory / "output")]):
        conversion.main()
    return directory / "result"


@pytest.mark.live_model
def test_a_native_page_carries_doclings_own_blocks_with_real_geometry(native_result, recorded_digital_pdf):
    # Born-digital provenance already exists: Docling knows every item's page and box, so a native page must
    # publish one segment per item rather than flatten the page into one coarse `input` segment. The boxes are
    # checked against the page they claim, not merely for being present: inside the page, non-empty, top-left.
    manifest = read_manifest(native_result)
    pages = {number: read_page(native_result, number, manifest) for number in manifest.pages}
    with pdfium.PdfDocument(str(recorded_digital_pdf)) as pdf:
        assert sorted(pages) == list(range(1, len(pdf) + 1))
        printed = {n + 1: _words(pdf[n].get_textpage().get_text_bounded()) for n in range(len(pdf))}
    tables = []
    for number, page in pages.items():
        blocks = [segment for segment in page.segments if segment.extent == "block"]
        assert blocks, f"page {number} has no block segment"
        # The coarse whole-input segment is gone wherever Docling found items: no fabricated page-sized box.
        assert [segment for segment in page.segments if segment.extent == "input"] == [], number
        width, height = page.size_pt
        for segment in blocks:
            x0, y0, x1, y1 = segment.bbox_pt
            assert x0 < x1 and y0 < y1, (number, segment.label, segment.bbox_pt)
            assert 0 <= x0 and x1 <= width and 0 <= y0 and y1 <= height, (number, segment.bbox_pt, page.size_pt)
            # With no engine raster, the transform is the identity: the engine box is already in page points.
            assert segment.bbox_px == tuple(segment.bbox_pt), (number, segment.label)
            assert segment.markdown is None and segment.confidence is None and segment.status == "ok"
        # Top-left origin: every page of this fixture opens at its top, so the first block's y0 is in the top
        # half. A bottom-left box of the same item would land in the bottom half instead.
        assert blocks[0].bbox_pt[1] < height / 2, (number, blocks[0].bbox_pt, page.size_pt)
        # The segments carry the page's own text: the words its accepted Markdown opens with — the page's first
        # heading or paragraph — are among them, and pdfium confirms this page is where they are printed.
        joined = " ".join(_words(segment.text) for segment in blocks)
        opening = [word for word in _opening(page.markdown).split() if len(word) > 3][:6]
        assert opening and all(word in joined for word in opening), (number, opening, joined[:300])
        assert all(word in _words(printed[number]) for word in opening), (number, opening)
        tables += [segment for segment in blocks if segment.label == "Table"]
    assert any(len(page.segments) > 1 for page in pages.values()), "a page of prose has more than one item"
    # Docling's table structure survives as the segment's HTML, as Surya's table blocks do.
    assert tables, "the fixture's table page must publish a Table segment"
    for table in tables:
        assert "<table" in (table.html or ""), table.html


@pytest.mark.live_model
def test_a_selected_native_page_keeps_its_number_and_the_cli_starts_no_server(digital_pdf, tmp_path):
    # OCR-only knobs are irrelevant to a selected native page, and its source number survives.
    with (
        patch("sys.argv", ["kei-exp", str(digital_pdf), "--model", "surya", "--pages", "4-4",
                           "--max-image-size", "800", "--debug-dir", str(tmp_path / "debug"),
                           "--output-dir", str(tmp_path / "output")]),
    ):
        conversion.main()
    report = json.loads((tmp_path / "debug/report.json").read_text())
    assert report["pages_requested"] == [4, 4] and len(report["pages"]) == 1
    assert report["pages"][0]["source_page"] == 4 and report["pages"][0]["incomplete"] is None
    assert report["pages"][0]["markdown"] == (tmp_path / "output" / f"{digital_pdf.stem}.md").read_text()
    assert report["pages"][0]["text"].strip() and not report["pages"][0]["text"].startswith("#")  # plain, not Markdown


def test_an_out_of_range_page_range_is_refused_before_a_server_could_start(digital_pdf, tmp_path):
    # An out-of-range page range is refused with exit 1 before conversion.
    with pdfium.PdfDocument(str(digital_pdf)) as document:
        beyond = f"{len(document) + 1}-{len(document) + 1}"
    with (
        patch("sys.argv", ["kei-exp", str(digital_pdf), "--model", "surya", "--pages", beyond,
                           "--output-dir", str(tmp_path / "output")]),
        pytest.raises(SystemExit) as refused,  # anything else, or no exit at all, is the pages being accepted
    ):
        conversion.main()
    assert refused.value.code == 1, refused.value.code
