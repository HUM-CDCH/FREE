"""The accepted result at version 4 (canonical evidence design §3, §5): the writer's files from Surya, VLM and native
records, the generation identity, the per-page digests, completeness and the recipe fingerprint; and the reader's
refusals. Hand-built records over the digital fixture; the ingest of the fixture spread for the book-page case."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from kei_exp import files
from kei_exp import pagefile
from kei_exp.models import MODELS
from kei_exp.pagefile import (
    RESULT_VERSION,
    PageResult,
    Result,
    ResultError,
    load_result,
    read_manifest,
    read_page,
    result_digest,
)
from kei_exp.result import Input, Inventory, Source, fingerprint, recipe, write_result
from kei_exp.transcription.types import TEXT_RULES, Transcription, html_to_text
from tests.helpers.replay import book_pages
from tests.helpers.synthetic import ERROR, TABLE, TABLE_TEXT, block, crop, execution, record
from tests.helpers.synthetic import cases as synthetic_cases


def close(a, b, tolerance=1e-6) -> bool:
    return all(abs(x - y) < tolerance for x, y in zip(a, b, strict=True))


def page_of(directory: Path, number: int) -> PageResult:
    return PageResult.model_validate_json((directory / "pages" / f"{number}.json").read_text(encoding="utf-8"))


def test_html_to_text_keeps_data_and_entities_as_given():
    """Data and entities as given, a newline where a block ends, a tab where a cell does; nothing normalised."""
    assert html_to_text("<p>Gr&uuml;&szlig;e</p>") == "Grüße"
    assert html_to_text("<tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr>") == "a\tb\t\nc\td"
    assert html_to_text("<p>one<br/>two<br>three</p>") == "one\ntwo\nthree"
    assert html_to_text("<p><b>bold</b> <i>it</i> ü</p>") == "bold it ü"
    assert html_to_text(TABLE) == TABLE_TEXT


@pytest.fixture
def written(digital_pdf, tmp_path):
    """The hand-built case written, with the publication order recorded: two crops on page 1 (a block per crop, one
    in error), one on page 2, page 3 ink-free. Boxes go through the recorded transforms, never a nominal dpi."""
    played = synthetic_cases()["hand-built"](digital_pdf, tmp_path)
    published = []
    real_replace = files.os.replace

    def replace(part, target):
        part, target = Path(part), Path(target)
        json.loads(part.read_text(encoding="utf-8"))  # complete at the moment its name appears
        published.append(target.name)
        real_replace(part, target)

    with patch.object(files.os, "replace", replace):
        manifest = write_result(played.outcome, played.execution, played.inventory, played.source, ingest_digest=None,
                                directory=played.execution.result_dir, started="2026-09-21T10:00:00+00:00",
                                seconds=1.5)
    return played, manifest, published


def test_pages_are_published_one_at_a_time_and_the_manifest_last(written):
    played, _, published = written
    assert published == ["1.json", "2.json", "3.json", "result.json"]
    assert not list(played.execution.result_dir.rglob("*.part"))


def test_the_manifest_names_the_generation_and_every_page_file_with_its_hash(written, digital_pdf):
    played, manifest, _ = written
    directory = played.execution.result_dir
    assert manifest.result_version == RESULT_VERSION and manifest.generation
    assert sorted(manifest.pages) == [1, 2, 3]
    assert [entry.complete for entry in manifest.pages.values()] == [False, True, True]
    for number, entry in manifest.pages.items():
        raw = (directory / "pages" / f"{number}.json").read_bytes()
        assert entry.sha256 == hashlib.sha256(raw).hexdigest()
        assert page_of(directory, number).generation == manifest.generation
    assert manifest.digest == result_digest({n: e.sha256 for n, e in manifest.pages.items()})
    assert (manifest.started, manifest.seconds) == ("2026-09-21T10:00:00+00:00", 1.5)
    assert manifest.status == "incomplete" and manifest.incomplete == ERROR and manifest.source_name == "scan.pdf"
    assert manifest.recipe["source_sha256"] == played.source.sha256 and manifest.page_count == played.source.page_count
    assert manifest.recipe["pages_requested"] is None and manifest.recipe["result_version"] == RESULT_VERSION
    assert manifest.tokens == {"input": 30, "output": 60} and manifest.recipe["transcriber"] == "surya"
    assert manifest.recipe["record"]["params"] == MODELS["surya"].params
    assert set(manifest.recipe["versions"]) == {"docling", "surya-ocr"}
    stored = json.loads((directory / "result.json").read_text(encoding="utf-8"))
    assert stored["pages"] == {"1": {"sha256": manifest.pages[1].sha256, "complete": False},
                               "2": {"sha256": manifest.pages[2].sha256, "complete": True},
                               "3": {"sha256": manifest.pages[3].sha256, "complete": True}}


def test_page_one_places_its_blocks_through_the_crop_transforms(written, digital_pdf):
    played, manifest, _ = written
    directory = played.execution.result_dir
    first = read_page(directory, 1, manifest)
    assert first.page == 1 and first.size_pt == played.source.sizes[1]
    assert [(unit.index, unit.kind) for unit in first.units] == [(0, "pdf_page")]
    crops = first.units[0].crops
    assert [(c.crop, c.kind, c.order, c.image_px, c.source_px) for c in crops] == [
        (1, "column", 0, (500, 700), None), (2, "figure", 1, (500, 700), None)]
    assert crops[0].origin_pt == (100.0, 200.0) and close(crops[0].pt_per_px, (72 / 250, 72 / 250))
    assert (crops[0].seconds, crops[0].stop, crops[0].capped, crops[0].incomplete) == (None, None, False, ERROR)
    assert close(crops[0].bbox_pt, (100.0, 200.0, 300.0, 500.0))
    text, header = first.segments
    assert (text.text, text.html, text.label, text.status, text.unit, text.crop) == ("Grüße", "<p>Grüße</p>", "Text", "ok", 0, 1)
    assert close(text.bbox_pt, (100.0, 200.0, 172.0, 236.0)) and text.bbox_px == (0.0, 0.0, 250.0, 125.0)
    assert text.extent == "block" and header.extent == "block"
    assert (header.status, header.confidence) == ("error", 0.5)
    assert close(header.bbox_pt, (102.88, 205.76, 108.64, 211.52), 1e-9)
    assert first.markdown == "# T\n\nGrüße" and first.complete is False and first.warnings == [ERROR]
    assert text.markdown is None and header.markdown is None  # a Surya block's evidence is its HTML


def test_a_table_block_keeps_its_html_and_its_tabbed_text(written):
    played, manifest, _ = written
    third = read_page(played.execution.result_dir, 2, manifest)
    (table,) = third.segments
    assert table.html == TABLE and table.text == TABLE_TEXT and table.label == "Table"
    assert close(table.bbox_pt, (28.8, 28.8, 57.6, 57.6)) and third.complete and third.markdown == "| Fdpl. | 2 |"


def test_an_ink_free_page_gets_a_file_with_a_warning(written):
    played, manifest, _ = written
    third = read_page(played.execution.result_dir, 3, manifest)
    assert third.units[0].crops == [] and third.segments == [] and third.complete
    assert third.warnings == ["no content found by the layout cut"] and third.markdown == ""


def test_an_all_blank_cut_publishes_every_page_as_incomplete(digital_pdf, tmp_path):
    played = synthetic_cases()["blank-cut"](digital_pdf, tmp_path)
    manifest = write_result(played.outcome, played.execution, played.inventory, played.source, ingest_digest=None,
                            directory=tmp_path / "blank")
    assert manifest.status == "incomplete" and sorted(manifest.pages) == [1, 2]
    for number in (1, 2):
        page = read_page(tmp_path / "blank", number, manifest)
        assert page.complete and page.segments == [] and page.warnings == ["no content found by the layout cut"]


def test_an_incomplete_record_publishes_every_page_with_its_reason_everywhere(digital_pdf, tmp_path):
    played = synthetic_cases()["capped"](digital_pdf, tmp_path)
    manifest = write_result(played.outcome, played.execution, played.inventory, played.source, ingest_digest=None,
                            directory=tmp_path / "capped")
    first = read_page(tmp_path / "capped", 1, manifest)
    assert first.complete is False and first.warnings == ["page 1 stopped at its cap"]
    assert first.units[0].crops[0].incomplete == "page 1 stopped at its cap"
    assert manifest.pages[1].complete is False and manifest.pages[2].complete and manifest.pages[3].complete
    assert manifest.status == "incomplete" and manifest.incomplete == "page 1 stopped at its cap; content is missing"
    assert (tmp_path / "capped" / "pages" / "3.json").exists()


def test_whole_pages_keep_engine_boxes_and_mark_a_boxless_input_as_coarse(digital_pdf, tmp_path):
    """An uncut Surya page keeps its blocks under the whole-image transform (page size over image size); a page whose
    transcriber gave no boxes is one segment of extent `input`; a range after page 1 keeps its page numbers."""
    played = synthetic_cases()["whole-pages"](digital_pdf, tmp_path)
    manifest = write_result(played.outcome, played.execution, played.inventory, played.source, ingest_digest=None,
                            directory=tmp_path / "whole")
    size3, size4 = played.source.sizes[3], played.source.sizes[4]
    third = read_page(tmp_path / "whole", 3, manifest)
    assert len(third.segments) == 2 and third.units[0].crops == [] and third.units[0].kind == "pdf_page"
    assert close(third.segments[0].bbox_pt, (192 * size3[0] / 1587, 0.0, 384 * size3[0] / 1587, 96 * size3[1] / 2245))
    assert third.segments[0].crop is None and third.segments[0].bbox_px == (192.0, 0.0, 384.0, 96.0)
    assert third.segments[0].extent == "block"
    fourth = read_page(tmp_path / "whole", 4, manifest)
    (plain,) = fourth.segments
    assert plain.bbox_px is None and plain.extent == "input" and plain.text == "Plain"
    assert plain.markdown == fourth.markdown != ""  # a whole input's segment keeps its own Markdown
    assert close(plain.bbox_pt, (0.0, 0.0, *size4)) and plain.confidence is None
    assert manifest.recipe["pages_requested"] == [3, 4] and sorted(manifest.pages) == [3, 4]
    assert manifest.effective == {"max_size": None, "scale": 192 / 72}
    assert manifest.status == "success" and manifest.started is None and manifest.seconds is None


def test_over_the_ingest_a_page_has_its_book_pages_as_units(scan_pdf, tmp_path):
    """Each unit is self-contained; the right page's crops and blocks land on the spread past the gutter; the manifest
    names the ingest artifact. The fixture's placement carries a -0.11 degree rotation, so nothing here is a plain
    translation: every box is asserted through the recorded transform and the placement. A block's box goes through
    the crop's recorded transform: the column requested at 10 pt was cut on the native grid at pixel 83 (9.96 pt),
    and 10 of its 100 dpi pixels are 60 native pixels, 7.2 pt; the crop's own box stays the requested one."""
    book = book_pages(scan_pdf, tmp_path)
    left, right = book.page(1), book.page(2)
    column = (10.0, 10.0, 100.0, 200.0)
    crops = [crop(1, "column", column, 0, left.crop_transform(100, column)),
             crop(2, "column", column, 0, right.crop_transform(100, column))]
    inventory = Inventory([1], [Input(1, 1, 1, crops[0]), Input(2, 1, 2, crops[1])], book)
    outcome = Transcription({}, [record(1, blocks=[block((0, 0, 10, 10))]), record(2, blocks=[block((0, 0, 10, 10))])])
    made = execution(scan_pdf, tmp_path, page_source="ingest")
    manifest = write_result(outcome, made, inventory, Source.of(made), ingest_digest=book.digest,
                            directory=tmp_path / "ingest-result")
    spread = read_page(tmp_path / "ingest-result", 1, manifest)
    assert [(unit.index, unit.kind) for unit in spread.units] == [(1, "book_page"), (2, "book_page")]
    # The units tile the spread: the left page starts within a point of the page's corner, the right page at the
    # gutter, 4952 native pixels (594.24 pt) in, both widened by the rotation's shear (the bounding box of a tall
    # box rotated by -0.11 degrees starts 0.8 pt before its top-left corner).
    assert abs(spread.units[0].bbox_pt[0]) < 1 and abs(spread.units[0].bbox_pt[1]) < 1.5
    assert 593 < spread.units[1].bbox_pt[0] < 595
    assert close(spread.units[1].bbox_pt, right.to_page_points((0.0, 0.0, *right.get_size())))
    assert close(spread.units[1].crops[0].bbox_pt, right.to_page_points(column))
    assert spread.units[1].crops[0].source_px == right.native_box(column)
    transform = left.crop_transform(100, column)  # the fixture's dpi is 599.99, hence the tolerance
    assert transform.source_px[:2] == (83, 83) and close(transform.to_unit_points((0, 0, 10, 10)), (9.96, 9.96, 17.16, 17.16), 1e-3)
    assert close(spread.segments[0].bbox_pt, left.to_page_points(transform.to_unit_points((0, 0, 10, 10))))
    block_on_right = right.crop_transform(100, column).to_unit_points((0, 0, 10, 10))
    assert close(spread.segments[1].bbox_pt, right.to_page_points(block_on_right)) and spread.segments[1].unit == 2
    assert manifest.recipe["ingest_digest"] == book.digest


def test_the_recipe_fingerprint_follows_the_recipe_alone(digital_pdf, tmp_path):
    """Stable for one recipe; changed by the version, a pinned Surya setting and the selection; two writes of one
    recipe are two generations under one fingerprint."""
    made = execution(digital_pdf, tmp_path)
    stable = fingerprint(recipe(made, "ab" * 32, None))
    assert stable == fingerprint(recipe(made, "ab" * 32, None)) and len(stable) == 64
    assert stable != fingerprint(recipe(execution(digital_pdf, tmp_path, pages=(1, 2)), "ab" * 32, None))
    with patch.object(pagefile, "RESULT_VERSION", RESULT_VERSION + 1):
        assert stable != fingerprint(recipe(made, "ab" * 32, None))
    with patch.dict(MODELS["surya"].params, {"SURYA_GUIDED_LAYOUT": False}):
        assert stable != fingerprint(recipe(made, "ab" * 32, None))
    played = synthetic_cases()["whole-pages"](digital_pdf, tmp_path)
    first = write_result(played.outcome, played.execution, played.inventory, played.source, ingest_digest=None,
                         directory=tmp_path / "one")
    second = write_result(played.outcome, played.execution, played.inventory, played.source, ingest_digest=None,
                          directory=tmp_path / "two")
    assert first.fingerprint == second.fingerprint and first.generation != second.generation
    assert first.digest != second.digest  # two sets of files, each naming its own generation: two identities
    assert Result.model_validate_json((tmp_path / "one" / "result.json").read_text(encoding="utf-8")).generation


# --- The reader: a result directory a consumer must not trust is refused, naming the file and the field --------
@pytest.fixture
def success(digital_pdf, tmp_path) -> Path:
    """A finished run over pages 3 and 4, as written."""
    played = synthetic_cases()["whole-pages"](digital_pdf, tmp_path)
    write_result(played.outcome, played.execution, played.inventory, played.source, ingest_digest=None,
                 directory=tmp_path / "success")
    return tmp_path / "success"


def edit_json(path: Path, change) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    change(data)
    path.write_text(json.dumps(data), encoding="utf-8")


def disagree_about_completeness(directory: Path) -> None:
    """Page 4 rewritten as incomplete with its entry's hash following, so only the completeness disagreement is left."""
    edit_json(directory / "pages" / "4.json", lambda p: p.update({"complete": False}))
    raw = (directory / "pages" / "4.json").read_bytes()
    edit_json(directory / "result.json", lambda m: m["pages"]["4"].update({"sha256": hashlib.sha256(raw).hexdigest()}))


def test_a_verified_result_loads_with_its_digest(success):
    loaded = load_result(success, pages=[3, 4], require_complete=True, transcriber="surya", page_source="pdf")
    assert sorted(loaded.pages) == [3, 4]
    assert loaded.manifest.digest == result_digest({n: e.sha256 for n, e in loaded.manifest.pages.items()})


def refusal(what, damage, *naming, **expect):
    return pytest.param(damage, naming, expect, id=what)


REFUSALS = [
    refusal("no manifest", lambda d: (d / "result.json").unlink(), "result.json"),
    refusal("another result version", lambda d: edit_json(d / "result.json", lambda m: m.update({"result_version": 3})),
            "result_version"),
    refusal("a listed page file that is missing", lambda d: (d / "pages" / "3.json").unlink(), "pages/3.json"),
    refusal("a page file that is not listed",
            lambda d: (d / "pages" / "5.json").write_bytes((d / "pages" / "4.json").read_bytes()), "pages/5.json"),
    refusal("a page file naming another page", lambda d: edit_json(d / "pages" / "4.json", lambda p: p.update({"page": 3})),
            "pages/4.json"),
    refusal("a page file of another generation",
            lambda d: edit_json(d / "pages" / "4.json", lambda p: p.update({"generation": "other"})), "generation"),
    refusal("other bytes than the manifest recorded",
            lambda d: edit_json(d / "pages" / "4.json", lambda p: p.update({"markdown": "edited"})), "pages/4.json", "sha256"),
    refusal("a page disagreeing with its entry about completeness", lambda d: disagree_about_completeness(d),
            "pages/4.json", "complete"),
    refusal("a successful run with an incomplete entry",
            lambda d: edit_json(d / "result.json", lambda m: m["pages"]["4"].update({"complete": False})), "status"),
    refusal("a digest that is not the page files'",
            lambda d: edit_json(d / "result.json", lambda m: m.update({"digest": "0" * 64})), "digest"),
    refusal("another source", lambda d: None, "source_sha256", source_sha256="0" * 64),
    refusal("another ingest", lambda d: None, "ingest_digest", ingest_digest="0" * 64),
    refusal("another transcriber", lambda d: None, "transcriber", transcriber="vlm"),
    refusal("another page source", lambda d: None, "page_source", page_source="ingest"),
    refusal("other pages than expected", lambda d: None, "pages", pages=[3]),
    refusal("an incomplete run where a complete one is required",
            lambda d: edit_json(d / "result.json", lambda m: m.update({"status": "incomplete", "incomplete": "capped"})),
            "incomplete", require_complete=True),
]


@pytest.mark.parametrize("damage, naming, expect", REFUSALS)
def test_the_reader_refuses_what_it_cannot_prove(success, damage, naming, expect):
    damage(success)
    with pytest.raises(ResultError) as caught:
        load_result(success, **expect)
    silent = [text for text in naming if text not in str(caught.value)]
    assert not silent, f"refused, but the message does not say {silent}: {caught.value}"


def test_read_page_proves_one_page_against_the_manifest(success):
    manifest = read_manifest(success)
    assert read_page(success, 4, manifest).page == 4
    edit_json(success / "pages" / "4.json", lambda p: p.update({"markdown": "edited"}))
    with pytest.raises(ResultError, match="sha256"):
        read_page(success, 4, manifest)


def test_the_page_file_reader_verifies_a_result_without_the_kie_package():
    """A reader of the accepted result imports no pipeline: the digest encoding is a leaf both sides agree on.

    In a fresh interpreter, because pytest has already imported the pipeline into this one. The digest is taken
    there as well, so a `pagefile` that reached for the encoding at call time would be caught too. What the bytes
    are is the writer's and the reader's business, and the tests above already pin them.
    """
    probe = """
import sys
from kei_exp.pagefile import result_digest
result_digest({1: "a" * 64})  # taking a digest must not be what pulls the pipeline in
pipeline = sorted(m for m in sys.modules if m.startswith("kei_exp.kie"))
assert not pipeline, pipeline
"""
    subprocess.run([sys.executable, "-c", probe], check=True, cwd=Path(__file__).resolve().parents[1])


def test_the_native_text_rules_are_part_of_what_a_native_run_was_asked(digital_pdf, tmp_path):
    """Native list items now publish their printed markers: the same PDF under the old rule wrote other text, so a
    native recipe names its text rules and a resumed attempt under other rules cannot share a fingerprint."""
    native = execution(digital_pdf, tmp_path, transcriber="native", model=None, repo=None, url=None, cut="none",
                       layout_model=None, crop_dpi=None)
    made = recipe(native, "ab" * 32, None)
    assert made["text_rules"] == TEXT_RULES["native"]
    with patch.dict(TEXT_RULES, {"native": TEXT_RULES["native"] + 1}):
        assert fingerprint(recipe(native, "ab" * 32, None)) != fingerprint(made)
    assert "text_rules" not in recipe(execution(digital_pdf, tmp_path), "ab" * 32, None)  # Surya's recipe unchanged


def test_a_version_4_manifest_is_refused(written):
    """Only the version this reader was written for is read: a version 4 manifest, consistent in itself (its recipe
    and fingerprint agree), is refused, and refusing it touches no page file."""
    played, _, _ = written
    directory = played.execution.result_dir
    file = directory / 'result.json'
    data = json.loads(file.read_text())
    data['result_version'] = 4
    data['recipe']['result_version'] = 4
    data['fingerprint'] = fingerprint(data['recipe'])
    file.write_text(json.dumps(data))
    before = {path: path.read_bytes() for path in (directory / 'pages').glob('*.json')}
    with pytest.raises(ResultError, match="result_version 4"):
        load_result(directory)
    assert all(path.read_bytes() == raw for path, raw in before.items())
