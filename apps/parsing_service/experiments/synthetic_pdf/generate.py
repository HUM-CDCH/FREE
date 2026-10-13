"""Reverse annotation: render known values and retain their physical source locations."""
from __future__ import annotations

import copy
import random
import re
from pathlib import Path

import pypdfium2 as pdfium
from jsonschema import validate
from PIL import ImageFilter
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader, simpleSplit
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen.canvas import Canvas

from experiments.extraction.manifest import digest, read, write_new
from kei_exp.kie.extract.schema import Schema, json_schema
from kei_exp.kie.extract.stages import leaves

TEMPLATES = Path(__file__).parent / "templates"
WIDTH, HEIGHT = A4


def normalized(value: str) -> str:
    return " ".join(value.split())


def identifier(value: str) -> str:
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", value):
        raise ValueError(f"unsafe identifier: {value!r}")
    return value


def schemas() -> dict:
    record = read(TEMPLATES / "record-schema.json")
    metadata = [
        {"id": "document.id", "name": "document_id", "type": "verbatim-string", "description": "Document reference."},
        {"id": "document.title", "name": "collection_title", "type": "verbatim-string",
         "description": "Collection title, not an object's title."},
        {"id": "document.edition", "name": "edition", "type": "integer", "description": "Printed edition year."},
    ]
    return {
        "article": {"recordDescription": "One document-level survey with its metadata and every distinct archival "
                                         "object under items. Object ID identifies objects; Sample ID identifies "
                                         "observations within an object. Repeated entries are the same object.",
                    "recordScope": "document", "schemaNodes": metadata + [
                        {"id": "document.items", "name": "items", "type": "array",
                         "description": record["recordDescription"], "children": record["schemaNodes"]}]},
        "catalog": {**record, "recordScope": "records", "schemaNodes": record["schemaNodes"] + [
            {**node, "valueSource": "document"} for node in metadata]},
    }


def values(spec: dict, template: dict) -> tuple[dict, list[dict]]:
    rng = random.Random(spec["seed"])
    count = spec.get("records", 2)
    if type(count) is not int or not 1 <= count <= 1000:
        raise ValueError("records must be an integer in 1..1000")
    prefix = f"{rng.randrange(100000, 999999)}"
    metadata = {"document_id": f"SUR-{prefix}", "collection_title": template["title"], "edition": 2024}
    titles = ["River register", "Workshop ledger", "Harbour inventory", "Market notebook"]
    records = []
    missing = spec.get("missing_year_every", 0)
    if type(missing) is not int or missing < 0:
        raise ValueError("missing_year_every must be a nonnegative integer")
    for n in range(count):
        records.append({
            "record_id": f"OBJ-{prefix}-{n + 1:03}", "title": f"{titles[n % len(titles)]} {n + 1}",
            "year": None if missing and (n + 1) % missing == 0 else 1810 + rng.randrange(80),
            "holding": {"institution": "Riverton Archive" if spec.get("repeat_values") else f"Archive {n + 1}",
                        "box": f"B{rng.randrange(100, 999)}"},
            "themes": ["trade", ["waterways", "craft", "shipping", "markets"][n % 4]],
            "observations": [{"sample_id": f"S{k + 1}", "count": 42 if spec.get("repeat_values") else rng.randrange(10, 90)}
                             for k in range(2)],
        })
    return metadata, records


class Renderer:
    """A small ReportLab renderer; annotations are made at the same write as each value."""
    def __init__(self, path: Path, template: dict):
        self.canvas = Canvas(str(path), pagesize=A4, invariant=1, pageCompression=1)
        self.canvas.setTitle(template["title"])
        self.canvas.setCreator("FREE synthetic PDF benchmark")
        self.template, self.annotations, self.page = template, [], 0
        self.placement = "primary"
        self.x, self.y, self.width = 48.0, HEIGHT - 100, WIDTH - 96
        self.new_page()

    def new_page(self):
        if self.page:
            self.canvas.showPage()
        self.page += 1
        self.canvas.setFillColorRGB(0.15, 0.24, 0.31)
        self.canvas.setFont("Helvetica-Bold", 11)
        self.canvas.drawString(48, HEIGHT - 45, "RIVERTON ARCHIVES / RESEARCH SERIES")
        self.canvas.setStrokeColorRGB(0.65, 0.7, 0.74)
        self.canvas.line(48, HEIGHT - 58, WIDTH - 48, HEIGHT - 58)
        self.canvas.setFont("Helvetica", 8)
        self.canvas.drawString(48, 30, "Synthetic research material - no historical claims")
        self.canvas.drawRightString(WIDTH - 48, 30, f"Page {self.page}")
        self.canvas.setFillColorRGB(0, 0, 0)
        self.y = HEIGHT - 90

    def paragraph(self, text: str):
        self.canvas.setFont("Helvetica", 10)
        for line in simpleSplit(text, "Helvetica", 10, self.width):
            if self.y < 65:
                self.new_page()
            self.canvas.drawString(self.x, self.y, line)
            self.y -= 14
        self.y -= 10

    def draw_value(self, record_id, path, value, prefix="", *, x=None, y=None, kind="text", font="Helvetica", size=10):
        x, y = self.x if x is None else x, self.y if y is None else y
        text = str(value)
        quote = prefix + text
        if stringWidth(quote, font, size) > self.width:
            raise ValueError(f"template text does not fit: {quote!r}")
        self.canvas.setFont(font, size)
        self.canvas.drawString(x, y, quote)
        left = x + stringWidth(prefix, font, size)
        self.annotations.append({"record_id": record_id, "path": list(path), "value": value, "page": self.page,
                                 "bbox_pt": [left, HEIGHT - y - size, left + stringWidth(text, font, size),
                                             HEIGHT - y + size * .3], "quote": quote, "value_text": text, "kind": kind,
                                 "placement": self.placement})

    def field(self, record_id, path, value, prefix):
        if self.y < 90:
            self.new_page()
        self.draw_value(record_id, path, value, prefix)
        self.y -= 26

    def record(self, record: dict, *, cross_page=False):
        rid = record["record_id"]
        self.draw_value(rid, ["record_id"], rid, self.template["entry_label"] + " / ", font="Helvetica-Bold", size=10)
        self.y -= 28
        self.field(rid, ["title"], record["title"], "Title: ")
        if record["year"] is not None:
            self.field(rid, ["year"], record["year"], "Recorded year: ")
        else:
            self.paragraph("The object's year is not recorded.")
        self.field(rid, ["holding", "institution"], record["holding"]["institution"], "Holding institution: ")
        self.field(rid, ["holding", "box"], record["holding"]["box"], "Archival box: ")
        if cross_page:
            self.new_page()
            self.paragraph(f"Continuation of object {rid}. The themes and sample observations below belong to it.")
        for n, theme in enumerate(record["themes"]):
            self.field(rid, ["themes", n], theme, "Theme: ")
        self.paragraph("Sample observations (counts)")
        if self.y < 140:
            self.new_page()
        top, cell_width = self.y + 10, min(110, self.width / 2)
        self.canvas.setFont("Helvetica-Bold", 9)
        for col, label in enumerate(("Sample ID", "Count")):
            self.canvas.drawString(self.x + col * cell_width + 8, self.y - 6, label)
        for row in range(3):
            for col in range(2):
                self.canvas.rect(self.x + col * cell_width, top - (row + 1) * 24, cell_width, 24, fill=0)
        for row, observation in enumerate(record["observations"]):
            for col, field in enumerate(("sample_id", "count")):
                self.draw_value(rid, ["observations", row, field], observation[field],
                                x=self.x + col * cell_width + 8, y=top - (row + 2) * 24 + 7, kind="table", size=9)
        self.y = top - 3 * 24 - 35


def generate(spec: dict, directory: Path) -> dict:
    allowed = {"id", "template", "seed", "records", "layout", "cross_page", "repeat_values", "missing_year_every",
               "repeat_entries", "padding_pages", "contradiction", "raster_dpi", "blur_radius"}
    if set(spec) - allowed:
        raise ValueError(f"unknown document settings: {sorted(set(spec) - allowed)}")
    identifier(spec["id"])
    if spec["template"] not in {"article", "catalog"} or type(spec["seed"]) is not int:
        raise ValueError("select an article/catalog template and an integer seed")
    if spec.get("layout", "single") not in {"single", "columns"}:
        raise ValueError("layout must be single or columns")
    for name in ("cross_page", "repeat_values", "contradiction"):
        if name in spec and type(spec[name]) is not bool:
            raise ValueError(f"{name} must be a boolean")
    for name in ("repeat_entries", "padding_pages"):
        if type(spec.get(name, 0)) is not int or not 0 <= spec.get(name, 0) <= 100:
            raise ValueError(f"{name} must be an integer in 0..100")
    directory.mkdir(parents=True, exist_ok=False)
    template = read(TEMPLATES / (spec["template"] + ".json"))
    metadata, records = values(spec, template)
    native = directory / "source.native.pdf"
    renderer = Renderer(native, template)
    for field, prefix in (("collection_title", "Collection title: "), ("document_id", "Document reference: "),
                          ("edition", "Edition year: ")):
        renderer.field(None, [field], metadata[field], prefix)
    renderer.paragraph(template["introduction"])
    if template["narrative"]:
        renderer.paragraph("Methods: each object was described independently. Tables list sample counts, "
                           "and themes record the survey's descriptive categories.")
    columns = spec.get("layout") == "columns"
    if columns:
        renderer.new_page()
        renderer.width = (WIDTH - 116) / 2
    for n, record in enumerate(records):
        if columns:
            if n and n % 2 == 0:
                renderer.new_page()
            renderer.x, renderer.y = 48 + (n % 2) * (renderer.width + 20), HEIGHT - 90
        elif renderer.y < 420:
            renderer.new_page()
        renderer.record(record, cross_page=bool(spec.get("cross_page") and n == 0))
    renderer.x, renderer.width = 48, WIDTH - 96
    for page in range(spec.get("padding_pages", 0)):
        renderer.new_page()
        for n in range(12):
            renderer.paragraph(f"Context note {page + 1}.{n + 1}. This background section discusses archival "
                               "handling, descriptive conventions, preservation and provenance. It contains "
                               "no further object entries or sample observations. Local cataloguing practice "
                               "distinguishes physical objects from the samples listed within their tables.")
    for n in range(spec.get("repeat_entries", 0)):
        renderer.placement = "reprint"
        renderer.new_page()
        renderer.paragraph("Repeated reference entry. The Object ID identifies the same archival object.")
        renderer.record(records[n % len(records)])
    contradictions = {}
    if spec.get("contradiction"):
        renderer.placement = "conflict"
        renderer.new_page()
        renderer.paragraph("A second edition statement is reproduced without resolving the disagreement.")
        renderer.field(None, ["edition"], 2025, "Edition year: ")
        contradictions["edition"] = [2024, 2025]
        metadata["edition"] = None
    renderer.canvas.save()
    source = directory / "source.pdf"
    source.write_bytes(native.read_bytes())
    if spec.get("raster_dpi"):
        dpi, blur = spec["raster_dpi"], spec.get("blur_radius", 0)
        if not 40 <= dpi <= 300 or not 0 <= blur <= 3:
            raise ValueError("raster_dpi must be 40..300 and blur_radius 0..3")
        canvas = Canvas(str(source), pagesize=A4, invariant=1, pageCompression=1)
        with pdfium.PdfDocument(str(native)) as document:
            for page in document:
                bitmap = page.render(scale=dpi / 72)
                image = bitmap.to_pil().convert("L").filter(ImageFilter.GaussianBlur(blur))
                canvas.drawImage(ImageReader(image), 0, 0, WIDTH, HEIGHT)
                canvas.showPage()
                bitmap.close()
                page.close()
        canvas.save()
    truth = {"version": 2, "spec": spec, "schemas": schemas(), "metadata": metadata, "items": records,
             "contradictions": contradictions, "annotations": renderer.annotations,
             "array_identities": {"items": "record_id", "observations": "sample_id"},
             "pdf_sha256": digest(source.read_bytes()), "native_pdf_sha256": digest(native.read_bytes())}
    truth["expected"] = {strategy: {"records": expected(truth, strategy)} for strategy in truth["schemas"]}
    validation = validate_truth(truth, native)
    write_new(directory / "truth.json", truth)
    write_new(directory / "validation.json", validation)
    return truth


def expected(truth: dict, strategy: str) -> list[dict]:
    if strategy == "article":
        return [{**copy.deepcopy(truth["metadata"]), "items": copy.deepcopy(truth["items"])}]
    return [{**copy.deepcopy(item), **truth["metadata"]} for item in truth["items"]]


def validate_truth(truth: dict, native: Path) -> dict:
    """Independently read the written glyphs in every recorded bounding box; fail closed."""
    if digest(native.read_bytes()) != truth["native_pdf_sha256"]:
        raise ValueError("native PDF changed")
    for strategy, definition in truth["schemas"].items():
        schema = Schema.model_validate(definition)
        if truth["expected"][strategy]["records"] != expected(truth, strategy):
            raise ValueError("exported expected records differ from generated values")
        for record in expected(truth, strategy):
            validate(record, json_schema(schema.nodes))
    ids = [item["record_id"] for item in truth["items"]]
    if len(ids) != len(set(ids)):
        raise ValueError("ground truth record IDs are not unique")
    for annotation in truth["annotations"]:
        if annotation.get("placement") not in {"primary", "reprint", "conflict"}:
            raise ValueError("annotation has no valid placement")
        value = truth["metadata"] if annotation["record_id"] is None else truth["items"][ids.index(annotation["record_id"])]
        for step in annotation["path"]:
            value = value[step]
        alternatives = truth["contradictions"].get(annotation["path"][0], []) if annotation["record_id"] is None else []
        if value != annotation["value"] and annotation["value"] not in alternatives:
            raise ValueError("annotation differs from its field's ground truth")
    covered = {(a["record_id"], tuple(a["path"])) for a in truth["annotations"]}
    for rid, value in [(None, truth["metadata"]), *zip(ids, truth["items"], strict=True)]:
        if any((rid, path) not in covered for path, _ in leaves(value)):
            raise ValueError("populated field has no rendered evidence")
    with pdfium.PdfDocument(str(native)) as document:
        for annotation in truth["annotations"]:
            left, top, right, bottom = annotation["bbox_pt"]
            if not 0 <= left < right <= WIDTH or not 0 <= top < bottom <= HEIGHT:
                raise ValueError(f"evidence is outside the page: {annotation}")
            page = document[annotation["page"] - 1]
            textpage = page.get_textpage()
            text = textpage.get_text_bounded(left - 1, HEIGHT - bottom - 1, right + 1, HEIGHT - top + 1)
            textpage.close()
            page.close()
            if normalized(annotation["value_text"]) != normalized(text):
                raise ValueError(f"rendered value differs from gold: {annotation['value_text']!r} vs {text!r}")
        return {"rendered_fields_checked": len(truth["annotations"]), "pages": len(document),
                "schemas_valid": True, "all_populated_fields_have_evidence": True}
