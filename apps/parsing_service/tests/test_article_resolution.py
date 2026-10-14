"""Resolution filters assembled occurrences without rewriting their original readings."""
import json
from copy import deepcopy
from dataclasses import replace

import jsonschema
import pytest

from kei_exp.kie.extract.contexts import Context, assemble_document
from kei_exp.kie.extract.resolution import _shown, resolve
from kei_exp.kie.extract.routing import value_origins
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract import run
from kei_exp.kie.extract.models import Router
from tests.test_article_occurrence_origins import occurrence_input, occurrence_reply
from tests.test_durable_extraction import MemoryLease, finish, linked_while_running
from tests.test_extract_grounded import CountingChat, WordCounter, keeps_every_reading, resolving
from tests.test_extract_stages import passages


SCHEMA = Schema(schemaNodes=[{"id": "finds", "name": "finds", "type": "array",
    "children": [{"id": "name", "name": "name", "type": "string"},
                 {"id": "parts", "name": "parts", "type": "array", "itemType": "string"}]}],
    recordDescription="One document's finds")
ITEM = {"name": "urn", "parts": ["clay", "clay"]}


def assembled(readings, chat, *, overlap=False, counter=None, texts=None, schema=SCHEMA):
    groups = [Context(tuple(passages([text], page=index + 1)))
              for index, text in enumerate(texts or ["An urn made from clay."] * len(readings))]
    item_sources = {}
    root, conflicts, repeats, joined = assemble_document(readings, lambda *_: overlap, item_sources=item_sources)
    result = resolve(readings, groups, root, conflicts, repeats, joined, schema, chat, counter or WordCounter(),
                     item_sources=item_sources)
    return result, item_sources


def valid(script):
    """A chat whose scripted resolution replies are checked against the reply schema the model is constrained to."""
    def checked(system, user, schema):
        answer = script(system, user, schema)
        jsonschema.validate(answer, schema)
        return answer
    return CountingChat(checked)


def labelling(**out):
    """A resolution answer: each scalar's first label; each list place's items OWN except those `out` labels."""
    def script(system, user, schema):
        return {key: {label: out.get(key, {}).get(label, "OWN") for label in spec["properties"]}
                if "properties" in spec else spec["enum"][0] for key, spec in schema["properties"].items()}
    return script


def test_keep_all_never_reintroduces_an_overlap_join_and_keeps_nested_origins():
    readings = [{"finds": [deepcopy(ITEM), deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    original = deepcopy(readings)
    chat = valid(lambda s, u, schema: keeps_every_reading(schema))
    (root, _, _, joined, _, _), item_sources = assembled(readings, chat, overlap=True)
    assert root["finds"] == [ITEM, ITEM]
    assert list(chat.calls[0]["schema"]["properties"]["L1"]["properties"]) == ["I1", "I2"]
    assert joined == [{"path": ["finds"], "contexts": [0, 1], "index": 0}]
    origins = {tuple(entry["path"]): entry["sources"] for entry in
               value_origins(readings, root, {}, [], item_sources=item_sources)}
    for index in (0, 1):
        assert origins[("finds", 0, "parts", index)] == [
            {"unit": unit, "path": ["finds", 0, "parts", index]} for unit in (0, 1)]
        assert origins[("finds", 1, "parts", index)] == [
            {"unit": 0, "path": ["finds", 1, "parts", index]}]
    assert readings == original


def test_dropping_the_first_equal_item_moves_only_the_kept_occurrence_origins():
    readings = [{"finds": [deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    (root, _, repeats, _, _, issues), item_sources = assembled(readings, valid(labelling(L1={"I1": "REPEAT"})))
    assert root["finds"] == [ITEM] and not repeats
    assert item_sources == {("finds", 0): [{"unit": 1, "path": ["finds", 0]}]}
    assert [entry["sources"] for entry in value_origins(readings, root, {}, [], item_sources=item_sources)] == [
        [{"unit": 1, "path": ["finds", 0, "name"]}],
        [{"unit": 1, "path": ["finds", 0, "parts", 0]}],
        [{"unit": 1, "path": ["finds", 0, "parts", 1]}]]
    assert issues[0].code == "dropped_items"


@pytest.mark.parametrize("out,expected", [({"I1": "OTHER"}, [{"path": ["finds"], "contexts": [0, 1], "index": 0}]),
                                         ({"I2": "OTHER"}, [])])
def test_overlap_diagnostics_follow_kept_indices(out, expected):
    readings = [{"finds": [{"name": "sword", "parts": []}, deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    (_, _, _, joined, _, _), _ = assembled(readings, valid(labelling(L1=out)), overlap=True)
    assert joined == expected


@pytest.mark.parametrize("answer", [{"L1": {"I1": "OWN", "I2": "OWN", "I3": "OTHER"}}, {"L1": {"I1": "MAYBE", "I2": "OWN"}},
                                    {"L1": {"I1": "OTHER"}}, {"L1": {}}, {"L1": ["I1"]}, {"L1": "UNSURE"},
                                    {"L1": None}])
def test_invalid_or_abstaining_list_answers_keep_assembly_and_its_origins(answer):
    readings = [{"finds": [deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    chat = CountingChat(lambda *_: answer)
    (root, _, repeats, _, _, issues), item_sources = assembled(readings, chat)
    assert root["finds"] == [ITEM, ITEM] and repeats and not issues
    assert item_sources == {("finds", index): [{"unit": index, "path": ["finds", 0]}] for index in (0, 1)}
    # null is the list's abstention: the one answer here the constrained model can give.
    assert jsonschema.Draft202012Validator(chat.calls[0]["schema"]).is_valid(answer) == (answer["L1"] is None)


SAMPLE = {"species": "Sebastes mentella", "tissue": "skin", "preparation": None}
READ = [SAMPLE | {"preparation": "ASC", "amino_acids": [{"analyte": "hydroxyproline", "value": 64}]},
        SAMPLE | {"preparation": "ASC", "amino_acids": [{"analyte": "imino acids", "value": 16.5}]}]
TWO_READINGS = ["Sebastes mentella skin ASC had 64 hydroxyproline residues.",
                "Sebastes mentella skin ASC had an imino acid content of 16.5%."]


def test_a_differently_filled_reading_of_an_own_item_is_never_left_out_as_a_repeat():
    """Two parts read one sample with different values: neither is the other printed again, so REPEAT is not offered
    for either, and an answer labelling one a repeat is outside its labels and keeps the whole list. Every item must
    be labelled: an answer naming only some items (the ones that belong, say) is never read as leaving the rest out."""
    readings = [{"finds": [deepcopy(READ[0])]}, {"finds": [deepcopy(READ[1])]}]
    chat = CountingChat(lambda *_: {"L1": {"I1": "OWN", "I2": "REPEAT"}})
    (root, _, _, _, _, issues), item_sources = assembled(readings, chat, texts=TWO_READINGS)
    reasons = chat.calls[0]["schema"]["properties"]["L1"]
    assert reasons["properties"] == {label: {"type": "string", "enum": ["OWN", "OTHER"]} for label in ("I1", "I2")}
    assert reasons["required"] == ["I1", "I2"]
    for answer in ({"I1": "OWN", "I2": "REPEAT"}, {"I1": "OTHER"}):
        assert not jsonschema.Draft202012Validator(reasons).is_valid(answer)
    assert root["finds"] == READ and len(item_sources) == 2 and not issues


def test_an_item_left_unnamed_is_kept_and_only_another_works_item_is_left_out():
    readings = [{"finds": [deepcopy(READ[0]), {"name": "cited cod skin"}]}, {"finds": [deepcopy(READ[1])]}]
    (root, _, _, _, _, issues), item_sources = assembled(readings, valid(labelling(L1={"I2": "OTHER"})),
                                                         texts=TWO_READINGS)
    assert root["finds"] == READ
    assert item_sources == {("finds", 0): [{"unit": 0, "path": ["finds", 0]}],
                            ("finds", 1): [{"unit": 1, "path": ["finds", 0]}]}
    assert [json.loads(issue.detail) for issue in issues] == [
        {"path": ["finds"], "dropped": [{"name": "cited cod skin"}]}]


@pytest.mark.parametrize("out,kept", [
    ({"I1": "REPEAT", "I2": "REPEAT"}, 1),  # the copy that stays is the one repeated
    ({"I1": "REPEAT"}, 2),
    ({"I1": "REPEAT", "I2": "REPEAT", "I3": "REPEAT"}, 3),  # nothing stays for them to repeat: all kept
    ({"I1": "OTHER", "I2": "REPEAT", "I3": "REPEAT"}, 2)])
def test_a_repeat_is_left_out_only_beside_an_equal_item_that_stays(out, kept):
    readings = [{"finds": [deepcopy(ITEM), deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    (root, _, _, _, _, _), item_sources = assembled(readings, valid(labelling(L1=out)))
    assert root["finds"] == [ITEM] * kept and len(item_sources) == kept


def test_an_item_is_shown_whole_where_its_least_printed_value_is():
    """A cut item hides the values that tell it from another, and its sample name is printed everywhere: the item is
    shown without empty fields and never cut, at the place its measured value is printed."""
    note = "tissue from the dorsal side, " * 8
    item = SAMPLE | {"note": note.strip(), "amino_acids": [{"analyte": "hydroxyproline", "value": 67.3}]}
    text = ("Sebastes mentella skin was studied. " + "Background. " * 20 + "Sebastes mentella is a redfish. "
            + "Background. " * 20 + "Table 1: raw skin hydroxyproline 67.3 mg/g.")
    chat = valid(lambda s, u, schema: keeps_every_reading(schema))
    assembled([{"finds": [item]}, {"finds": []}], chat, texts=[text, "Nothing."])
    shown = next(line for line in chat.calls[0]["user"].splitlines() if line.startswith("  I1 = "))
    assert json.dumps({key: value for key, value in item.items() if value is not None}, ensure_ascii=False) in shown
    assert "preparation" not in shown and "raw skin hydroxyproline 67.3 mg/g" in shown and "printed" not in shown


def test_a_value_is_shown_where_it_is_printed_as_a_whole_number():
    schema = Schema(schemaNodes=[{"id": "n", "name": "participants", "type": "number"}],
                    recordDescription="One study")
    texts = ["The cited study had 210 participants. " + "Unrelated background. " * 5 + "Our study had 10 participants.",
             "Twelve were enrolled."]
    chat = valid(lambda *_: {"S1": "UNSURE"})
    assembled([{"participants": 10}, {"participants": 12}], chat, texts=texts, schema=schema)
    shown = next(line for line in chat.calls[0]["user"].splitlines() if line.startswith("  C1 = 10"))
    assert "Our study had 10 participants" in shown and "210" not in shown


@pytest.mark.parametrize("answer,expected", [("C2", 12), ("NONE", None)])
def test_a_disagreeing_scalar_settled_to_a_reading_or_none_replaces_its_conflict(answer, expected):
    schema = Schema(schemaNodes=[{"id": "n", "name": "participants", "type": "number"}],
                    recordDescription="One study")
    readings = [{"participants": 10}, {"participants": 12}]
    root, conflicts, _, _ = assemble_document(deepcopy(readings), lambda *_: False)
    assert root["participants"] is None and conflicts
    chat = valid(lambda *_: {"S1": answer})
    (root, contested, _, _, calls, issues), _ = assembled(
        readings, chat, texts=["Our study had 10 participants.", "A cited study had 12 participants."], schema=schema)
    assert root["participants"] == expected and contested == []
    assert [call.stage for call in calls] == ["arbitration"]
    assert [issue.code for issue in issues] == ["resolved_value"]


@pytest.mark.parametrize("value,text,printed", [
    # A page number or a range's endpoint is the number itself.
    (10, "See pp. 5-10 of the report.", True),
    (10, "See pp. 5\u201310 of the report.", True),
    (10, "As shown on p.10 of the report.", True),
    # Digits that end another number are not printed: its sign, minus, leading point or exponent starts it before them.
    (10, "A cited value was -10.", False),
    (10, "A cited value was \u221210.", False),
    (10, "A cited value was 1e-10.", False),
    (10, "A cited value was 1e+10.", False),
    (10, "A cited value was .10.", False),
    ("10", "A cited value was -10.", False),
    # Nor are digits inside a longer number.
    (10, "A cited value was 210.", False),
    (10, "A cited value was 10.5.", False),
    (10, "A cited value was 1,100.", False),
    # A word is matched whole, and a hyphen ends a word.
    ("Smith", "By Jones-Smith.", True),
    ("Smith", "By Smithson.", False),
])
def test_a_value_is_found_where_it_is_printed_and_not_inside_another_number_or_word(value, text, printed):
    shown = _shown(value, Context(tuple(passages([text]))))
    assert shown.endswith(f": …{text}…" if printed else " (not printed verbatim)"), shown


@pytest.mark.parametrize("other", ["-10", "\u221210", "1e-10", ".10"])
def test_other_numbers_ending_in_the_value_never_displace_where_it_is_printed(other):
    schema = Schema(schemaNodes=[{"id": "n", "name": "degrees", "type": "number"}], recordDescription="One study")
    cited = " ".join(f"Reference study {index} had {other} degrees. " + "Background. " * 20 for index in range(3))
    chat = valid(lambda *_: {"S1": "UNSURE"})
    assembled([{"degrees": 10}, {"degrees": 12}], chat, texts=[cited + "Our study had 10 degrees.", "Twelve degrees."],
              schema=schema)
    shown = next(line for line in chat.calls[0]["user"].splitlines() if line.startswith("  C1 = 10"))
    # Shown once where it is printed: three places of the cited numbers would fill the shown places and count as four.
    assert shown.endswith("Our study had 10 degrees.…") and "printed" not in shown and other not in shown, shown


def test_equal_items_printed_twice_are_shown_at_both_places_not_as_their_own_occurrence():
    texts = ["Grave A contained an urn. " + "The soil was dark. " * 5 + "Grave B contained an urn.", "Nothing."]
    chat = valid(lambda s, u, schema: keeps_every_reading(schema))
    readings = [{"finds": [{"name": "urn", "parts": []}, {"name": "urn", "parts": []}]}, {"finds": []}]
    (root, _, _, _, _, _), _ = assembled(readings, chat, texts=texts)
    lines = [line for line in chat.calls[0]["user"].splitlines() if line.startswith(("  I1", "  I2"))]
    for line in lines:
        assert "printed 2 times" in line and "Grave A contained an urn" in line and "Grave B contained an urn" in line
    assert lines[1].endswith("(same value as I1)") and len(root["finds"]) == 2


OTHERS = [{"name": f"find {number}", "parts": []} for number in range(1, 60)]


@pytest.mark.parametrize("answer,expected", [
    ({}, [{"path": ["finds"], "contexts": [0, 1], "indices": [0, 60]}]),
    ({"L1": {"I2": "OTHER"}}, [{"path": ["finds"], "contexts": [0, 1], "indices": [0, 59]}]),
    ({"L2": {"I1": "OTHER"}}, [])])
def test_a_repeat_across_list_parts_stays_named_until_its_copies_are_shown_together(answer, expected):
    readings = [{"finds": [deepcopy(ITEM), *deepcopy(OTHERS)]}, {"finds": [deepcopy(ITEM)]}]
    (_, _, repeats, _, _, _), _ = assembled(readings, valid(labelling(**answer)))
    assert repeats == expected


def test_a_raising_provider_keeps_assembly_on_the_direct_path_but_halts_the_durable_one():
    readings = [{"finds": [deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]

    def timeout(*_):
        raise TimeoutError("read timed out")
    (root, _, repeats, _, calls, issues), item_sources = assembled(readings, CountingChat(timeout))
    assert root["finds"] == [ITEM, ITEM] and repeats and len(item_sources) == 2
    assert [(call.ok, call.recovered, call.error) for call in calls] == [
        (False, True, "provider call raised TimeoutError")]
    assert [issue.code for issue in issues] == ["resolution_failed"]

    class Runtime:
        def complete(self, *args, **kwargs):
            raise RuntimeError("capture could not be saved")
    chat = CountingChat(timeout)
    with pytest.raises(RuntimeError):
        assembled(readings, Router(chat, chat, runtime=Runtime()))


def test_a_failed_resolution_keeps_values_and_records_a_recovered_failed_call():
    class Failed(CountingChat):
        def complete(self, **kwargs):
            return replace(super().complete(**kwargs), text="{", finish="length")
    readings = [{"finds": [deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    (root, _, repeats, _, calls, issues), item_sources = assembled(readings, Failed(lambda *_: {}))
    assert root["finds"] == [ITEM, ITEM] and repeats and len(item_sources) == 2
    assert len(calls) == 1 and not calls[0].ok and calls[0].recovered
    assert issues[0].code == "resolution_failed"


def test_a_parsed_reply_with_a_wrong_token_count_never_drops_assembled_items():
    class WrongCount(CountingChat):
        def complete(self, **kwargs):
            return replace(super().complete(**kwargs), input_tokens=1)
    readings = [{"finds": [deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    (root, _, repeats, _, calls, issues), item_sources = assembled(
        readings, WrongCount(lambda *_: {"L1": {"I1": "REPEAT", "I2": "OWN"}}))
    assert root["finds"] == [ITEM, ITEM] and repeats and len(item_sources) == 2
    assert len(calls) == 1 and not calls[0].ok and calls[0].recovered
    assert "server reported 1" in calls[0].error
    assert [issue.code for issue in issues] == ["resolution_failed"]


def test_one_unsettled_list_part_preserves_the_entire_assembled_list():
    readings = [{"finds": [deepcopy(ITEM) for _ in range(61)]}, {"finds": []}]
    (root, _, _, _, _, issues), item_sources = assembled(readings,
        valid(lambda *_: {"L1": {f"I{n}": "OTHER" for n in range(1, 61)}, "L2": None}))
    assert len(root["finds"]) == len(item_sources) == 61 and not issues


def test_an_oversized_resolution_keeps_assembly_before_durable_call_admission():
    class SmallCounter(WordCounter):
        context_tokens = 1

    class Runtime:
        def complete(self, *args, **kwargs):
            pytest.fail("an oversized optional resolution must not be admitted")

    chat = CountingChat(lambda *_: pytest.fail("an oversized request must not reach the provider"))
    readings = [{"finds": [deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    (root, _, repeats, _, calls, issues), item_sources = assembled(readings, Router(chat, chat, runtime=Runtime()),
                                                                 counter=SmallCounter())
    assert root["finds"] == [ITEM, ITEM] and repeats and len(item_sources) == 2 and not calls
    assert issues[0].code == "resolution_exceeds_budget"


@pytest.mark.parametrize("raises", [False, True])
def test_failed_resolution_does_not_make_article_processing_incomplete(monkeypatch, raises):
    source, request = occurrence_input(monkeypatch, "off")

    class FailedResolution(CountingChat):
        def complete(self, **kwargs):
            if raises and resolving(kwargs["user"]):
                raise TimeoutError("read timed out")
            reply = super().complete(**kwargs)
            return replace(reply, text="{", finish="length") if resolving(kwargs["user"]) else reply

    result = run.dispatch(None, source, request, FailedResolution(occurrence_reply),
        counter={role: WordCounter() for role in ("fields", "reasoning")})
    assert result["records"] == [{"fees": [10, 10]}]
    assert result["completion"]["processing"]
    call = next(call for call in result["calls"] if call["stage"] == "arbitration")
    assert not call["ok"] and call["recovered"]
    assert "resolution_failed" in {issue["code"] for issue in result["issues"]}


@pytest.mark.parametrize("grounding", ["semantic", "quoted", "spans"])
def test_a_kept_later_occurrence_is_grounded_and_retained_in_its_own_source(monkeypatch, grounding):
    source, request = occurrence_input(monkeypatch, grounding)
    lease = MemoryLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
    chat = valid(lambda s, u, schema: labelling(L1={"I1": "REPEAT"})(s, u, schema) if resolving(u)
                 else occurrence_reply(s, u, schema))
    def extract(router, counter):
        return run.dispatch(None, source, request, router, counter={"fields": counter, "reasoning": counter})
    result = finish(lease, chat, extract)
    assert result["records"] == [{"fees": [10]}]
    assert [(entry["path"], entry["segment"]) for entry in result["evidence"]] == [
        (["records", 0, "fees", 0], "p2_s0")]
    _, final = linked_while_running(lease)
    for saved in final.values():
        assert [(entry["producer"]["path"], entry["producer"]["segment"]) for entry in saved] == [
            (["records", 0, "fees", 0], "p2_s0")]
    count = len(chat.calls)
    assert finish(lease, chat, extract)["evidence"] == result["evidence"]
    assert len(chat.calls) == count
