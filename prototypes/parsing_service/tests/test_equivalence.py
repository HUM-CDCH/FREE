"""The version 4 writer writes what the version 3 writer wrote, on identical inputs (canonical evidence design §8).

The golden outputs under tests/golden are the version 3 writer's, captured at e5ad72f from the replay of one
recorded run and four hand-built cases. They now run over the committed synthetic eight-page PDF: its sha was
pinned in place of the original's, and the recorded run's text was swapped for synthetic text in its recording
and golden together. Every page file and manifest the new
writer produces is compared with its golden after the documented version 4 mapping, with text, HTML, boxes and
Markdown compared verbatim: non-ASCII text, a table block, whole pages under an engine transform, a page with no
boxes, an errored block, a capped page and an all-blank cut are among the cases.
"""
import json
from pathlib import Path

import pytest

from kei_exp.pagefile import RESULT_VERSION, read_manifest, read_page, result_digest
from kei_exp.result import write_result
from kei_exp.transcription.types import TEXT_RULES
from tests.helpers.replay import Replay, replay
from tests.helpers.synthetic import cases

GOLDEN = Path(__file__).resolve().parent / "golden"
RECORDED = {"native-main": "digital"}


def as_version_4(page: dict) -> dict:
    """The version 3 golden page file as the version 4 writer must write it: the generation instead of the recipe
    fingerprint, named units, the transform as two named pairs plus the record's diagnostics, and the extent of
    every segment's evidence made explicit."""
    page = {key: value for key, value in page.items() if key != "fingerprint"}
    for unit in page["units"]:
        unit["kind"] = "pdf_page" if unit["index"] == 0 else "book_page"
        for crop in unit["crops"]:
            origin_x, origin_y, per_px_x, per_px_y = crop.pop("transform")
            crop.update(origin_pt=[origin_x, origin_y], pt_per_px=[per_px_x, per_px_y], seconds=None, stop=None,
                        capped=False)
    for segment in page["segments"]:
        segment["extent"] = "input" if segment["bbox_px"] is None else "block"
        segment.setdefault("table", None)
    return page


@pytest.fixture
def played(request, recorded, recorded_digital_pdf, tmp_path) -> tuple[str, Replay]:
    case = request.param
    if case in RECORDED:
        return case, replay(recorded(case), recorded_digital_pdf, tmp_path)
    return case, cases()[case](recorded_digital_pdf, tmp_path)


@pytest.mark.parametrize("played", [*RECORDED, *cases()], indirect=True)
def test_version_4_writes_what_version_3_wrote(played):
    case, run = played
    directory = run.execution.result_dir
    write_result(run.outcome, run.execution, run.inventory, run.source, ingest_digest=run.ingest_digest,
                 directory=directory)
    manifest = read_manifest(directory)
    golden = json.loads((GOLDEN / case / "result.json").read_text(encoding="utf-8"))
    assert manifest.result_version == RESULT_VERSION
    assert sorted(manifest.pages) == golden["pages"]
    # Since 2026-09-23 a native recipe also names its text rules (list items keep their printed markers).
    rules = {"text_rules": TEXT_RULES[manifest.recipe["transcriber"]]} if manifest.recipe["transcriber"] in TEXT_RULES else {}
    # The recipe names more library versions now (pypdfium2, pillow); compare the ones the golden names.
    recipe = {**manifest.recipe, "versions": {key: value for key, value in manifest.recipe["versions"].items()
                                               if key in golden["recipe"]["versions"]}}
    assert recipe == {**golden["recipe"], "result_version": RESULT_VERSION, **rules}
    assert (manifest.status, manifest.incomplete, manifest.tokens, manifest.source_name, manifest.page_count,
            manifest.effective) == (golden["status"], golden["incomplete"], golden["tokens"], golden["source_name"],
                                    golden["page_count"], golden["effective"])
    assert manifest.digest == result_digest({n: entry.sha256 for n, entry in manifest.pages.items()})
    for number, entry in manifest.pages.items():
        page = read_page(directory, number, manifest)
        written = page.model_dump(mode="json")
        expected = as_version_4(json.loads((GOLDEN / case / "pages" / f"{number}.json").read_text(encoding="utf-8")))
        assert written.pop("generation") == manifest.generation
        assert written == expected, f"{case}: page {number} differs from the version 3 golden"
        assert entry.complete == page.complete
