"""The structural segmenter: start roles by the source's own numbering, blocks, the coverage ledger, and the immutable
segmentation artifact (grounded catalogue design §4, §5, §7). No model is involved anywhere in this file.
"""
import json

import pytest

from kei_exp.kie.extract.evidence import load
from kei_exp.kie.recipe import load_recipe
from kei_exp.kie.segmentation import SegmentationInvalid, load_segmentation, obtain, publish_segmentation
from kei_exp.kie.stages import segment as segmenter
from kei_exp.kie.stages.segment import Candidate, resolve_starts, segment
from tests.helpers import catalogue

RECIPE = load_recipe("numbered-catalogue-de@1")
KINDS = ("bezirk", "kreis")


# --- start roles ---------------------------------------------------------------------------------------------------

def roles(numbers: list, barriers: tuple[int, ...] = ()) -> list[set[str]]:
    """Resolve a bare sequence: an int is a candidate number, `(n, "a")` a suffixed one; `barriers` lists the
    positions preceded by a heading that ends any open entry."""
    candidates = [Candidate(number=n if isinstance(n, int) else n[0], suffix="" if isinstance(n, int) else n[1],
                            barrier=i in barriers) for i, n in enumerate(numbers)]
    return [set(options) for options in resolve_starts(candidates).roles]


def test_a_plain_sequence_is_all_entries():
    assert roles([30, 31, (31, "a"), 32]) == [{"entry"}] * 4


def test_nested_finds_after_an_entry_are_list_items_even_at_the_catalogue_start():
    assert roles([1, 1, 2, 2, 1, 3]) == [{"entry"}, {"list_item"}, {"list_item"}, {"entry"}, {"list_item"}, {"entry"}]


def test_a_long_nested_list_is_not_promoted_by_a_count_of_entries():
    """[1e, 1..4 finds, 2e, 3e]: promoting the finds would leave 2e and 3e unexplained."""
    assert roles([1, 1, 2, 3, 4, 2, 3]) == [{"entry"}] + [{"list_item"}] * 4 + [{"entry"}] * 2


def test_a_find_that_could_be_the_missing_entry_stays_ambiguous():
    """[1e, 1n, 2n, 3?] at the end of the source: entry 3 after finds 1-2, entries 2 and 3, and finds 1-3 all explain
    every candidate, so neither 2 nor 3 is resolved."""
    assert roles([1, 1, 2, 3]) == [{"entry"}, {"list_item"}, {"entry", "list_item"}, {"entry", "list_item"}]


def test_a_jump_does_not_make_a_nested_item_into_an_entry():
    """Jumps are diagnostics, not costs: [1e, 1n, 2n, 7e, 8e] leaves 2n ambiguous instead of resolving a split."""
    assert roles([1, 1, 2, 7, 8]) == [{"entry"}, {"list_item"}, {"entry", "list_item"}, {"entry"}, {"entry"}]


def test_a_list_continues_numbering_written_inline_in_the_entry_before_it():
    """"... Funde: 1. Urne." then a line "2. Beil.": the entry's own text already numbered find 1, so the line is
    find 2, not an unexplained start (paragraph context, plan M3)."""
    candidates = [Candidate(154, "", False), Candidate(2, "", False, inline=(1,)), Candidate(4, "", False, inline=(3,)),
                  Candidate(155, "", False)]
    assert [set(options) for options in resolve_starts(candidates).roles] == [
        {"entry"}, {"list_item"}, {"list_item"}, {"entry"}]


def test_a_second_list_inside_one_entry_starts_again_at_one():
    assert roles([154, 1, 2, 1, 2, 3, 155]) == [{"entry"}] + [{"list_item"}] * 5 + [{"entry"}]


def test_a_misread_number_is_the_exception_and_does_not_poison_its_neighbours():
    assert roles([150, 1540, 151, 152]) == [{"entry"}, {"exception"}, {"entry"}, {"entry"}]


def test_missing_pages_are_a_jump_not_a_run_of_exceptions():
    resolved = resolve_starts([Candidate(150, "", False), Candidate(400, "", False), Candidate(401, "", False)])
    assert [set(options) for options in resolved.roles] == [{"entry"}] * 3


def test_a_repeated_identity_leaves_both_candidates_unresolved():
    """Either 34 can be the entry and the other the exception: the numbering cannot say which record is 34."""
    assert roles([33, 34, 34, 35]) == [{"entry"}, {"entry", "exception"}, {"entry", "exception"}, {"entry"}]


def test_an_entry_1_followed_by_a_candidate_1_keeps_the_list_reading():
    assert roles([1, 1, 2]) == [{"entry"}, {"list_item"}, {"entry", "list_item"}]


def test_a_heading_between_them_ends_the_entry_a_list_could_belong_to():
    """After a heading no entry is open, so 1 and 2 cannot be finds; as entries they would cost three exceptions."""
    assert roles([38, 39, 40, 1, 2], barriers=(3,)) == [{"entry"}] * 3 + [{"exception"}] * 2


# --- the acceptance fixtures ---------------------------------------------------------------------------------------

def detail_of(disposition, segmentation, evidence) -> str:
    if disposition.role == "entry":
        return next(block.entry_label for block in segmentation.blocks if block.id == disposition.block)
    if disposition.role == "heading" and disposition.heading is None:
        return f"section:{disposition.reason}"
    if disposition.role == "heading":
        event = next(event for event in segmentation.heading_events if event.id == disposition.heading)
        span = event.spans[0]
        return f"{event.kind}:{evidence.by_id(span.segment_id).text[span.start:span.end]}"
    return disposition.reason or ""


def value_of(heading_id, segmentation, evidence):
    event = next(event for event in segmentation.heading_events if event.id == heading_id)
    span = event.spans[0]
    return event.kind, evidence.by_id(span.segment_id).text[span.start:span.end]


@pytest.mark.parametrize("name", catalogue.names())
def test_every_fixture_is_segmented_as_its_expected_source_intervals_say(name, tmp_path):
    evidence = load(catalogue.write(name, tmp_path))
    segmentation = segment(evidence, RECIPE)
    expected = catalogue.fixture(name)["expected"]
    found = sorted([d.segment_id, d.start, d.end, d.role, detail_of(d, segmentation, evidence)]
                   for d in segmentation.dispositions)
    assert found == sorted(line[:5] for line in expected["lines"]), name
    assert [block.entry_label for block in segmentation.blocks] == [block["label"] for block in expected["blocks"]]
    for block, want in zip(segmentation.blocks, expected["blocks"], strict=True):
        assert block.continuation == want["continuation"], (name, block.entry_label)
        inherited = dict.fromkeys(KINDS)
        inherited.update(value_of(heading, segmentation, evidence) for heading in block.heading_events)
        assert inherited == want["headings"], (name, block.entry_label)
    if "rejected_starts" in expected:
        assert [[start.span.segment_id, start.label, start.role] for start in segmentation.rejected_starts] == \
            expected["rejected_starts"], name
    assert sorted({d.code for d in segmentation.diagnostics}) == sorted(set(expected.get("diagnostics", []))), name
    assert segmentation.coverage.complete is expected["coverage_complete"], name
    if "withheld" in expected:
        assert segmentation.coverage.withheld_intentional == expected["withheld"]["intentional"]
        assert segmentation.coverage.withheld_failures == expected["withheld"]["failures"]


def test_an_exception_names_why_the_numbering_cannot_explain_it(tmp_path):
    """A lower number that continues no list cites something earlier (a museum line naming find 5); a far higher one
    among consecutive entries is an outlier such as an OCR misreading. Both are reported, neither opens a block."""
    case = {"pages": [{"page": 1, "units": [{"index": 1, "crops": [{"segments": [
        "30. Adorf. FA: G. Funde: 1. Urne.", "31. Bdorf. FA: EF.", "5. Mus. Halle 5.", "32. Cdorf. FA: G.",
        "920. Ddorf. FA: G.", "33. Edorf. FA: EF.", "34. Fdorf. FA: G."]}]}]}]}
    segmentation = segment(load(catalogue.write(case, tmp_path)), RECIPE)
    assert [(start.label, start.role, start.reason) for start in segmentation.rejected_starts] == [
        ("5", "exception", "backward_label"), ("920", "exception", "sequence_exception")]
    assert [block.entry_label for block in segmentation.blocks] == ["30", "31", "32", "33", "34"]


def test_two_entries_in_one_segment_own_disjoint_spans_of_the_unchanged_segment(tmp_path):
    evidence = load(catalogue.write("two-in-one-segment", tmp_path))
    first, second = segment(evidence, RECIPE).blocks
    assert first.primary_spans[0].segment_id == second.primary_spans[0].segment_id == "p1_s2"
    assert first.primary_spans[0].end <= second.primary_spans[0].start
    assert evidence.by_id("p1_s2").text.count("\n") == 1  # canonical text untouched


def test_context_is_bounded_and_never_owned(tmp_path):
    evidence = load(catalogue.write("continuations", tmp_path))
    segmentation = segment(evidence, RECIPE)
    block = next(block for block in segmentation.blocks if block.entry_label == "41")
    assert block.context_spans, "a block sees its neighbours"
    assert len([span for span in block.context_spans]) <= 2 * RECIPE.structure.context.lines
    for span in block.context_spans:
        assert span.end - span.start <= RECIPE.structure.context.max_chars


def test_a_reading_order_the_page_file_contradicts_leaves_coverage_incomplete(tmp_path):
    import dataclasses
    evidence = load(catalogue.write("two-in-one-segment", tmp_path))
    disordered = dataclasses.replace(evidence, order_issues=("p1_s2 (unit 1, crop order 0) follows p1_s1 ...",))
    segmentation = segment(disordered, RECIPE)
    assert segment(evidence, RECIPE).coverage.complete is True
    assert segmentation.coverage.complete is False and segmentation.coverage.reading_order_issues == 1
    assert [d.code for d in segmentation.diagnostics] == ["reading_order"]


def test_segmenting_twice_gives_the_same_artifact(tmp_path):
    evidence = load(catalogue.write("numbering", tmp_path))
    assert segment(evidence, RECIPE) == segment(evidence, RECIPE)


# --- the artifact --------------------------------------------------------------------------------------------------

def test_a_published_artifact_loads_back_and_is_reused_without_recomputation(tmp_path, monkeypatch):
    run = catalogue.write("continuations", tmp_path)
    evidence = load(run)
    first = obtain(run, evidence, RECIPE)
    monkeypatch.setattr(segmenter, "segment", lambda *_: pytest.fail("a valid artifact was recomputed"))
    assert obtain(run, evidence, RECIPE) == first
    assert load_segmentation(run, evidence, RECIPE) == first


@pytest.mark.parametrize("tamper", ["digest", "fingerprint", "span", "ownership", "disposition", "identity",
                                    "glossary", "ledger", "disposition_bounds", "disposition_segment"])
def test_an_invalid_artifact_is_refused(tmp_path, tamper):
    run = catalogue.write("continuations", tmp_path)
    evidence = load(run)
    path = publish_segmentation(run, segment(evidence, RECIPE))
    data = json.loads(path.read_text(encoding="utf-8"))
    if tamper == "digest":
        data["blocks"][0]["entry_label"], data["blocks"][0]["entry_no"] = "39", 39
    elif tamper == "fingerprint":
        data["fingerprint"] = "0" * 64
    elif tamper == "span":
        data["blocks"][0]["primary_spans"][0]["end"] = 10_000
    elif tamper == "ownership":
        data["blocks"][1]["primary_spans"].append(data["blocks"][0]["primary_spans"][0])
    elif tamper == "identity":
        data["blocks"][1].update(entry_label=data["blocks"][0]["entry_label"], entry_no=data["blocks"][0]["entry_no"])
    elif tamper == "glossary":
        data["glossary"].append({"key": "B", "expansion": "Bezirk", "key_span": {"segment_id": "p1_s0", "start": 0,
                                 "end": 1}, "expansion_span": {"segment_id": "p1_s0", "start": 2, "end": 9999}})
    elif tamper == "ledger":  # the block claims less of its first line than the ledger gives it
        data["blocks"][0]["primary_spans"][0]["end"] = data["blocks"][0]["primary_spans"][0]["start"] + 2
    elif tamper == "disposition_bounds":
        next(d for d in data["dispositions"] if d["role"] == "entry")["end"] = 9999
    elif tamper == "disposition_segment":
        next(d for d in data["dispositions"] if d["role"] == "entry")["segment_id"] = "p9_s9"
    else:
        data["dispositions"].pop()
    if tamper != "digest":  # every other tamper keeps a self-consistent digest, so only the deeper checks can catch it
        from kei_exp.kie.segmentation import namespace_digest
        data["digest"] = namespace_digest(data)
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(SegmentationInvalid):
        load_segmentation(run, evidence, RECIPE)
    assert obtain(run, evidence, RECIPE) == segment(evidence, RECIPE)  # refused, so recomputed rather than crashing


def test_an_artifact_of_another_generation_is_refused_and_recomputed(tmp_path):
    run = catalogue.write("continuations", tmp_path)
    obtain(run, load(run), RECIPE)
    rerun = catalogue.write("continuations", tmp_path, generation="20260924T000000.000000Z-fixture1")
    evidence = load(rerun)
    with pytest.raises(SegmentationInvalid):
        load_segmentation(rerun, evidence, RECIPE)
    assert obtain(rerun, evidence, RECIPE).generation == "20260924T000000.000000Z-fixture1"
