"""Synthetic long-list Articles for the PR #275 measurement, from the synthetic PDF benchmark's article template.

Extends `experiments.synthetic_pdf.generate` (commit 1513c446, imported from its worktree) with what the two P2s
need and nothing else:
- `observations`: rows in each object's sample table (the benchmark prints 2), so a list item is large enough that 60
  of them shown whole exceed a 12,288-token resolution request;
- `cited`: objects of another collection, each printed twice (a "Comparative material" section after the methods and
  again in the "Discussion"), each with its catalogue and citation (Lund 1998) but no statement that it is outside
  the survey, as a cited study's values are printed. They are another work's items;
- `repeat_entries` (the benchmark's): own objects printed again at the end, the same object.

Usage: python generate_p2s.py SPEC.json OUT_DIR   (SPEC: {"documents": [{"id", "seed", "records", ...}]})
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

BENCH = Path.home() / "Progetti/FREE/.claude/worktrees/synthetic-pdf-benchmark/apps/parsing_service"
sys.path.insert(0, str(BENCH))
sys.path.insert(0, str(BENCH / "src"))

from experiments.extraction.manifest import digest, write_new  # noqa: E402
from experiments.synthetic_pdf import generate as bench  # noqa: E402

CITED_BY = "Kalmar Harbour Museum"
# Description sentences without values: each object page carries a few, so a reading part holds about 15 objects and
# its reply restates them without running past its reserve.
PROSE = [
    "The object was examined on a padded table under daylight lamps and handled with cotton gloves throughout.",
    "Its binding shows wear along the spine, and several gatherings have loosened from the sewing structure.",
    "Ink on the opening leaves has faded unevenly, which suggests long exposure to light before accession.",
    "Earlier repairs with paper tape were noted and left in place, since removing them would damage the support.",
    "The text block retains its original order, and no leaves appear to have been removed or replaced.",
    "Water staining at the lower margin is old and stable, with no sign of active mould or insect damage.",
    "A later owner added pencil annotations in the margins; these were recorded but not transcribed.",
    "The cover boards are warped slightly, and the object is stored flat in a custom enclosure.",
    "Paper quality varies between gatherings, indicating that stock was bought in several batches.",
    "The object was photographed before sampling so that its condition can be compared at the next survey.",
]


class Renderer(bench.Renderer):
    prose: list[str] = []
    def record(self, record: dict, *, cross_page=False, label=None, note=None):
        """The benchmark's object layout with a sample table of any number of rows, kept on one page with its note."""
        rid = record["record_id"]
        rows = len(record["observations"]) + 1
        if self.y - (28 + 26 * (5 + len(record["themes"])) + 24 + rows * 24 + 45 + (40 if note else 0)
                     + 14 * 2 * len(self.prose)) < 65:
            self.new_page()
        if note:
            self.paragraph(note)
        self.draw_value(rid, ["record_id"], rid, (label or self.template["entry_label"]) + " / ",
                        font="Helvetica-Bold", size=10)
        self.y -= 28
        self.field(rid, ["title"], record["title"], "Title: ")
        if record["year"] is not None:
            self.field(rid, ["year"], record["year"], "Recorded year: ")
        else:
            self.paragraph("The object's year is not recorded.")
        self.field(rid, ["holding", "institution"], record["holding"]["institution"], "Holding institution: ")
        self.field(rid, ["holding", "box"], record["holding"]["box"], "Archival box: ")
        for n, theme in enumerate(record["themes"]):
            self.field(rid, ["themes", n], theme, "Theme: ")
        self.paragraph("Sample observations (counts)")
        top, cell_width = self.y + 10, min(110, self.width / 2)
        self.canvas.setFont("Helvetica-Bold", 9)
        for col, label in enumerate(("Sample ID", "Count")):
            self.canvas.drawString(self.x + col * cell_width + 8, self.y - 6, label)
        for row in range(rows):
            for col in range(2):
                self.canvas.rect(self.x + col * cell_width, top - (row + 1) * 24, cell_width, 24, fill=0)
        for row, observation in enumerate(record["observations"]):
            for col, field in enumerate(("sample_id", "count")):
                self.draw_value(rid, ["observations", row, field], observation[field],
                                x=self.x + col * cell_width + 8, y=top - (row + 2) * 24 + 7, kind="table", size=9)
        self.y = top - rows * 24 - 35
        if self.prose:
            self.paragraph(" ".join(self.prose))


def objects(spec: dict) -> tuple[dict, list[dict], list[dict]]:
    """The survey's metadata and own objects (the benchmark's values, with `observations` rows) and cited objects."""
    template = bench.read(bench.TEMPLATES / "article.json")
    metadata, records = bench.values({key: spec[key] for key in ("seed", "records", "missing_year_every")
                                      if key in spec}, template)
    rng = random.Random(spec["seed"] * 7 + 1)
    rows = spec.get("observations", 2)
    for record in records:
        record["observations"] = [{"sample_id": f"S{k + 1}", "count": rng.randrange(10, 90)} for k in range(rows)]
    cited = []
    for n in range(spec.get("cited", 0)):
        cited.append({
            "record_id": f"KHM-{rng.randrange(1000, 9999)}-{n + 1:02}", "title": f"Harbour ledger {n + 1}",
            "year": 1800 + rng.randrange(90),
            "holding": {"institution": CITED_BY, "box": f"K{rng.randrange(100, 999)}"},
            "themes": ["trade", "shipping"],
            "observations": [{"sample_id": f"S{k + 1}", "count": rng.randrange(10, 90)} for k in range(rows)]})
    return metadata, records, cited


def cited_section(renderer: Renderer, heading: str, cited: list[dict]) -> None:
    renderer.new_page()
    renderer.paragraph(heading)
    for record in cited:
        renderer.placement = "cited"
        renderer.prose = []
        renderer.record(record, label="Object",
                        note=f"Catalogued by the {CITED_BY} (Lund 1998, Harbour Records of Kalmar, pp. 41-88).")
    renderer.placement = "primary"


def generate(spec: dict, directory: Path) -> dict:
    directory.mkdir(parents=True, exist_ok=False)
    template = bench.read(bench.TEMPLATES / "article.json")
    metadata, records, cited = objects(spec)
    native = directory / "source.pdf"
    renderer = Renderer(native, template)
    for field, prefix in (("collection_title", "Collection title: "), ("document_id", "Document reference: "),
                          ("edition", "Edition year: ")):
        renderer.field(None, [field], metadata[field], prefix)
    renderer.paragraph(template["introduction"])
    renderer.paragraph("Methods: each object was described independently. Tables list sample counts, "
                       "and themes record the survey's descriptive categories.")
    if cited:
        cited_section(renderer, f"Comparative material. The objects below are catalogued by the {CITED_BY} "
                                "(Lund 1998) and are cited for comparison.", cited)
    renderer.new_page()
    renderer.paragraph("Survey objects.")
    rng = random.Random(spec["seed"] * 11 + 3)
    def described():
        renderer.prose = rng.sample(PROSE, spec.get("prose", 0))
    for record in records:
        described()
        renderer.record(record)
    if cited:
        cited_section(renderer, f"Discussion. The {CITED_BY} objects cited for comparison (Lund 1998) are "
                                "listed again here.", cited)
    for n in range(spec.get("repeat_entries", 0)):
        renderer.placement = "reprint"
        renderer.new_page()
        renderer.paragraph("Repeated reference entry. The Object ID identifies the same archival object.")
        renderer.prose = []
        renderer.record(records[(n * 7) % len(records)])
    renderer.canvas.save()
    truth = {"spec": spec, "schema": bench.schemas()["article"], "metadata": metadata, "items": records,
             "cited": cited, "reprinted": [records[(n * 7) % len(records)]["record_id"]
                                           for n in range(spec.get("repeat_entries", 0))],
             "pages": renderer.page, "pdf_sha256": digest(native.read_bytes())}
    write_new(directory / "truth.json", truth)
    return truth


if __name__ == "__main__":
    config = json.loads(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2])
    for document in config["documents"]:
        truth = generate(document, out / document["id"])
        print(document["id"], truth["pages"], "pages", len(truth["items"]), "own", len(truth["cited"]), "cited",
              len(truth["reprinted"]), "reprinted")
