"""Synthetic embedded figures: clipped drafts must never become native evidence."""
from io import BytesIO

import pypdfium2 as pdfium
import pytest
from docling.datamodel.base_models import DocumentStream, InputFormat
from docling.datamodel.document import InputDocument
from docling.document_converter import PdfFormatOption
from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject

from kei_exp.transcription.native_pdf import visible_text_source
from tests.helpers.pdfs import text_pdf


@pytest.fixture
def clipped_figure_pdf(tmp_path, request):
    """A figure PDF retains a draft paragraph outside its BBox, as some publisher exports do."""
    writer = PdfWriter()
    page = writer.add_blank_page(width=600, height=800)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'),
                             NameObject('/BaseFont'): NameObject('/Helvetica')})
    resources = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})

    def stream(data):
        obj = DecodedStreamObject()
        obj.set_data(data)
        return obj

    figure = stream(b'q 1 0 0 rg 20 20 150 70 re f Q\n'
                    b'BT /F1 11 Tf 30 150 Td (Temperature 34.51) Tj ET\n'
                    b'BT /F1 11 Tf 30 170 Td (Draft value 99.99) Tj ET\n'
                    b'BT /F1 11 Tf 30 30 Td (Visible figure label 12.75) Tj ET\n'
                    b'BT /F1 11 Tf 30 95 Td (Partially clipped label) Tj ET')
    figure.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Form'),
                   NameObject('/BBox'): ArrayObject([FloatObject(v) for v in (0, 0, 200, 100)]),
                   NameObject('/Resources'): resources})
    # Both an inner and an outer transform exercise the clip's parent coordinate space.
    outer = stream(b'q 1 0 0 1 10 20 cm /Figure Do Q')
    outer.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Form'),
                  NameObject('/BBox'): ArrayObject([FloatObject(v) for v in (0, 0, 250, 250)]),
                  NameObject('/Resources'): DictionaryObject({NameObject('/XObject'): DictionaryObject({
                      NameObject('/Figure'): writer._add_object(figure)})})})
    placed = outer if getattr(request, 'param', False) else figure
    page[NameObject('/Resources')] = DictionaryObject({**resources, NameObject('/XObject'): DictionaryObject({
        NameObject('/Outer'): writer._add_object(placed)})})
    page[NameObject('/Contents')] = writer._add_object(stream(
        b'BT /F1 11 Tf 72 730 Td (Temperature 34.51) Tj ET\n'
        b'BT /F1 11 Tf 72 700 Td (Repeated visible note) Tj 0 -20 Td (Repeated visible note) Tj ET\n'
        b'q 0.8 0 0 0.8 120 300 cm /Outer Do Q'))
    path = tmp_path / 'clipped-figure.pdf'
    writer.write(path)
    return path


def decoded_text(source):
    stream = BytesIO(source.stream.getvalue()) if isinstance(source, DocumentStream) else source
    document = InputDocument(stream, InputFormat.PDF, PdfFormatOption.model_fields['backend'].default,
                             filename='fixture.pdf')
    try:
        return '\n'.join(cell.text for page in document._backend.iter_pages()
                         for cell in page.get_segmented_page().textline_cells)
    finally:
        document._backend.unload()


def rendered(source):
    stream = source.stream if isinstance(source, DocumentStream) else source
    with pdfium.PdfDocument(stream) as document:
        page = document[0]
        try:
            bitmap = page.render(scale=1)
            try:
                return bytes(bitmap.buffer)
            finally:
                bitmap.close()
        finally:
            page.close()


@pytest.mark.parametrize('clipped_figure_pdf', [False, True], indirect=True)
def test_clipped_draft_is_removed_without_deduplicating_visible_text(clipped_figure_pdf):
    original = clipped_figure_pdf.read_bytes()
    assert 'Draft value 99.99' in decoded_text(clipped_figure_pdf)
    source = visible_text_source(clipped_figure_pdf)
    text = decoded_text(source)
    assert text.count('Temperature 34.51') == 1
    assert '99.99' not in text
    assert 'Visible figure label 12.75' in text
    assert 'Partially clipped label' in text
    assert text.count('Repeated visible note') == 2
    source.stream.seek(0)
    assert rendered(source) == rendered(clipped_figure_pdf)
    assert clipped_figure_pdf.read_bytes() == original


def test_native_pdf_without_clipped_text_is_not_rewritten(tmp_path):
    path = tmp_path / 'ordinary.pdf'
    text_pdf(path, [['A printed value: 34.51']])
    assert visible_text_source(path) == path
