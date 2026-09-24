"""Accepted results: one file per PDF page and a manifest, grounded on the page, written for every outcome.

A page file holds the units that were rendered (the page itself, or the book pages the ingest cut from it), the
crops the transcriber received for them with their render transforms, and the segments found: immutable text,
the engine's own box in the space it read, and that box derived onto the PDF page through the recorded transforms.
The manifest names the generation, every page file written with its hash, the recipe the run followed and its
fingerprint, the token totals and the status. Nothing here reads the debug report. The models of those files and
their reader are `kei_exp.pagefile`, a leaf a reader can import without the converter.
"""
import hashlib
import secrets
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path
from typing import Literal

from kei_exp.canonical import canonical_json, sha256_file
from kei_exp.cut import Crop
from kei_exp.files import publish
from kei_exp.geometry import CropTransform, PointBox
from kei_exp.models import MODELS
from kei_exp.pagefile import (  # noqa: F401  the page-file models keep their names here for their readers
    RESULT_VERSION,
    CropResult,
    PageEntry,
    PageResult,
    PageSegment,
    PixelBox,
    Result,
    Unit,
    result_digest,
)
from kei_exp.pages import BookPages, PdfPages
from kei_exp.transcription.types import TEXT_RULES, Execution, PageRecord, Transcription, html_to_text


@dataclass(frozen=True)
class Input:
    """One transcriber input by its ordinal, and the PDF page, unit and crop it came from."""
    ordinal: int
    page: int                          # PDF page
    unit: int                          # 0 for the page itself; the book page index over the ingest
    crop: Crop | None                  # None for a whole-page input


@dataclass(frozen=True)
class Inventory:
    """What the transcriber was given, and which PDF pages the run selected; built by the OCR stage alone."""
    pages: list[int]                   # expected PDF pages, ascending
    inputs: list[Input]                # by ordinal, 1..N
    book: BookPages | None

    def input(self, ordinal: int) -> Input:
        return self.inputs[ordinal - 1]


def recipe(execution: Execution, source_sha256: str, ingest_digest: str | None) -> dict:
    """What the run was asked to do, as far as that is known before any work: hashed into the fingerprint."""
    record = MODELS[execution.model] if execution.model else None
    return {
        "result_version": RESULT_VERSION, "source_sha256": source_sha256, "ingest_digest": ingest_digest,
        "transcriber": execution.transcriber, "model": execution.model, "repo": execution.repo,
        "cut": execution.cut, "crop_dpi": execution.crop_dpi, "layout_model": execution.layout_model,
        "page_source": execution.page_source, "pages_requested": list(execution.pages) if execution.pages else None,
        "max_image_size": execution.max_image_size, "max_output_tokens": execution.max_output_tokens,
        "record": None if record is None else {
            "max_new_tokens": record.max_new_tokens, "context": record.context, "params": record.params,
            "scale": record.scale, "spec": record.spec.name if record.spec else None,
            "prompt": record.spec.prompt if record.spec else None,
        },
        "versions": versions(),
        # Only a transcriber whose text rules have changed names them, so every other recipe stays as it was.
        **({"text_rules": TEXT_RULES[execution.transcriber]} if execution.transcriber in TEXT_RULES else {}),
    }


def fingerprint(recipe: dict) -> str:
    return hashlib.sha256(canonical_json(recipe)).hexdigest()


def versions() -> dict[str, str]:
    return {"docling": version("docling"), "surya-ocr": version("surya-ocr")}


def new_generation() -> str:
    """The identity of one result as written: the moment, to the microsecond, and a random tail, so two writes of
    one recipe are two generations and a reference into one never resolves in the other."""
    return f"{datetime.now(UTC):%Y%m%dT%H%M%S.%f}Z-{secrets.token_hex(4)}"


def page_markdown(markdowns: Iterable[str]) -> str:
    """A page's Markdown: its records' in reading order, the empty ones adding no blank lines."""
    return "\n\n".join(markdown for markdown in markdowns if markdown)


def assemble_pages(inventory: Inventory, pairs: Iterable[tuple[Input, PageRecord]]) -> Iterator[
        tuple[int, list[tuple[Input, PageRecord]], str]]:
    """Group supplied input/record pairs, preserving their order and every selected page.

    The caller owns ordering: execution supplies outcome order, persistence supplies inventory order.
    Those differ for a shuffled adapter outcome; grouping must not silently reconcile them.
    """
    grouped: dict[int, list[tuple[Input, PageRecord]]] = {number: [] for number in inventory.pages}
    for item, record in pairs:
        grouped[item.page].append((item, record))
    for number, records in grouped.items():
        yield number, records, page_markdown(record.markdown for _, record in records)


def _status(block: dict) -> Literal["ok", "error", "skipped"]:
    return "error" if block.get("error") else "skipped" if block.get("skipped") else "ok"


def _segments(unit: int, ordinal: int | None, record: PageRecord, transform: CropTransform,
              to_page: Callable[[PointBox], PointBox], bbox_pt: PointBox) -> list[PageSegment]:
    """The segments of one record: the engine's blocks one each (Surya's, or Docling's items on a native page),
    else one coarse segment covering the whole input."""
    blocks = record.payload.get("blocks")
    if blocks is None:
        return [PageSegment(text=record.text, html=None, markdown=record.markdown, label="text", confidence=None,
                            status="ok", unit=unit, crop=ordinal, bbox_px=None, bbox_pt=bbox_pt, extent="input")]
    segments = []
    for block in blocks:
        box = tuple(float(v) for v in block["bbox"])
        table = block.get("table")
        if table is not None:
            table = {**table, "cells": [{**cell, "bbox_pt": to_page(transform.to_unit_points(cell["bbox_pt"]))
                                       if cell["bbox_pt"] is not None else None} for cell in table["cells"]]}
        segments.append(PageSegment(
            text=html_to_text(block["html"]), html=block["html"], markdown=None,
            label=block["label"], confidence=block.get("confidence"), status=_status(block), unit=unit,
            crop=ordinal, bbox_px=box, bbox_pt=to_page(transform.to_unit_points(box)), extent="block",
            table=table,
        ))
    return segments


def _total(values: Iterable[int | None]) -> int | None:
    known = [value for value in values if value is not None]
    return sum(known) if known else None


def _whole_image_transform(record: PageRecord, size: tuple[float, float]) -> CropTransform:
    """The transform of an uncut whole-page image, which covers the page exactly: page size over image size."""
    box = record.payload.get("image_bbox")
    if not box:
        return CropTransform(0.0, 0.0, 1.0, 1.0, None)  # no engine geometry: the coarse segment uses no transform
    return CropTransform(0.0, 0.0, size[0] / box[2], size[1] / box[3], None)


@dataclass(frozen=True)
class Source:
    """The PDF as the run found it: name, identity and page sizes, taken before a byte of it is parsed. The path is
    the run's private copy (the execution contract), so the hash and every later read are of the same bytes."""
    name: str
    sha256: str
    page_count: int
    sizes: dict[int, tuple[float, float]]

    @classmethod
    def of(cls, execution: Execution) -> "Source":
        sha256 = sha256_file(execution.pdf)
        with PdfPages(execution.pdf) as pages:
            return cls(execution.source_name or execution.pdf.name, sha256, pages.count,
                       {number: pages.page(number).get_size() for number in range(1, pages.count + 1)})


def write_result(outcome: Transcription, execution: Execution, inventory: Inventory, source: Source, *,
                 ingest_digest: str | None, directory: Path, started: str | None = None,
                 seconds: float | None = None) -> Result:
    """Write `result/pages/{page}.json` for every selected page, then `result/result.json`; return the manifest.

    Identities come from the inventory, never from the records: a page the cut found nothing on gets a file with
    no segments and a warning; a page with records gets its units, crops and segments in reading order. Every
    page file names the generation minted here and is published by rename; the manifest, written last, records
    each file's hash and the digest over them.
    """
    recipe_ = recipe(execution, source.sha256, ingest_digest)
    print_ = fingerprint(recipe_)
    generation = new_generation()
    records = {record.page: record for record in outcome.pages}  # by ordinal; the converter asserted the shape
    (directory / "pages").mkdir(parents=True, exist_ok=True)
    entries: dict[int, PageEntry] = {}
    for number, inputs, markdown in assemble_pages(
            inventory, ((item, records[item.ordinal]) for item in inventory.inputs)):
        size = source.sizes[number]
        units: list[Unit] = []
        segments: list[PageSegment] = []
        warnings: list[str] = []
        for index, bbox_pt, to_page in _units(number, inventory, size):
            crops: list[CropResult] = []
            for item, record in inputs:
                if item.unit != index:
                    continue
                if record.incomplete:
                    warnings.append(record.incomplete)
                if item.crop is None:  # a whole-page input: the record is the unit's
                    transform = _whole_image_transform(record, size)
                    segments += _segments(index, None, record, transform, to_page, bbox_pt)
                    continue
                _, region, image = item.crop
                assert region.transform is not None  # the cut records every crop's transform
                crop_bbox = to_page(region.bbox)
                crops.append(CropResult(
                    crop=item.ordinal, kind=region.kind, order=region.order, bbox_pt=crop_bbox, ink=region.ink,
                    origin_pt=(region.transform.origin_x, region.transform.origin_y),
                    pt_per_px=(region.transform.pt_per_px_x, region.transform.pt_per_px_y),
                    source_px=region.transform.source_px, image_px=image.size,
                    input_tokens=record.input_tokens, output_tokens=record.output_tokens, seconds=record.seconds,
                    stop=record.stop, capped=record.capped, incomplete=record.incomplete,
                ))
                segments += _segments(index, item.ordinal, record, region.transform, to_page, crop_bbox)
            units.append(Unit(index=index, kind="pdf_page" if index == 0 else "book_page", bbox_pt=bbox_pt, crops=crops))
        if not inputs:  # only the layout cut leaves a page without an input: it found nothing there
            warnings.append("no content found by the layout cut")
        complete = all(record.incomplete is None for _, record in inputs)
        page = PageResult(generation=generation, page=number, size_pt=size, units=units, segments=segments,
                          markdown=markdown, complete=complete,
                          warnings=warnings)
        data = (page.model_dump_json(indent=2) + "\n").encode("utf-8")
        with publish(directory / "pages" / f"{number}.json") as part:
            part.write_bytes(data)
        entries[number] = PageEntry(sha256=hashlib.sha256(data).hexdigest(), complete=complete)
    result = Result(
        result_version=RESULT_VERSION, generation=generation,
        digest=result_digest({number: entry.sha256 for number, entry in entries.items()}),
        fingerprint=print_, recipe=recipe_, source_name=source.name, page_count=source.page_count,
        effective={"max_size": outcome.header.get("max_size"), "scale": outcome.header.get("scale")},
        started=started, seconds=seconds,
        status="incomplete" if outcome.incomplete else "success", incomplete=outcome.incomplete,
        pages=entries,
        tokens={"input": _total(record.input_tokens for record in outcome.pages),
                "output": _total(record.output_tokens for record in outcome.pages)},
    )
    # A resumed run can select fewer pages; the directory must contain exactly this generation's files.
    for path in (directory / "pages").glob("*.json"):
        if path.stem.isdigit() and int(path.stem) not in entries:
            path.unlink()
    with publish(directory / "result.json") as part:
        part.write_text(result.model_dump_json(indent=2) + "\n", encoding="utf-8")
    return result


UnitOf = tuple[int, PointBox, Callable[[PointBox], PointBox]]


def _units(number: int, inventory: Inventory, size: tuple[float, float]) -> list[UnitOf]:
    """The units of PDF page `number`: its book pages over the ingest, each with its transform to page points, or the
    page itself with the identity."""
    if inventory.book is None:
        return [(0, (0.0, 0.0, size[0], size[1]), lambda bbox: bbox)]
    units = []
    for index in inventory.book.numbers_in((number, number)):
        book_page = inventory.book.page(index)
        width, height = book_page.get_size()
        units.append((index, book_page.to_page_points((0.0, 0.0, width, height)), book_page.to_page_points))
    return units
