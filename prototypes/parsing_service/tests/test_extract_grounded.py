"""The grounded Catalog path: one bounded call per entry, candidates verified in code (design §8).

The model is scripted and answers from the entry text in its own prompt, as a real model would; the counter counts
words so budgets are easy to reason about. Structural fields (the printed label, inherited headings) never come
from the model; a field with a recipe key rule is accepted only where its key introduces the value; any other
quote-supported value is proposed, not accepted.
"""
import json
import re
from itertools import pairwise

import pytest

from kei_exp.kie.extract.grounded import EXTRACTION_VERSION
from kei_exp.kie.extract.llm import Reply
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.run import ExtractRequest, StaleGeneration, extract
from tests.helpers import catalogue
from tests.helpers.chat import FakeChat

SCHEMA = {"recordDescription": "One numbered entry of an archaeological catalogue.", "schemaNodes": [
    {"id": "n", "name": "entry_no", "type": "integer"},
    {"id": "s", "name": "site_name", "type": "string", "description": "the find place after the number"},
    {"id": "b", "name": "bezirk", "type": "string"},
    {"id": "k", "name": "kreis", "type": "string"},
    {"id": "m", "name": "mbl_old", "type": "integer", "description": "map sheet number after Mbl."},
    {"id": "f", "name": "fundart", "type": "string", "description": "find category after FA:"},
]}


class WordCounter:
    """Counts words plus a fixed template overhead: a stand-in with the served counter's interface."""
    template_tokens = 5
    context_tokens = 16_384

    def __init__(self):
        self.counted: list[int] = []
        self.schemas: list[dict | None] = []

    def request_tokens(self, system: str, user: str, schema: dict | None = None) -> int:
        count = len(system.split()) + len(user.split()) + self.template_tokens
        self.counted.append(count)
        self.schemas.append(schema)
        return count

    def identity(self) -> dict:
        return {"source": "words", "model": "fake/extractor", "model_digest": "w" * 64, "template_tokens": 5}


class CountingChat(FakeChat):
    """Reports the served input count an honest server would: the same words-plus-template the counter counts."""
    def complete(self, *, system, user, schema, max_tokens=None):
        reply = super().complete(system=system, user=user, schema=schema, max_tokens=max_tokens)
        if reply.input_tokens == 10:  # FakeChat's placeholder, not a scripted Reply
            reply = Reply(reply.text, len(system.split()) + len(user.split()) + WordCounter.template_tokens,
                          reply.output_tokens, reply.finish, reply.seconds)
        return reply


def entry_text(user: str) -> str:
    return user.split("### ENTRY\n", 1)[1].split("\n### END ENTRY", 1)[0]


def candidate(value, quote, key=None, provenance="positional"):
    return {"value": value, "quote": quote, "key": key, "provenance": provenance}


def honest(system, user, schema):
    """Reads the entry like a careful model: the site after the number, Mbl. and FA: after their keys."""
    text = entry_text(user)
    answer = {name: None for name in schema["properties"]}
    if (site := re.match(r"\d+[a-z]?\.\s+([^.,]+)", text)) and "site_name" in answer:
        answer["site_name"] = candidate(site[1], site[1])
    if (sheet := re.search(r"Mbl\. (\d+)", text)) and "mbl_old" in answer:
        answer["mbl_old"] = candidate(int(sheet[1]), f"Mbl. {sheet[1]}", "Mbl.", "token")
    if (kind := re.search(r"FA: ([A-Za-z]+)", text)) and "fundart" in answer:
        answer["fundart"] = candidate(kind[1], f"FA: {kind[1]}", "FA:", "token")
    return answer


def request(**catalog) -> ExtractRequest:
    return ExtractRequest.model_validate({"schema": SCHEMA, "options": {
        "strategy": "catalog", "catalog": {"recipe": "numbered-catalogue-de@1", **catalog}}})


def run(name, tmp_path, script=honest, counter=None, **catalog):
    run_dir = catalogue.write(name, tmp_path)
    chat = CountingChat(script)
    counter = counter or WordCounter()
    return extract(run_dir, request(**catalog), chat, counter=counter), chat, counter


def evidence_for(result, record, field):
    return [link for link in result["evidence"] if link["path"] == ["records", record, field]]


def test_two_entries_in_one_segment_become_two_grounded_records(tmp_path):
    result, chat, _ = run("two-in-one-segment", tmp_path)
    assert result["extraction_version"] == EXTRACTION_VERSION == 2
    assert [call["stage"] for call in result["calls"]] == ["entry", "entry"]
    first, second = result["records"]
    assert (first["entry_no"], first["mbl_old"], first["fundart"]) == (31, 1827, "G")
    assert (second["entry_no"], second["mbl_old"], second["fundart"]) == (32, 1828, "EF")
    assert [block["entry_label"] for block in result["record_blocks"]] == ["31", "32"]
    # Each call saw only its own entry.
    assert "32. Birkenau" not in entry_text(chat.calls[0]["user"]) and "31." not in entry_text(chat.calls[1]["user"])
    (sheet,) = evidence_for(result, 1, "mbl_old")
    assert sheet["segment"] == "p1_s2" and sheet["linked_by"] == "key" and sheet["key_spans"]
    text = "31. Eichdorf. Fdpl. 2. Mbl. 1827 (3436). FA: G. Urne.\n32. Birkenau. Fdpl. 1. Mbl. 1828. FA: EF. Axt."
    span = sheet["spans"][0]
    assert text[span["start"]:span["end"]] == "1828"


def test_inherited_fields_come_from_the_heading_with_its_evidence_never_from_the_model(tmp_path):
    result, chat, _ = run("headings", tmp_path)
    assert all("kreis" not in call["schema"]["properties"] for call in chat.calls[:2])
    first, second, third = result["records"][:3]
    assert (first["bezirk"], first["kreis"], second["kreis"]) == ("Nord", "Heide", "Moor")
    (kreis,) = evidence_for(result, 0, "kreis")
    assert kreis["segment"] == "p1_s1" and kreis["provenance"] == "inherited" and kreis["linked_by"] == "structure"
    assert kreis["heading"] is not None
    # Entry 3 sits under Bezirk Süd with no Kreis: the field is asked of the model and cannot be accepted from it.
    assert "kreis" in chat.calls[2]["schema"]["properties"] and third["kreis"] is None


def test_the_printed_label_is_bound_from_structure_with_its_span(tmp_path):
    result, _, _ = run("numbering", tmp_path)
    labels = [block["entry_label"] for block in result["record_blocks"]]
    assert labels == ["30", "31", "31a", "35"]
    assert [record["entry_no"] for record in result["records"]] == [30, 31, 31, 35]
    (label,) = evidence_for(result, 2, "entry_no")
    assert label["raw"] == "31" and label["linked_by"] == "structure"


def test_a_quote_supported_value_without_a_key_rule_is_proposed_not_accepted(tmp_path):
    result, _, _ = run("two-in-one-segment", tmp_path)
    assert result["records"][0]["site_name"] is None
    proposed = [item for item in result["proposed"] if item["path"] == ["records", 0, "site_name"]]
    assert proposed and proposed[0]["value"] == "Eichdorf" and proposed[0]["spans"][0]["segment"] == "p1_s2"


def test_a_value_its_key_does_not_introduce_is_rejected_even_if_the_word_occurs(tmp_path):
    """Same value in unrelated fields: "2" occurs (Fdpl. 2), but the map sheet's key introduces 1827."""
    def confused(system, user, schema):
        answer = honest(system, user, schema)
        answer["mbl_old"] = candidate(2, "Fdpl. 2", "Mbl.", "token")
        return answer
    result, _, _ = run("two-in-one-segment", tmp_path, confused)
    assert result["records"][0]["mbl_old"] is None
    rejected = [item for item in result["rejected"] if item["path"] == ["records", 0, "mbl_old"]]
    assert rejected and rejected[0]["reason"] == "key_context_missing"


def test_a_quote_the_entry_does_not_contain_is_rejected_and_kept_for_review(tmp_path):
    def invented(system, user, schema):
        answer = honest(system, user, schema)
        answer["fundart"] = candidate("Siedl.", "FA: Siedl.", "FA:", "token")
        return answer
    result, _, _ = run("two-in-one-segment", tmp_path, invented)
    assert result["records"][0]["fundart"] is None
    assert {item["reason"] for item in result["rejected"] if item["path"][-1] == "fundart"} == {"quote_not_in_entry"}
    assert result["completeness"]["grounding"] is True  # nothing unverified was accepted


def test_normalised_quotes_map_back_to_raw_spans(tmp_path):
    def reader(system, user, schema):
        answer = honest(system, user, schema)
        answer["site_name"] = candidate("Großenhain", "GROSSENHAIN")
        return answer
    result, _, _ = run("normalization", tmp_path, reader)
    assert result["records"][0]["mbl_old"] == 2457
    (proposal,) = [item for item in result["proposed"] if item["path"][-1] == "site_name"]
    assert proposal["raw"] == "Großenhain"


def test_every_call_fits_the_input_budget_and_an_oversized_entry_is_windowed(tmp_path):
    long = " ".join(f"Scherbe{n}" for n in range(300))
    case = {"pages": [{"page": 1, "units": [{"index": 1, "crops": [{"segments": [
        "Kreis Heide", "7. Adorf. Mbl. 1827. FA: G.", long, "Mbl. 1827 noch einmal.", "8. Bdorf. FA: EF."]}]}]}]}
    counter = WordCounter()
    run_dir = catalogue.write(case, tmp_path)
    chat = CountingChat(honest)
    result = extract(run_dir, request(input_tokens=260, output_tokens=64), chat, counter=counter)
    entry_calls = [call for call in result["calls"] if call["stage"] == "entry"]
    sent = [len(call["system"].split()) + len(call["user"].split()) + counter.template_tokens for call in chat.calls]
    assert len(entry_calls) > 2 and max(sent) <= 260  # trial counts while fitting may exceed; sent requests never
    assert all(call["max_tokens"] == 64 for call in chat.calls)
    assert result["records"][0]["mbl_old"] == 1827  # the same value in two windows is one value
    assert result["budget"]["input_tokens"] == 260 and result["budget"]["tokenizer"]["source"] == "words"


def test_disagreeing_windows_are_competitors_and_arbitration_may_choose_among_them_only(tmp_path):
    long = " ".join(f"Scherbe{n}" for n in range(300))
    case = {"pages": [{"page": 1, "units": [{"index": 1, "crops": [{"segments": [
        "7. Adorf. Mbl. 1827. FA: G.", long, "Mbl. 1828 nach anderer Angabe."]}]}]}]}

    def script(system, user, schema):
        if "### Candidates" in user:
            assert "1827" in user and "1828" in user
            return {"choice": "C2"}
        return honest(system, user, schema)
    run_dir = catalogue.write(case, tmp_path)
    result = extract(run_dir, request(input_tokens=260, output_tokens=64), CountingChat(script), counter=WordCounter())
    assert result["records"][0]["mbl_old"] == 1828
    (competition,) = result["competitors"]
    assert sorted(item["value"] for item in competition["candidates"]) == [1827, 1828]
    assert competition["outcome"] == "arbitrated" and result["calls"][-1]["stage"] == "arbitration"


def test_entries_are_read_by_the_fields_model_and_arbitration_by_the_reasoning_model_each_counted_on_its_server(
        tmp_path):
    long = " ".join(f"Scherbe{n}" for n in range(300))
    case = {"pages": [{"page": 1, "units": [{"index": 1, "crops": [{"segments": [
        "7. Adorf. Mbl. 1827. FA: G.", long, "Mbl. 1828 nach anderer Angabe."]}]}]}]}
    reader, judge = CountingChat(honest), CountingChat(lambda system, user, schema: {"choice": "C2"})
    reader.model, judge.model = "numind/NuExtract3-FP8", "Qwen/Qwen3.8-27B-FP8"
    counters = {"fields": WordCounter(), "reasoning": type("Other", (WordCounter,), {
        "identity": lambda self: {"source": "other", "model": "Qwen/Qwen3.8-27B-FP8", "model_digest": None,
                                  "template_tokens": None}})()}
    run_dir = catalogue.write(case, tmp_path)
    result = extract(run_dir, request(input_tokens=260, output_tokens=64), Router(fields=reader, reasoning=judge),
                     counter=counters)
    stages = [call["stage"] for call in result["calls"]]
    assert "arbitration" in stages and len(judge.calls) == stages.count("arbitration") == 1
    assert len(reader.calls) == stages.count("entry") + stages.count("document")
    assert len(counters["reasoning"].counted) == 1 and all(counters["fields"].schemas)  # counted with its template
    assert result["records"][0]["mbl_old"] == 1828
    assert result["model"] == "numind/NuExtract3-FP8"
    assert result["models"] == {"fields": "numind/NuExtract3-FP8", "reasoning": "Qwen/Qwen3.8-27B-FP8"}
    assert result["budget"]["tokenizer"]["source"] == "words"  # the fields model's, for a client reading one
    assert result["budget"]["tokenizers"]["reasoning"]["source"] == "other"


def test_a_schema_that_alone_exceeds_the_budget_is_refused_before_any_call(tmp_path):
    result, chat, _ = run("two-in-one-segment", tmp_path, input_tokens=520, output_tokens=64,
                          counter=type("Huge", (WordCounter,), {"template_tokens": 600})())
    assert chat.calls == [] and result["records"] == []
    assert [issue["code"] for issue in result["issues"]] == ["schema_exceeds_budget"]
    assert result["complete"] is False and result["completeness"]["processing"] is False


def test_a_server_that_reports_no_context_size_is_refused_before_any_call(tmp_path):
    result, chat, _ = run("two-in-one-segment", tmp_path, counter=type("Unknown", (WordCounter,),
                                                                        {"context_tokens": None})())
    assert chat.calls == [] and "budget_context_unknown" in {issue["code"] for issue in result["issues"]}
    assert result["completeness"]["processing"] is False


def test_a_served_count_that_differs_from_the_count_is_reported(tmp_path):
    def reported(system, user, schema):
        return Reply(text=json.dumps(honest(system, user, schema)), input_tokens=9_999, output_tokens=5,
                     finish="stop", seconds=0.0)
    result, _, _ = run("two-in-one-segment", tmp_path, reported)
    assert "budget_count_mismatch" in {issue["code"] for issue in result["issues"]}
    assert result["complete"] is False


def test_no_records_is_an_explicit_outcome_not_a_complete_catalogue(tmp_path):
    result, chat, _ = run("no-records", tmp_path)
    assert result["records"] == [] and chat.calls == [] and result["complete"] is False
    assert "no_records" in {issue["code"] for issue in result["issues"]}


def test_coverage_and_completeness_are_reported_separately(tmp_path):
    result, _, _ = run("mixed-page", tmp_path)
    assert result["coverage"]["complete"] is False and result["coverage"]["unresolved"] == 1
    assert result["completeness"] == {"processing": True, "coverage": False, "grounding": True, "recall": "unmeasured"}
    assert result["complete"] is False
    assert result["segmentation"]["recipe"]["id"] == "numbered-catalogue-de"


def test_the_fingerprint_follows_schema_budget_and_tokenizer_but_one_segmentation_serves_all(tmp_path):
    class OtherTokenizer(WordCounter):
        def identity(self) -> dict:
            return {**super().identity(), "model_digest": "v" * 64}
    renamed = [{**node, "name": "fundort"} if node["name"] == "site_name" else node for node in SCHEMA["schemaNodes"]]
    base, _, _ = run("two-in-one-segment", tmp_path / "a")
    budget, _, _ = run("two-in-one-segment", tmp_path / "b", input_tokens=3000)
    tokenizer, _, _ = run("two-in-one-segment", tmp_path / "c", counter=OtherTokenizer())
    schema = run_schema("two-in-one-segment", tmp_path / "d", renamed)
    prints = {result["fingerprint"] for result in (base, budget, tokenizer, schema)}
    assert len(prints) == 4 and base["fingerprint"] == run("two-in-one-segment", tmp_path / "e")[0]["fingerprint"]
    assert len({result["segmentation"]["fingerprint"] for result in (base, budget, tokenizer, schema)}) == 1


def test_a_stale_generation_is_refused_before_any_call(tmp_path):
    run_dir = catalogue.write("two-in-one-segment", tmp_path)
    chat = FakeChat(honest)
    with pytest.raises(StaleGeneration):
        extract(run_dir, request(), chat, counter=WordCounter(), generation="another")
    assert chat.calls == []


GLOSSED = {"pages": [{"page": 1, "units": [{"index": 1, "crops": [{"segments": [
    {"text": "Im Katalog verwendete Abkürzungen:", "label": "SectionHeader"},
    "G. — Grab\nEF — Einzelfund\nS. — Siedlung\nS — Scherbe",
    {"text": "Katalog", "label": "SectionHeader"},
    "Kreis Heide", "1. Adorf. FA: G.", "2. Bdorf. FA: EF.", "3. Cdorf. FA: S.", "4. Ddorf. FA: Urne."]}]}]}]}


def test_a_value_the_documents_glossary_defines_carries_its_expansion_beside_the_raw_value(tmp_path):
    result, _, _ = run(GLOSSED, tmp_path)
    assert [record["fundart"] for record in result["records"]] == ["G", "EF", "S", "Urne"]  # raw values kept
    expanded = [evidence_for(result, number, "fundart")[0]["normalized"] for number in range(4)]
    assert [entry and entry["value"] for entry in expanded] == ["Grab", "Einzelfund", None, None]
    # `G` is quoted without the period the glossary prints; `S.` and `S` expand two ways, so neither is used.
    text = "G. — Grab\nEF — Einzelfund\nS. — Siedlung\nS — Scherbe"
    key, expansion = expanded[0]["key_span"], expanded[0]["expansion_span"]
    assert (text[key["start"]:key["end"]], text[expansion["start"]:expansion["end"]]) == ("G.", "Grab")
    assert expanded[0]["rule"] == "glossary" and key["segment"] == "p1_s1"
    assert evidence_for(result, 0, "kreis")[0]["normalized"] is None
    assert result["normalization"] == {"version": 1, "rules": ["glossary"]}


def one_entry(text: str) -> dict:
    return {"pages": [{"page": 1, "units": [{"index": 1, "crops": [{"segments": ["Kreis Heide", text]}]}]}]}


def run_schema(case, tmp_path, nodes, script=honest, **catalog):
    schema = {"recordDescription": "One numbered entry of an archaeological catalogue.", "schemaNodes": nodes}
    request = ExtractRequest.model_validate({"schema": schema, "options": {
        "strategy": "catalog", "catalog": {"recipe": "numbered-catalogue-de@1", **catalog}}})
    return extract(catalogue.write(case, tmp_path), request, CountingChat(script), counter=WordCounter())


def test_a_yes_or_no_from_the_model_is_proposed_on_its_quote_and_never_accepted(tmp_path):
    nodes = [{"id": "u", "name": "urn", "type": "boolean"}]

    def script(system, user, schema):
        return {"urn": candidate(True, "Urne" if "Urne" in entry_text(user) else "Urne gefunden")}
    found = run_schema(one_entry("7. Adorf. FA: G. Urne."), tmp_path / "a", nodes, script)
    invented = run_schema(one_entry("7. Bdorf. FA: G."), tmp_path / "b", nodes, script)
    assert found["records"] == [{"urn": None}] and found["evidence"] == []
    assert [(item["value"], item["raw"]) for item in found["proposed"]] == [(True, "Urne")]
    assert invented["records"] == [{"urn": None}] and invented["rejected"][0]["reason"] == "quote_not_in_entry"


@pytest.mark.parametrize("text, cut_after", [
    ("7. Adorf. FA:\tGxyz", "FA:\tG"),       # a cut after G would make a whole token of the start of `Gxyz`
    ("7. Adorf. xyzFA: G.", "Adorf. xyz"),  # a cut before FA: would make a key of the end of `xyzFA:`
])
def test_a_window_cut_never_makes_a_boundary_the_source_does_not_have(tmp_path, monkeypatch, text, cut_after):
    from kei_exp.kie.extract import grounded
    entry = text + " " + " ".join(f"Scherbe{n}" for n in range(300))

    def windows(run, units, texts, fits):
        (unit,) = units
        cut = unit.start + entry.index(cut_after) + len(cut_after)
        spaces = [index for index, char in enumerate(texts[unit.segment]) if char == " " and index > cut + 6][::25]
        bounds = [unit.start, cut, *spaces, unit.end]
        return [[grounded._Unit(unit.segment, start, end)] for start, end in pairwise(bounds)]
    monkeypatch.setattr(grounded, "_windows", windows)

    def script(system, user, schema):
        answer = {name: None for name in schema["properties"]}
        if kind := re.search(r"FA:\s?G", entry_text(user)):
            answer["fundart"] = candidate("G", kind[0], "FA:", "token")
        return answer
    result = run_schema(one_entry(entry), tmp_path, SCHEMA["schemaNodes"], script, input_tokens=260)
    assert len([call for call in result["calls"] if call["stage"] == "entry"]) > 2
    assert result["records"][0]["fundart"] is None
    assert [item["reason"] for item in result["rejected"] if item["path"][-1] == "fundart"] == ["quote_not_in_entry"]


def test_a_number_is_verified_as_printed_never_rounded_truncated_or_stripped_of_its_sign(tmp_path):
    nodes = [{"id": "n", "name": "entry_no", "type": "integer"}, {"id": "m", "name": "mbl_old", "type": "integer"},
             {"id": "d", "name": "depth", "type": "number"}]
    case = {"pages": [{"page": 1, "units": [{"index": 1, "crops": [{"segments": [
        "7. Adorf. Mbl. 245.7. Tiefe 1.23457.", "8. Bdorf. Mbl. -2.", "9. Cdorf. Mbl. 1827-1828.",
        "10. Ddorf. Mbl. - 2."]}]}]}]}

    def script(system, user, schema):
        text, answer = entry_text(user), {name: None for name in schema["properties"]}
        if "Adorf" in text:
            answer.update(mbl_old=candidate(245, "Mbl. 245", "Mbl.", "token"), depth=candidate(1.234567, "1.23457"))
        if "Bdorf" in text:
            answer["mbl_old"] = candidate(2, "Mbl. -2", "Mbl.", "token")
        if "Cdorf" in text:  # a range's hyphen is no sign
            answer["mbl_old"] = candidate(1828, "1827-1828", "Mbl.", "token")
        if "Ddorf" in text:  # a sign apart from its number is still its sign
            answer["mbl_old"] = candidate(2, "Mbl. - 2", "Mbl.", "token")
        return answer
    result = run_schema(case, tmp_path, nodes, script)
    assert [(record["mbl_old"], record["depth"]) for record in result["records"]] == [(None, None)] * 4
    assert sorted((item["path"][1], item["path"][2], item["reason"]) for item in result["rejected"]) == [
        (0, "depth", "value_not_in_quote"), (0, "mbl_old", "value_not_in_quote"),
        (1, "mbl_old", "value_not_in_quote"), (2, "mbl_old", "key_context_missing"),
        (3, "mbl_old", "value_not_in_quote")]


def test_a_yes_or_no_field_takes_only_a_yes_or_no_from_structure_keys_or_the_model(tmp_path):
    nodes = [{"id": n, "name": n, "type": "boolean"} for n in ("entry_no", "kreis", "fundart")]
    result = run_schema(one_entry("7. Adorf. FA: G."), tmp_path, nodes)
    assert result["records"] == [{"entry_no": None, "kreis": None, "fundart": None}]
    assert sorted((item["path"][-1], item["reason"]) for item in result["rejected"]) == [
        ("entry_no", "type_mismatch"), ("fundart", "type_mismatch"), ("kreis", "type_mismatch")]
    assert result["complete"] is False


def test_a_structural_value_must_still_fit_its_field(tmp_path):
    nodes = [{"id": "n", "name": "entry_no", "type": "string", "allowedValues": ["A", "B"]},
             {"id": "k", "name": "kreis", "type": "integer"}]
    result = run_schema(one_entry("7. Adorf. FA: G."), tmp_path, nodes)
    assert result["records"] == [{"entry_no": None, "kreis": None}] and result["evidence"] == []
    assert sorted((item["path"][-1], item["value"], item["reason"]) for item in result["rejected"]) == [
        ("entry_no", "7", "type_mismatch"), ("kreis", "Heide", "type_mismatch")]
    assert [issue["code"] for issue in result["issues"]] == ["binding_type_mismatch"] * 2
    assert result["complete"] is False and result["calls"] == []  # structure owns both fields: no model call


def test_a_calibration_request_the_counter_made_is_a_reported_call(tmp_path):
    counter = WordCounter()
    counter.probes = [{"input_tokens": 23, "output_tokens": 1, "seconds": 0.5}]
    result, _, _ = run("two-in-one-segment", tmp_path, counter=counter)
    assert [call["stage"] for call in result["calls"]] == ["tokenizer_probe", "entry", "entry"]
    assert result["calls"][0]["input_tokens"] == 23 and result["tokens"]["input"] == 23 + sum(
        call["input_tokens"] for call in result["calls"][1:])


@pytest.mark.parametrize("reply, issue", [([], "reply_malformed"), (None, "reply_malformed"),
                                          ({}, "reply_missing_fields")])
def test_a_reply_that_is_not_the_requested_object_is_a_processing_failure(tmp_path, reply, issue):
    result = run_schema(one_entry("7. Adorf. FA: G."), tmp_path, SCHEMA["schemaNodes"], lambda *_: reply)
    assert [entry["code"] for entry in result["issues"]] == [issue]
    assert result["completeness"]["processing"] is False and result["complete"] is False


def test_a_candidate_s_provenance_and_key_are_checked_before_publication(tmp_path):
    def script(system, user, schema):
        answer = {name: None for name in schema["properties"]}
        answer["fundart"] = {"value": "G", "quote": "FA: G"}  # no key, no provenance
        answer["site_name"] = {"value": "Adorf", "quote": "Adorf", "key": 7, "provenance": "guess"}
        return answer
    result = run_schema(one_entry("7. Adorf. FA: G."), tmp_path, SCHEMA["schemaNodes"], script)
    (fundart,) = evidence_for(result, 0, "fundart")
    assert result["records"][0]["fundart"] == "G" and fundart["provenance"] == "token"  # a key introduces it
    (site,) = result["proposed"]
    assert (site["key"], site["provenance"]) == (None, None)
    assert all(link["provenance"] in ("token", "positional", "inherited") for link in result["evidence"])


def test_a_reading_order_disagreement_reaches_the_result_and_leaves_it_incomplete(tmp_path, monkeypatch):
    import dataclasses

    from kei_exp.kie.extract import run as extraction
    loaded = extraction.load

    def disordered(run_dir):
        return dataclasses.replace(loaded(run_dir), order_issues=("p1_s2 (unit 1, crop order 0) follows p1_s1 ...",))
    monkeypatch.setattr(extraction, "load", disordered)
    result, _, _ = run("two-in-one-segment", tmp_path)
    assert result["completeness"]["coverage"] is False and result["complete"] is False
    assert [(d["code"], d["detail"]) for d in result["segmentation"]["diagnostics"]] == [
        ("reading_order", "p1_s2 (unit 1, crop order 0) follows p1_s1 ...")]
    assert result["coverage"]["reading_order_issues"] == 1
