"""A rendered minus with an unusable Unicode map must be read from the page image, block by block."""
from dataclasses import replace
from unittest.mock import Mock, patch

import pypdfium2 as pdfium
import pytest

from kei_exp.kie.stages import ocr
from kei_exp.kie.stages.ocr import resolve, undecodable_blocks
from kei_exp.pagefile import read_manifest, read_page
from kei_exp.transcription.native import _has_undecodable_glyph, native_regions, undecodable_glyphs
from kei_exp.transcription.types import IncompleteConversionError, OcrRegion, RunParams, Transcription
from tests.test_hybrid import block, record


def _pdf(path, broken):
    mapping = b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <00> <ff> endcodespacerange\n1 beginbfchar <04> <0000> endbfchar\nendcmap CMapName currentdict /CMap defineresource pop end end"
    text = b"BT /F1 12 Tf 40 100 Td (Units: cm " + (b"\004" if broken else b"-") + b" 1) Tj ET"
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Differences [4 /minus] >>" +
               (b" /ToUnicode 6 0 R" if broken else b"") + b" >>",
               b"<< /Length " + str(len(text)).encode() + b" >>\nstream\n" + text + b"\nendstream",
               b"<< /Length " + str(len(mapping)).encode() + b" >>\nstream\n" + mapping + b"\nendstream"]
    content, offsets = b"%PDF-1.4\n", [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(len(content))
        content += str(index).encode() + b" 0 obj\n" + obj + b"\nendobj\n"
    xref = len(content)
    size = str(len(objects) + 1).encode()
    content += b"xref\n0 " + size + b"\n0000000000 65535 f \n" + b"".join(f"{offset:010} 00000 n \n".encode() for offset in offsets[1:])
    content += b"trailer << /Size " + size + b" /Root 1 0 R >>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n"
    path.write_bytes(content)


def _pdfs(tmp_path):
    broken, clean = tmp_path / "broken.pdf", tmp_path / "clean.pdf"
    _pdf(broken, True)
    _pdf(clean, False)
    return broken, clean


def test_undecodable_font_glyph_is_screened_and_readable_text_is_not(tmp_path):
    broken, clean = _pdfs(tmp_path)
    assert native_regions(broken) == native_regions(clean) == ()
    assert undecodable_glyphs(broken) and not undecodable_glyphs(clean)


def test_undecodable_font_glyph_keeps_native_text_with_the_selected_model_for_its_blocks(tmp_path):
    broken, clean = _pdfs(tmp_path)
    execution = resolve(RunParams(pdf=broken, model="surya"))
    assert (execution.transcriber, execution.model, execution.cut) == ("hybrid", "surya", "none")
    assert execution.ocr_text and execution.ocr_regions == ()
    assert resolve(RunParams(pdf=clean, model="surya")).transcriber == "native"


def test_undecodable_font_glyph_is_judged_per_selected_page_range(tmp_path):
    broken, clean = _pdfs(tmp_path)
    with pdfium.PdfDocument.new() as combined, pdfium.PdfDocument(clean) as a, pdfium.PdfDocument(broken) as b:
        combined.import_pages(a)
        combined.import_pages(b)
        path = tmp_path / "mixed.pdf"
        combined.save(path)
    assert not undecodable_glyphs(path, (1, 1))
    assert undecodable_glyphs(path, (2, 2))


def test_pdfium_generated_layout_and_discretionary_hyphen_controls_are_not_glyph_errors():
    class TextPage:
        def count_chars(self): return 1
    with patch("pypdfium2.raw.FPDFText_GetUnicode", return_value=2), \
         patch("pypdfium2.raw.FPDFText_IsGenerated", return_value=0), \
         patch("pypdfium2.raw.FPDFText_IsHyphen", return_value=1):
        assert not _has_undecodable_glyph(TextPage())
    with patch("pypdfium2.raw.FPDFText_GetUnicode", return_value=0), \
         patch("pypdfium2.raw.FPDFText_IsGenerated", return_value=1), \
         patch("pypdfium2.raw.FPDFText_IsHyphen", return_value=0):
        assert not _has_undecodable_glyph(TextPage())


def test_only_body_blocks_keeping_a_control_code_leave_native_text_one_region_per_box():
    head = block("Journal \x00 head", (10, 5, 290, 15), label="PageHeader")
    merged = {**block("cm \x00 1 continues", (10, 20, 140, 60)), "boxes": [[10, 20, 140, 60], [160, 20, 290, 40]]}
    native = Transcription({}, [record(1, [head, block("Before", (10, 70, 290, 80)), merged,
                                           block("After", (10, 90, 290, 100))], source_page=1),
                                record(2, [block("only \x0e C", (10, 20, 290, 40))], source_page=2),
                                record(3, [block("Clean", (10, 20, 290, 40))], source_page=3)])
    kept, regions, anchors = undecodable_blocks(native)
    assert [[b["html"] for b in r.payload.get("blocks", [])] for r in kept.pages] == [
        ["<p>Journal \x00 head</p>", "<p>Before</p>", "<p>After</p>"], [], ["<p>Clean</p>"]]
    assert kept.pages[1].payload["blocks"] == [] and kept.pages[2] is native.pages[2]
    assert regions == [OcrRegion(1, (10, 20, 140, 60)), OcrRegion(1, (160, 20, 290, 40)), OcrRegion(2, (10, 20, 290, 40))]
    assert anchors == [2, 2, 0]


def test_a_table_read_by_ocr_reads_its_caption_too():
    """A table's HTML carries its caption, printed outside the table's box."""
    table = {**block("Location (cm \x00 1) 1696", (10, 40, 290, 90), label="Table"), "caption_boxes": [[10, 20, 290, 30]]}
    _, regions, anchors = undecodable_blocks(Transcription({}, [record(1, [table], source_page=1)]))
    assert regions == [OcrRegion(1, (10, 20, 290, 30)), OcrRegion(1, (10, 40, 290, 90))] and anchors == [0, 0]


# Long enough that an undeclared encoding was guessed wrong, as on a real page.
TEXT = "1651 cm⁻¹ and 1649 cm⁻¹, respectively, indicating the presence of amide I groups of proteins."


def test_an_undecodable_block_is_read_by_ocr_in_its_place_and_published_without_the_control_code(tmp_path, monkeypatch):
    broken, _ = _pdfs(tmp_path)
    execution = resolve(RunParams(pdf=broken, model="surya", result_dir=tmp_path / "result"))
    monkeypatch.setattr(ocr.TRANSCRIBERS["native"], "transcribe", Mock(return_value=Transcription({}, [
        record(1, [block("Native above", (40, 20, 260, 40)), block("Units: cm \x00 1", (40, 90, 200, 110)),
                   block("Native below", (40, 150, 260, 170))], source_page=1)])))
    seen = []

    def recognize(request, crops, emit):
        seen.extend(crops)
        (_, region, image), = crops
        assert (region.kind, region.bbox) == ("text", (40, 90, 200, 110))
        return Transcription({}, [record(1, [block(TEXT, (0, 0, image.width, image.height))], image=image)])

    monkeypatch.setattr(ocr.TRANSCRIBERS["surya"], "transcribe", recognize)
    markdown = ocr.run(execution, lambda _: None)
    assert len(seen) == 1 and "\x00" not in markdown
    assert markdown.index("Native above") < markdown.index(TEXT) < markdown.index("Native below")
    manifest = read_manifest(execution.result_dir)
    assert manifest.status == "success" and manifest.recipe["ocr_text"] is True
    page = read_page(execution.result_dir, 1, manifest)
    assert [segment.text for segment in page.segments] == ["Native above", TEXT, "Native below"]
    crop, = page.units[0].crops
    assert (crop.kind, crop.bbox_pt) == ("text", (40, 90, 200, 110))


def test_artwork_printed_after_a_replaced_block_reads_after_it(tmp_path, monkeypatch):
    """Both anchor before "Native below" among the blocks kept; the page's printed order breaks the tie."""
    broken, _ = _pdfs(tmp_path)
    execution = replace(resolve(RunParams(pdf=broken, model="surya", result_dir=tmp_path / "result")),
                        ocr_regions=(OcrRegion(1, (40, 120, 260, 140)),))
    monkeypatch.setattr(ocr.TRANSCRIBERS["native"], "transcribe", Mock(return_value=Transcription({}, [
        record(1, [block("Native above", (40, 20, 260, 40)), block("Units: cm \x00 1", (40, 90, 200, 110)),
                   block("Native below", (40, 150, 260, 170))], source_page=1)])))
    monkeypatch.setattr(ocr.TRANSCRIBERS["surya"], "transcribe", lambda request, crops, emit: Transcription({}, [
        record(n, [block(TEXT if region.kind == "text" else "Artwork words", (0, 0, image.width, image.height))],
               image=image) for n, (_, region, image) in enumerate(crops, 1)]))
    ocr.run(execution, lambda _: None)
    page = read_page(execution.result_dir, 1, read_manifest(execution.result_dir))
    assert [segment.text for segment in page.segments] == ["Native above", TEXT, "Artwork words", "Native below"]


def test_a_screened_glyph_that_docling_decodes_needs_no_ocr(tmp_path, monkeypatch):
    broken, _ = _pdfs(tmp_path)
    execution = resolve(RunParams(pdf=broken, model="surya", result_dir=tmp_path / "result"))
    monkeypatch.setattr(ocr.TRANSCRIBERS["native"], "transcribe", Mock(return_value=Transcription({}, [
        replace(record(1, [block("Units: cm - 1", (40, 90, 200, 110))], source_page=1), markdown="Units: cm - 1")])))
    monkeypatch.setattr(ocr.TRANSCRIBERS["surya"], "transcribe", Mock(side_effect=AssertionError("no OCR input")))
    assert "Units: cm - 1" in ocr.run(execution, lambda _: None)
    assert read_manifest(execution.result_dir).status == "success"


def _only_block_read_by(tmp_path, monkeypatch, ocr_text):
    broken, _ = _pdfs(tmp_path)
    execution = resolve(RunParams(pdf=broken, model="surya", result_dir=tmp_path / "result"))
    monkeypatch.setattr(ocr.TRANSCRIBERS["native"], "transcribe", Mock(return_value=Transcription({}, [
        record(1, [block("Units: cm \x00 1", (40, 90, 200, 110))], source_page=1)])))
    monkeypatch.setattr(ocr.TRANSCRIBERS["surya"], "transcribe", lambda request, crops, emit: Transcription({}, [
        record(1, [block(ocr_text, (0, 0, image.width, image.height))] if ocr_text else [], image=image)
        for _, _, image in crops]))
    return execution


def test_a_page_whose_only_block_is_read_by_ocr_publishes_it_once(tmp_path, monkeypatch):
    execution = _only_block_read_by(tmp_path, monkeypatch, TEXT)
    ocr.run(execution, lambda _: None)
    page = read_page(execution.result_dir, 1, read_manifest(execution.result_dir))
    assert [(segment.text, segment.extent) for segment in page.segments] == [(TEXT, "block")]


def test_ocr_returning_no_text_for_a_native_block_is_incomplete(tmp_path, monkeypatch):
    with pytest.raises(IncompleteConversionError, match="native text crop 1 returned no text"):
        ocr.run(_only_block_read_by(tmp_path, monkeypatch, None), lambda _: None)


def test_a_text_crop_gets_a_white_margin_and_its_pixels_still_map_to_the_block(tmp_path):
    from kei_exp.cut import artwork_crops
    from kei_exp.pages import PdfPages
    pdf, _ = _pdfs(tmp_path)
    bbox = (50.0, 60.0, 250.0, 100.0)
    with PdfPages(pdf) as pages:
        (_, figure, plain), (_, text, image) = artwork_crops(pages, [(1, bbox, 0, "figure"), (1, bbox, 1, "text")], 144)
    pad = (image.width - plain.width) // 2
    assert pad == round(0.15 * max(plain.size)) and image.height == plain.height + 2 * pad
    assert image.getpixel((0, 0)) == image.getpixel((image.width - 1, image.height - 1)) == 255
    assert text.transform.to_unit_points((pad, pad, pad + plain.width, pad + plain.height)) == pytest.approx(
        figure.transform.to_unit_points((0, 0, plain.width, plain.height)))
