"""Native text with image-only OCR, through resolution and canonical result publication."""
import ctypes
import json
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock, patch
from types import SimpleNamespace

import pypdfium2 as pdfium
import pytest
from PIL import Image
from docling.datamodel.base_models import ConversionStatus
from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, DoclingDocument, ProvenanceItem, Size, TableData

from kei_exp.failures import should_retry
from kei_exp.kie import passages
from kei_exp.kie.stages import ocr
from kei_exp.pagefile import read_manifest, read_page
from kei_exp.pages import PdfPages
from kei_exp.regions import anchor, splice
from kei_exp.result import fingerprint, recipe
from kei_exp.transcription import types
from kei_exp.transcription.native import native_regions
from kei_exp.transcription.types import PageRecord, RunParams, Transcription
from tests.helpers.pdfs import text_pdf


@pytest.fixture
def illustrated_pdf(tmp_path):
    path = tmp_path / "illustrated.pdf"
    text_pdf(path, [["Native paragraph above the image."], ["Native second page."]])
    with pdfium.PdfDocument(path) as document:
        page = document[0]
        with Image.new("RGB", (200, 120), "white") as pixels:
            bitmap = pdfium.PdfBitmap.from_pil(pixels)
            image = pdfium.PdfImage.new(document)
            image.set_bitmap(bitmap)
            image.set_matrix(pdfium.PdfMatrix(300, 0, 0, 150, 72, 400))
            page.insert_obj(image)
            page.gen_content()
            document.save(tmp_path / "with-image.pdf")
            bitmap.close()
        page.close()
    return tmp_path / "with-image.pdf"


def block(text, box, label="Text"):
    return {"html": f"<p>{text}</p>", "bbox": list(box), "label": label,
            "confidence": None, "error": False, "skipped": False}


def record(number, blocks, *, source_page=None, image=None, incomplete=None):
    return PageRecord(page=number, region=None, image=image, seconds=None, input_tokens=3,
                      output_tokens=5, stop=None, capped=False, payload={"blocks": blocks}, stats={},
                      markdown="", text="", incomplete=incomplete, source_page=source_page)


def test_resolution_selects_image_only_ocr_and_honours_page_selection(illustrated_pdf):
    execution = ocr.resolve(RunParams(pdf=illustrated_pdf, model="surya"))
    assert execution.transcriber == "hybrid"
    assert execution.cut == "none" and execution.layout_model is None
    assert [(region.page, region.bbox) for region in execution.ocr_regions] == [(1, (72, 292, 372, 442))]
    assert ocr.resolve(RunParams(pdf=illustrated_pdf, model="surya", pages=(2, 2))).transcriber == "native"
    assert ocr.resolve(RunParams(pdf=illustrated_pdf, model="surya", pages=(1, 1))).transcriber == "hybrid"


@pytest.mark.parametrize("backend", ["surya", "granite_vision"])
def test_only_the_image_reaches_ocr_and_both_paths_keep_evidence(illustrated_pdf, tmp_path, monkeypatch, backend):
    execution = ocr.resolve(RunParams(pdf=illustrated_pdf, model=backend, result_dir=tmp_path / "result"))
    assert execution.transcriber == "hybrid"
    native = Mock(return_value=Transcription({}, [
        record(1, [block("Native above", (72, 60, 350, 80)),
                   block("Native below", (72, 470, 350, 490))], source_page=1),
        record(2, [block("Native second page", (72, 60, 350, 80))], source_page=2),
    ]))
    calls = []

    def recognize(request, crops, emit):
        calls.extend(crops)
        assert request.transcriber == ("surya" if backend == "surya" else "vlm")
        assert len(crops) == 1 and crops[0][0] == 1
        number, region, image = crops[0]
        assert region.bbox == (72, 292, 372, 442)
        assert image.width < 595 * 250 / 72 and image.height < 842 * 250 / 72
        return Transcription({}, [record(1, [block("Image table text", (0, 0, image.width, image.height))],
                                        image=image)])

    monkeypatch.setattr(ocr.TRANSCRIBERS["native"], "transcribe", native)
    monkeypatch.setattr(ocr.TRANSCRIBERS["surya" if backend == "surya" else "vlm"], "transcribe", recognize)
    monkeypatch.setattr(ocr, "cut_pages", Mock(side_effect=AssertionError("native prose must not be cut")))
    markdown = ocr.run(execution, lambda _: None)
    assert len(calls) == 1
    assert markdown.index("Native above") < markdown.index("Image table text") < markdown.index("Native below")
    manifest = read_manifest(execution.result_dir)
    assert manifest.status == "success" and manifest.recipe["transcriber"] == "hybrid"
    first = read_page(execution.result_dir, 1, manifest)
    second = read_page(execution.result_dir, 2, manifest)
    assert [s.text for s in first.segments] == ["Native above", "Image table text", "Native below"]
    assert [s.text for s in second.segments] == ["Native second page"]
    native_segment, image_segment, _ = first.segments
    assert native_segment.crop is None and native_segment.bbox_pt == (72, 60, 350, 80)
    assert image_segment.crop is not None
    crop, = first.units[0].crops
    assert crop.bbox_pt == (72, 292, 372, 442)
    assert crop.order == 0
    assert image_segment.crop == crop.crop
    assert image_segment.bbox_px == (0, 0, calls[0][2].width, calls[0][2].height)
    assert image_segment.bbox_pt == pytest.approx(crop.bbox_pt, abs=0.4)
    assert not second.units[0].crops


def test_an_incomplete_image_cannot_publish_a_successful_native_page(illustrated_pdf, tmp_path, monkeypatch):
    execution = ocr.resolve(RunParams(pdf=illustrated_pdf, model="surya", pages=(1, 1),
                                    result_dir=tmp_path / "result"))
    assert execution.transcriber == "hybrid"
    monkeypatch.setattr(ocr.TRANSCRIBERS["native"], "transcribe", lambda *args: Transcription({}, [
        record(1, [block("Native prose", (72, 60, 350, 80))], source_page=1)]))
    monkeypatch.setattr(ocr.TRANSCRIBERS["surya"], "transcribe", lambda request, crops, emit: Transcription({}, [
        replace(record(1, [block("Partial image text", (0, 0, 50, 50))], image=crops[0][2]),
                incomplete="OCR token budget exhausted", capped=True)]))
    with pytest.raises(ocr.IncompleteConversionError, match="OCR token budget exhausted"):
        ocr.run(execution, lambda _: None)
    manifest = read_manifest(execution.result_dir)
    assert manifest.status == "incomplete"
    page = read_page(execution.result_dir, 1, manifest)
    assert not page.complete and page.units[0].crops[0].capped


def test_ocr_cannot_hide_missing_native_evidence(illustrated_pdf, tmp_path, monkeypatch):
    execution = ocr.resolve(RunParams(pdf=illustrated_pdf, model="surya", pages=(1, 1),
                                    result_dir=tmp_path / "result"))
    monkeypatch.setattr(ocr.TRANSCRIBERS["native"], "transcribe", lambda *args: Transcription({}, [
        replace(record(1, [], source_page=1), payload={}, text="Native text without located blocks")]))
    monkeypatch.setattr(ocr.TRANSCRIBERS["surya"], "transcribe", lambda request, crops, emit: Transcription({}, [
        record(1, [block("Image text", (0, 0, 50, 50))], image=crops[0][2])]))
    with pytest.raises(ocr.IncompleteConversionError, match="native evidence"):
        ocr.run(execution, lambda _: None)
    assert read_manifest(execution.result_dir).status == "incomplete"


def test_an_empty_native_table_is_replaced_by_ocr_without_losing_its_caption(illustrated_pdf, monkeypatch):
    document = DoclingDocument(name="raster-table")
    document.add_page(page_no=1, size=Size(width=595, height=842))

    def at(box):
        return ProvenanceItem(page_no=1, charspan=(0, 0), bbox=BoundingBox(
            l=box[0], t=box[1], r=box[2], b=box[3], coord_origin=CoordOrigin.TOPLEFT))

    document.add_text(label=DocItemLabel.TEXT, text="Native prose", prov=at((72, 60, 350, 80)))
    caption = document.add_text(label=DocItemLabel.CAPTION, text="Table 1. Native caption", prov=at((72, 260, 350, 280)))
    table = document.add_table(data=TableData(num_rows=0, num_cols=0, table_cells=[]), prov=at((72, 292, 372, 442)))
    table.captions.append(caption.get_ref())
    result = SimpleNamespace(document=document, pages=[SimpleNamespace(page_no=1)], errors=[],
                             status=ConversionStatus.SUCCESS)
    monkeypatch.setattr("kei_exp.transcription.native.DocumentConverter", lambda **_: SimpleNamespace(
        convert=lambda *args, **kwargs: result))
    execution = ocr.resolve(RunParams(pdf=illustrated_pdf, model="surya", pages=(1, 1)))
    outcome = ocr.TRANSCRIBERS["native"].transcribe(execution, None, lambda _: None)
    assert outcome.incomplete is None
    assert [b["html"] for b in outcome.pages[0].payload["blocks"]] == [
        "<p>Native prose</p>", "<p>Table 1. Native caption</p>",
    ]


def test_vlm_crop_keeps_its_markdown_and_coarse_evidence(illustrated_pdf, tmp_path, monkeypatch):
    execution = ocr.resolve(RunParams(pdf=illustrated_pdf, model="granite_vision", pages=(1, 1),
                                    result_dir=tmp_path / "result"))
    monkeypatch.setattr(ocr.TRANSCRIBERS["native"], "transcribe", lambda *args: Transcription({}, [
        record(1, [block("Native above", (72, 60, 350, 80)), block("Native below", (72, 470, 350, 490))], source_page=1)]))
    table = "| Field | Value |\n| --- | --- |\n| Sample | 42 |"

    def recognize(request, crops, emit):
        emit({"type": "page_start", "page": 1})
        return Transcription({}, [replace(record(1, [], image=crops[0][2]), payload={}, text=table, markdown=table)])

    monkeypatch.setattr(ocr.TRANSCRIBERS["vlm"], "transcribe", recognize)
    seen = []
    markdown = ocr.run(execution, seen.append)
    assert table in markdown
    page = read_page(execution.result_dir, 1, read_manifest(execution.result_dir))
    image = page.segments[1]
    assert image.extent == "input" and image.bbox_px is None and image.markdown == table
    assert image.bbox_pt == (72, 292, 372, 442)
    assert {"type": "page_start", "page": 1, "unit": 0, "crop": 1} in seen


def test_region_insertion_keeps_native_column_order():
    native = [block("left above", (10, 10, 90, 20)), block("left below", (10, 150, 90, 170)),
              block("right above", (110, 10, 190, 20)), block("right below", (110, 150, 190, 170))]
    at = anchor([tuple(b["bbox"]) for b in native], (110, 50, 190, 120))
    assert [b["html"] for b in splice(native, [(at, [block("right image", (110, 50, 190, 120))])])] == [
        "<p>left above</p>", "<p>left below</p>", "<p>right above</p>", "<p>right image</p>", "<p>right below</p>",
    ]


def test_marginal_artwork_follows_what_is_printed_above_it_not_the_page_header():
    header, body, more = (100, 20, 400, 30), (100, 100, 400, 300), (100, 400, 400, 600)
    assert anchor([header, body, more], (450, 350, 560, 450)) == 2  # no item spans it: after the last above
    assert anchor([header, body, more], (450, 5, 560, 15)) == 0     # nothing above it: first
    assert anchor([], (450, 350, 560, 450)) == 0


def test_running_heads_and_feet_keep_their_place_but_never_place_column_artwork():
    header, footer = (40, 20, 560, 30), (40, 800, 560, 810)
    left_top, right_top, right_bottom = (40, 100, 290, 300), (310, 100, 560, 300), (310, 400, 560, 700)
    # Foot of the left column, a full-width footer its only block below: after the left column's text.
    assert anchor([header, left_top, right_top, right_bottom, footer], (40, 400, 290, 700), {0, 4}) == 2
    # Head of a right column with no text of its own: after the left column, not after the running head.
    left_bottom = (40, 400, 290, 700)
    assert anchor([header, left_top, left_bottom, footer], (310, 100, 560, 300), {0, 3}) == 3
    # Head of a left column with no text of its own: before the body, after the running head.
    assert anchor([header, right_top, right_bottom, footer], (40, 100, 290, 300), {0, 3}) == 1
    # Marginal artwork under a full-width running head still follows the body printed above it.
    body, more = (100, 100, 400, 300), (100, 400, 400, 600)
    assert anchor([header, body, more], (450, 350, 560, 450), {0}) == 2
    assert anchor([header, body, more], (450, 350, 560, 450)) == 3  # were the head body, it would span the figure
    # A page of furniture alone: placed among it.
    assert anchor([header, footer], (40, 400, 290, 700), {0, 1}) == 1


def test_body_sections_spanning_both_columns_still_bound_column_artwork():
    intro, outro = (40, 40, 560, 80), (40, 740, 560, 780)
    left_top, right_top, right_bottom = (40, 100, 290, 300), (310, 100, 560, 300), (310, 400, 560, 700)
    native = [intro, left_top, right_top, right_bottom, outro]
    assert anchor(native, (40, 400, 290, 700)) == 2      # in the left column, though the outro spans it
    assert anchor(native, (310, 320, 560, 380)) == 3     # between the right column's blocks
    assert anchor(native, (40, 800, 560, 830)) == 5      # below the outro
    assert anchor(native[:3], (310, 400, 560, 700)) == 3  # foot of the right column, nothing below
    assert anchor([intro, left_top, outro], (310, 100, 560, 300)) == 2  # a textless right column, before the outro


def test_overlapping_artwork_is_one_ocr_crop(illustrated_pdf, tmp_path):
    path = tmp_path / "overlapping.pdf"
    with pdfium.PdfDocument(illustrated_pdf) as document:
        page = document[0]
        with Image.new("RGB", (200, 120), "white") as pixels:
            bitmap = pdfium.PdfBitmap.from_pil(pixels)
            image = pdfium.PdfImage.new(document)
            image.set_bitmap(bitmap)
            image.set_matrix(pdfium.PdfMatrix(300, 0, 0, 150, 100, 400))
            page.insert_obj(image)
            page.gen_content()
            document.save(path)
            bitmap.close()
        page.close()
    regions = native_regions(path)
    assert len(regions) == 1 and regions[0].bbox == (72, 292, 400, 442)


def test_rotated_artwork_keeps_the_scan_path(illustrated_pdf, tmp_path):
    path = tmp_path / "rotated.pdf"
    with pdfium.PdfDocument(illustrated_pdf) as document:
        page = document[0]
        page.set_rotation(180)
        document.save(path)
        page.close()
    assert ocr.resolve(RunParams(pdf=path, model="surya")).transcriber == "surya"


@pytest.mark.live_model
def test_real_native_and_selected_ocr_backends_preserve_the_illustrated_pdf(tmp_path):
    """Opt-in full conversion with a caller-supplied PDF and serving OCR endpoint; no deployment mutation."""
    import os

    source = os.environ.get("KEI_HYBRID_PDF")
    url = os.environ.get("KEI_HYBRID_OCR_URL")
    if not source or not url:
        pytest.skip("KEI_HYBRID_PDF and KEI_HYBRID_OCR_URL are required")
    execution = ocr.resolve(RunParams(pdf=Path(source), model="surya", url=url, result_dir=tmp_path / "result"))
    assert execution.transcriber == "hybrid" and execution.ocr_regions
    ocr.run(execution, lambda _: None)
    manifest = read_manifest(execution.result_dir)
    assert manifest.status == "success"
    pages = [read_page(execution.result_dir, n, manifest) for n in manifest.pages]
    assert len(pages) == manifest.page_count
    # Native blocks with undecodable glyphs add text crops of their own (`execution.ocr_text`).
    assert sum(crop.kind == "figure" for page in pages for unit in page.units for crop in unit.crops) \
        == len(execution.ocr_regions)
    assert any(segment.crop is None and segment.text for page in pages for segment in page.segments)


# --- Geometry, several regions on one page, and the seams they cross ------------------------------------------------
def black_image(document, matrix):
    """A black image placed by `matrix` (PDF canvas units): its rendered crop is all ink, so a misplaced box shows."""
    with Image.new("RGB", (200, 120), "black") as pixels:
        bitmap = pdfium.PdfBitmap.from_pil(pixels)
        image = pdfium.PdfImage.new(document)
        image.set_bitmap(bitmap)
        image.set_matrix(pdfium.PdfMatrix(*matrix))
        bitmap.close()
    return image


def dark_share(path, region):
    with PdfPages(path) as pages, pages.page(region.page).render(72, region.bbox) as crop:
        return sum(crop.histogram()[:128]) / (crop.width * crop.height)


def text_page(document, width, height, text, x, y):
    page = document.new_page(width, height)
    obj = pdfium.raw.FPDFPageObj_NewTextObj(document, b"Helvetica", 11.0)
    pdfium.raw.FPDFText_SetText(obj, ctypes.cast((text + "\0").encode("utf-16-le"), pdfium.raw.FPDF_WIDESTRING))
    pdfium.raw.FPDFPageObj_Transform(obj, 1, 0, 0, 1, x, y)
    pdfium.raw.FPDFPage_InsertObject(page, obj)
    return page


@pytest.mark.parametrize("box", ["crop", "media"])
def test_a_displayed_page_with_an_origin_offset_crops_the_artwork_it_shows(tmp_path, box):
    path = tmp_path / f"{box}box.pdf"
    with pdfium.PdfDocument.new() as document:
        page = text_page(document, 700, 950, "Native paragraph above the image.", 122, 820)
        page.insert_obj(black_image(document, (300, 0, 0, 150, 122, 450)))
        (page.set_cropbox if box == "crop" else page.set_mediabox)(50, 50, 645, 892)
        page.gen_content()
        document.save(path)
        page.close()
    region, = native_regions(path)
    # Displayed top-left points: x 122 - 50, y 892 - 600. Uncorrected canvas bounds read (122, 242, 422, 392).
    assert region.bbox == pytest.approx((72, 292, 372, 442))
    assert dark_share(path, region) == 1.0


def test_an_image_inside_a_translated_form_is_one_crop_where_it_is_printed(tmp_path):
    path = tmp_path / "nested.pdf"
    with pdfium.PdfDocument.new() as artwork, pdfium.PdfDocument.new() as document:
        source = artwork.new_page(595, 842)
        source.insert_obj(black_image(artwork, (300, 0, 0, 150, 122, 450)))
        source.gen_content()
        page = text_page(document, 595, 842, "Native paragraph above the image.", 72, 770)
        xobject = pdfium.raw.FPDF_NewXObjectFromPage(document, artwork, 0)
        form = pdfium.raw.FPDF_NewFormObjectFromXObject(xobject)
        pdfium.raw.FPDFPageObj_Transform(form, 1, 0, 0, 1, -50, -100)
        pdfium.raw.FPDFPage_InsertObject(page, form)
        page.gen_content()
        document.save(path)
        page.close()
        pdfium.raw.FPDF_CloseXObject(xobject)
        source.close()
    region, = native_regions(path)  # the form's own bounds and its image's, transformed: one region, not two
    assert region.bbox == pytest.approx((72, 342, 372, 492))  # untransformed, its image would read (122, 242, ...)
    assert dark_share(path, region) == 1.0


@pytest.fixture
def two_column_pdf(tmp_path):
    """Page 1 prose only; page 2 two images: A at the top of the right column, B lower in the left one."""
    path = tmp_path / "two-column.pdf"
    with pdfium.PdfDocument.new() as document:
        first = text_page(document, 595, 842, "Native first page.", 72, 770)
        first.gen_content()
        page = text_page(document, 595, 842, "Native second page.", 40, 790)
        page.insert_obj(black_image(document, (250, 0, 0, 120, 310, 622)))  # A: top-left (310, 100, 560, 220)
        page.insert_obj(black_image(document, (250, 0, 0, 120, 40, 322)))   # B: top-left (40, 400, 290, 520)
        page.gen_content()
        document.save(path)
        first.close()
        page.close()
    return path


def two_column_native(*_args):
    return Transcription({"max_size": None, "scale": 1.0}, [
        record(1, [block("Native first page", (72, 60, 350, 80))], source_page=1),
        record(2, [block("Running head", (40, 20, 560, 30), "PageHeader"), block("Title", (40, 40, 290, 60), "Title"),
                   block("Left above", (40, 300, 290, 320)), block("Left below", (40, 600, 290, 620)),
                   block("Right below", (310, 300, 560, 320)), block("7", (290, 820, 300, 830), "PageFooter")],
               source_page=2)])


def test_two_regions_on_one_page_read_in_place_in_markdown_page_file_and_evidence(two_column_pdf, tmp_path,
                                                                                  monkeypatch):
    run_dir = tmp_path / "run"
    execution = ocr.resolve(RunParams(pdf=two_column_pdf, model="surya", pages=(2, 2), result_dir=run_dir / "result",
                                      debug_dir=tmp_path / "debug"))
    assert [(r.page, r.bbox) for r in execution.ocr_regions] == [(2, (310, 100, 560, 220)), (2, (40, 400, 290, 520))]
    monkeypatch.setattr(ocr.TRANSCRIBERS["native"], "transcribe", lambda *args: Transcription(
        {}, [replace(two_column_native().pages[1], page=1)]))
    seen = []

    def recognize(request, crops, emit):
        assert [crop[1].order for crop in crops] == [1, 0]  # A reads after B: the left column comes first
        for n, crop in enumerate(crops, 1):
            emit({"type": "page_start", "page": n})
        return Transcription({}, [record(n, [block(f"Image {'AB'[n - 1]}", (0, 0, 20, 10))], image=crop[2])
                                  for n, crop in enumerate(crops, 1)])

    monkeypatch.setattr(ocr.TRANSCRIBERS["surya"], "transcribe", recognize)
    markdown = ocr.run(execution, seen.append)
    order = ["Title", "Left above", "Image B", "Left below", "Image A", "Right below"]
    assert [markdown.index(text) for text in order] == sorted(markdown.index(text) for text in order)
    # Docling's page export: no furniture, headings as headings, as on every page OCR did not touch.
    assert "Running head" not in markdown and "\n7" not in markdown and markdown.startswith("# Title")
    manifest = read_manifest(execution.result_dir)
    page = read_page(execution.result_dir, 2, manifest)
    assert [s.text for s in page.segments] == ["Running head", "Title", "Left above", "Image B", "Left below",
                                               "Image A", "Right below", "7"]
    assert [(c.crop, c.order) for c in page.units[0].crops] == [(2, 0), (1, 1)]
    evidence = passages.load(run_dir)
    assert evidence.order_issues == ()
    assert [p.text for p in evidence.passages if p.crop is not None] == ["Image B", "Image A"]
    # Region and page events name the PDF page of an offset selection and the crop's ordinal.
    assert [(e["page"], e["crop"], e["order"]) for e in seen if e["type"] == "region"] == [(2, 1, 1), (2, 2, 0)]
    assert [(e["page"], e["unit"], e["crop"]) for e in seen if e["type"] == "page_start"] == [(2, 0, 1), (2, 0, 2)]
    # The debug report keeps each crop's own outcome and image beside the merged page.
    report = json.loads((tmp_path / "debug" / "report.json").read_text())
    entry, = report["pages"]
    assert [(s["crop"], s["region"]["order"], s["blocks"][0]["html"]) for s in entry["ocr"]] == [
        (2, 0, "<p>Image B</p>"), (1, 1, "<p>Image A</p>")]
    assert (tmp_path / "debug" / "ocr-1.png").exists() and (tmp_path / "debug" / "ocr-2.png").exists()


@pytest.fixture
def furnished_pdf(tmp_path):
    """Pages under a full-width running head and foot. Page 1: artwork F at the foot of the left column. Page 2:
    artwork R heading a right column with no text, and artwork L inside the left column. Page 3: one column and
    marginal artwork M beside it."""
    path = tmp_path / "furnished.pdf"
    with pdfium.PdfDocument.new() as document:
        first = text_page(document, 595, 842, "Native first page.", 40, 790)
        first.insert_obj(black_image(document, (250, 0, 0, 140, 40, 142)))   # F: top-left (40, 560, 290, 700)
        first.gen_content()
        second = text_page(document, 595, 842, "Native second page.", 40, 790)
        second.insert_obj(black_image(document, (250, 0, 0, 200, 310, 542)))  # R: top-left (310, 100, 560, 300)
        second.insert_obj(black_image(document, (250, 0, 0, 120, 40, 392)))   # L: top-left (40, 330, 290, 450)
        second.gen_content()
        third = text_page(document, 595, 842, "Native third page.", 40, 790)
        third.insert_obj(black_image(document, (160, 0, 0, 200, 420, 322)))  # M: top-left (420, 320, 580, 520)
        third.gen_content()
        document.save(path)
        for page in (first, second, third):
            page.close()
    return path


def furnished_native(*_args):
    head, foot = block("Running head", (40, 20, 560, 30), "PageHeader"), block("Running foot", (40, 800, 560, 810),
                                                                                 "PageFooter")
    return Transcription({"max_size": None, "scale": 1.0}, [
        record(1, [head, block("Left top", (40, 100, 290, 300)), block("Right top", (310, 100, 560, 300)),
                   block("Right bottom", (310, 400, 560, 700)), foot], source_page=1),
        record(2, [head, block("Left top 2", (40, 100, 290, 300)), block("Left bottom 2", (40, 500, 290, 700)), foot],
               source_page=2),
        record(3, [head, block("Body above", (100, 100, 400, 300)), block("Body below", (100, 400, 400, 600)), foot],
               source_page=3)])


def test_a_full_width_running_head_or_foot_never_places_column_artwork(furnished_pdf, tmp_path, monkeypatch):
    run_dir = tmp_path / "run"
    execution = ocr.resolve(RunParams(pdf=furnished_pdf, model="surya", result_dir=run_dir / "result"))
    assert [(r.page, r.bbox) for r in execution.ocr_regions] == [
        (1, (40, 560, 290, 700)), (2, (310, 100, 560, 300)), (2, (40, 330, 290, 450)), (3, (420, 320, 580, 520))]
    monkeypatch.setattr(ocr.TRANSCRIBERS["native"], "transcribe", furnished_native)
    monkeypatch.setattr(ocr.TRANSCRIBERS["surya"], "transcribe", lambda request, crops, emit: Transcription({}, [
        record(n, [block(f"Image {'FRLM'[n - 1]}", (0, 0, 20, 10))], image=crop[2]) for n, crop in enumerate(crops, 1)]))
    markdown = ocr.run(execution, lambda _: None)
    order = ["Left top", "Image F", "Right top", "Right bottom",
             "Left top 2", "Image L", "Left bottom 2", "Image R", "Body above", "Image M", "Body below"]
    assert [markdown.index(text) for text in order] == sorted(markdown.index(text) for text in order)
    assert "Running" not in markdown
    manifest = read_manifest(execution.result_dir)
    first, second, third = (read_page(execution.result_dir, n, manifest) for n in (1, 2, 3))
    # The furniture stays evidence, in its own place.
    assert [s.text for s in first.segments] == ["Running head", "Left top", "Image F", "Right top", "Right bottom",
                                                "Running foot"]
    assert [s.text for s in second.segments] == ["Running head", "Left top 2", "Image L", "Left bottom 2", "Image R",
                                                 "Running foot"]
    assert [s.text for s in third.segments] == ["Running head", "Body above", "Image M", "Body below", "Running foot"]
    assert [(c.crop, c.order) for c in first.units[0].crops] == [(1, 0)]
    assert sorted((c.crop, c.order) for c in second.units[0].crops) == [(2, 1), (3, 0)]  # L reads before R
    evidence = passages.load(run_dir)
    assert evidence.order_issues == ()
    assert [p.text for p in evidence.passages] == [
        "Running head", "Left top", "Image F", "Right top", "Right bottom", "Running foot",
        "Running head", "Left top 2", "Image L", "Left bottom 2", "Image R", "Running foot",
        "Running head", "Body above", "Image M", "Body below", "Running foot"]
    assert [p.crop_order for p in evidence.passages if p.crop is not None] == [0, 0, 1, 0]


def test_overlapping_artwork_whose_union_encloses_native_text_keeps_the_scan_path(tmp_path):
    paths = {}
    for enclosed in (False, True):
        paths[enclosed] = path = tmp_path / f"union-{enclosed}.pdf"
        with pdfium.PdfDocument.new() as document:
            page = text_page(document, 595, 842, "Native paragraph at the top.", 72, 780)
            page.insert_obj(black_image(document, (250, 0, 0, 120, 72, 400)))   # A: 72..322 x 400..520 (PDF space)
            page.insert_obj(black_image(document, (220, 0, 0, 200, 300, 300)))  # B: 300..520 x 300..500, overlaps A
            if enclosed:  # inside the union, in neither image: right of A, above B
                text = pdfium.raw.FPDFPageObj_NewTextObj(document, b"Helvetica", 11.0)
                pdfium.raw.FPDFText_SetText(text, ctypes.cast("Zq\0".encode("utf-16-le"), pdfium.raw.FPDF_WIDESTRING))
                pdfium.raw.FPDFPageObj_Transform(text, 1, 0, 0, 1, 340, 504)
                pdfium.raw.FPDFPage_InsertObject(page, text)
            page.gen_content()
            document.save(path)
            page.close()
    assert [region.bbox for region in native_regions(paths[False])] == [(72, 322, 520, 542)]
    assert native_regions(paths[True]) is None
    assert ocr.resolve(RunParams(pdf=paths[True], model="surya")).transcriber == "surya"


def test_a_failed_ocr_backend_closes_every_rendered_crop_and_writes_no_result(illustrated_pdf, tmp_path, monkeypatch):
    execution = ocr.resolve(RunParams(pdf=illustrated_pdf, model="surya", result_dir=tmp_path / "result"))
    monkeypatch.setattr(ocr.TRANSCRIBERS["native"], "transcribe", lambda *args: Transcription({}, [
        record(1, [block("Native above", (72, 60, 350, 80))], source_page=1),
        record(2, [block("Native second page", (72, 60, 350, 80))], source_page=2)]))
    seen = []

    def refuse(request, crops, emit):
        seen.extend(crops)
        raise ConnectionError("connection refused")

    monkeypatch.setattr(ocr.TRANSCRIBERS["surya"], "transcribe", refuse)
    with pytest.raises(ConnectionError) as raised:
        ocr.run(execution, lambda _: None)
    assert should_retry(raised.value)
    assert len(seen) == 1
    for _, _, image in seen:
        with pytest.raises(ValueError):  # a closed PIL image refuses its pixels
            image.getpixel((0, 0))
    assert not (tmp_path / "result").exists()


def test_a_hybrid_recipe_changes_with_native_text_rules_and_others_keep_their_fingerprints(
        illustrated_pdf, digital_pdf_for_rules, monkeypatch):
    hybrid = ocr.resolve(RunParams(pdf=illustrated_pdf, model="surya"))
    native = ocr.resolve(RunParams(pdf=digital_pdf_for_rules, model="surya"))
    with patch("kei_exp.kie.stages.ocr.native_regions", return_value=None):
        scan = ocr.resolve(RunParams(pdf=digital_pdf_for_rules, model="surya"))
    assert recipe(hybrid, "0" * 64, None)["text_rules"] == {"hybrid": 3, "native": 3, "surya": 1}
    assert recipe(native, "0" * 64, None)["text_rules"] == 3
    assert recipe(scan, "0" * 64, None)["text_rules"] == 1
    before = {name: fingerprint(recipe(e, "0" * 64, None)) for name, e in
              {"hybrid": hybrid, "native": native, "scan": scan}.items()}
    monkeypatch.setitem(types.TEXT_RULES, "native", 4)
    after = {name: fingerprint(recipe(e, "0" * 64, None)) for name, e in
             {"hybrid": hybrid, "native": native, "scan": scan}.items()}
    assert after["hybrid"] != before["hybrid"] and after["native"] != before["native"]
    assert after["scan"] == before["scan"]


@pytest.fixture
def digital_pdf_for_rules(tmp_path):
    path = tmp_path / "prose.pdf"
    text_pdf(path, [["Only native prose."]])
    return path


def test_a_vlm_crop_records_its_data_dependent_image_cap(illustrated_pdf, tmp_path, monkeypatch):
    execution = ocr.resolve(RunParams(pdf=illustrated_pdf, model="granite_vision", pages=(1, 1),
                                      result_dir=tmp_path / "result"))
    monkeypatch.setattr(ocr.TRANSCRIBERS["native"], "transcribe", lambda *args: Transcription(
        {"max_size": None, "scale": 1.0}, [record(1, [block("Native above", (72, 60, 350, 80))], source_page=1)]))
    monkeypatch.setattr(ocr.TRANSCRIBERS["vlm"], "transcribe", lambda request, crops, emit: Transcription(
        {"max_size": 1234, "scale": 0.5}, [replace(record(1, [], image=crops[0][2]), payload={}, text="t", markdown="t")]))
    ocr.run(execution, lambda _: None)
    assert read_manifest(execution.result_dir).effective == {"max_size": 1234, "scale": 0.5}
