"""A rendered minus with an unusable Unicode map must be read from the page image."""
from unittest.mock import patch

import pypdfium2 as pdfium

from kei_exp.transcription.native import native_regions, _has_undecodable_glyph
from kei_exp.kie.stages.ocr import resolve
from kei_exp.transcription.types import RunParams


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


def test_undecodable_font_glyph_refuses_native_text_and_readable_text_stays_native(tmp_path):
    broken, clean = _pdfs(tmp_path)
    assert native_regions(clean) == ()
    assert native_regions(broken) is None


def test_undecodable_font_glyph_routes_to_the_selected_ocr_model(tmp_path):
    broken, clean = _pdfs(tmp_path)
    execution = resolve(RunParams(pdf=broken, model="surya"))
    assert execution.transcriber == "surya"
    assert execution.model == "surya"
    assert resolve(RunParams(pdf=clean, model="surya")).transcriber == "native"


def test_undecodable_font_glyph_is_judged_per_selected_page_range(tmp_path):
    broken, clean = _pdfs(tmp_path)
    with pdfium.PdfDocument.new() as combined, pdfium.PdfDocument(clean) as a, pdfium.PdfDocument(broken) as b:
        combined.import_pages(a)
        combined.import_pages(b)
        path = tmp_path / "mixed.pdf"
        combined.save(path)
    assert native_regions(path, (1, 1)) == ()
    assert native_regions(path, (2, 2)) is None


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
