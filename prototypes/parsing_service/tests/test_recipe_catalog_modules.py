"""The recipe Catalog's model-free modules, exercised through their public names without a chat: candidate
acceptance over an entry's text, windows over an entry's units under a `fits` predicate, and the artifact's shapes
from outcomes."""
from kei_exp.kie.extract.acceptance import Outcome, assess, bounded, typed_value
from kei_exp.kie.extract.catalog_result import (
    conformed_record,
    evidence_link,
    glossary_expansions,
    place,
    review_item,
    spans_json,
)
from kei_exp.kie.extract.locate import BlockText
from kei_exp.kie.extract.schema import Node, Schema
from kei_exp.kie.extract.windows import units_of, windows_of
from kei_exp.kie.model import Block, GlossaryEntry, Span
from tests.test_extract_stages import passages

ENTRY = "7. Adorf. Fdpl. 2. Mbl. 1827. FA: G. Urne."
VIEW = BlockText.of([("s1", ENTRY, Span(segment_id="s1", start=0, end=len(ENTRY)))])
SHEET = Node(id="m", name="mbl_old", type="integer")


def candidate(value, quote, key=None, provenance="positional"):
    return {"value": value, "quote": quote, "key": key, "provenance": provenance}


def verdict(node, answer, keys=None, **options) -> list[tuple]:
    return [(outcome.kind, outcome.reason, outcome.value)
            for outcome in assess(("records", 0, node.name), node, answer, VIEW, keys, **options)]


def test_a_candidate_is_accepted_only_where_its_quote_holds_its_value_and_a_key_introduces_it():
    (keyed,) = assess(("records", 0, "mbl_old"), SHEET, candidate(1827, "Mbl. 1827", "Mbl.", "token"), VIEW, ["Mbl."])
    assert (keyed.kind, keyed.linked_by, keyed.provenance) == ("accepted", "key", "token")
    assert [ENTRY[span.start:span.end] for span in keyed.spans] == ["1827"]
    assert [ENTRY[span.start:span.end] for span in keyed.key_spans] == ["Mbl."]
    assert verdict(SHEET, candidate(1827, "Mbl. 1827")) == [("proposed", None, 1827)]  # no key rule for the field
    assert verdict(SHEET, candidate(2, "Fdpl. 2"), ["Mbl."]) == [("rejected", "key_context_missing", 2)]
    assert verdict(SHEET, candidate(1828, "Mbl. 1828"), ["Mbl."]) == [("rejected", "quote_not_in_entry", 1828)]
    assert verdict(SHEET, candidate(1828, "Mbl. 1827"), ["Mbl."]) == [("rejected", "value_not_in_quote", 1828)]
    assert verdict(SHEET, candidate("Adorf", "Adorf")) == [("rejected", "type_mismatch", "Adorf")]
    assert verdict(SHEET, candidate(1827, " ")) == [("rejected", "no_quote", 1827)]
    assert verdict(SHEET, "1827") == [("rejected", "malformed_candidate", "1827")]
    assert verdict(SHEET, candidate(1828, "anything"), ["Mbl."], verify=False) == [
        ("proposed", "verification_disabled", 1828)]
    assert verdict(SHEET, None) == []


def test_a_yes_or_no_is_proposed_on_its_quote_and_array_items_are_assessed_one_by_one():
    urn = Node(id="u", name="urn", type="boolean")
    assert verdict(urn, candidate(True, "Urne")) == [("proposed", None, True)]
    finds = Node(id="f", name="finds", type="array", itemType="string")
    outcomes = assess(("records", 0, "finds"), finds, [candidate("Urne", "Urne"), candidate("Beil", "Beil")], VIEW,
                      None)
    assert [(outcome.path, outcome.kind, outcome.reason) for outcome in outcomes] == [
        (("records", 0, "finds", 0), "proposed", None), (("records", 0, "finds", 1), "rejected", "quote_not_in_entry")]
    assert (typed_value("1,5", Node(id="d", name="depth", type="number")), typed_value(True, SHEET)) == (1.5, None)
    assert bounded("FA:", ENTRY) == [ENTRY.index("FA:")] and bounded("dorf", ENTRY) == []


def lines(text: str) -> tuple[list, dict]:
    block = Block(id="b1", entry_label="1", entry_no=1, entry_suffix="", continuation=False,
                  primary_spans=[Span(segment_id="s", start=0, end=len(text))])
    return units_of(block, {"s": text}), {"s": text}


def words_at_most(limit: int, texts: dict):
    return lambda window: sum(len(texts[unit.segment][unit.start:unit.end].split()) for unit in window) <= limit


def shown(windows: list, texts: dict) -> list[list[str]]:
    return [[texts[unit.segment][unit.start:unit.end] for unit in window] for window in windows]


def test_windows_fit_the_predicate_and_overlap_by_one_unit_only_when_asked():
    units, texts = lines("one\n  two \nthree\n\nfour\nfive")
    assert shown([units], texts) == [["one", "two", "three", "four", "five"]]  # source lines, trimmed, blanks dropped
    assert shown(windows_of(units, texts, words_at_most(2, texts), overlap=True), texts) == [
        ["one", "two"], ["two", "three"], ["three", "four"], ["four", "five"]]
    assert shown(windows_of(units, texts, words_at_most(2, texts), overlap=False), texts) == [
        ["one", "two"], ["three", "four"], ["five"]]


def test_a_line_too_long_for_any_window_is_cut_at_whitespace_and_nothing_fits_means_no_windows():
    units, texts = lines("epsilon zeta eta")
    windows = windows_of(units, texts, words_at_most(2, texts), overlap=True)
    assert shown(windows, texts) == [["epsilon zeta"], ["eta"]]
    assert windows_of(units, texts, lambda window: False, overlap=True) is None


def test_accepted_outcomes_fill_the_record_and_link_their_evidence_with_the_glossary_expansion():
    glossary_text, entry = "G. — Grab\nS. — Siedlung\nS — Scherbe", "7. Adorf. FA: G."
    glossary, text = passages([glossary_text, entry])
    texts = {glossary.id: glossary, text.id: text}
    entries = [GlossaryEntry(key=key, expansion=expansion,
                             key_span=Span(segment_id=glossary.id, start=start, end=start + len(key)),
                             expansion_span=Span(segment_id=glossary.id, start=at, end=at + len(expansion)))
               for key, expansion, start, at in [("G.", "Grab", 0, 5), ("S.", "Siedlung", 10, 15),
                                                 ("S", "Scherbe", 24, 28)]]
    expansions = glossary_expansions(entries)
    assert list(expansions) == ["G"]  # `S.` and `S` would expand two ways
    start = entry.index("G.")
    fundart = Outcome("accepted", ("records", 0, "fundart"), "G", spans=[Span(segment_id=text.id, start=start,
                      end=start + 1)], linked_by="key", provenance="token")
    link = evidence_link(fundart, texts, expansions)
    assert (link["segment"], link["raw"], link["hits"], link["cell"]) == (text.id, "G", 1, None)
    assert link["spans"] == spans_json(fundart.spans) == [{"segment": text.id, "start": start, "end": start + 1}]
    assert link["normalized"]["value"] == "Grab" and link["normalized"]["key_span"]["end"] == 2

    schema = Schema.model_validate({"recordDescription": "An entry.", "schemaNodes": [
        {"id": "f", "name": "fundart", "type": "string"},
        {"id": "i", "name": "finds", "type": "array", "itemType": "string"},
        {"id": "p", "name": "place", "type": "object", "children": [{"id": "q", "name": "parish", "type": "string"}]},
        {"id": "s", "name": "site_name", "type": "string"}]})
    record: dict = {}
    for path, value in [(("fundart",), "G"), (("finds", 1), "Urne"), (("place", "parish"), "Adorf")]:
        place(record, path, value)
    assert record == {"fundart": "G", "finds": [None, "Urne"], "place": {"parish": "Adorf"}}
    assert conformed_record(schema, record) == {"fundart": "G", "finds": ["Urne"], "place": {"parish": "Adorf"},
                                                "site_name": None}


def test_proposed_and_rejected_outcomes_become_review_items():
    (text,) = passages(["7. Adorf. FA: G."])
    proposed = Outcome("proposed", ("records", 0, "site_name"), "Adorf", quote="Adorf", provenance="positional",
                       spans=[Span(segment_id=text.id, start=3, end=8)], window=1)
    rejected = Outcome("rejected", ("records", 0, "fundart"), "Siedl.", quote="FA: Siedl.", reason="quote_not_in_entry")
    assert review_item(proposed, {text.id: text}) == {
        "path": ["records", 0, "site_name"], "value": "Adorf", "quote": "Adorf", "key": None,
        "provenance": "positional", "spans": [{"segment": text.id, "start": 3, "end": 8}], "alternatives": [],
        "window": 1, "raw": "Adorf"}
    item = review_item(rejected, {text.id: text})
    assert item["reason"] == "quote_not_in_entry" and "raw" not in item and item["spans"] == []
