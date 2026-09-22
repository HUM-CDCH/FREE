"""A finished parse run, as extraction reads it: passages named by page and position, in reading order."""
import dataclasses
from pathlib import Path

import pytest

from kei_exp.kie.extract.evidence import Evidence, EvidenceUnavailable, load, text_of
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
