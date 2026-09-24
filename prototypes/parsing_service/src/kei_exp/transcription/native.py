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
from kei_exp.cut import Crop
from kei_exp.progress import Emit
from kei_exp.transcription.types import ConversionError, Execution, PageRecord, Transcription
from kei_exp.transcription.tables import table_of_html


def has_native_text(path: Path, pages: tuple[int, int] | None = None) -> bool:
    """Every selected nonblank page must have text and no page-sized raster scan.

    A text layer on only some pages is not enough to bypass OCR for a mixed PDF.
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
        for index in range(first - 1, last):
            page = document[index]
            try:
                textpage = page.get_textpage()
                try:
                    text = textpage.get_text_bounded().strip()
                finally:
                    textpage.close()
                objects = list(page.get_objects())
                if not text:
                    if objects:
                        return False
                    continue
                width, height = page.get_size()
                for obj in objects:
                    if isinstance(obj, pdfium.PdfImage):  # pypdfium2 builds the subclass for FPDF_PAGEOBJ_IMAGE
                        l, b, r, t = obj.get_bounds()
                        area = max(0, min(r, width) - max(l, 0)) * max(0, min(t, height) - max(b, 0))
                        # A large scan with a page number or an OCR overlay still needs the scan path.
                        if area >= width * height / 2:
                            return False
                found_text = True
            finally:
                page.close()
        return found_text


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


def blocks_of(document: DoclingDocument, page_no: int) -> list[dict]:
    """The items Docling placed on one page, as the blocks a Surya page returns, in the document's own order.

    Born-digital provenance already exists — Docling knows each item's page and box — so a native page publishes
    one block per body and furniture item rather than one coarse box around the whole page. A table keeps its
    structure as HTML, any other text-bearing item is its text in a paragraph; an item with neither (a bare
    picture) carries no evidence and is left out. A table's caption is serialised inside that table's HTML, so
    the caption item itself is left out too rather than published twice; a picture's caption is published,
    because the picture it belongs to is not. The box is the item's provenance on *this* page, in the page's own
    top-left points, which is where `kei_exp.result` expects an engine box whose record has no image to be
    transformed through.
    """
    page = document.pages.get(page_no)
    if page is None:  # a page Docling could not build: its record keeps the coarse segment
        return []
    inlined = {reference.cref for item, _level in _items(document, page_no)
               if isinstance(item, TableItem) for reference in item.captions}
    blocks = []
    for item, _level in _items(document, page_no):
        provenance = next((prov for prov in item.prov if prov.page_no == page_no), None) \
            if isinstance(item, DocItem) else None
        if provenance is None or item.self_ref in inlined:
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
        box = provenance.bbox.to_top_left_origin(page.size.height)
        block = {"html": html, "label": BLOCK_LABELS.get(item.label, str(item.label)),
                 "bbox": [box.l, box.t, box.r, box.b], "confidence": None, "error": False, "skipped": False}
        if isinstance(item, TableItem):
            block["table"] = _table_of(item, document, page_no, html)
        blocks.append(block)
    return blocks


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
    knobs: frozenset[str] = frozenset()

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
            errors = [error.error_message for error in result.errors if error.page_no == page.page_no]
            blocks = blocks_of(document, page.page_no)
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
