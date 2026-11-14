"""Keep fully clipped PDF text out of the native decoder, without changing the source document."""
from ctypes import c_float, c_int
from io import BytesIO
from pathlib import Path

import pypdfium2 as pdfium
from docling.datamodel.base_models import DocumentStream
from pypdf import PageObject, PdfWriter
from pypdf.generic import (ArrayObject, ByteStringObject, ContentStream, DecodedStreamObject, DictionaryObject,
                           NameObject, NumberObject, RectangleObject)

from kei_exp._pdfium import pdfium_lock


def visible_text_source(path: Path) -> Path | DocumentStream:
    """Docling reads text outside a Form's clip, including drafts embedded beside a figure.

    PDFium exposes clips in the object's parent coordinate space. Empty only text blocks wholly disjoint
    from a clip's enclosing box; partially visible blocks and nonrectangular interiors stay untouched.
    The native decoder alone reads the in-memory copy: rendering, source hashes and published inputs stay original.
    """
    writer = PdfWriter(clone_from=path)
    visited = set()
    changed = False

    def clean(resources):
        nonlocal changed
        resources = resources.get_object()
        for reference in resources.get('/XObject', {}).values():
            form = reference.get_object()
            if form.get('/Subtype') != '/Form' or reference.idnum in visited:
                continue
            visited.add(reference.idnum)
            clean(form.get('/Resources', DictionaryObject()))
            replacement = _clean_form(form)
            if replacement is not None:
                replacement[NameObject('/Resources')] = replacement['/Resources'].clone(writer)
                writer._replace_object(reference, replacement)
                changed = True

    for page in writer.pages:
        clean(page.get('/Resources', DictionaryObject()))
    if not changed:
        return path
    stream = BytesIO()
    writer.write(stream)
    stream.seek(0)
    return DocumentStream(name=path.name, stream=stream)


def _clean_form(form):
    # Keep the original graphics operators: PDFium content regeneration can change ICC-coloured paths.
    contents = ContentStream(form, form.indirect_reference.pdf)
    probe = ContentStream(None, form.indirect_reference.pdf)
    marked = []
    block = -1
    for operands, operator in contents.operations:
        if operator == b'BT':
            block += 1
            marked.append(([NameObject('/Span'), DictionaryObject({NameObject('/FREEClipBlock'): NumberObject(block)})],
                           b'BDC'))
        marked.append((operands, operator))
        if operator == b'ET':
            marked.append(([], b'EMC'))
    if block < 0:
        return None
    probe.operations = marked
    left, bottom, right, top = map(float, form['/BBox'])
    left, right = sorted((left, right))
    bottom, top = sorted((bottom, top))
    page = PageObject.create_blank_page(width=right - left, height=top - bottom)
    page.mediabox = RectangleObject((left, bottom, right, top))
    page[NameObject('/Resources')] = form.get('/Resources', DictionaryObject())
    page[NameObject('/Contents')] = probe
    isolated = PdfWriter()
    isolated.add_page(page)
    data = BytesIO()
    isolated.write(data)
    data.seek(0)
    seen, visible = set(), set()
    with pdfium_lock, pdfium.PdfDocument(data) as document:
        page = document[0]
        textpage = page.get_textpage()
        try:
            for obj in page.get_objects(max_depth=1, textpage=textpage):
                if obj.type != pdfium.raw.FPDF_PAGEOBJ_TEXT or not obj.extract().strip():
                    continue
                for index in range(pdfium.raw.FPDFPageObj_CountMarks(obj.raw)):
                    mark = pdfium.raw.FPDFPageObj_GetMark(obj.raw, index)
                    identity = c_int()
                    if not pdfium.raw.FPDFPageObjMark_GetParamIntValue(mark, b'FREEClipBlock', identity):
                        continue
                    seen.add(identity.value)
                    x0, y0, x1, y1 = obj.get_bounds()
                    if not (x1 < left or x0 > right or y1 < bottom or y0 > top or _outside_clip(obj)):
                        visible.add(identity.value)
        finally:
            textpage.close()
            page.close()
    hidden = seen - visible
    # shortcut: mixed visible/clipped BT blocks remain intact; split shows only with exact text-advance preservation.
    if not hidden:
        return None
    block = -1
    filtered = []
    for operands, operator in contents.operations:
        if operator == b'BT':
            block += 1
        if block in hidden and operator in (b'Tj', b'TJ', b"'", b'"'):
            # Empty the show, retaining font/spacing state. The next BT resets text positioning.
            operands = [*operands[:-1], ArrayObject() if operator == b'TJ' else ByteStringObject(b'')]
        filtered.append((operands, operator))
    contents.operations = filtered
    replacement = DecodedStreamObject()
    replacement.update({key: value for key, value in form.items()
                        if key not in ('/Filter', '/DecodeParms', '/Length')})
    replacement.set_data(contents.get_data())
    return replacement


def _outside_clip(obj: pdfium.PdfObject) -> bool:
    clip = pdfium.raw.FPDFPageObj_GetClipPath(obj.raw)
    if not clip:
        return False
    left, bottom, right, top = obj.get_bounds()
    for index in range(pdfium.raw.FPDFClipPath_CountPaths(clip)):
        points = []
        for ordinal in range(pdfium.raw.FPDFClipPath_CountPathSegments(clip, index)):
            segment = pdfium.raw.FPDFClipPath_GetPathSegment(clip, index, ordinal)
            x, y = c_float(), c_float()
            if pdfium.raw.FPDFPathSegment_GetPoint(segment, x, y):
                points.append((x.value, y.value))
        if points and (right < min(x for x, _ in points) or left > max(x for x, _ in points)
                       or top < min(y for _, y in points) or bottom > max(y for _, y in points)):
            return True
    return False
