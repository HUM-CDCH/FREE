"""Catalogue fixtures: inspectable JSON under `tests/fixtures/catalogue/`, written as a verified canonical result.

A fixture lists pages, their units (0 for a native PDF page, else book pages of a spread), each unit's crops
(columns of the cut) and each crop's segments, plus the boundaries a reader should find. Only what a case is
about is spelled out: a segment is a string or `{"text", "label", "status", "bbox_pt"}`, a crop may carry its own
`bbox_pt` (to make two crops overlap); everything else is laid out here. A segment's `unit` or `crop` may be forced to
name something its page does not have, which is how the reader's referential checks are exercised. The files are
written with the models, hashes and digest the service's reader verifies, so `kie.extract.evidence.load` accepts them.
"""
from __future__ import annotations

import hashlib
import json
from html import escape
from pathlib import Path

from kei_exp.pagefile import RESULT_VERSION, CropResult, PageEntry, PageResult, PageSegment, Result, Unit, result_digest

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "catalogue"
LINE_PT = 12.0
GENERATION = "20260923T000000.000000Z-fixture0"


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))


def names() -> list[str]:
    return sorted(path.stem for path in FIXTURES.glob("*.json"))


def write(case: dict | str, run_dir: Path, *, generation: str = GENERATION) -> Path:
    """`run_dir/result/` holding the fixture as a complete canonical result; returns `run_dir`."""
    data = fixture(case) if isinstance(case, str) else case
    native = data.get("transcriber", "surya") == "native"
    size = tuple(data.get("size_pt", [842.0, 595.0]))
    directory = run_dir / "result"
    (directory / "pages").mkdir(parents=True, exist_ok=True)
    entries: dict[int, PageEntry] = {}
    ordinal = 0
    for spec in data["pages"]:
        number = spec["page"]
        units, segments = [], []
        unit_specs = spec["units"]
        for position, unit_spec in enumerate(unit_specs):
            index = unit_spec["index"]
            width = size[0] / len(unit_specs)
            unit_box = (position * width, 0.0, (position + 1) * width, size[1])
            crops = []
            crop_specs = unit_spec.get("crops") or [{"segments": unit_spec.get("segments", [])}]
            for order, crop_spec in enumerate(crop_specs):
                column = (unit_box[2] - unit_box[0]) / len(crop_specs)
                box = tuple(crop_spec.get("bbox_pt") or (unit_box[0] + order * column, 36.0,
                                                          unit_box[0] + (order + 1) * column, size[1] - 36.0))
                crop = None
                if not native:
                    ordinal += 1
                    crop = crop_spec.get("crop", ordinal)
                    crops.append(_crop(crop, order, box))
                top = box[1]
                for item in crop_spec["segments"]:
                    item = {"text": item} if isinstance(item, str) else item
                    lines = max(1, item["text"].count("\n") + 1)
                    seg_box = tuple(item.get("bbox_pt") or (box[0] + 2.0, top, box[2] - 2.0, top + LINE_PT * lines))
                    top = seg_box[3] + 2.0
                    segments.append(_segment(item, item.get("unit", index), item.get("crop", crop), box, seg_box, native))
            units.append(Unit(index=index, kind="pdf_page" if index == 0 else "book_page", bbox_pt=unit_box,
                              crops=crops))
        page = PageResult(generation=generation, page=number, size_pt=size, units=units, segments=segments,
                          markdown="\n\n".join(segment.text for segment in segments), complete=True, warnings=[])
        raw = (page.model_dump_json(indent=2) + "\n").encode("utf-8")
        (directory / "pages" / f"{number}.json").write_bytes(raw)
        entries[number] = PageEntry(sha256=hashlib.sha256(raw).hexdigest(), complete=True)
    source_sha = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
    manifest = Result(
        result_version=RESULT_VERSION, generation=generation,
        digest=result_digest({n: entry.sha256 for n, entry in entries.items()}),
        fingerprint=hashlib.sha256(b"fixture-recipe").hexdigest(),
        recipe={"result_version": RESULT_VERSION, "source_sha256": source_sha,
                "transcriber": "native" if native else "surya",
                "page_source": data.get("page_source", "pdf" if native else "ingest")},
        source_name=data.get("source_name", "fixture.pdf"), page_count=data.get("page_count", len(entries)),
        effective={}, started=None, seconds=None, status="success", incomplete=None, pages=entries,
        tokens={"input": None, "output": None})
    (directory / "result.json").write_text(manifest.model_dump_json(indent=2) + "\n", encoding="utf-8")
    return run_dir


def _crop(crop: int, order: int, box: tuple[float, float, float, float]) -> CropResult:
    return CropResult(crop=crop, kind="column", order=order, bbox_pt=box, ink=0.1, origin_pt=(box[0], box[1]),
                      pt_per_px=(0.25, 0.25), source_px=(0, 0, 100, 100), image_px=(100, 100), input_tokens=None,
                      output_tokens=None, seconds=None, stop=None, capped=False, incomplete=None)


def _segment(item: dict, unit: int, crop: int | None, crop_box, box, native: bool) -> PageSegment:
    text = item["text"]
    html = "<p>" + escape(text).replace("\n", "<br>") + "</p>"
    if native:
        bbox_px = box
    else:  # crop pixels at 4 px per point, relative to the crop's origin
        bbox_px = tuple(round((v - o) * 4.0, 3) for v, o in zip(box, (crop_box[0], crop_box[1]) * 2, strict=True))
    return PageSegment(text=text, html=html, markdown=None, label=item.get("label", "Text"), confidence=None,
                       status=item.get("status", "ok"), unit=unit, crop=crop, bbox_px=bbox_px, bbox_pt=box,
                       extent="block")
