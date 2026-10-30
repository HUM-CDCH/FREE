"""Defaults 6, the single pass: the entry call is the only reading of a value. Code grounds it; nothing reads it again.

A located value is accepted as code's link (`lexical`), never called verified; a value whose quote is missing or found
nowhere stays in the record without Evidence; a located quote that does not print its value still rejects it. The
durable tests drive the real planner and `retained.publish_final` with the in-memory lease.
"""
import json
import re

import pytest

from kei_exp.kie.extract import run, unified
from tests import test_unified_catalog as catalog
from tests.test_durable_extraction import MemoryLease, finish, linked_while_running
from tests.test_extract_grounded import CountingChat
from tests.test_unified_catalog import NOTES, START, Model, candidate, evidence, extract, fields, noted


def entry_system(chat) -> str:
    return next(call["system"] for call in chat.calls if call["system"].startswith("You extract structured data"))


def test_a_single_pass_accepts_what_a_supporting_verifier_accepts_without_asking_one():
    source = evidence("1. Hill. Material: gold. Gilded. Find: bead (2) Find: cup (1)", "2. Valley. Material: flint.")
    single, chat = extract(source, defaults=6)
    verified, _ = extract(source, defaults=6, verification=True)  # verdicts on the same fixed candidates
    assert single["records"] == verified["records"]
    assert single["records"][0]["finds"] == [{"name": "bead", "count": 2}, {"name": "cup", "count": 1}]
    assert [(link["path"], link["spans"], link["support"], link["item"]) for link in single["evidence"]] == \
        [(link["path"], link["spans"], link["support"], link["item"]) for link in verified["evidence"]]
    assert {link["linked_by"] for link in single["evidence"]} == {"lexical"}
    assert {link["linked_by"] for link in verified["evidence"]} == {"verification"}
    assert {call["stage"] for call in single["calls"]} == {"discovery", "entry", "document"}
    assert "verification" in {call["stage"] for call in verified["calls"]}
    assert single["processing"]["verification"] == {"enabled": False, "undecided": 0}
    structure = json.dumps(unified.json_schema(unified.Schema.model_validate(catalog.SCHEMA).record_nodes),
                           ensure_ascii=False, separators=(",", ":"))
    assert entry_system(chat).endswith("before adding the value/evidence wrappers:\n" + structure)
    assert single["execution"]["prompt_version"] == 7 and single["execution"]["effective"]["single_pass"] is True


@pytest.mark.parametrize(("defaults", "prompt_version"), [(1, 5), (4, 5), (5, 6)])
def test_earlier_defaults_keep_their_prompts_and_execution_record(defaults, prompt_version):
    source = evidence("1. Hill. Material: gold.")
    result, chat = extract(source, defaults=defaults)
    assert result["execution"]["prompt_version"] == prompt_version
    assert "single_pass" not in result["execution"]["effective"]
    assert "Requested value structure" not in entry_system(chat)
    assert {link["linked_by"] for link in result["evidence"]} == {"verification"}


def test_a_value_whose_quote_is_missing_or_found_nowhere_stays_in_the_record_without_evidence():
    source = evidence("1. Hill. Material: gold. Find: bead (2) Find: cup (1) Find: lid (3)")

    def entry(record, user, schema):
        answer = fields(record, user, schema)
        answer["site"] = candidate("Hill", "")                      # no quote
        answer["material"] = candidate("gold", "Material: golden")  # a quote found nowhere
        bead, cup, lid = answer["finds"]
        cup["count"] = candidate(1, "(one)")                        # one leaf of an item
        lid.update({"name": candidate("lid", "a lid"), "count": candidate(3, "three"), unified.ITEM: None})
        return answer
    result, _ = extract(source, Model(source, entry=entry), defaults=6)
    record = result["records"][0]
    assert (record["site"], record["material"]) == ("Hill", "gold")
    assert record["finds"] == [{"name": "bead", "count": 2}, {"name": "cup", "count": 1}, {"name": "lid", "count": 3}]
    linked = sorted(tuple(link["path"][2:]) for link in result["evidence"])
    assert linked == [("finds", 0, "count"), ("finds", 0, "name"), ("finds", 1, "name"), ("label",)]
    assert sorted((tuple(each["path"][2:]), each["reason"]) for each in result["proposed"]) == [
        (("finds", 1, "count"), "quote_not_in_source"), (("finds", 2, "count"), "quote_not_in_source"),
        (("finds", 2, "name"), "quote_not_in_source"), (("material",), "quote_not_in_source"),
        (("site",), "no_quote")]
    assert not result["rejected"] and result["completeness"]["evidence"] is False


@pytest.mark.parametrize(("text", "answer"), [
    ("1. Adorf. Fund in Bdorf.", noted(None, site=candidate("Cdorf", "Fund in Cdorf"))),
    ("1. Adorf. 26 Stück.", noted(None, count=candidate(27, "27 Stück"))),
])
def test_a_misquoted_value_is_kept_for_review_never_repaired_or_linked(text, answer):
    """Code cannot tell a misread value from a misquoted one: it stays the record's, an ungrounded proposal."""
    source = evidence(text)
    result, _ = extract(source, Model(source, entry=answer), schema=NOTES, defaults=6)
    (proposal,) = result["proposed"]
    assert result["records"][0][proposal["path"][2]] == proposal["value"] and proposal["reason"] == "quote_not_in_source"
    assert not result["evidence"] and not [i for i in result["issues"] if i["code"] == "quote_repaired"]


def test_text_copied_nearly_verbatim_is_still_the_source_text_linked_by_code():
    near = catalog.PARAGRAPH.replace("pale ", "")
    source = evidence(f"1. Adorf. {catalog.PARAGRAPH}")
    result, _ = extract(source, Model(source, entry=noted(candidate(near, near))), schema=NOTES, defaults=6)
    assert result["records"][0]["notes"] == catalog.PARAGRAPH
    (link,) = result["evidence"]
    assert link["raw"] == catalog.PARAGRAPH and link["linked_by"] == "lexical"
    assert [issue["code"] for issue in result["issues"]] == ["quote_repaired"]


def test_a_located_quote_that_does_not_print_its_value_still_rejects_it():
    """A value of another row, quoted with this row's text: the record never takes it, with or without Evidence."""
    source = evidence("1. Adorf. Material: Holz.\n2. Bdorf. Material: Stein.")
    result, _ = extract(source, Model(source, entry=lambda record, user, schema: {
        **fields(record, user, schema), "material": candidate("Stein", "Material: Holz") if "Adorf" in record
        else fields(record, user, schema)["material"]}), defaults=6)
    assert [record["material"] for record in result["records"]] == [None, "Stein"]
    assert [(row["path"], row["reason"]) for row in result["rejected"]] == [
        (["records", 0, "material"], "value_not_in_quote")]


def test_a_field_whose_policy_asks_no_quote_keeps_its_list_values():
    schema = {"recordDescription": "One entry.", "schemaNodes": [
        {"id": "f", "name": "finds", "type": "array", "children": [
            {"id": "fn", "name": "name", "type": "string"},
            {"id": "fc", "name": "count", "type": "integer", "evidencePolicy": "unverified"}]}]}
    source = evidence("1. Hill. Find: bead (2) Find: cup (1)")
    result, _ = extract(source, schema=schema, defaults=6)
    assert result["records"][0]["finds"] == [{"name": "bead", "count": 2}, {"name": "cup", "count": 1}]
    assert {tuple(link["path"][2:]) for link in result["evidence"]} == {("finds", 0, "name"), ("finds", 1, "name")}
    assert {each["reason"] for each in result["proposed"]} == {"evidence_policy_unverified"}


def test_disagreeing_located_readings_still_go_to_one_arbitration_that_names_them_located():
    lines = "1. Adorf. Material: Holz. " + " ".join(["Text"] * 700) + " Material: Stein."
    source = evidence(lines)

    def entry(record, user, schema):
        answer = fields(record, user, schema)
        if material := re.findall(r"Material: (\w+)", record):
            answer["material"] = candidate(material[-1], f"Material: {material[-1]}")
        return answer
    settings = {"defaults": 6, "input_tokens": 520, "output_tokens": 64}
    chosen, chat = extract(source, Model(source, entry=entry, choice="C2"), **settings)
    assert chosen["records"][0]["material"] == "Stein" and chosen["competitors"][0]["outcome"] == "arbitrated"
    (asked,) = [call["system"] for call in chat.calls if call["system"].startswith("Several ")]
    assert asked.startswith("Several candidate values, each located in the record's text") and "verified" not in asked
    undecided, _ = extract(source, Model(source, entry=entry, choice="NONE"), **settings)
    assert undecided["records"][0]["material"] is None and undecided["competitors"][0]["outcome"] == "unresolved"
    assert {each["reason"] for each in undecided["proposed"]} == {"competing_value"}


# Table rows, repeated values and list items are grounded by the same code: with a single pass, these scenarios of
# the unified Catalog's tests (written for a verifier that supports every located candidate) hold unchanged.
SAME_AS_A_SUPPORTING_VERIFIER = [
    (catalog.test_a_dense_table_gives_one_entry_per_row_and_each_value_its_own_cell, {}),
    *[(catalog.test_list_items_locate_repeated_partial_quotes_in_their_own_table_rows, {"item_text": text})
      for text in (lambda number: number, lambda number: None, lambda number: "Bone fragments, probably tibia")],
    (catalog.test_an_item_whose_values_name_different_rows_is_no_row, {}),
    (catalog.test_a_value_also_printed_in_a_merged_cell_names_no_row, {}),
    (catalog.test_a_table_item_value_can_continue_verbatim_into_the_next_page, {}),
    (catalog.test_a_value_in_the_quoted_table_row_is_literal_in_its_own_cell, {}),
    (catalog.test_a_merged_cell_never_widens_the_quoted_row_to_the_rows_it_spans, {}),
    (catalog.test_the_row_rule_applies_only_to_a_quote_found_in_one_place, {}),
    (catalog.test_a_list_item_value_printed_in_several_items_is_its_own_items, {}),
    (catalog.test_an_item_whose_value_is_also_printed_at_a_window_cut_is_kept_whole, {}),
    (catalog.test_an_item_seen_whole_by_two_windows_under_overlap_is_one_item, {}),
    (catalog.test_without_overlap_an_item_at_a_cut_stays_a_partial_proposal, {}),
]


@pytest.mark.parametrize(("case", "arguments"), SAME_AS_A_SUPPORTING_VERIFIER,
                         ids=[f"{case.__name__}-{n}" for n, (case, _) in enumerate(SAME_AS_A_SUPPORTING_VERIFIER)])
def test_a_single_pass_grounds_rows_and_items_as_before(case, arguments, monkeypatch):
    original = catalog.request
    monkeypatch.setattr(catalog, "request", lambda schema=catalog.SCHEMA, start_page=None, **settings:
                        original(schema, start_page, **{"defaults": 6, **settings}))
    extracted = catalog.extract

    def single(*args, **kwargs):
        result, chat = extracted(*args, **kwargs)
        assert result["execution"]["method"]["defaults"] == 6
        assert not [call for call in result["calls"] if call["stage"] == "verification"]
        return result, chat
    monkeypatch.setattr(catalog, "extract", single)
    case(**arguments)


# --- durable publication -------------------------------------------------------------------------------------------

NESTED = {"recordDescription": "One numbered catalogue entry.", "schemaNodes": [
    {"id": "label", "name": "label", "type": "string"},
    {"id": "finds", "name": "finds", "type": "array", "children": [
        {"id": "name", "name": "name", "type": "string"},
        {"id": "parts", "name": "parts", "type": "array", "children": [{"id": "part", "name": "part", "type": "string"}]}]},
    {"id": "tags", "name": "tags", "type": "array", "itemType": "string"}]}
NESTED_SOURCE = ("1. Hill. Find: bowl with rim, foot; Find: cup with handle; Tags: red, fine.",
                 "2. Valley. Find: pin with head; Tags: plain.")


def nested(record, user, schema):
    label = START.match(record)[1]
    finds = [{"name": candidate(m[1], m[1]), unified.ITEM: m[0],
              "parts": [{"part": candidate(part, part), unified.ITEM: None} for part in m[2].split(", ")]}
             for m in re.finditer(r"Find: (\w+) with ([\w, ]+);", record)]
    tags = [candidate(tag, tag) for tag in re.search(r"Tags: ([\w, ]+)\.", record)[1].split(", ")]
    return {"label": candidate(label.rstrip("."), label), "finds": finds, "tags": tags}


def published(defaults, **settings):
    """The durable run's values as its final publication saved them, by (record, field)."""
    source = evidence(*NESTED_SOURCE)
    request = catalog.request(NESTED, defaults=defaults, **settings)
    lease = MemoryLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
    chat = CountingChat(Model(source, entry=nested, verdict=lambda *_: pytest.fail("nothing verifies")))
    finish(lease, chat, lambda router, counter: run.dispatch(None, source, request, router, counter=counter))
    return {(value["path"][1], value["path"][2]): value for publication in lease.publications.values()
            if publication["coverage"].get("processingComplete") is True for value in publication["values"]}, lease


def test_a_single_pass_publishes_nested_and_repeating_lists_whole():
    final, lease = published(6)
    assert final[(0, "finds")]["modelValue"] == [{"name": "bowl", "parts": [{"part": "rim"}, {"part": "foot"}]},
                                                 {"name": "cup", "parts": [{"part": "handle"}]}]
    assert final[(0, "tags")]["modelValue"] == ["red", "fine"] and final[(1, "tags")]["modelValue"] == ["plain"]
    assert final[(1, "finds")]["modelValue"] == [{"name": "pin", "parts": [{"part": "head"}]}]
    assert (final[(0, "label")]["modelValue"], final[(0, "label")]["grounding"]) == ("1", "grounded")
    producers = [each["producer"] for value in final.values() for each in value["evidence"]]
    assert producers and {producer["linked_by"] for producer in producers} == {"lexical"}
    assert {tuple(producer["path"][2:]) for producer in producers if producer["path"][1] == 0} >= {
        ("finds", 0, "parts", 1, "part"), ("finds", 1, "name"), ("tags", 1)}
    running, settled = linked_while_running(lease)
    assert running and running.items() <= settled.items()


def test_verification_off_under_earlier_defaults_still_publishes_only_restored_scalars():
    """The fixed version 5 behaviour, which a single pass replaces: replays of older admissions do not change."""
    final, _ = published(5, verification=False)
    assert final[(0, "label")]["modelValue"] == "1" and final[(0, "label")]["grounding"] == "ungrounded"
    assert final[(0, "finds")]["modelValue"] is None and final[(0, "tags")]["modelValue"] is None


def test_a_single_pass_shows_final_values_while_discovery_still_reads_later_windows():
    """Pipelined: an entry the windows already read is published with its Evidence before every record is planned."""
    source = evidence(*[f"{n}. Site{n}. " + "Description " * 100 + f" Material: M{n}." for n in range(1, 11)])
    request = catalog.request(catalog.SCHEMA, defaults=6, input_tokens=1000, output_tokens=256)
    lease = MemoryLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
    events, call = [], lease.call

    def logged(name, *args):
        if name == "publish_plan":
            events.append(("plan", args[1].split(":")[0]))
        if name == "publish_snapshot" and any(value["evidence"] for value in args[2]):
            events.append(("linked", args[3].get("processingComplete")))
        return call(name, *args)
    lease.call = logged
    result = finish(lease, CountingChat(Model(source)), lambda router, counter: run.dispatch(
        None, source, request, router, counter=counter))
    assert [record["material"] for record in result["records"]] == [f"M{n}" for n in range(1, 11)]
    assert ("plan", "unified-prefix") in events
    assert events.index(("linked", False)) < events.index(("plan", "unified-records"))
