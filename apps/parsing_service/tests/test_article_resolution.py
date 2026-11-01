"""Resolution filters assembled occurrences without rewriting their original readings."""
import json
from copy import deepcopy
from dataclasses import replace

import jsonschema
import pytest

from kei_exp.kie.extract.contexts import Context, assemble_document, sharing
from kei_exp.kie.extract.resolution import (LIST_CHUNK, OF_CHARS, OTHER, REPEAT, UNSURE, _attributed, _form_of, _shown,
                                            resolve)
from kei_exp.kie.extract.routing import value_origins
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract import article, resolution, run
from kei_exp.kie.extract.models import Router
from kei_exp.kie.passages import Passage
from tests.test_article_occurrence_origins import occurrence_input, occurrence_reply
from tests.test_durable_extraction import MemoryLease, finish, linked_while_running
from tests.test_extract_grounded import CountingChat, WordCounter, keeps_every_reading, resolving
from tests.test_extract_stages import evidence, passages


SCHEMA = Schema(schemaNodes=[{"id": "finds", "name": "finds", "type": "array",
    "children": [{"id": "name", "name": "name", "type": "string"},
                 {"id": "parts", "name": "parts", "type": "array", "itemType": "string"}]}],
    recordDescription="One document's finds")
ITEM = {"name": "urn", "parts": ["clay", "clay"]}
CITED = "Smith 2001"  # the work a test source cites, so an item given to it can leave


def assembled(readings, chat, *, overlap=False, counter=None, texts=None, schema=SCHEMA):
    groups = [Context(tuple(passages([text], page=index + 1)))
              for index, text in enumerate(texts or [f"An urn made from clay ({CITED})."] * len(readings))]
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


def answer(spec: dict, label: str, of: str = "") -> str | dict:
    """One list item's answer in the shape its reply schema asks: a bare label, or its `of` and label."""
    return label if spec.get("type") == "string" else {"of": of, "label": label}


def labelling(**out):
    """A resolution answer: each scalar's first label; each list place's items OWN except those `out` labels, an item
    labelled OTHER given to the work the test source cites."""
    def script(system, user, schema):
        return {key: {label: answer(item, reason := out.get(key, {}).get(label, "OWN"), CITED if reason == "OTHER"
                                    else "") for label, item in spec["properties"].items()}
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
    assert root["finds"] == [ITEM, ITEM] and repeats
    assert [issue.code for issue in issues] == ["resolution_not_applied"]
    assert item_sources == {("finds", index): [{"unit": index, "path": ["finds", 0]}] for index in (0, 1)}
    # None of these is an answer the constrained model can give: a list abstains item by item (UNSURE), never whole.
    assert not jsonschema.Draft202012Validator(chat.calls[0]["schema"]).is_valid(answer)


SAMPLE = {"species": "Sebastes mentella", "tissue": "skin", "preparation": None}
READ = [SAMPLE | {"preparation": "ASC", "amino_acids": [{"analyte": "hydroxyproline", "value": 64}]},
        SAMPLE | {"preparation": "ASC", "amino_acids": [{"analyte": "imino acids", "value": 16.5}]}]
TWO_READINGS = [f"Sebastes mentella skin ASC had 64 hydroxyproline residues; cited cod skin had fewer ({CITED}).",
                "Sebastes mentella skin ASC had an imino acid content of 16.5%."]


def test_a_differently_filled_reading_of_an_own_item_is_never_left_out_as_a_repeat():
    """Two parts read one sample with different values: neither is the other printed again, so REPEAT is not offered
    for either, and an answer labelling one a repeat is outside its labels and keeps the whole list. Every item must
    be labelled: an answer naming only some items (the ones that belong, say) is never read as leaving the rest out."""
    readings = [{"finds": [deepcopy(READ[0])]}, {"finds": [deepcopy(READ[1])]}]
    own, repeat = {"of": "", "label": "OWN"}, {"of": "", "label": "REPEAT"}
    chat = CountingChat(lambda *_: {"L1": {"I1": own, "I2": repeat}})
    (root, _, _, _, _, issues), item_sources = assembled(readings, chat, texts=TWO_READINGS)
    reasons = chat.calls[0]["schema"]["properties"]["L1"]
    assert {label: spec["properties"]["label"]["enum"] for label, spec in reasons["properties"].items()} == {
        label: ["OWN", "OTHER", "UNSURE"] for label in ("I1", "I2")}
    assert reasons["required"] == ["I1", "I2"]
    for each in ({"I1": own, "I2": repeat}, {"I1": {"of": CITED, "label": "OTHER"}}):
        assert not jsonschema.Draft202012Validator(reasons).is_valid(each)
    assert root["finds"] == READ and len(item_sources) == 2
    assert [issue.code for issue in issues] == ["resolution_not_applied"]


def test_an_item_left_unnamed_is_kept_and_only_another_works_item_is_left_out():
    readings = [{"finds": [deepcopy(READ[0]), {"name": "cited cod skin"}]}, {"finds": [deepcopy(READ[1])]}]
    (root, _, _, _, _, issues), item_sources = assembled(readings, valid(labelling(L1={"I2": "OTHER"})),
                                                         texts=TWO_READINGS)
    assert root["finds"] == READ
    assert item_sources == {("finds", 0): [{"unit": 0, "path": ["finds", 0]}],
                            ("finds", 1): [{"unit": 1, "path": ["finds", 0]}]}
    assert [json.loads(issue.detail) for issue in issues] == [
        {"path": ["finds"], "dropped": [{"name": "cited cod skin"}], "of": [CITED]}]


@pytest.mark.parametrize("out,kept", [
    ({"I1": "REPEAT", "I2": "REPEAT"}, 1),  # the copy that stays is the one repeated
    ({"I1": "REPEAT"}, 2),
    ({"I1": "REPEAT", "I2": "REPEAT", "I3": "REPEAT"}, 3),  # nothing labelled for them to repeat: all kept
    ({"I1": "OTHER", "I2": "REPEAT", "I3": "OWN"}, 1),  # the own copy stays
    ({"I1": "OTHER", "I2": "REPEAT", "I3": "REPEAT"}, 0),  # repeats of another work's item are that work's too
    ({"I1": "REPEAT", "I2": "OTHER", "I3": "REPEAT"}, 0)])
def test_a_repeat_is_left_out_beside_an_equal_item_labelled_own_or_another_works(out, kept):
    readings = [{"finds": [deepcopy(ITEM), deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    (root, _, _, _, _, _), item_sources = assembled(readings, valid(labelling(L1=out)))
    assert root["finds"] == [ITEM] * kept and len(item_sources) == kept


@pytest.mark.parametrize("out,kept,unsure", [
    ({"I1": "UNSURE", "I2": "REPEAT", "I3": "REPEAT"}, 3, [0]),  # an abstention settles no copy: all stay
    ({"I1": "REPEAT", "I2": "UNSURE", "I3": "REPEAT"}, 3, [1]),
    ({"I1": "UNSURE", "I2": "UNSURE", "I3": "REPEAT"}, 3, [0, 1]),
    ({"I1": "UNSURE", "I2": "REPEAT", "I3": "OWN"}, 2, [0])])  # beside an own copy the repeat still leaves
def test_an_item_labelled_unsure_is_no_copy_a_repeat_leaves_beside(out, kept, unsure):
    """A repeat leaves only beside an equal item labelled OWN or OTHER (ADR 0019): UNSURE says the source does not
    settle the item, so it is not the copy the repeat is the same thing printed again as."""
    readings = [{"finds": [deepcopy(ITEM), deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    (root, _, _, _, _, issues), item_sources = assembled(readings, valid(labelling(L1=out)))
    assert root["finds"] == [ITEM] * kept and len(item_sources) == kept
    assert doubts(issues) == [{"index": index, "of": "", "label": "UNSURE"} for index in unsure]


def test_a_repeat_of_another_works_item_leaves_with_it_and_both_are_reported_dropped():
    """Labelled another's and a repeat, both copies are another work's item: none stays in the list, and the issue
    names exactly what left."""
    readings = [{"finds": [deepcopy(ITEM)]}, {"finds": [deepcopy(ITEM)]}]
    (root, _, repeats, _, _, issues), item_sources = assembled(
        readings, valid(labelling(L1={"I1": "OTHER", "I2": "REPEAT"})))
    assert root["finds"] == [] and item_sources == {} and not repeats
    assert [json.loads(issue.detail) for issue in issues] == [{"path": ["finds"], "dropped": [ITEM, ITEM],
                                                               "of": [CITED, ""]}]


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
    texts = ["The cited study had 210 participants. " + "Unrelated background. " * 10 + "Our study had 10 participants.",
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


class Budget(WordCounter):
    """A context that fits about 20 of the wordy items below in one request, not 60."""
    context_tokens = 1_500


WORDY = [{"name": f"find {number}, a decorated bowl from the north trench",
          "parts": ["cited" if number % 10 == 0 else "own"]} for number in range(1, 51)]


def shown_items(user: str) -> dict[str, dict[str, str]]:
    """Each list place's item lines in a resolution request, by label."""
    blocks = user.split("\n### Places\n", 1)[1].split("\n\n")
    return {block.split(" ", 1)[0]: {line.split(" = ", 1)[0].strip(): line for line in block.splitlines()[1:]}
            for block in blocks}


def by_line(rule):
    """A resolution answer labelling every list item by `rule` over the line it is shown on."""
    def script(system, user, schema):
        shown = shown_items(user)
        return {key: {label: answer(item, reason := rule(shown[key][label]), CITED if reason == "OTHER" else "")
                      for label, item in spec["properties"].items()} for key, spec in schema["properties"].items()}
    return script


def test_a_list_too_long_for_one_request_is_resolved_in_parts_that_each_fit():
    """Shown whole, 50 items do not fit one request: the list is resolved in parts that each hold as many items as fit,
    rather than kept unresolved, and another work's items leave from every part."""
    counter = Budget()
    chat = valid(by_line(lambda line: "OTHER" if '"cited"' in line else "OWN"))
    readings = [{"finds": deepcopy(WORDY[:30])}, {"finds": deepcopy(WORDY[30:])}]
    (root, _, _, _, calls, issues), item_sources = assembled(readings, chat, counter=counter)
    assert root["finds"] == [item for item in WORDY if item["parts"] == ["own"]] and len(item_sources) == 45
    assert [issue.code for issue in issues] == ["dropped_items"]
    assert json.loads(issues[0].detail)["dropped"] == [item for item in WORDY if item["parts"] == ["cited"]]
    parts = [shown_items(call["user"]) for call in chat.calls]
    assert len(parts) > 1 and all(len(part) == 1 for part in parts)
    sizes = [len(next(iter(part.values()))) for part in parts]
    assert sum(sizes) == 50 and len(calls) == len(parts)
    for call, start, size in zip(chat.calls, [sum(sizes[:n]) for n in range(len(sizes))], sizes):
        assert f"(items {start + 1}-{start + size} of 50)" in call["user"]
    for call, part, size, following in zip(chat.calls, parts, sizes, [*parts[1:], None]):
        reserve = 256 + (16 + OF_CHARS // 2) * size
        words = len(call["system"].split()) + len(call["user"].split()) + WordCounter.template_tokens
        assert words + reserve <= Budget.context_tokens
        if following:  # as many as fit: the next part's first item would not
            assert (words + reserve + len(next(iter(following.values()))["I1"].split()) + 16 + OF_CHARS // 2
                    > Budget.context_tokens)


def test_a_repeat_whose_copies_fall_in_different_parts_that_fit_stays_named():
    readings = [{"finds": [deepcopy(ITEM), *deepcopy(WORDY[:40])]}, {"finds": [deepcopy(ITEM)]}]
    chat = valid(lambda s, u, schema: keeps_every_reading(schema))
    (root, _, repeats, _, _, _), _ = assembled(readings, chat, counter=Budget())
    assert len(chat.calls) > 1 and len(root["finds"]) == 42
    assert repeats == [{"path": ["finds"], "contexts": [0, 1], "indices": [0, 41]}]


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
    other = {"of": CITED, "label": "OTHER"}
    (root, _, _, _, _, issues), item_sources = assembled(readings,
        CountingChat(lambda *_: {"L1": {f"I{n}": other for n in range(1, 61)}, "L2": None}))
    assert len(root["finds"]) == len(item_sources) == 61
    assert [issue.code for issue in issues] == ["resolution_not_applied"]


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


# A bare OTHER is a weak, order-dependent call: once the reasoning model called a paper's first own sample another
# work's, it called every following one so too, and the paper's whole own list left. Another's item now leaves only
# where the part it was read from prints the work the model gives it to; otherwise it stays, named for review.
OWN_TEXT = "Collagen from cod backbone contains 6.4% hydroxyproline in the dry weight."
CITED_TEXT = "Collagen from Alaska pollock is denatured at 16.8 C (Kimura et al., 1987)."
OWN_SAMPLE = {"name": "cod backbone collagen", "parts": ["6.4"]}
CITED_SAMPLE = {"name": "Alaska pollock collagen", "parts": ["16.8"]}
KIMURA = "Kimura et al., 1987"
POLLOCK = '"Alaska pollock collagen"'  # the cited sample's value, as its item line shows it


def deciding(rule):
    """A resolution answer giving every list item `rule(line)`: its label and `of`, in the shape its schema asks."""
    def script(system, user, schema):
        shown = shown_items(user)
        return {key: {label: answer(item, *rule(shown[key][label])) for label, item in spec["properties"].items()}
                for key, spec in schema["properties"].items()}
    return script


def doubts(issues) -> list[dict]:
    return [each for issue in issues if issue.code == "uncertain_items" for each in json.loads(issue.detail)["items"]]


def test_own_items_called_another_works_without_naming_a_printed_work_are_kept_and_marked():
    """Every item labelled OTHER, as when the first own sample's call carries the list: the own sample names no work
    and stays, marked for review; the cited sample names the work its part prints and leaves."""
    def rule(line):
        return ("OTHER", KIMURA if POLLOCK in line else "")
    readings = [{"finds": [deepcopy(OWN_SAMPLE)]}, {"finds": [deepcopy(CITED_SAMPLE)]}]
    (root, _, _, _, _, issues), item_sources = assembled(readings, valid(deciding(rule)),
                                                         texts=[OWN_TEXT, CITED_TEXT])
    assert root["finds"] == [OWN_SAMPLE]
    assert item_sources == {("finds", 0): [{"unit": 0, "path": ["finds", 0]}]}
    assert json.loads(next(i for i in issues if i.code == "dropped_items").detail) == {
        "path": ["finds"], "dropped": [CITED_SAMPLE], "of": [KIMURA]}
    assert doubts(issues) == [{"index": 0, "of": "", "label": "OTHER"}]


def test_a_work_printed_only_in_another_part_does_not_take_an_item_with_it():
    """The work the model names must be printed where the item was read: a citation copied from another part's source
    (or invented) keeps the item."""
    def rule(line):
        return ("OTHER", KIMURA)
    readings = [{"finds": [deepcopy(OWN_SAMPLE)]}, {"finds": [deepcopy(CITED_SAMPLE)]}]
    (root, _, _, _, _, issues), _ = assembled(readings, valid(deciding(rule)), texts=[OWN_TEXT, CITED_TEXT])
    assert root["finds"] == [OWN_SAMPLE]
    assert doubts(issues) == [{"index": 0, "of": KIMURA, "label": "OTHER"}]


@pytest.mark.parametrize("of,printed", [
    ("Kimura et al., 1987", "(Kimura et al., 1987)"),
    ("kimura et al., 1987", "(Kimura et al. , 1987 )"),  # case and the spacing around marks differ in the source
    ("Food Chemistry, 172, 836-843", "Food Chemistry, 172 , 836-843."),
    ("[19]", "as described previously [ 19 ]."),
])
def test_another_works_item_leaves_when_its_part_prints_the_work(of, printed):
    def rule(line):
        return ("OTHER", of) if POLLOCK in line else ("OWN", "")
    readings = [{"finds": [deepcopy(OWN_SAMPLE)]}, {"finds": [deepcopy(CITED_SAMPLE)]}]
    texts = [OWN_TEXT, f"Collagen from Alaska pollock is denatured at 16.8 C {printed}"]
    (root, _, _, _, _, issues), item_sources = assembled(readings, valid(deciding(rule)), texts=texts)
    assert root["finds"] == [OWN_SAMPLE] and len(item_sources) == 1 and not doubts(issues)


# One part's prose gives a group's average, which its reading gave to one specimen; another part's table prints that
# specimen's own row under a caption naming the group.
GROUP = "Group A"
SUMMARY_TEXT = "Leaves of the Group A trees alder, birch and cedar were analysed. Group A nitrogen averaged 251 ± 7."
TABLE_TEXT = f"Table 1 Nitrogen (mg/g) of {GROUP}: alder 248, birch 262, cedar 239."
AVERAGED = {"name": "alder", "parts": ["251"]}
SPECIMEN = {"name": "alder", "parts": ["248"]}


@pytest.mark.parametrize("label", ["OWN", "OTHER"])
def test_a_groups_summary_given_to_one_item_leaves_with_the_group_its_part_prints(label):
    """The averaged reading is another's, given to the group its values summarise (version 15), and leaves: its part
    prints the group. The specimen's row labelled OWN stays. Labelled OTHER and given the caption's group it leaves too:
    whether a printed group is this item's is the model's judgment, and the loss is recorded in `dropped_items`."""
    def rule(line):
        return ("OTHER", GROUP) if '"251"' in line else (label, GROUP if label == OTHER else "")
    readings = [{"finds": [deepcopy(AVERAGED)]}, {"finds": [deepcopy(SPECIMEN)]}]
    (root, _, _, _, _, issues), item_sources = assembled(readings, valid(deciding(rule)),
                                                         texts=[SUMMARY_TEXT, TABLE_TEXT])
    gone = [SPECIMEN] if label == OTHER else []
    assert root["finds"] == ([] if gone else [SPECIMEN]) and len(item_sources) == 1 - len(gone)
    assert dropped(issues) == [{"path": ["finds"], "dropped": [AVERAGED, *gone], "of": [GROUP] * (1 + len(gone))}]
    assert not doubts(issues)


def test_an_item_whose_membership_the_source_does_not_settle_is_kept_and_named_at_its_kept_index():
    """UNSURE is an item's own abstention: the item stays where it is, after another work's item before it left, and
    the issue names its kept position."""
    def rule(line):
        return ("OTHER", KIMURA) if POLLOCK in line else ("UNSURE", "")
    readings = [{"finds": [deepcopy(CITED_SAMPLE), deepcopy(OWN_SAMPLE)]}, {"finds": []}]
    (root, _, _, _, _, issues), item_sources = assembled(readings, valid(deciding(rule)),
                                                         texts=[f"{CITED_TEXT} {OWN_TEXT}", "Nothing."])
    assert root["finds"] == [OWN_SAMPLE]
    assert item_sources == {("finds", 0): [{"unit": 0, "path": ["finds", 1]}]}
    assert doubts(issues) == [{"index": 0, "of": "", "label": "UNSURE"}]


def test_a_reading_of_an_own_sample_with_only_its_method_stays_beside_the_reading_with_its_values():
    """One part read a sample's method details and no value, another its values: called another's without a work the
    source names, the method reading is kept with its details."""
    method = {"name": "catla swim bladder ASC", "parts": ["0.05 M acetic acid"]}
    values = {"name": "catla swim bladder ASC", "parts": ["38.88"]}
    texts = ["The catla swim bladder ASC was dissolved in 0.05 M acetic acid for calorimetry.",
             "The Tmax of the catla swim bladder ASC was 38.88 C."]
    def rule(line):
        return ("OTHER", "") if "0.05 M" in line else ("OWN", "")
    (root, _, _, _, _, issues), _ = assembled([{"finds": [deepcopy(method)]}, {"finds": [deepcopy(values)]}],
                                              valid(deciding(rule)), texts=texts)
    assert root["finds"] == [method, values]
    assert doubts(issues) == [{"index": 0, "of": "", "label": "OTHER"}]


@pytest.mark.parametrize("of,kept", [(CITED, []), ("", [ITEM])])
def test_a_repeat_beside_an_item_called_another_works_leaves_with_it_only_when_the_work_is_printed(of, kept):
    """OTHER and REPEAT on equal copies: with the work printed both copies are that work's and leave; without it the
    OTHER copy stays, marked, and only its repeat leaves, since the copy kept holds the same value."""
    readings = [{"finds": [deepcopy(ITEM), deepcopy(ITEM)]}, {"finds": []}]
    labels = iter([("OTHER", of), ("REPEAT", "")])
    (root, _, _, _, _, issues), item_sources = assembled(readings, valid(deciding(lambda line: next(labels))))
    assert root["finds"] == kept and len(item_sources) == len(kept)
    assert doubts(issues) == ([] if of else [{"index": 0, "of": "", "label": "OTHER"}])


# What the runtime guard guarantees and what stays the model's judgment. The guard checks only that the work an item is
# given to is printed in the part the item was read from: an item the model calls another's without such a work stays,
# marked. It cannot tell whose a printed work is (this item's, a neighbouring item's, the document's own name), so a
# printed citation never shows that an item is another's: an own item given a work its part prints leaves, and only
# `dropped_items`, with that `of`, keeps it visible.
TITLE = "Hydroxyproline in fish backbone collagen"
NAGAI = "Nagai et al. (2002)"
METHOD = {"name": "catla skin ASC", "parts": ["0.5 M acetic acid"]}
METHOD_TEXT = f"Collagen was extracted from catla skin with 0.5 M acetic acid as described by {NAGAI}."


def dropped(issues) -> list[dict]:
    return [json.loads(issue.detail) for issue in issues if issue.code == "dropped_items"]


@pytest.mark.parametrize("label", ["OWN", "OTHER"])
def test_an_own_item_given_another_items_citation_printed_in_its_part_rests_on_the_models_label(label):
    """Both samples were read from one part, which prints the cited sample's work. Labelled OWN, the own sample stays;
    labelled OTHER and given that work, it leaves with the cited sample: the work is printed in its part, and which item
    it belongs to is the model's judgment. The loss is recorded, never silent."""
    def rule(line):
        return ("OTHER", KIMURA) if POLLOCK in line else (label, KIMURA if label == OTHER else "")
    readings = [{"finds": [deepcopy(OWN_SAMPLE), deepcopy(CITED_SAMPLE)]}, {"finds": []}]
    (root, _, _, _, _, issues), item_sources = assembled(readings, valid(deciding(rule)),
                                                         texts=[f"{OWN_TEXT} {CITED_TEXT}", "Nothing."])
    gone = [OWN_SAMPLE] if label == OTHER else []
    assert root["finds"] == ([] if gone else [OWN_SAMPLE]) and len(item_sources) == 1 - len(gone)
    assert dropped(issues) == [{"path": ["finds"], "dropped": [*gone, CITED_SAMPLE], "of": [KIMURA] * (1 + len(gone))}]
    assert not doubts(issues)


@pytest.mark.parametrize("header", [False, True])
def test_an_own_item_given_the_documents_own_title_leaves_only_where_its_part_prints_the_title(header):
    """The model gives an own item to the document itself. Where its part does not print the title, the item stays,
    marked; where a running header prints it, the guard cannot tell the document's name from another work's and the
    item leaves, recorded as dropped. Naming the document as another work is the model's error, not caught here."""
    text = f"{TITLE} 3 {OWN_TEXT}" if header else OWN_TEXT
    readings = [{"finds": [deepcopy(OWN_SAMPLE)]}, {"finds": []}]
    (root, _, _, _, _, issues), _ = assembled(readings, valid(deciding(lambda line: ("OTHER", TITLE))),
                                              texts=[text, f"{TITLE}. Abstract."])
    assert root["finds"] == ([] if header else [OWN_SAMPLE])
    assert dropped(issues) == ([{"path": ["finds"], "dropped": [OWN_SAMPLE], "of": [TITLE]}] if header else [])
    assert doubts(issues) == ([] if header else [{"index": 0, "of": TITLE, "label": "OTHER"}])


@pytest.mark.parametrize("label", ["OWN", "UNSURE", "OTHER"])
def test_an_own_method_citing_a_borrowed_method_leaves_only_when_the_model_calls_it_anothers(label):
    """The document's own sample prepared by a cited work's method: the citation is printed beside it and is its `of`.
    An `of` alone never removes an item: labelled OWN it stays unmarked, UNSURE it stays marked. Labelled OTHER the
    work is printed in its part and it leaves: telling a borrowed method from a cited result is the model's call."""
    readings = [{"finds": [deepcopy(METHOD)]}, {"finds": []}]
    (root, _, _, _, _, issues), _ = assembled(readings, valid(deciding(lambda line: (label, NAGAI))),
                                              texts=[METHOD_TEXT, "Nothing."])
    assert root["finds"] == ([] if label == OTHER else [METHOD])
    assert dropped(issues) == ([{"path": ["finds"], "dropped": [METHOD], "of": [NAGAI]}] if label == OTHER else [])
    assert doubts(issues) == ([{"index": 0, "of": NAGAI, "label": UNSURE}] if label == UNSURE else [])


def test_an_uncertain_item_is_saved_with_the_record_publication_and_survives_replay(monkeypatch):
    """The issue naming a kept, uncertain item reaches the durable record publication's diagnostics and the completion
    publication the review page reads, at its kept index, and a replay publishes the same without a new call."""
    source, request = occurrence_input(monkeypatch, "semantic")
    lease = MemoryLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
    chat = valid(lambda s, u, schema: labelling(L1={"I1": "UNSURE"})(s, u, schema) if resolving(u)
                 else occurrence_reply(s, u, schema))
    def extract(router, counter):
        return run.dispatch(None, source, request, router, counter={"fields": counter, "reasoning": counter})
    result = finish(lease, chat, extract)
    assert result["records"] == [{"fees": [10, 10]}]
    def saved(publications):
        return [issue for publication in publications for issue in
                publication["coverage"].get("diagnostics", {}).get("issues", []) if issue["code"] == "uncertain_items"]
    first = saved(lease.publications.values())
    assert len(first) == 2 and first[0] == first[1] and first[0]["path"] == ["records", 0, "fees"]
    assert json.loads(first[0]["detail"]) == {"path": ["fees"], "items": [{"index": 0, "of": "", "label": "UNSURE"}]}
    def completions():
        return [p["coverage"] for p in lease.publications.values() if "finalizedAttempt" in p["coverage"]]
    [completion] = completions()
    assert completion["finalizedAttempt"]["attemptId"] == lease.attempt
    assert completion["diagnostics"] == {"issues": result["issues"]}
    before, count = set(lease.publications), len(chat.calls)
    assert finish(lease, chat, extract)["issues"] == result["issues"] and len(chat.calls) == count
    assert saved(lease.publications[key] for key in set(lease.publications) - before) in ([], first[:1])
    assert completions() == [completion]


def test_an_attempt_planned_again_under_a_changed_resolution_prompt_asks_it_anew_and_reuses_every_other_call(
        monkeypatch):
    """A durable call capture is keyed by its exact request, system prompt included, and the admitted method pins no
    prompt: an attempt planned again after the resolution prompt changed (a version 14 attempt resumed on version 15)
    replays the calls whose requests are unchanged, never reuses the earlier prompt's resolution reply, and asks the
    changed prompt anew. Its result is the changed prompt's decision, with no trace of the earlier one. This fixture
    has one resolution request and unchanged grounding requests, hence one more call; a part whose resolution
    changes may change its grounding requests too."""
    source, request = occurrence_input(monkeypatch, "semantic")
    lease = MemoryLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
    changed = " A changed resolution prompt."
    def reply(system, user, schema):
        if not resolving(user):
            return occurrence_reply(system, user, schema)
        return labelling(**({} if system.endswith(changed) else {"L1": {"I1": "UNSURE"}}))(system, user, schema)
    chat = valid(reply)
    def extract(router, counter):
        return run.dispatch(None, source, request, router, counter={"fields": counter, "reasoning": counter})
    earlier = finish(lease, chat, extract)
    def doubted(result):
        return [issue for issue in result["issues"] if issue["code"] == "uncertain_items"]
    assert len(doubted(earlier)) == 1
    count, units = len(chat.calls), len(lease.units)
    monkeypatch.setattr(resolution, "RESOLUTION", resolution.RESOLUTION + changed)
    later = finish(lease, chat, extract)
    asked = chat.calls[count:]
    assert len(asked) == 1 and resolving(asked[0]["user"]) and asked[0]["system"].endswith(changed)
    assert len(lease.units) == units + 1
    assert later["records"] == earlier["records"] == [{"fees": [10, 10]}] and not doubted(later)
    assert later["issues"] == [issue for issue in earlier["issues"] if issue not in doubted(earlier)]


def test_a_rejected_list_reply_reports_non_application_through_completion_and_replay(monkeypatch):
    source, request = occurrence_input(monkeypatch, "semantic")
    lease = MemoryLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
    # Valid JSON, but I1 is missing: runtime validation must still reject the list.
    chat = CountingChat(lambda s, u, schema: {"L1": {}} if resolving(u) else occurrence_reply(s, u, schema))
    def extract(router, counter):
        return run.dispatch(None, source, request, router, counter={"fields": counter, "reasoning": counter})
    result = finish(lease, chat, extract)
    assert result["records"] == [{"fees": [10, 10]}]
    rejected = [issue for issue in result["issues"] if issue["code"] == "resolution_not_applied"]
    assert rejected and all(issue["path"] == ["records", 0, "fees"] for issue in rejected)
    assert all(json.loads(issue["detail"]) == {"path": ["fees"], "reason": "invalid_list_reply"} for issue in rejected)
    [completion] = [p for p in lease.publications.values() if "finalizedAttempt" in p["coverage"]]
    assert completion["coverage"]["diagnostics"] == {"issues": result["issues"]}
    before, count = deepcopy(lease.publications), len(chat.calls)
    assert finish(lease, chat, extract)["issues"] == result["issues"]
    assert len(chat.calls) == count
    assert all(lease.publications[key] == publication for key, publication in before.items())
    assert [p for p in lease.publications.values() if "finalizedAttempt" in p["coverage"]] == [completion]


# An Article read in parts (ADR 0019): a later part reads an author's name from a running header that shortens it, and
# the bibliography part answers with a cited work's authors, copied as `of` from its reference entry until the reply
# schema's `OF_CHARS` limit stops it.
AUTHORS = Schema(schemaNodes=[{"id": "authors", "name": "authors", "type": "array", "itemType": "string"}],
                 recordDescription="One article's authors")
BYLINE = ["Ada B. Lovelace", "Charles Babbage", "Grace Hopper"]
ENTRY = ("[7] Noether E, Hilbert D, Klein F. Invariant forms of collagen from the backbone of the northern Atlantic "
         "cod. Food Synth. 2010;24:325-329.")
CUT = ENTRY[:OF_CHARS]  # "… the northern Atl": the limit stopped the copy inside a word
HEAD, TAIL = CUT.rsplit(" ", 1)


def value_of(line: str):
    """The item an item line shows."""
    return json.loads(line.split(" = ", 1)[1].split(" — ", 1)[0])


@pytest.mark.parametrize("of,leaves", [
    (CUT, True),
    (f"{CUT[:-1]},", True),  # a mark where the source goes on with the word
    (f"{HEAD} {'q' * len(TAIL)}", False),  # a last word no printed word starts with
    (CUT.replace("Invariant", "Covariant"), False),  # an earlier word not as printed
    (f"{ENTRY[:60].rsplit(' ', 1)[0]},", False)])  # under the limit, an `of` is printed whole or the item stays
def test_another_works_item_leaves_when_its_of_cut_at_the_limit_is_printed_up_to_its_last_word(of, leaves):
    def rule(line):
        return ("OTHER", of) if value_of(line) == "Noether E" else ("OWN", "")
    readings = [{"authors": BYLINE[:1]}, {"authors": ["Noether E"]}]
    (root, _, _, _, _, issues), item_sources = assembled(readings, valid(deciding(rule)), schema=AUTHORS,
                                                         texts=[", ".join(BYLINE), f"References {ENTRY} [8] Next."])
    assert root["authors"] == (BYLINE[:1] if leaves else [*BYLINE[:1], "Noether E"])
    assert len(item_sources) == len(root["authors"])
    assert dropped(issues) == ([{"path": ["authors"], "dropped": ["Noether E"], "of": [of]}] if leaves else [])
    assert doubts(issues) == ([] if leaves else [{"index": 1, "of": of, "label": OTHER}])


@pytest.mark.parametrize("item,earlier,form", [
    ("A. LOVELACE", "Ada B. Lovelace", True),  # a running header's initial, middle initial left out
    ("Lovelace A", "Ada Lovelace", True),  # family name first
    ("M. García Márquez", "Maria García Márquez", True),
    ("ADA B. LOVELACE", "Ada B. Lovelace", True),  # case, accents and punctuation aside, the same words
    ("Zoë Lovelace", "Zoe Lovelace", True),
    ("A. C. Lovelace", "Ada B. Lovelace", False),  # an initial the earlier name does not have
    ("B. Lovelace", "Ada Lovelace", False),
    ("B. Lovelace", "Ada B. Lovelace", False),  # the first given name is never skipped
    ("C. Lovelace", "Ada Catherine Lovelace", False),
    ("1 Lovelace", "123 Lovelace", False),  # an initial is a letter
    ("A. 12", "Ada 12", False),  # a last word is letters
    ("A. _x", "Ada _x", False),
    ("A. Lovelace", "A. B. Lovelace", False),  # shortcut: an initials-only name left out a middle initial stays
    ("J.-P. Sartre", "Jean-Paul Sartre", True),
    ("Lovelace", "Ada Lovelace", False),  # nothing cut to an initial: another word list's shorter item
    ("type I collagen", "type I fish collagen", False),
    ("Ada B. Lovelace", "A. B. Lovelace", False),  # never the full name as a form of its initials
    ("Sample 1", "Sample 2", False),
    ("Ada B. Lovelace", "Ada B. Lovelace", False),  # equal: a repeat of its own, not a form
    ({"name": "A. Lovelace"}, {"name": "Ada Lovelace"}, False)])  # objects stay equal or different readings
def test_a_form_of_an_earlier_item_is_its_words_or_a_shortening_that_keeps_the_last(item, earlier, form):
    assert _form_of(item, earlier) is form


@pytest.mark.parametrize("readings,forms,repeats", [
    ([BYLINE, ["A. LOVELACE"]], {"I4": "I1"}, {"I4"}),
    ([["A. LOVELACE"], BYLINE], {}, set()),  # an earlier shortening keeps its place: the later full name is no form
    ([["Ada Lovelace", "Ann Lovelace"], ["A. Lovelace"]], {}, set()),  # which name it shortens is not known
    ([["Ada B. Lovelace", "Ada B. Lovelace"], ["Lovelace A"]], {"I3": "I1"}, {"I1", "I2", "I3"}),  # one value
    ([["fish collagen", "type I fish collagen"], ["collagen", "type I collagen"]], {}, set())])
def test_a_repeat_is_offered_to_a_later_form_of_exactly_one_earlier_value_and_never_to_that_value(readings, forms,
                                                                                                repeats):
    chat = valid(lambda s, u, schema: keeps_every_reading(schema))
    (root, _, _, _, _, _), _ = assembled([{"authors": each} for each in readings], chat, schema=AUTHORS,
                                         texts=[", ".join(each) for each in readings])
    assert root["authors"] == [item for each in readings for item in each]
    [call] = chat.calls
    lines = shown_items(call["user"])["L1"]
    assert {label: line.rsplit("(a form of ", 1)[1][:-1] for label, line in lines.items()
            if "(a form of " in line} == forms
    assert {label for label, spec in call["schema"]["properties"]["L1"]["properties"].items()
            if REPEAT in spec["properties"]["label"]["enum"]} == repeats


@pytest.mark.parametrize("first,form,kept", [
    (("OWN", ""), "REPEAT", BYLINE),
    (("OWN", ""), "OWN", [*BYLINE, "A. LOVELACE"]),  # printed again or another author: the model's call
    (("UNSURE", ""), "REPEAT", [*BYLINE, "A. LOVELACE"]),  # UNSURE settles no copy for a repeat to be
    (("OTHER", "Menabrea 1842"), "REPEAT", BYLINE[1:]),  # another work's author printed again is that work's too
    (("OTHER", "Menabrea 1843"), "REPEAT", BYLINE)])  # kept unattributed, marked: still the copy that stays
def test_a_form_labelled_a_repeat_leaves_only_beside_its_earlier_item_labelled_own_or_anothers(first, form, kept):
    def rule(line):
        return (form, "") if line.endswith("(a form of I1)") else first if value_of(line) == BYLINE[0] else ("OWN", "")
    readings = [{"authors": deepcopy(BYLINE)}, {"authors": ["A. LOVELACE"]}]
    texts = [f"{', '.join(BYLINE)} (translating Menabrea 1842)", "4 A. LOVELACE ET AL."]
    (root, _, _, _, _, issues), item_sources = assembled(readings, valid(deciding(rule)), schema=AUTHORS, texts=texts)
    assert root["authors"] == kept
    assert sorted(item_sources) == [("authors", index) for index in range(len(kept))]
    assert ("A. LOVELACE" in kept) is not any("A. LOVELACE" in each["dropped"] for each in dropped(issues))


def test_an_article_read_in_overlapping_parts_keeps_only_its_byline_in_order():
    """The QA shape. The byline is read again from the next part's overlap, where it is printed once, and joins; that
    part also reads the first author from a running header printed on each of its pages, and the others from its
    ORCID section; the bibliography part answers with a cited work's authors, given to their reference entry cut at
    the `of` limit. The byline alone stays, in its order, each name kept at the occurrences it was read from."""
    def at(id_, page, text, label="Text"):
        return Passage(id=id_, page=page, index=0, text=text, label=label, bbox_pt=(0, 0, 1, 1), extent="block")
    byline = at("byline", 1, ", ".join(BYLINE))
    cite = at("cite", 1, f"To cite this article: {', '.join(BYLINE)} (2020) Analytic engines.")
    heads = tuple(at(f"head{page}", page, f"{page} A. LOVELACE ET AL.", "PageHeader") for page in range(2, 6))
    orcid = at("orcid", 6, "ORCID " + " ".join(f"{name} https://orcid.org/0000-0000-0000-000{number}"
                                               for number, name in enumerate(BYLINE)))
    groups = [Context((at("title", 1, "Analytic engines for fish collagen", "Title"), byline, cite)),
              Context((*heads, orcid), overlap=(byline,)), Context((at("refs", 7, f"References {ENTRY} [8] Next."),))]
    readings = [{"authors": [BYLINE[0], *BYLINE]}, {"authors": ["A. LOVELACE", *BYLINE[1:]]},
                {"authors": ["Noether E", "Hilbert D", "Klein F"]}]
    original, item_sources = deepcopy(readings), {}
    root, conflicts, repeats, joined = assemble_document(readings, sharing(groups), item_sources=item_sources)
    assert root["authors"] == [BYLINE[0], *BYLINE, "A. LOVELACE", "Noether E", "Hilbert D", "Klein F"]
    assert not repeats and [join["index"] for join in joined] == [2, 3]
    def rule(line):
        value = value_of(line)
        return (("REPEAT", "") if line.endswith(("(a form of I1)", "(same value as I1)")) else ("OTHER", f"{CUT[:-1]},")
                if value in ("Noether E", "Hilbert D", "Klein F") else ("OWN", ""))
    chat = valid(deciding(rule))
    root, _, repeats, joined, _, issues = resolve(readings, groups, root, conflicts, repeats, joined, AUTHORS, chat,
                                                  WordCounter(), item_sources=item_sources)
    assert root["authors"] == BYLINE and not repeats and not doubts(issues) and readings == original
    assert dropped(issues) == [{"path": ["authors"], "of": ["", "", *[f"{CUT[:-1]},"] * 3],
                                "dropped": [BYLINE[0], "A. LOVELACE", "Noether E", "Hilbert D", "Klein F"]}]
    # The citation line's copy left from before the joined names: they and their reply coordinates move up one.
    assert joined == [{"path": ["authors"], "contexts": [0, 1], "index": index} for index in (1, 2)]
    assert item_sources == {("authors", 0): [{"unit": 0, "path": ["authors", 0]}],
                            **{("authors", index): [{"unit": 0, "path": ["authors", index + 1]},
                                                    {"unit": 1, "path": ["authors", index]}] for index in (1, 2)}}


BASE = "Invariant forms of collagen, after Noether and Hilbert, "


def capped(ending: str) -> str:
    """An `of` of exactly `OF_CHARS` characters ending in `ending`, after printed words."""
    return f"{BASE}{'q' * (OF_CHARS - len(BASE) - len(ending) - 1)} {ending}"


@pytest.mark.parametrize("ending,printed,attributed", [
    ("bac", "backbone", True),  # a word the limit cut
    ("bac,", "backbone", True),
    ("[19]", "[19]", True),  # printed whole
    ("[19]", "[190]", False),  # a number or reference is never a cut word
    ("10", "100", False),
    ("10", "10.5", False),
    ("wrongword", "backbone", False),
    ("bac", "bac123", False),  # the printed word goes on in letters only
    ("[19a]", "[19abc]", False),
    ("[AB]", "[ABC]", False),
    ("x_foo", "x_foobar", False),
    ("foo_", "foobar", False),
    ("bac", "bac\u00b2", False),  # a numeral is no letter
    ("[Smith AB]", "[Smith ABC]", False),  # a closing delimiter is kept, so a reference ends whole
    ("(Smith AB)", "(Smith ABC)", False)])
def test_an_of_at_the_limit_may_end_in_a_cut_word_but_never_a_cut_number(ending, printed, attributed):
    of = capped(ending)
    part = Context(tuple(passages([f"The {of[:-len(ending)]}{printed} and more."])))
    assert len(of) == OF_CHARS and _attributed(of, part) is attributed
    # Under or over the limit, an `of` is no cut reply: printed whole, or not at all.
    assert _attributed(of.split(" ", 1)[1], part) is _attributed(f"The {of}", part) is (ending == printed)
    assert not _attributed("," * OF_CHARS, part) and not _attributed(" " * OF_CHARS, part)


@pytest.mark.parametrize("labels,kept", [
    (("REPEAT", "OWN", "REPEAT"), ["Ada B. Lovelace"]),  # an own copy of the earlier value is its anchor
    (("REPEAT", "UNSURE", "REPEAT"), ["Ada B. Lovelace", "Ada B. Lovelace", "A. LOVELACE"])])  # no copy settled
def test_a_form_leaves_beside_any_copy_of_its_earlier_value_labelled_own(labels, kept):
    readings = [{"authors": ["Ada B. Lovelace"]}, {"authors": ["Ada B. Lovelace", "A. LOVELACE"]}]
    answers = iter(labels)
    (root, _, _, _, _, _), _ = assembled(readings, valid(deciding(lambda line: (next(answers), ""))), schema=AUTHORS,
                                         texts=["Ada B. Lovelace", "Ada B. Lovelace 4 A. LOVELACE ET AL."])
    assert root["authors"] == kept


@pytest.mark.parametrize("others,counter", [
    ([f"Author {number}" for number in range(1, LIST_CHUNK)], WordCounter()),  # the 60-item part
    ([item["name"] for item in WORDY[:40]], Budget())])  # the items one request fits
def test_a_form_shown_in_another_list_part_than_its_earlier_value_is_never_offered_a_repeat(others, counter):
    """shortcut (`LIST_CHUNK` and the request size): a form and the value it may repeat in different list parts are
    never compared."""
    readings = [{"authors": ["Ada B. Lovelace", *others]}, {"authors": ["A. LOVELACE"]}]
    chat = valid(lambda s, u, schema: keeps_every_reading(schema))
    (root, _, _, _, _, _), _ = assembled(readings, chat, schema=AUTHORS, counter=counter)
    users = "\n".join(call["user"] for call in chat.calls)
    assert users.count(" · authors (items ") > 1 and "(a form of" not in users
    assert not any(REPEAT in spec["properties"]["label"]["enum"] for call in chat.calls
                   for place in call["schema"]["properties"].values() for spec in place["properties"].values())
    assert root["authors"] == ["Ada B. Lovelace", *others, "A. LOVELACE"]


def test_a_shortened_header_name_and_cited_authors_leave_through_durable_completion_and_replay(monkeypatch):
    """A durable Article read from its last part first (`start_page`): the byline, a running header's shortened first
    author and a reference's authors. What leaves is in the completion's diagnostics with its raw `of`, the byline keeps
    its order and its own evidence, and a replay publishes the same without another call."""
    texts = [", ".join(BYLINE), "4 A. LOVELACE ET AL.", f"References {ENTRY}"]
    source = replace(evidence([p for page, text in enumerate(texts, 1) for p in passages([text], page=page)]),
                     page_count=3)
    contexts = [Context((p,)) for p in source.passages]
    monkeypatch.setattr(article, "source_contexts", lambda *_: contexts)
    monkeypatch.setattr(article, "partition", lambda *_args, **_kwargs: contexts)
    request = run.ExtractRequest(schema={"recordDescription": "One article.", "recordScope": "document",
        "schemaNodes": [{"id": "authors", "name": "authors", "type": "array", "itemType": "string"}]},
        options={"strategy": "article", "start_page": 3, "article": {"context": "bounded", "grounding": "semantic"}})
    read = {texts[0]: BYLINE, texts[1]: ["A. LOVELACE"], texts[2]: ["Noether E"]}
    def rule(line):
        return ("REPEAT", "") if line.endswith("(a form of I1)") else (
            ("OTHER", CUT) if value_of(line) == "Noether E" else ("OWN", ""))
    def reply(system, user, schema):
        if resolving(user):
            return deciding(rule)(system, user, schema)
        if "### Claims" in user:
            return occurrence_reply(system, user, schema)
        return {"authors": next(authors for text, authors in read.items() if text in user)}
    lease = MemoryLease(request.schema_.model_dump(by_alias=True, exclude_none=True))
    chat = valid(reply)
    def extract(router, counter):
        return run.dispatch(None, source, request, router, counter={"fields": counter, "reasoning": counter})
    result = finish(lease, chat, extract)
    assert [next(text for text in texts if text in call["user"]) for call in chat.calls
            if not resolving(call["user"]) and "### Claims" not in call["user"]] == texts[::-1]
    assert result["records"] == [{"authors": BYLINE}]
    assert {tuple(link["path"]): link["segment"] for link in result["evidence"]} == {
        ("records", 0, "authors", index): "p1_s0" for index in range(3)}
    assert [json.loads(issue["detail"]) for issue in result["issues"] if issue["code"] == "dropped_items"] == [
        {"path": ["authors"], "dropped": ["A. LOVELACE", "Noether E"], "of": ["", CUT]}]
    [completion] = [p["coverage"] for p in lease.publications.values() if "finalizedAttempt" in p["coverage"]]
    assert completion["diagnostics"] == {"issues": result["issues"]}
    count = len(chat.calls)
    assert finish(lease, chat, extract)["issues"] == result["issues"] and len(chat.calls) == count


def test_resolution_constrains_its_reply_without_showing_the_schema():
    # RESOLUTION states the reply's shape; the per-place label enums constrain decoding but are not shown.
    _, schema, _ = resolution._request("Opening", [{"key": "S1", "kind": "scalar", "options": [], "text": "S1: x",
                                                    "schema": {"type": "string", "enum": ["A", "NONE", "UNSURE"]}}])
    assert schema["x-free-hidden"] and schema["required"] == ["S1"]
