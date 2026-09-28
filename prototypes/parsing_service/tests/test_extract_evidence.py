"""A finished parse run, as extraction reads it: passages named by page and position, in reading order."""
import dataclasses
from pathlib import Path

import pytest

from kei_exp.kie.passages import Evidence, EvidenceUnavailable, load, text_of
from kei_exp.pagefile import load_result
from kei_exp.result import write_result
from tests.helpers.synthetic import cases


def written(case: str, digital_pdf: Path, tmp_path: Path) -> Path:
    """The synthetic case's result written under `tmp_path/result`, the layout of a run directory."""
    run = cases()[case](digital_pdf, tmp_path)
    write_result(run.outcome, run.execution, run.inventory, run.source, ingest_digest=run.ingest_digest,
                 directory=tmp_path / "result")
    return tmp_path


def hand_built_complete(digital_pdf: Path, tmp_path: Path) -> Path:
    """The `hand-built` synthetic case, with its errored block's own record kept complete.

    `hand_built()` gives the second block on page 1 both `error=True` (a `status="error"` segment: the gap in
    numbering these tests need) and its record the `ERROR` incomplete reason. The latter makes
    `Transcription.incomplete`, and so the whole manifest, "incomplete" (`tests/test_result.py` pins this), which
    `load`'s `require_complete=True` then refuses outright before a single passage is projected. Dropping just
    that record's incomplete reason keeps the block's own error status while letting the run finish as a whole,
    so the "ok segments in reading order" and "a missing case is refused" tests can both be satisfied by one case.
    """
    run = cases()["hand-built"](digital_pdf, tmp_path)
    first, *rest = run.outcome.pages
    outcome = dataclasses.replace(run.outcome, pages=[dataclasses.replace(first, incomplete=None), *rest])
    write_result(outcome, run.execution, run.inventory, run.source, ingest_digest=run.ingest_digest,
                 directory=tmp_path / "result")
    return tmp_path


def test_passages_are_the_ok_segments_of_every_page_in_reading_order(digital_pdf, tmp_path):
    run_dir = hand_built_complete(digital_pdf, tmp_path)
    loaded = load_result(run_dir / "result")
    evidence = load(run_dir)
    assert isinstance(evidence, Evidence)
    assert evidence.generation == loaded.manifest.generation
    assert evidence.digest == loaded.manifest.digest
    assert evidence.page_count == loaded.manifest.page_count
    expected = [(number, index, segment.text)
                for number in sorted(loaded.pages)
                for index, segment in enumerate(loaded.pages[number].segments)
                if segment.status == "ok" and segment.text.strip()]
    assert [(p.page, p.index, p.text) for p in evidence.passages] == expected
    assert [p.id for p in evidence.passages] == [f"p{page}_s{index}" for page, index, _ in expected]
    first = evidence.passages[0]
    assert evidence.by_id(first.id) is first
    assert len(first.bbox_pt) == 4 and first.extent in ("block", "input")


def test_an_errored_segment_keeps_its_neighbours_positions(digital_pdf, tmp_path):
    """Identity is the position in the page file, so a skipped segment leaves a gap in the numbering."""
    run_dir = hand_built_complete(digital_pdf, tmp_path)
    loaded = load_result(run_dir / "result")
    statuses = [(number, index, segment.status) for number in sorted(loaded.pages)
                for index, segment in enumerate(loaded.pages[number].segments)]
    assert any(status != "ok" for _, _, status in statuses), "the hand-built case carries an errored block"
    evidence = load(run_dir)
    for page, index, status in statuses:
        if status != "ok":
            assert f"p{page}_s{index}" not in {p.id for p in evidence.passages}


def test_an_incomplete_result_is_refused(digital_pdf, tmp_path):
    run_dir = written("capped", digital_pdf, tmp_path)
    with pytest.raises(EvidenceUnavailable, match="incomplete"):
        load(run_dir)


def test_a_missing_result_is_refused(tmp_path):
    with pytest.raises(EvidenceUnavailable, match="result.json"):
        load(tmp_path)


def test_text_of_joins_passages_with_blank_lines(digital_pdf, tmp_path):
    evidence = load(hand_built_complete(digital_pdf, tmp_path))
    expected = f"{evidence.passages[0].text.strip()}\n\n{evidence.passages[1].text.strip()}"
    assert text_of(evidence.passages[:2]) == expected


def test_passages_carry_their_unit_crop_order_crop_box_and_precision(tmp_path):
    from tests.helpers import catalogue
    evidence = load(catalogue.write("continuations", tmp_path))
    by_text = {passage.text: passage for passage in evidence.passages}
    right_page = by_text["mit Rand."]
    assert (right_page.page, right_page.unit) == (1, 2)          # the right book page of PDF page 1
    assert (by_text["2. Beil."].crop_order, by_text["3. Knochen."].crop_order) == (0, 1)
    assert by_text["2. Beil."].crop != by_text["3. Knochen."].crop
    assert by_text["Weitere Scherben."].unit == 3 and by_text["Weitere Scherben."].page == 2
    first = by_text["40. Aue. Fdpl. 1. FA: G. Funde:"]
    assert first.crop_bbox_pt is not None and first.crop_bbox_pt[0] <= first.bbox_pt[0]
    assert first.precision == "segment"


def test_a_segment_that_did_not_read_ok_is_withheld_not_silently_dropped(tmp_path):
    from tests.helpers import catalogue
    case = {"pages": [{"page": 1, "units": [{"index": 1, "crops": [{"segments": [
        "7. Adorf. FA: G.", {"text": "garbled", "status": "error"}, {"text": "   ", "status": "error"}]}]}]}]}
    evidence = load(catalogue.write(case, tmp_path))
    assert [passage.id for passage in evidence.passages] == ["p1_s0"]
    # A block the engine failed on is known unreadable evidence even when it carries no text.
    assert [(passage.id, passage.status) for passage in evidence.withheld] == [("p1_s1", "error"), ("p1_s2", "error")]


@pytest.mark.parametrize("forced, reason", [({"crop": 99}, "crop 99"), ({"unit": 7}, "unit 7")])
def test_a_segment_naming_a_crop_or_unit_its_page_has_not_is_refused(tmp_path, forced, reason):
    """Hashes prove the bytes, not the placement: a segment pointing at another unit's crop, or at none, cannot be
    placed in reading order or on its column, so the result is refused rather than projected without it."""
    from tests.helpers import catalogue
    case = {"pages": [{"page": 1, "units": [{"index": 1, "crops": [{"segments": [
        "7. Adorf. FA: G.", {"text": "8. Bdorf. FA: EF.", **forced}]}]}]}]}
    with pytest.raises(EvidenceUnavailable, match=reason):
        load(catalogue.write(case, tmp_path))


def test_a_crop_that_belongs_to_another_unit_is_refused(tmp_path):
    from tests.helpers import catalogue
    case = {"pages": [{"page": 1, "units": [
        {"index": 1, "crops": [{"segments": ["7. Adorf. FA: G."]}]},
        {"index": 2, "crops": [{"segments": [{"text": "8. Bdorf. FA: EF.", "crop": 1}]}]}]}]}
    with pytest.raises(EvidenceUnavailable, match="crop 1"):
        load(catalogue.write(case, tmp_path))


def test_duplicate_crop_ordinals_on_a_page_are_refused(tmp_path):
    from tests.helpers import catalogue
    case = {"pages": [{"page": 1, "units": [{"index": 1, "crops": [
        {"crop": 3, "segments": ["7. Adorf. FA: G."]}, {"crop": 3, "segments": ["8. Bdorf. FA: EF."]}]}]}]}
    with pytest.raises(EvidenceUnavailable, match="crop 3"):
        load(catalogue.write(case, tmp_path))


def test_reading_order_disagreeing_with_the_cut_order_is_reported():
    from kei_exp.kie.passages import Passage, order_issues
    def passage(index, unit, crop, order):
        return Passage(id=f"p1_s{index}", page=1, index=index, text="x", label="Text", bbox_pt=(0, 0, 1, 1),
                       extent="block", unit=unit, crop=crop, crop_order=order, crop_bbox_pt=(0, 0, 1, 1))
    assert order_issues([passage(0, 1, 1, 0), passage(1, 1, 2, 1), passage(2, 2, 3, 0)]) == []
    assert order_issues([passage(0, 1, 2, 1), passage(1, 1, 1, 0)]) == [
        "p1_s1 (unit 1, crop order 0) follows p1_s0 (unit 1, crop order 1) in the page file"]
    assert order_issues([passage(0, 2, 3, 0), passage(1, 1, 1, 0)]) == [
        "p1_s1 (unit 1, crop order 0) follows p1_s0 (unit 2, crop order 0) in the page file"]
