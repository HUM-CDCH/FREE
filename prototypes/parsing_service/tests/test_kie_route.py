"""The ordered view as a segmenter reads it: recipe, source lines, duplicate observations and line routing.

Everything here is a pure function of the canonical result and a recipe: no model, no file written. Routing decides
what each line *is* by recipe syntax and parser hints (a section heading, a heading event, a start candidate, a
running head, glossary or bibliography material); which candidates become entries is the segmenter's decision.
"""
import pytest

from kei_exp.kie.extract.evidence import load
from kei_exp.kie.recipe import Recipe, RecipeError, load_recipe
from kei_exp.kie.stages.layout import Duplicates, duplicate_observations, lines
from kei_exp.kie.stages.route import route
from tests.helpers import catalogue

RECIPE = "numbered-catalogue-de@1"


def routed(name, tmp_path):
    evidence = load(catalogue.write(name, tmp_path))
    return evidence, route(evidence, load_recipe(RECIPE))


# --- recipe --------------------------------------------------------------------------------------------------------

def test_the_recipe_loads_by_id_and_version_with_separate_structure_and_binding_digests():
    recipe = load_recipe(RECIPE)
    assert (recipe.id, recipe.version) == ("numbered-catalogue-de", 1)
    assert len(recipe.structure_sha256) == 64 and len(recipe.bindings_sha256) == 64
    assert recipe.structure_sha256 != recipe.bindings_sha256
    changed = recipe.model_copy(update={"bindings": recipe.bindings.model_copy(update={"entry_label": ["Nr"]})})
    assert changed.structure_sha256 == recipe.structure_sha256 != "" and changed.bindings_sha256 != recipe.bindings_sha256


@pytest.mark.parametrize("ref", ["numbered-catalogue-de@2", "numbered-catalogue-de", "../etc@1", "unknown@1"])
def test_an_unknown_or_malformed_recipe_reference_is_refused(ref):
    with pytest.raises(RecipeError):
        load_recipe(ref)


def _variant(**structure) -> dict:
    data = load_recipe(RECIPE).model_dump()
    data["structure"].update(structure)
    return data


@pytest.mark.parametrize("data, message", [
    (_variant(entry_marker=r"\d+\."), "number"),
    (_variant(entry_marker=r"(?P<number>\d+"), "entry_marker"),
    (_variant(headings=[{"kind": "kreis", "level": 1, "pattern": r"Kreis\s+\S.*", "max_chars": 60}]), "value"),
    (_variant(headings=[{"kind": "kreis", "level": 1, "pattern": r"Kreis\s+(?P<value>\S.*)", "max_chars": 60},
                        {"kind": "kreis", "level": 2, "pattern": r"Kr\.\s+(?P<value>\S.*)", "max_chars": 60}]), "level"),
])
def test_a_recipe_whose_patterns_cannot_do_their_job_is_refused(data, message):
    with pytest.raises(ValueError, match=message):
        Recipe.model_validate(data)


def test_a_binding_to_a_heading_kind_the_structure_lacks_is_refused():
    data = load_recipe(RECIPE).model_dump()
    data["bindings"]["headings"]["gemeinde"] = ["Gemeinde"]
    with pytest.raises(ValueError, match="gemeinde"):
        Recipe.model_validate(data)


# --- lines ---------------------------------------------------------------------------------------------------------

def test_lines_keep_raw_code_point_offsets_and_skip_blank_ones(tmp_path):
    evidence = load(catalogue.write("normalization", tmp_path))
    found = [(line.segment, line.start, line.end, line.whole) for line in lines(evidence.passages)]
    assert found == [("p1_s0", 0, 11, True), ("p1_s1", 0, 59, False), ("p1_s1", 60, 88, False)]
    text = evidence.by_id("p1_s1").text
    assert [line.text for line in lines(evidence.passages)][1:] == [text[0:59], text[60:88]]


# --- duplicate observations ----------------------------------------------------------------------------------------

def test_a_mutually_unique_seam_pair_marks_the_later_observation_and_keeps_repeated_text(tmp_path):
    evidence = load(catalogue.write("duplicate-observation", tmp_path))
    found = duplicate_observations(evidence.passages)
    assert found.excluded == {"p1_s2": "p1_s1"} and found.potential == []


def test_an_ambiguous_match_excludes_nothing_and_reports_the_whole_component(tmp_path):
    evidence = load(catalogue.write("duplicate-ambiguous", tmp_path))
    found = duplicate_observations(evidence.passages)
    assert found.excluded == {} and found.potential == [("p1_s1", "p1_s2", "p1_s3")]


def test_the_same_line_at_the_same_place_on_two_scanned_pages_is_two_observations(tmp_path):
    pages = [{"page": number, "units": [{"index": 0, "segments": ["Mus. Halle 12."]}]} for number in (1, 2)]
    evidence = load(catalogue.write({"pages": pages}, tmp_path))
    assert duplicate_observations(evidence.passages) == Duplicates({}, [])


# --- routing -------------------------------------------------------------------------------------------------------

# What each final disposition in a fixture allows routing to have said about that line.
ALLOWED = {
    "entry": {"candidate", "content"},
    "reference": {"reference"},
    "glossary": {"glossary"},
}
EXCLUDED = {"furniture": "furniture", "duplicate_observation": "duplicate"}
UNRESOLVED = {"unclassified_heading": {"unclassified_heading", "hint"}, "scoped_identity_unsupported":
              {"series", "candidate", "content"}, "duplicate_identity": {"candidate", "content"},
              "ambiguous_start": {"candidate"}, "unnumbered_item": {"content"}}


@pytest.mark.parametrize("name", catalogue.names())
def test_routing_agrees_with_every_fixture_line(name, tmp_path):
    evidence, routing = routed(name, tmp_path)
    by_line = {(item.line.segment, item.line.start): item for item in routing.lines}
    assert len(by_line) == len(routing.lines) == len(catalogue.fixture(name)["expected"]["lines"])
    for segment, start, _end, role, detail, text in catalogue.fixture(name)["expected"]["lines"]:
        item = by_line[(segment, start)]
        where = f"{name} {segment}:{start} {text!r}"
        if role == "heading" and detail.startswith("section:"):
            assert (item.kind, item.region) == ("section", detail.removeprefix("section:")), where
        elif role == "heading":
            kind, value = detail.split(":", 1)
            assert item.kind == "heading" and item.heading.kind == kind, where
            value_span = item.heading.spans[0]
            assert evidence.by_id(value_span.segment_id).text[value_span.start:value_span.end] == value, where
        elif role == "excluded" and detail.startswith("region:"):
            assert (item.kind, item.region) == ("excluded_region", detail.removeprefix("region:")), where
        elif role == "excluded" and detail.startswith("segment_status:"):
            assert item.kind == "withheld", where
        elif role == "excluded":
            assert item.kind == EXCLUDED[detail], where
        elif role == "unresolved" and detail.startswith("orphan"):
            assert item.kind == "content", where
        elif role == "unresolved":
            assert item.kind in UNRESOLVED[detail], where
        else:
            assert item.kind in ALLOWED[role], where


def test_a_start_candidate_keeps_its_printed_label_and_marker_offsets(tmp_path):
    _, routing = routed("two-in-one-segment", tmp_path)
    candidates = [item for item in routing.lines if item.kind == "candidate"]
    assert [(item.line.segment, item.line.start, item.label, item.number, item.suffix) for item in candidates] == [
        ("p1_s2", 0, "31", 31, ""), ("p1_s2", 54, "32", 32, "")]
    _, suffixed = routed("numbering", tmp_path / "numbering")
    assert ("31a", 31, "a") in {(item.label, item.number, item.suffix) for item in suffixed.lines if item.label}


def test_a_long_sentence_beginning_like_a_heading_is_no_heading(tmp_path):
    _, routing = routed("hallucinated-heading", tmp_path)
    assert [item.kind for item in routing.lines] == ["heading", "content", "candidate"]
    assert [event.kind for event in routing.headings] == ["kreis"]


def test_headings_are_events_with_levels_ids_and_value_evidence(tmp_path):
    _, routing = routed("heading-labels", tmp_path)
    assert [(event.id, event.kind, event.level) for event in routing.headings] == [
        ("h1", "bezirk", 1), ("h2", "kreis", 2), ("h3", "kreis", 2), ("h4", "kreis", 2), ("h5", "kreis", 2),
        ("h6", "bezirk", 1)]
    assert routing.headings[0].text == "Bezirk Nord"


def test_a_heading_hint_is_reported_so_its_false_positives_can_be_inspected(tmp_path):
    _, routing = routed("heading-hint", tmp_path)
    assert [item.kind for item in routing.lines if item.line.segment == "p1_s3"] == ["hint"]
    assert [diagnostic.code for diagnostic in routing.diagnostics] == ["heading_hint"]
    assert routing.diagnostics[0].spans[0].segment_id == "p1_s3"


def test_the_glossary_is_parsed_once_into_key_and_expansion_spans(tmp_path):
    evidence, routing = routed("glossary", tmp_path)
    usable = {(entry.key, entry.expansion) for entry in routing.glossary}
    assert usable == {("Mbl.", "Meßtischblatt"), ("Fdpl.", "Fundplatz")}
    entry = next(entry for entry in routing.glossary if entry.key == "Mbl.")
    text = evidence.by_id(entry.key_span.segment_id).text
    assert text[entry.key_span.start:entry.key_span.end] == "Mbl."
    assert text[entry.expansion_span.start:entry.expansion_span.end] == "Meßtischblatt"
    assert sorted(diagnostic.code for diagnostic in routing.diagnostics) == [
        "glossary_ambiguous", "glossary_ambiguous", "glossary_malformed"]
