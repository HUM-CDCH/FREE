"""Synthetic embedded figures: clipped drafts must never become native evidence."""
from io import BytesIO

import pypdfium2 as pdfium
import pytest
from docling.datamodel.base_models import DocumentStream, InputFormat
from docling.datamodel.document import InputDocument
from docling.document_converter import PdfFormatOption
from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, FloatObject, NameObject, NumberObject

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


def test_native_pdf_without_clipped_text_is_not_rewritten(tmp_path, monkeypatch):
    path = tmp_path / 'ordinary.pdf'
    text_pdf(path, [['A printed value: 34.51']])
    monkeypatch.setattr('kei_exp.transcription.native_pdf.PdfWriter',
                        lambda **_: pytest.fail('an ordinary native PDF must not be cloned'))
    assert visible_text_source(path) == path


def test_only_forms_on_selected_pages_are_inspected(clipped_figure_pdf, tmp_path, monkeypatch):
    from kei_exp.transcription import native_pdf

    plain = tmp_path / 'plain.pdf'
    text_pdf(plain, [['A printed value: 34.51']])
    writer = PdfWriter(clone_from=plain)
    writer.append(clipped_figure_pdf)
    path = tmp_path / 'selected.pdf'
    writer.write(path)
    original = native_pdf._clean_form
    calls = []
    def clean(form):
        calls.append(form)
        return original(form)
    monkeypatch.setattr(native_pdf, '_clean_form', clean)
    assert visible_text_source(path, (1, 1)) == path
    assert calls == []
    source = visible_text_source(path, (2, 2))
    assert len(calls) == 1
    assert '99.99' not in decoded_text(source)


@pytest.mark.parametrize('clipped_figure_pdf', [False, True], indirect=True)
def test_indirect_resource_dictionaries_are_resolved(clipped_figure_pdf):
    writer = PdfWriter(clone_from=clipped_figure_pdf)
    resources = writer.pages[0]['/Resources']
    resources[NameObject('/XObject')] = writer._add_object(resources['/XObject'])
    writer.pages[0][NameObject('/Resources')] = writer._add_object(resources)
    path = clipped_figure_pdf.with_name('indirect.pdf')
    writer.write(path)
    source = visible_text_source(path)
    assert '99.99' not in decoded_text(source)
    assert rendered(source) == rendered(path)


@pytest.mark.parametrize('mode', [4, 5, 6, 7])
def test_text_used_as_a_clip_keeps_its_graphics_effect(clipped_figure_pdf, mode):
    writer = PdfWriter(clone_from=clipped_figure_pdf)
    form = writer.pages[0]['/Resources']['/XObject']['/Outer']
    form.set_data(form.get_data() + (
        f'\nBT /F1 11 Tf {mode} Tr 30 170 Td (Clip outside figure) Tj ET\n'
        '0 0 1 rg 0 0 200 100 re f\n').encode())
    path = clipped_figure_pdf.with_name(f'text-clip-{mode}.pdf')
    writer.write(path)
    source = visible_text_source(path)
    assert source == path
    assert rendered(source) == rendered(path)


def test_mixed_visible_and_hidden_text_block_is_kept(clipped_figure_pdf):
    writer = PdfWriter(clone_from=clipped_figure_pdf)
    form = writer.pages[0]['/Resources']['/XObject']['/Outer']
    form.set_data(form.get_data() + b'\nBT /F1 11 Tf 30 170 Td (Hidden mixed value 77.77) Tj '
                                  b'0 -110 Td (Visible mixed value 22.22) Tj ET\n')
    path = clipped_figure_pdf.with_name('mixed.pdf')
    writer.write(path)
    source = visible_text_source(path)
    text = decoded_text(source)
    assert '77.77' in text and '22.22' in text
    assert rendered(source) == rendered(path)


def test_a_form_can_inherit_text_clipping_from_its_caller(clipped_figure_pdf):
    writer = PdfWriter(clone_from=clipped_figure_pdf)
    form = writer.pages[0]['/Resources']['/XObject']['/Outer']
    form.set_data(b'BT /F1 11 Tf 30 170 Td (Clip outside figure) Tj ET\n'
                  b'0 0 1 rg 0 0 200 100 re f\n')
    contents = DecodedStreamObject()
    contents.set_data(b'BT 7 Tr ET\nq 0.8 0 0 0.8 120 300 cm /Outer Do Q')
    writer.pages[0][NameObject('/Contents')] = writer._add_object(contents)
    path = clipped_figure_pdf.with_name('inherited-text-clip.pdf')
    writer.write(path)
    source = visible_text_source(path)
    assert source == path
    assert rendered(source) == rendered(path)


def test_a_visible_glyph_mapped_to_space_is_not_discarded(clipped_figure_pdf):
    writer = PdfWriter(clone_from=clipped_figure_pdf)
    form = writer.pages[0]['/Resources']['/XObject']['/Outer']
    glyph = DecodedStreamObject()
    glyph.set_data(b'500 0 0 0 500 700 d1 0 0 500 700 re f')
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type3'),
        NameObject('/FontBBox'): ArrayObject([FloatObject(v) for v in (0, 0, 500, 700)]),
        NameObject('/FontMatrix'): ArrayObject([FloatObject(v) for v in (.001, 0, 0, .001, 0, 0)]),
        NameObject('/CharProcs'): DictionaryObject({NameObject('/space'): writer._add_object(glyph)}),
        NameObject('/Encoding'): DictionaryObject({NameObject('/Differences'): ArrayObject([
            NumberObject(32), NameObject('/space')])}),
        NameObject('/FirstChar'): NumberObject(32), NameObject('/LastChar'): NumberObject(32),
        NameObject('/Widths'): ArrayObject([FloatObject(500)]), NameObject('/Resources'): DictionaryObject()})
    form['/Resources']['/Font'][NameObject('/F2')] = writer._add_object(font)
    form.set_data(form.get_data() + b'\nBT /F1 11 Tf 30 170 Td (Hidden value 88.88) Tj '
                                  b'/F2 20 Tf 1 0 0 1 30 50 Tm ( ) Tj ET\n')
    path = clipped_figure_pdf.with_name('painted-space.pdf')
    writer.write(path)
    source = visible_text_source(path)
    assert rendered(source) == rendered(path)
