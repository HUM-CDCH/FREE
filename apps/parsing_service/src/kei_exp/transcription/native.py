"""Native PDF text extraction, before the scan-only cut and OCR paths."""
# docling_core re-exports its document types without an __all__, which Pylance reads as private imports.
# pyright: reportPrivateImportUsage=false
from html import escape
from itertools import groupby
from math import isfinite
from pathlib import Path

import pypdfium2 as pdfium
from docling.datamodel.base_models import ConversionStatus, InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.datamodel.settings import DEFAULT_PAGE_RANGE
from docling.document_converter import DocumentConverter, PdfFormatOption
from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline
from docling_core.types.doc import (
    ContentLayer,
    DocItem,
    DocItemLabel,
    DoclingDocument,
    FormulaItem,
    ListItem,
    TableItem,
    TextItem,
)

from kei_exp._pdfium import pdfium_lock
from kei_exp.geometry import PointBox
from kei_exp.progress import Emit
from kei_exp.regions import Crop
from kei_exp.transcription.types import TRANSCRIBER_KNOBS, ConversionError, Execution, OcrRegion, PageRecord, Transcription
from kei_exp.transcription.tables import table_of_html


def native_regions(path: Path, pages: tuple[int, int] | None = None) -> tuple[OcrRegion, ...] | None:
    """Native PDF with its textless artwork, or None when any nonblank page requires the scan path; () when the
    selected pages need no OCR at all.

    Keep the existing 5% artwork threshold and page-sized raster safeguard. A digital page with an image
    table needs only that image read; an OCR overlay on a page-sized scan is not treated as digital prose.
    PDFium measures objects and text in canvas space, whose origin is the MediaBox's, not the displayed page's:
    a region is returned in displayed top-left points (what `PdfPage.render` crops and Docling's boxes use).
    """
    with (
        pdfium_lock,
        pdfium.PdfDocument(str(path)) as document,
    ):
        first, last = pages or (1, len(document))
        if not 1 <= first <= last <= len(document):
            # The same refusal (CLI exit 1) as the cut and whole-page guards; ValueError would be a usage error.
            raise ConversionError(f"page range {first}-{last} outside 1-{len(document)}")
        found_text = False
        regions: list[OcrRegion] = []
        for index in range(first - 1, last):
            page = document[index]
            try:
                textpage = page.get_textpage()
                try:
                    text = textpage.get_text_bounded().strip()
                    objects = list(page.get_objects())
                    if not text:
                        if objects:
                            return None
                        continue
                    # An embedded font can render a symbol while its Unicode map
                    # exposes only a control code. Read the visible page through
                    # the established OCR path; never guess a scientific symbol.
                    if _has_unmapped_glyph(textpage):
                        return None
                    width, height = page.get_size()
                    x0, y0, x1, y1 = page.get_bbox()  # the displayed page in canvas space: MediaBox and CropBox
                    page_regions: list[OcrRegion] = []
                    for obj in objects:
                        if obj.type not in {pdfium.raw.FPDF_PAGEOBJ_IMAGE, pdfium.raw.FPDF_PAGEOBJ_FORM}:
                            continue
                        left, bottom, right, top = _canvas_bounds(obj)
                        left, bottom, right, top = max(left, x0), max(bottom, y0), min(right, x1), min(top, y1)
                        area = max(0, right - left) * max(0, top - bottom)
                        # A page-sized scan with an OCR overlay still needs OCR. A substantial textless
                        # form/image can be a table whose letters are outlines: native text loses its body
                        # completely (Akita 2020, p4). Include embedded artwork rather than guessing its text.
                        if obj.type == pdfium.raw.FPDF_PAGEOBJ_IMAGE and area >= width * height / 2:
                            return None
                        if area >= width * height / 20 and not textpage.get_text_bounded(left, bottom, right, top).strip():
                            # PDFium object bounds are unrotated; the crop renderer uses displayed page space.
                            # Until the projection is supported, rotated artwork retains the established scan path.
                            if page.get_rotation():
                                return None
                            page_regions.append(OcrRegion(index + 1, (left - x0, y1 - top, right - x0, y1 - bottom)))
                    distinct = _distinct_regions(page_regions)
                    # A bounding union of overlapping objects can enclose native prose between them. Retain
                    # the scan path in that case rather than replace those original characters with OCR.
                    if any(textpage.get_text_bounded(left + x0, y1 - bottom, right + x0, y1 - top).strip()
                           for region in distinct for left, top, right, bottom in [region.bbox]):
                        return None
                    regions.extend(distinct)
                    found_text = True
                finally:
                    textpage.close()
            finally:
                page.close()
        return tuple(regions) if found_text else None


def _has_unmapped_glyph(textpage: pdfium.PdfTextPage) -> bool:
    for index in range(textpage.count_chars()):
        code = pdfium.raw.FPDFText_GetUnicode(textpage, index)
        if code < 32 and code not in (9, 10, 13) \
                and not pdfium.raw.FPDFText_IsGenerated(textpage, index) \
                and not pdfium.raw.FPDFText_IsHyphen(textpage, index):
            return True
    return False


def _canvas_bounds(obj: pdfium.PdfObject) -> tuple[float, float, float, float]:
    """An object's bounds on the page canvas. PDFium bounds an object inside a Form XObject in that form's own
    space; the forms around it place it on the page. Recursing still matters: a page-sized scan or a textless
    image can sit inside a form whose own box also holds text."""
    bounds = obj.get_bounds()
    container = obj.container
    while container is not None:
        bounds = container.get_matrix().on_rect(*bounds)
        container = container.container
    return bounds


def _distinct_regions(regions: list[OcrRegion]) -> tuple[OcrRegion, ...]:
    """Overlapping form/image objects describe one crop, never duplicate OCR of the same printed region."""
    merged: list[OcrRegion] = []
    for region in regions:
        remaining = merged.copy()
        merged = []
        while remaining:
            other = remaining.pop(0)
            a, b = region.bbox, other.bbox
            if region.page == other.page and max(a[0], b[0]) < min(a[2], b[2]) \
                    and max(a[1], b[1]) < min(a[3], b[3]):
                region = OcrRegion(region.page, (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])))
                remaining = merged + remaining
                merged = []
            else:
                merged.append(other)
        merged.append(region)
    return tuple(sorted(merged, key=lambda region: (region.page, region.bbox[1], region.bbox[0])))


class PageBoundPipeline(StandardPdfPipeline):
    """Docling's standard pipeline with no item merged across a page break, so a page's export carries what is
    printed on it and nothing of its neighbour. The merge's provenance charspans cannot be trusted to slice a
    page's text back out: docling 2.127 computes them before the join drops a hyphen or soft hyphen, two
    characters off exactly where a word breaks across pages. A paragraph continued on the next page stays one
    item per page, hyphen as printed; a column continuation on one page still merges."""

    def __init__(self, pipeline_options: PdfPipelineOptions) -> None:
        super().__init__(pipeline_options)
        predictor = self.reading_order_model.ro_model
        predict = predictor.predict_merges

        def within_pages(sorted_elements):
            page = {element.cid: element.page_no for element in sorted_elements}
            merges = {}
            for head, tail in predict(sorted_elements=sorted_elements).items():
                for _, run in groupby([head, *tail], key=page.__getitem__):  # a chain cut at every page break
                    first, *rest = run
                    if rest:
                        merges[first] = rest
            return merges
        predictor.predict_merges = within_pages


# Docling's item labels in the vocabulary Surya's blocks use, so one consumer mapping serves both paths; a label
# with no counterpart there is carried as Docling writes it. `SectionHeader`, `PageHeader` and `PageFooter` are
# the names the installed Surya canonicalises its layout predictions to (surya/layout/label.py).
BLOCK_LABELS = {
    DocItemLabel.SECTION_HEADER: "SectionHeader",
    DocItemLabel.TITLE: "Title",
    DocItemLabel.TEXT: "Text",
    DocItemLabel.PARAGRAPH: "Text",
    DocItemLabel.LIST_ITEM: "List-item",
    DocItemLabel.TABLE: "Table",
    DocItemLabel.PICTURE: "Picture",
    DocItemLabel.CAPTION: "Caption",
    DocItemLabel.FORMULA: "Formula",
    DocItemLabel.CODE: "Code",
    DocItemLabel.FOOTNOTE: "Footnote",
    DocItemLabel.PAGE_HEADER: "PageHeader",
    DocItemLabel.PAGE_FOOTER: "PageFooter",
    DocItemLabel.DOCUMENT_INDEX: "TableOfContents",
    DocItemLabel.FORM: "Form",
}

# The content layers a page's blocks are read from. BODY alone — `iterate_items`' default — drops every running
# header, running footer and page number, because Docling's PDF pipeline files each PAGE_HEADER/PAGE_FOOTER item
# under FURNITURE. A scan publishes Surya's PageHeader blocks, so a native page that dropped them would give the
# same page two different evidence sets depending on how it was read; and a catalogue's running header is
# evidence a record may inherit from (shared heading context). BACKGROUND, INVISIBLE and NOTES stay out: they are
# not printed matter. The page's `text`/`markdown` exports keep Docling's own default (BODY), so the accepted
# Markdown is unchanged — the blocks are the evidence set, deliberately wider than the reading text.
BLOCK_LAYERS = {ContentLayer.BODY, ContentLayer.FURNITURE}


def blocks_of(document: DoclingDocument, page_no: int, *, omit: tuple[PointBox, ...] = ()) -> list[dict]:
    """The items Docling placed on one page, as the blocks a Surya page returns, in the document's own order.

    Born-digital provenance already exists — Docling knows each item's page and box — so a native page publishes
    one block per body and furniture item rather than one coarse box around the whole page. A table keeps its
    structure as HTML, any other text-bearing item is its text in a paragraph; an item with neither (a bare
    picture) carries no evidence and is left out. A table's caption is serialised inside that table's HTML, so
    the caption item itself is left out too rather than published twice; a picture's caption is published,
    because the picture it belongs to is not. The box is the item's first provenance on *this* page, in the page's
    own top-left points, which is where `kei_exp.result` expects an engine box whose record has no image to be
    transformed through. An item printed in several places on the page (a paragraph Docling merged across a column
    break) also lists every such box, the first included, in reading order as `boxes`.
    """
    page = document.pages.get(page_no)
    if page is None:  # a page Docling could not build: its record keeps the coarse segment
        return []
    items = [(item, level) for item, level in _items(document, page_no) if not _covered(item, document, page_no, omit)]
    inlined = {reference.cref for item, _level in items
               if isinstance(item, TableItem) for reference in item.captions}
    blocks = []
    for item, _level in items:
        provenances = [prov for prov in item.prov if prov.page_no == page_no] if isinstance(item, DocItem) else []
        if not provenances or item.self_ref in inlined:
            continue
        if isinstance(item, TableItem):
            html = item.export_to_html(doc=document)
        elif isinstance(item, ListItem) and item.orig.strip():
            # Docling strips a list item's printed marker ("31.") from `text`; `orig` keeps the PDF's own
            # characters. A catalogue's entry numbers are such markers, so the source text is what is published.
            html = f"<p>{escape(item.orig)}</p>"
        elif text := getattr(item, "text", ""):
            html = f"<p>{escape(text)}</p>"
        else:
            continue
        boxes = [[box.l, box.t, box.r, box.b]
                 for box in (prov.bbox.to_top_left_origin(page.size.height) for prov in provenances)]
        block = {"html": html, "label": BLOCK_LABELS.get(item.label, str(item.label)),
                 "bbox": boxes[0], "confidence": None, "error": False, "skipped": False}
        if len(boxes) > 1:
            block["boxes"] = boxes
        if isinstance(item, TableItem):
            block["table"] = _table_of(item, document, page_no, html)
        blocks.append(block)
    return blocks


def _covered(item, document: DoclingDocument, page_no: int, boxes: tuple[PointBox, ...]) -> bool:
    """An item inside an OCR crop belongs to that crop; keep its caption when it lies outside the crop."""
    provenance = next((prov for prov in getattr(item, "prov", []) if prov.page_no == page_no), None)
    page = document.pages.get(page_no)
    if provenance is None or page is None or not boxes:  # a page Docling could not build has no item to omit
        return False
    box = provenance.bbox.to_top_left_origin(page.size.height)
    area = (box.r - box.l) * (box.b - box.t)
    return area > 0 and any(max(0, min(box.r, right) - max(box.l, left)) * max(0, min(box.b, bottom) - max(box.t, top))
                           >= area * 0.95 for left, top, right, bottom in boxes)


def _table_of(item: TableItem, document: DoclingDocument, page_no: int, html: str) -> dict | None:
    table = table_of_html(html)
    if table is None:
        return None
    page = document.pages[page_no]
    sources: dict[tuple[int, int], list] = {}
    for source in item.data.table_cells:
        sources.setdefault((source.start_row_offset_idx, source.start_col_offset_idx), []).append(source)
    for cell in table["cells"]:
        candidates = sources.get((cell["row"], cell["column"]), [])
        if len(candidates) != 1:
            continue
        source = candidates[0]
        if (source.row_span, source.col_span) != (cell["rowspan"], cell["colspan"]):
            continue
        box = source.bbox
        # Rich cells may carry their geometry on a referenced document item.
        if reference := getattr(source, "ref", None):
            resolved = reference.resolve(document)
            provenances = [p for p in getattr(resolved, "prov", []) if p.page_no == page_no]
            box = provenances[0].bbox if len(provenances) == 1 else None
        if box is None:
            continue
        box = box.to_top_left_origin(page.size.height)
        values = [box.l, box.t, box.r, box.b]
        if all(isfinite(v) for v in values) and 0 <= box.l < box.r <= page.size.width \
                and 0 <= box.t < box.b <= page.size.height:
            cell["bbox_pt"] = values
        cell["role"] = ("column_header" if source.column_header else "row_header" if source.row_header
                        else "row_section" if source.row_section else "data")
    return table


def _items(document: DoclingDocument, page_no: int):
    """One page's items over `BLOCK_LAYERS`, in the document's own order. Named once so the caption pass and the
    block pass can never disagree about which items the page has."""
    return document.iterate_items(page_no=page_no, included_content_layers=BLOCK_LAYERS)


class NativeText:
    """Transcriber over the PDF's own text through Docling's standard layout/table pipeline: no OCR, VLM or server."""
    kind = "native"
    knobs = TRANSCRIBER_KNOBS[kind]

    def transcribe(self, execution: Execution, crops: list[Crop] | None, emit: Emit) -> Transcription:
        options = PdfPipelineOptions(do_ocr=False, force_backend_text=True)
        converter = DocumentConverter(format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_cls=PageBoundPipeline, pipeline_options=options)})
        emit({"type": "log", "text": "Embedded PDF text found; extracting without OCR."})
        pages = execution.pages
        emit({"type": "phase", "name": "native", "total": pages[1] - pages[0] + 1 if pages else None})
        result = converter.convert(execution.pdf, raises_on_error=False, page_range=pages or DEFAULT_PAGE_RANGE)
        document = result.document
        # Without formula recognition Docling leaves native formula characters in orig and exports a placeholder.
        # Preserve those characters as text; they are not decoded LaTeX.
        document.texts = [TextItem(**{**item.model_dump(), "label": DocItemLabel.TEXT, "text": item.orig})
                          if isinstance(item, FormulaItem) and not item.text else item for item in document.texts]
        records = []
        for index, page in enumerate(result.pages, 1):
            omit = tuple(region.bbox for region in execution.ocr_regions if region.page == page.page_no)
            errors = [error.error_message for error in result.errors if error.page_no == page.page_no]
            errors += ["table has no readable cells; OCR is required" for item, _ in _items(document, page.page_no)
                       if isinstance(item, TableItem) and not _covered(item, document, page.page_no, omit)
                       and not any(cell.text.strip() for cell in item.data.table_cells)]
            blocks = blocks_of(document, page.page_no, omit=omit)
            records.append(PageRecord(
                page=index, region=None, image=None, seconds=None, input_tokens=0, output_tokens=0, stop=None,
                capped=False, payload={"blocks": blocks} if blocks else {}, stats={},
                markdown=document.export_to_markdown(page_no=page.page_no),
                text=document.export_to_text(page_no=page.page_no),
                incomplete=f"page {page.page_no}: " + "; ".join(errors) if errors else None, source_page=page.page_no,
            ))
        stray = "; ".join(error.error_message for error in result.errors if not error.page_no)
        unattributed = None
        if result.status != ConversionStatus.SUCCESS:
            status = f"native PDF extraction: {result.status.value}"
            attributed = any(record.incomplete for record in records)
            unattributed = f"{status}: {stray}" if stray else (None if attributed else status)
        header = {"prompt": None, "scale": 1.0, "max_size": None, "max_output_tokens": None,
                  "generation_params": None, "errors": [error.model_dump(mode="json") for error in result.errors],
                  "docling_status": result.status.value}
        emit({"type": "phase", "name": "export", "total": None})
        return Transcription(header, records, unattributed)
