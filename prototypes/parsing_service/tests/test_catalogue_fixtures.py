"""The acceptance-matrix fixtures are real canonical results, and their expected boundaries are source text.

These checks keep the fixtures honest before any segmenter reads them: every file is written with the hashes the
service verifies, and every expected primary span is text that actually occurs at a line boundary of one of the
fixture's segments, so a boundary can never be satisfied by text the source does not contain.
"""
import pytest

from kei_exp.kie.extract.evidence import load
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract.stages import discover
from tests.helpers import catalogue
from tests.helpers.chat import FakeChat


@pytest.mark.parametrize("name", catalogue.names())
def test_every_fixture_is_a_verified_canonical_result(name, tmp_path):
    evidence = load(catalogue.write(name, tmp_path))
    assert evidence.generation == catalogue.GENERATION
    assert evidence.passages, "a fixture without passages exercises nothing"


def source_lines(evidence) -> list[tuple[str, int, int]]:
    """Every non-blank line of every segment the view holds, withheld ones included, as (segment, start, end)."""
    lines = []
    for passage in (*evidence.passages, *evidence.withheld):
        position = 0
        for raw in passage.text.split("\n"):
            start, end = position + len(raw) - len(raw.lstrip()), position + len(raw.rstrip())
            if end > start:
                lines.append((passage.id, start, end))
            position += len(raw) + 1
    return sorted(lines)


@pytest.mark.parametrize("name", catalogue.names())
def test_expected_lines_are_exact_source_intervals_accounting_for_every_line_once(name, tmp_path):
    """Each expectation names its segment and code-point offsets and repeats the text as a readable assertion; the
    set of expected lines is exactly the source's non-blank lines, so no line can be owned twice or forgotten."""
    evidence = load(catalogue.write(name, tmp_path))
    texts = {passage.id: passage.text for passage in (*evidence.passages, *evidence.withheld)}
    expected = catalogue.fixture(name)["expected"]
    for segment, start, end, role, detail, text in expected["lines"]:
        assert texts[segment][start:end] == text, f"{name}: {segment}[{start}:{end}] is not {text!r}"
        assert role in ("entry", "heading", "glossary", "reference", "figure", "excluded", "unresolved"), role
    assert sorted((line[0], line[1], line[2]) for line in expected["lines"]) == source_lines(evidence), name
    labels = [block["label"] for block in expected["blocks"]]
    owners = [detail for _, _, _, role, detail, _ in expected["lines"] if role == "entry"]
    assert sorted(set(owners)) == sorted(labels) and len(set(labels)) == len(labels), name


SCHEMA = Schema.model_validate({"recordDescription": "One numbered catalogue entry.",
                                "schemaNodes": [{"id": "site", "name": "site", "type": "string"}]})


def test_baseline_model_discovery_cannot_split_two_entries_inside_one_segment(tmp_path):
    """Recorded limitation of the generic discovery path (plan M0): labels name whole segments, so even a model
    that names every label as a start leaves entries 31 and 32 in one record slice."""
    evidence = load(catalogue.write("two-in-one-segment", tmp_path))
    everything = FakeChat(lambda system, user, schema: {"starts": schema["properties"]["starts"]["items"]["enum"],
                                                        "end": None})
    slices, _, _ = discover(evidence, SCHEMA, everything, budget=48_000)
    both = [group for group in slices if any("31. Eichdorf" in p.text and "32. Birkenau" in p.text for p in group)]
    assert len(both) == 1, "the same-segment limitation no longer reproduces: update the plan's baseline"
