"""Hand-built ingest artifacts and result directories, with no PDF and no GPU: a spread-mode ingest of two spreads
(four book pages) and the page files a converter run over it would write, at the current RESULT_VERSION."""
import copy
import hashlib
import json
from pathlib import Path
from typing import Any

from kei_exp.canonical import canonical_json
from kei_exp.kie.artifacts import seal
from kei_exp.kie.ingest_model import IngestArtifact
from kei_exp.pagefile import RESULT_VERSION, result_digest

SPREAD_W, SPREAD_H = 400, 300
GUTTER = 240
PAGE_PT = (500.0, 350.0)
CREATED = "2026-09-17T12:00:00+00:00"
UNSEALED = "0" * 64
GENERATION = "20260917T120000.000000Z-0badcafe"  # the reference generation every hand-built page file names


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def placement() -> dict:
    width_pt, height_pt = PAGE_PT
    return {"a": width_pt, "b": 0.0, "c": 0.0, "d": height_pt, "e": 0.0, "f": 0.0,
            "page_width_pt": width_pt, "page_height_pt": height_pt}


def evidence() -> dict:
    return {"dark_run": (GUTTER, GUTTER + 40), "blank_run": None, "dark_runs": 1, "blank_runs": 0,
            "band_support": 0.8, "distance_from_midline_px": abs(GUTTER - SPREAD_W // 2)}


def ingest_page(index: int, spread: int, side: str) -> dict:
    rect = (0, 0, GUTTER, SPREAD_H) if side == "left" else (GUTTER, 0, SPREAD_W, SPREAD_H)
    return {
        "index": index, "spread": spread, "side": side, "image": f"pages/{index:03d}.png",
        "width_px": rect[2] - rect[0], "height_px": SPREAD_H, "sha256": digest(f"png {index}"),
        "source_rect": rect, "spread_width_px": SPREAD_W, "spread_height_px": SPREAD_H, "placement": placement(),
        "dpi_x": 72.0 * SPREAD_W / PAGE_PT[0], "dpi_y": 72.0 * SPREAD_H / PAGE_PT[1],
        "gutter_x_px": GUTTER, "gutter_method": "shadow", "gutter_reason": None, "gutter_evidence": evidence(),
    }


def spread_report(spread: int) -> dict:
    return {"spread": spread, "gutter_x_px": GUTTER, "method": "shadow", "reason": None, "evidence": evidence(),
            "min_blank_px": 2, "min_dark_px": 2, "support_radius_px": 1}


def spread_ingest() -> IngestArtifact:
    """Two spreads, four book pages: unit 1 (the left page, 240 x 300), unit 2 (the right page, 160 x 300), and 3, 4."""
    return seal(IngestArtifact.model_validate({
        "envelope": {"stage": "ingest", "stage_version": 3, "fingerprint": digest("ingest inputs"), "digest": UNSEALED,
                     "upstream": {}, "created": CREATED},
        "source": {"pdf_name": "catalogue.pdf", "sha256": digest("pdf"), "spreads": 2,
                   "page_size_pt": {1: PAGE_PT, 2: PAGE_PT}},
        "config": {"split": "spread"},
        "pages": [ingest_page(1, 1, "left"), ingest_page(2, 1, "right"), ingest_page(3, 2, "left"),
                  ingest_page(4, 2, "right")],
        "report": {"spreads_read": 2, "pages_written": 4, "methods": {"shadow": 2},
                   "spreads": [spread_report(1), spread_report(2)], "weak_support": [], "text_layers": {},
                   "extract_seconds": 0.1, "write_seconds": 0.1, "seconds": 0.2},
    }))


# --- Page files as the converter writes them: units, crops with their native rectangles, segments in order ------
def recipe(ingest: IngestArtifact, **overrides: Any) -> dict:
    fields = {
        "result_version": RESULT_VERSION, "source_sha256": ingest.source.sha256,
        "ingest_digest": ingest.envelope.digest, "transcriber": "surya", "model": "surya",
        "repo": "datalab-to/surya-ocr-2", "cut": "auto", "crop_dpi": 250, "layout_model": "layout_heron_101",
        "page_source": "ingest", "pages_requested": None, "max_image_size": None, "max_output_tokens": None,
        "record": None, "versions": {"docling": "2.127.0", "surya-ocr": "0.22.1"},
    }
    return {**fields, **overrides}


def fingerprint_of(recipe_: dict) -> str:
    return hashlib.sha256(canonical_json(recipe_)).hexdigest()


def crop(ordinal: int, order: int, source_px: tuple | None, image_px: tuple, kind: str = "column") -> dict:
    return {"crop": ordinal, "kind": kind, "order": order, "bbox_pt": [0.0, 0.0, 1.0, 1.0], "ink": 0.5,
            "origin_pt": [0.0, 0.0], "pt_per_px": [1.0, 1.0], "source_px": None if source_px is None else list(source_px),
            "image_px": list(image_px), "input_tokens": 1, "output_tokens": 2, "seconds": None, "stop": None,
            "capped": False, "incomplete": None}


def unit(index: int, crops: list[dict]) -> dict:
    return {"index": index, "kind": "pdf_page" if index == 0 else "book_page", "bbox_pt": [0.0, 0.0, 1.0, 1.0],
            "crops": crops}


def page_segment(unit_index: int, crop_ordinal: int | None, bbox_px: tuple | None, text: str = "text", *,
                 label: str = "Text", confidence: float | None = 0.9, status: str = "ok") -> dict:
    return {"text": text, "html": f"<p>{text}</p>", "markdown": None, "label": label, "confidence": confidence,
            "status": status, "unit": unit_index, "crop": crop_ordinal,
            "bbox_px": None if bbox_px is None else list(bbox_px), "bbox_pt": [0.0, 0.0, 1.0, 1.0],
            "extent": "input" if bbox_px is None else "block"}


def page_file(number: int, units: list[dict], segments: list[dict], generation: str = GENERATION, *,
              complete: bool = True) -> dict:
    return {"generation": generation, "page": number, "size_pt": list(PAGE_PT), "units": units, "segments": segments,
            "markdown": "", "complete": complete, "warnings": []}


def manifest(recipe_: dict, pages: list[int], *, status: str = "success", incomplete: str | None = None,
             tokens: tuple[int, int] = (3, 4), generation: str = GENERATION) -> dict:
    """The manifest with `pages` still a list: `write_result_dir` turns it into the entries of the files it writes."""
    return {"result_version": RESULT_VERSION, "generation": generation, "digest": UNSEALED,
            "fingerprint": fingerprint_of(recipe_), "recipe": recipe_, "source_name": "catalogue.pdf", "page_count": 2,
            "effective": {"max_size": None, "scale": None}, "started": None, "seconds": None, "status": status,
            "incomplete": incomplete, "pages": pages, "tokens": {"input": tokens[0], "output": tokens[1]}}


def write_result_dir(directory: Path, manifest_: dict | None, files: dict[int, Any]) -> Path:
    """The files as the converter leaves them; a value that is not a dict is written as text (a corrupt file). A
    manifest whose `pages` is a list gets one entry per listed page, hashing the file written for it (a placeholder
    hash for a listed page without a file), and the digest over those entries."""
    (directory / "pages").mkdir(parents=True, exist_ok=True)
    hashes: dict[int, str] = {}
    for number, data in files.items():
        text = json.dumps(data, indent=2) + "\n" if isinstance(data, dict) else str(data)
        path = directory / "pages" / f"{number}.json"
        path.write_text(text, encoding="utf-8")
        hashes[number] = hashlib.sha256(path.read_bytes()).hexdigest()
    if manifest_ is not None:
        if isinstance(manifest_["pages"], list):
            manifest_["pages"] = {
                str(n): {"sha256": hashes.get(n, UNSEALED),
                         "complete": files[n]["complete"] if isinstance(files.get(n), dict) else True}
                for n in manifest_["pages"]}
        manifest_["digest"] = result_digest({int(n): entry["sha256"] for n, entry in manifest_["pages"].items()})
        (directory / "result.json").write_text(json.dumps(manifest_, indent=2) + "\n", encoding="utf-8")
    return directory


# The reference fixture. Unit 1 (the left page, 240 x 300) has crop 1 at native rectangle [10, 230) x [20, 260)
# rendered to 110 x 80 pixels (a scale of 2 across and 3 down), and crop 3 overlapping it; unit 2 (the right
# page, 160 x 300) has crop 2 over its whole raster. Page file 2 covers units 3 and 4 the same way.
CROP_1 = (10, 20, 230, 260)


def fixture_files(generation: str = GENERATION) -> dict[int, dict]:
    return {
        1: page_file(1, [unit(1, [crop(1, 0, CROP_1, (110, 80)), crop(3, 1, (200, 0, 240, 300), (20, 150))]),
                         unit(2, [crop(2, 0, (0, 0, 160, 300), (80, 150))])],
                     [page_segment(1, 1, (1.0, 2.5, 10.0, 7.25), "Kreis Wanzleben"),
                      page_segment(1, 1, None, "no box"),
                      page_segment(1, 1, (105.0, 0.0, 112.0, 10.0), "poking past the crop"),
                      page_segment(1, 1, (110.0, 0.0, 115.0, 10.0), "entirely outside"),
                      page_segment(1, 3, (0.0, 0.0, 20.0, 150.0), "102", label="PageHeader"),
                      page_segment(2, 2, (0.0, 0.0, 80.0, 150.0), "76. Ampfurth"),
                      page_segment(2, 2, (0.0, 0.0, 1.0, 1.0), "", status="skipped")],
                     generation),
        2: page_file(2, [unit(3, [crop(4, 0, (0, 0, 240, 300), (120, 150))]),
                         unit(4, [crop(5, 0, (0, 0, 160, 300), (80, 150))])],
                     [page_segment(3, 4, (0.0, 0.0, 120.0, 150.0), "77. Bebertal"),
                      page_segment(4, 5, (0.0, 0.0, 80.0, 150.0), "Kreis Haldensleben")],
                     generation),
    }


def fixture(directory: Path, ingest: IngestArtifact, *, pages: list[int] | None = None,
            files: dict[int, dict] | None = None, prepare=None) -> Path:
    """The reference result directory over `ingest`, after `prepare(manifest, files)` has edited its dicts."""
    recipe_ = recipe(ingest)
    files = fixture_files() if files is None else files
    manifest_ = manifest(copy.deepcopy(recipe_), sorted(files) if pages is None else pages)
    if prepare is not None:
        prepare(manifest_, files)
    return write_result_dir(directory, manifest_, files)


# --- Page files over a single-mode ingest, for runs of the real runner over a generated PDF -----------------------
PAGE_SIZE = (300, 200)
