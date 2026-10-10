"""Merge native page evidence with the OCR of its substantial textless embedded artwork.

The OCR stage (`kei_exp.kie.stages.ocr`) owns the route, the crops, their reading anchors and progress identity;
it runs the native transcriber and the selected model's transcriber as they are. This module only joins their
records: one whole-page record per native page, its crops' outcomes attached unchanged as supplements.
"""
from dataclasses import replace
from html import escape

from kei_exp.regions import Crop, splice
from kei_exp.transcription import html as html_export
from kei_exp.transcription.types import ConversionError, OcrRecord, PageRecord, Transcription, html_to_text

KIND = "hybrid"

# The labels of the furniture a native page's blocks carry (`native.BLOCK_LAYERS`) and Docling's page Markdown
# leaves out, and the headings it writes as such: the Markdown of a supplemented page reads like its neighbours'.
# Furniture stays in the page file but never anchors artwork (`regions.anchor`).
FURNITURE = frozenset({"PageHeader", "PageFooter"})
HEADINGS = {"Title": "h1", "SectionHeader": "h2"}


def supplement(native: Transcription, recognized: Transcription, crops: list[Crop],
               anchors: list[int]) -> Transcription:
    """Native's records with each crop's record attached to its page, read at its anchor (`regions.anchor`).

    crops[n - 1] and anchors[n - 1] are the crop recognized's record n read. OCR text never makes a page with
    missing native evidence complete. ConversionError: native omitted a page that has a crop.
    """
    assert sorted(record.page for record in recognized.pages) == list(range(1, len(crops) + 1)), \
        "OCR records are not the region inputs"
    grouped: dict[int, list[OcrRecord]] = {}
    for record in recognized.pages:
        crop = crops[record.page - 1]
        grouped.setdefault(crop[0], []).append(OcrRecord(record.page, crop, record, anchors[record.page - 1]))
    if set(grouped) - {page.source_page for page in native.pages}:
        raise ConversionError("Native conversion omitted a page containing an OCR region")
    converter = html_export.converter()
    merged = []
    for page in native.pages:
        supplements = tuple(sorted(grouped.get(page.source_page, []), key=lambda s: s.crop[1].order))
        if not supplements:
            merged.append(page)
            continue
        markdown, text, unreadable = _export(converter, page, supplements)
        reasons = [p.incomplete for p in [page, *(s.record for s in supplements)] if p.incomplete]
        if not page.payload.get("blocks") and all(s.crop[1].kind != "text" for s in supplements):
            reasons.append(f"page {page.source_page}: native evidence has no located blocks")
        if unreadable:
            reasons.append(f"page {page.source_page}: hybrid HTML export failed: {unreadable}")
        # Artwork may hold no text; a native block read by OCR always did.
        reasons += [f"page {page.source_page}: OCR of native text crop {s.ordinal} returned no text"
                    for s in supplements if s.crop[1].kind == "text" and not _has_text(s.record)]
        merged.append(replace(page, ocr=supplements, markdown=markdown, text=text,
                              incomplete="; ".join(reasons) or None,
                              input_tokens=_sum(s.record.input_tokens for s in supplements),
                              output_tokens=_sum(s.record.output_tokens for s in supplements),
                              capped=any(s.record.capped for s in supplements)))
    unattributed = "; ".join(reason for reason in (native.unattributed, recognized.unattributed) if reason)
    return Transcription({**native.header, "ocr": recognized.header}, merged, unattributed or None)


def _has_text(record: PageRecord) -> bool:
    blocks = record.payload.get("blocks") or []
    return any(part.strip() for part in [record.text, record.markdown,
                                         *(html_to_text(b["html"]) for b in blocks if not b.get("skipped"))])


def _sum(values) -> int | None:
    values = list(values)
    return sum(values) if all(value is not None for value in values) else None


def _export(converter, page: PageRecord, supplements: tuple[OcrRecord, ...]) -> tuple[str, str, str | None]:
    """The page's Markdown and text in reading order. Native blocks are written as Docling's page export writes
    them (body only, headings as headings); OCR blocks' HTML runs go through the HTML backend together, and a
    VLM's Markdown is kept exactly as the engine gave it."""
    native: list[str | None] = []
    for block in page.payload.get("blocks", []):
        tag = HEADINGS.get(block["label"])
        skip = block.get("skipped") or block["label"] in FURNITURE
        native.append(None if skip else f"<{tag}>{escape(html_to_text(block['html']))}</{tag}>" if tag
                      else block["html"])
    regions = []
    for supplement in supplements:
        blocks = supplement.record.payload.get("blocks")
        regions.append((supplement.anchor, [supplement.record] if blocks is None
                        else [block["html"] for block in blocks if not block.get("skipped")]))
    markdown, text, errors, pending = [], [], [], []

    def flush():
        if not pending:
            return
        html = "\n".join(pending)
        exported, error = html_export.markdown(converter, html, f"page-{page.source_page}")
        markdown.append(exported)
        text.append(html_to_text(html))
        if error:
            errors.append(error)
        pending.clear()

    for part in splice(native, regions):
        if isinstance(part, PageRecord):  # a VLM's Markdown, which HTML would escape
            flush()
            markdown.append(part.markdown)
            text.append(part.text)
        elif part is not None:
            pending.append(part)
    flush()
    return "\n\n".join(part for part in markdown if part), "\n".join(text), "; ".join(errors) or None
