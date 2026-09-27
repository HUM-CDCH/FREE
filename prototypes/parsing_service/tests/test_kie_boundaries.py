"""Boundary labels and block-F1 (grounded catalogue design §9): the frozen matching, its refusals and the sample."""
import json

import pytest

from kei_exp.kie import boundaries
from kei_exp.kie.boundaries import BoundaryLabels, LabelsRefused, prefill, report, sample_pages, score
from kei_exp.kie.passages import load
from kei_exp.kie.recipe import load_recipe
from kei_exp.kie.stages.segment import segment
from tests.helpers import catalogue

RECIPE = load_recipe("numbered-catalogue-de@1")
THREE = {"pages": [{"page": 1, "units": [{"index": 0, "segments": ["1. Au.", "2. Bach.", "3. Dorf."]}]}]}


def parsed(case, tmp_path):
    evidence = load(catalogue.write(case, tmp_path / "run"))
    return evidence, segment(evidence, RECIPE)


def gold(evidence, pages, owners: dict[str, str | None]) -> BoundaryLabels:
    """A reviewer's labels: every line of `pages`, owned as `owners` says by segment id (unlisted lines: none)."""
    rows = [{"segment": line.segment, "start": line.start, "end": line.end, "text": line.text,
             "entry": owners.get(line.segment)}
            for line in boundaries.source_lines(evidence) if (line.passage.page, line.passage.unit) in pages]
    return BoundaryLabels(labels_version=1, matching="exact-line-set@1", generation=evidence.generation,
                          parse_digest=evidence.digest, pages=sorted(pages), sample={}, prefilled_from=None,
                          lines=rows)


def fixture_owners(name: str) -> dict[str, str | None]:
    """The fixture's hand-written expectation, independent of the segmenter: the owning entry of every line."""
    return {row[0]: row[4] for row in catalogue.fixture(name)["expected"]["lines"] if row[3] == "entry"}


def test_blocks_crossing_a_column_a_book_page_and_a_pdf_page_match_when_their_lines_do(tmp_path):
    evidence, segmentation = parsed("continuations", tmp_path)
    pages = {(1, 1), (1, 2), (2, 3), (2, 4)}
    result = score(gold(evidence, pages, fixture_owners("continuations")), evidence, segmentation)
    assert (result["gold_blocks"], result["predicted_blocks"], result["matched"]) == (4, 4, 4)
    assert (result["precision"], result["recall"], result["f1"]) == (1.0, 1.0, 1.0)
    # 40 crosses a column, 41 a book page, 42 a PDF page; 43 owns its column's last entry line.
    assert result["boundary"] == {"gold": 4, "matched": 4, "recall": 1.0}
    assert result["interior"] == {"gold": 0, "matched": 0, "recall": None}
    assert result["exceptions"] == []


def test_on_a_sample_of_pages_only_the_lines_there_are_compared(tmp_path):
    evidence, segmentation = parsed("continuations", tmp_path)
    result = score(gold(evidence, {(1, 1)}, fixture_owners("continuations")), evidence, segmentation)
    # 41 continues on the next book page, which is not labelled: its one line here still matches.
    assert (result["pages"], result["gold_blocks"], result["matched"], result["f1"]) == (1, 2, 2, 1.0)


def test_a_moved_boundary_fails_both_blocks_it_touches_and_only_those(tmp_path):
    evidence, segmentation = parsed(THREE, tmp_path)
    # The reviewer reads "2." as a find of entry 1, not an entry.
    result = score(gold(evidence, {(1, 0)}, {"p1_s0": "1", "p1_s1": "1", "p1_s2": "3"}), evidence, segmentation)
    assert (result["gold_blocks"], result["predicted_blocks"], result["matched"]) == (2, 3, 1)
    assert (result["precision"], result["recall"], result["f1"]) == (0.3333, 0.5, 0.4)
    assert result["unmatched_gold"] == ["1"] and result["unmatched_predicted"] == ["1", "2"]
    assert result["boundary"] == {"gold": 2, "matched": 1, "recall": 0.5}


def test_the_middle_entry_of_a_column_is_interior_and_its_edges_are_boundary(tmp_path):
    evidence, segmentation = parsed(THREE, tmp_path)
    result = score(gold(evidence, {(1, 0)}, {"p1_s0": "1", "p1_s1": "2", "p1_s2": "3"}), evidence, segmentation)
    assert result["interior"] == {"gold": 1, "matched": 1, "recall": 1.0}
    assert result["boundary"] == {"gold": 2, "matched": 2, "recall": 1.0}


def test_a_printed_label_the_reviewer_reads_differently_still_matches_and_is_reported(tmp_path):
    evidence, segmentation = parsed(THREE, tmp_path)
    labels = gold(evidence, {(1, 0)}, {"p1_s0": "1", "p1_s1": "8#1", "p1_s2": "3"})
    result = score(labels, evidence, segmentation)
    assert result["matched"] == 3 and result["label_disagreements"] == [["8#1", "2"]]


def test_lines_a_reviewer_gives_no_entry_but_the_segmenter_owns_are_counted(tmp_path):
    evidence, segmentation = parsed(THREE, tmp_path)
    result = score(gold(evidence, {(1, 0)}, {"p1_s0": "1", "p1_s2": "3"}), evidence, segmentation)
    assert result["other_lines_predicted_as_entry"] == 1 and result["entry_lines_predicted_otherwise"] == 0
    assert result["unmatched_predicted"] == ["2"]


@pytest.mark.parametrize("tamper, message", [
    (lambda data: data.update(generation="20260101T000000.000000Z-other000"), "generation"),
    (lambda data: data["lines"].pop(), "missing"),
    (lambda data: data["lines"][0].update(text="1. Aue."), "reads"),
    (lambda data: data["lines"].append(dict(data["lines"][0])), "twice"),
    (lambda data: data["lines"][0].update(entry="#2"), "empty entry label"),
])
def test_labels_that_do_not_describe_this_parse_exactly_are_refused(tmp_path, tamper, message):
    evidence, segmentation = parsed(THREE, tmp_path)
    data = gold(evidence, {(1, 0)}, {"p1_s0": "1", "p1_s1": "2", "p1_s2": "3"}).model_dump(mode="json")
    tamper(data)
    with pytest.raises(LabelsRefused, match=message):
        score(BoundaryLabels.model_validate(data), evidence, segmentation)


def test_the_sample_draws_one_page_per_stratum_of_catalogue_pages_reproducibly(tmp_path):
    evidence, segmentation = parsed("continuations", tmp_path)
    pages, sample = sample_pages(evidence, segmentation, count=2, seed=5)
    assert pages[0] == (1, 1) and pages[1] in [(1, 2), (2, 3)]
    assert (pages, sample) == sample_pages(evidence, segmentation, count=2, seed=5)
    # The furniture-only book page 4 is no candidate, and the description says what was sampled from.
    assert sample["candidates"] == 3 and sample["strata"] == 2 and "entry or unresolved" in sample["restriction"]
    assert sample_pages(evidence, segmentation, count=20)[1]["strata"] == 3


def test_a_prefill_covers_the_sampled_pages_and_records_the_segmentation_it_is_not_gold_for(tmp_path):
    evidence, segmentation = parsed("continuations", tmp_path)
    labels = prefill(evidence, segmentation, [(2, 3)], {"seed": 0})
    assert [(line.segment, line.entry, line.predicted) for line in labels.lines] == [
        ("p2_s0", None, "excluded: furniture"), ("p2_s1", "42", "entry"), ("p2_s2", None, "heading"),
        ("p2_s3", "43", "entry")]
    assert labels.prefilled_from == segmentation.digest
    assert score(labels, evidence, segmentation)["prefilled_from"] == segmentation.digest


def test_the_report_accounts_for_the_segmentation_without_claiming_accuracy(tmp_path):
    evidence, segmentation = parsed("continuations", tmp_path)
    summary = report(evidence, segmentation, seconds=0.1)
    assert (summary["blocks"], summary["continuations"], summary["entry_numbers"]) == (4, 3, [40, 43])
    assert summary["coverage"]["complete"] is True and summary["rejected_starts"] == {"list_item": 3}


def test_a_source_without_catalogue_pages_has_nothing_to_sample(tmp_path, capsys):
    run = catalogue.write("no-records", tmp_path / "run")
    assert boundaries.main(["prefill", str(run)]) == 2
    assert "no entry or unresolved line" in capsys.readouterr().err


def test_the_command_line_never_writes_into_the_run_it_measures(tmp_path, capsys):
    run = catalogue.write(THREE, tmp_path / "run")
    before = sorted(path.relative_to(run) for path in run.rglob("*"))
    assert boundaries.main(["prefill", str(run), "--pages", "1"]) == 0
    labels = tmp_path / "labels.json"
    labels.write_text(capsys.readouterr().out, encoding="utf-8")
    assert boundaries.main(["score", str(run), str(labels)]) == 0
    assert json.loads(capsys.readouterr().out)["f1"] == 1.0
    data = json.loads(labels.read_text(encoding="utf-8"))
    data["lines"].pop()
    labels.write_text(json.dumps(data), encoding="utf-8")
    assert boundaries.main(["score", str(run), str(labels)]) == 2
    assert "refused" in capsys.readouterr().err
    assert sorted(path.relative_to(run) for path in run.rglob("*")) == before
