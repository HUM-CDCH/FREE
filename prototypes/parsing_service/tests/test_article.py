"""Article reads one document root with complete input and served-token admission; the inventory of
noncontiguous records it used to take stays for the research replays and is tested here as a unit."""
import dataclasses

import pytest

from kei_exp.kie.extract import run
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.llm import Reply
from kei_exp.kie.extract.article import DOCUMENT_LABEL, RootUnanswered, inventory
from kei_exp.kie.extract.calls import complete
from kei_exp.kie.extract.grounding import verify
from kei_exp.kie.extract.stages import DOCUMENT, extract_record, record_request
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract.tokens import BudgetUnavailable
from kei_exp.kie.passages import text_of
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import SCHEMA, evidence, passages


def test_article_reads_the_complete_source_as_one_document_root_without_an_identity_inventory(monkeypatch):
    """Document scope: the late results and the uncited methods are both read, every field (identity-like ones too)
    is asked of the whole document, and its repeated array items are the model's to keep."""
    source = passages(["31. Hill; 32. Brook.", "Methods: aqueous solution. " + "x" * 25_000,
                       "Results: Hill 1827. Brook 1828."])
    monkeypatch.setattr(run, "load", lambda _: evidence(source))
    systems = []

    def reason(system, user, schema):
        assert "records" not in schema["properties"], "no identity inventory"
        assert f"### Record identity\n{DOCUMENT_LABEL}" in user and "Results: Hill 1827" in user
        return {claim: "NONE" for claim in schema["properties"]}

    def fields(system, user, schema):
        assert "Results: Hill 1827. Brook 1828." in user
        assert "Methods: aqueous solution." in user
        if "title" in schema["properties"]:
            return {"title": "Sites"}
        systems.append(system)
        assert "site" in schema["properties"]  # nothing is bound before the value call
        return {"entry_no": "31", "site": "Hill", "year": 1827, "finds": ["spear", "spear"]}
    result = run.extract(None, run.ExtractRequest(schema=SCHEMA, options={"strategy": "article"}),
                         Router(CountingChat(fields), CountingChat(reason)),
                         counter={role: WordCounter() for role in ("fields", "reasoning")})
    assert len(systems) == 1 and DOCUMENT in systems[0] and "Extract ONLY the record" not in systems[0]
    assert result["records"] == [{"entry_no": "31", "site": "Hill", "year": 1827, "finds": ["spear", "spear"],
                                  "title": "Sites", "filename": "beier.pdf"}]
    assert result["inventory"] == [{"identity": {}, "label": DOCUMENT_LABEL, "passages": ["p1_s0", "p1_s1", "p1_s2"]}]
    assert not result["issues"] and result["article_version"] == 7
    assert [call["stage"] for call in result["calls"]] == ["document", "record", "grounding"]
    assert all(call["counted_input_tokens"] + call["max_output_tokens"] <= call["context_tokens"]
               for call in result["calls"])
    assert not result["complete"] and result["ungrounded"]  # a model's NONE remains explicit


def test_article_grounding_does_not_lexically_accept_another_samples_unique_measurement():
    source = passages(["Hill: temperature 18.5. Brook: not measured."])
    fields = {"site": "Brook", "year": 18.5}
    seen = []
    chat = CountingChat(lambda system, user, schema: seen.append(user) or {k: "NONE" for k in schema["properties"]})
    links, calls, issues = verify(source, fields, SCHEMA, chat, record=0, budget=10,
        counter=WordCounter(), record_context="Brook")
    assert not links and len(calls) == 1 and not issues
    assert '"site": "Brook"' in seen[0] and "18.5" in seen[0]


def test_article_inventory_retains_all_passages_of_repeated_identities_and_rejects_foreign_passages():
    chat = CountingChat(lambda *_: {"records": [
        {"label": "Hill", "identity": {"site": "Hill"}, "passages": ["p1_s0"]},
        {"label": "Hill again", "identity": {"site": "Hill"}, "passages": ["p1_s1"]},
        {"label": "Brook", "identity": {}, "passages": ["p99_s1"]}]})
    identities, _, issues = inventory(passages(), SCHEMA, chat, counter=WordCounter())
    assert identities == [{"label": "Hill; Hill again", "identity": {"site": "Hill"}, "passages": ["p1_s0", "p1_s1"]}]
    assert [i.code for i in issues] == ["duplicate_inventory_record", "invalid_inventory_record"]


@pytest.mark.parametrize("attributes", [
    {"year": "1827"}, {"year": True}, {"site": ""}, {"foreign": "Hill"},
])
def test_inventory_bindings_must_be_typed_record_fields(attributes):
    chat = CountingChat(lambda *_: {"records": [{"label": "Hill", "identity": attributes, "passages": ["p1_s0"]}]})
    found, _, issues = inventory(passages(), SCHEMA, chat, counter=WordCounter())
    assert not found and issues[0].code == "invalid_inventory_record"


def test_all_identity_fields_need_no_second_extraction_and_nested_only_schemas_can_use_a_label():
    scalar = Schema(schemaNodes=[{"id": "site", "name": "site", "type": "string"}], recordDescription="A site")
    chat = CountingChat(lambda *_: pytest.fail("no remaining fields"))
    result, calls, issues = extract_record(passages(), scalar, chat, budget=1000,
        identity={"site": "Hill"}, record_name="Hill", counter=WordCounter())
    assert result == {"site": "Hill"} and not calls and not issues
    nested = Schema(schemaNodes=[{"id": "finds", "name": "finds", "type": "array", "itemType": "string"},
                                 {"id": "empty", "name": "empty", "type": "object", "children": []}],
                    recordDescription="Finds from one site")
    chat = CountingChat(lambda *_: {"records": [{"label": "Hill", "identity": {}, "passages": ["p1_s1"]}]})
    found, _, issues = inventory(passages(), nested, chat, counter=WordCounter())
    assert found == [{"label": "Hill", "identity": {}, "passages": ["p1_s1"]}] and not issues


def test_unknown_identity_attributes_do_not_drop_the_record_or_bind_its_remaining_fields():
    chat = CountingChat(lambda *_: {"records": [{"label": "Hill", "identity": {
        "site": "Hill", "year": None}, "passages": ["p1_s0"]}]})
    found, _, issues = inventory(passages(), SCHEMA, chat, counter=WordCounter())
    assert found == [{"label": "Hill", "identity": {"site": "Hill"}, "passages": ["p1_s0"]}] and not issues


def test_complete_request_including_output_reserve_is_refused_without_clipping_or_inference():
    counter = WordCounter()
    counter.context_tokens = 4100
    chat = CountingChat(lambda *_: pytest.fail("over-budget inference"))
    identities, calls, issues = inventory(passages(), SCHEMA, chat, counter=counter)
    assert not identities and not chat.calls and not calls[-1].ok
    assert "complete source was not sent" in issues[0].detail
    assert calls[-1].max_output_tokens == 4096


def test_grounding_splits_claims_while_retaining_all_evidence_and_stops_at_oversized_singletons():
    class Counter(WordCounter):
        context_tokens = 2100
        def request_tokens(self, system, user, schema=None):
            return 30 * len(schema["properties"])
    class Chat(CountingChat):
        def complete(self, **kwargs):
            return dataclasses.replace(super().complete(**kwargs),
                input_tokens=30 * len(kwargs["schema"]["properties"]))
    seen = []
    chat = Chat(lambda s, u, schema: seen.append(u) or {k: "NONE" for k in schema["properties"]})
    _, calls, issues = verify(passages(["Hill 1827", "Brook 1828"]), {"site": "Hill", "year": 1827},
        SCHEMA, chat, record=0, counter=Counter(), record_context="Hill")
    assert len(calls) == 2 and not issues
    assert all("Hill 1827" in text and "Brook 1828" in text for text in seen)
    counter = Counter()
    counter.context_tokens = 2070
    links, calls, issues = verify(passages(), {"site": "Hill"}, SCHEMA, chat, record=0,
        counter=counter, record_context="Hill")
    assert not links and not calls and issues[0].code == "grounding_exceeds_budget"


def test_article_refuses_unknown_context_and_reports_incorrect_server_counts(monkeypatch):
    counter = WordCounter()
    counter.context_tokens = None
    monkeypatch.setattr(run, "load", lambda _: evidence())
    chat = CountingChat(lambda *_: {})
    with pytest.raises(BudgetUnavailable, match="context size"):
        run.extract(None, run.ExtractRequest(schema=SCHEMA, options={"strategy": "article"}), chat,
            counter={role: counter for role in ("fields", "reasoning")})
    assert not chat.calls
    chat = CountingChat(lambda *_: Reply('{}', 999, 1, 'stop', 0))
    _, calls = complete(chat, stage="record", record=0, system="S", user="U", schema={"type": "object"},
                       max_tokens=100, counter=WordCounter())
    assert not calls[-1].ok and "server reported 999" in calls[-1].error


# A document-scope list: each find the reply lists costs `PER_FIND` reply tokens, so 2,000 do not fit 4,096.
FINDS = [f"sherd {n}" for n in range(3000)]
PER_FIND = 4


class Lister(CountingChat):
    """Answers the root with every find its context lists, cut off when its reply allowance is under `PER_FIND` tokens
    per find (or whenever `cut` says so); the document field and any grounding answer at once."""
    def __init__(self, cut=lambda user: False):
        def script(system, user, schema):
            if "finds" in schema["properties"]:
                return {"entry_no": None, "site": "Hill", "year": None,
                        "finds": [find for find in FINDS if f"{find}," in user]}
            return {"title": "Finds"} if "title" in schema["properties"] else {k: "NONE" for k in schema["properties"]}
        super().__init__(script)
        self.cut = cut

    def complete(self, *, system, user, schema, max_tokens=None):
        reply = super().complete(system=system, user=user, schema=schema, max_tokens=max_tokens)
        if "finds" in schema["properties"] and (self.cut(user) or max_tokens < PER_FIND * reply.text.count("sherd")):
            return dataclasses.replace(reply, text='{"finds": [', finish="length")
        return reply


def finds_request(**article):
    return run.ExtractRequest.model_validate({"schema": {**SCHEMA.model_dump(by_alias=True, exclude_none=True),
        "recordScope": "document"}, "options": {"strategy": "article", "article": {"grounding": "off", **article}}})


def finds_source(count, parts=1):
    """`count` finds in `parts` passages of about `2 * count / parts` words each."""
    size = count // parts
    return evidence(passages([f"Part {part}. Finds: " + " ".join(f"{find}," for find in FINDS[part * size:(part + 1) * size])
                              for part in range(parts)]))


def counters():
    return {role: WordCounter() for role in ("fields", "reasoning")}


def test_a_long_list_root_may_reply_with_the_served_context_its_input_leaves():
    """The measured failure: a 4,096-token reply cut a long list off, and its null answer became an all-null root
    under a successful run. The root's call now gets the context its counted input leaves; other calls keep theirs."""
    result = run.dispatch(None, finds_source(2000), finds_request(), Lister(), counter=counters())
    (root,) = [call for call in result["calls"] if call["stage"] == "record"]
    assert root["ok"] and root["max_output_tokens"] == WordCounter.context_tokens - root["counted_input_tokens"]
    assert root["max_output_tokens"] >= PER_FIND * 2000 > 4096
    assert result["records"][0]["finds"] == FINDS[:2000] and not result["issues"]
    (document,) = [call for call in result["calls"] if call["stage"] == "document"]
    assert document["max_output_tokens"] == 2048


def test_a_context_too_full_for_a_4096_token_reply_is_refused_before_it_is_sent():
    source = finds_source(2000)
    system, user, reply_schema = record_request(text_of(source.passages), SCHEMA, None, None, document=True)
    counter = WordCounter()
    counter.context_tokens = WordCounter().request_tokens(system, user, reply_schema) + 4000
    chat = Lister()
    with pytest.raises(RootUnanswered, match="4096 output tokens exceed the served context"):
        run.dispatch(None, source, finds_request(), chat, counter={"fields": counter, "reasoning": counter})
    assert not [call for call in chat.calls if "finds" in call["schema"]["properties"]]


def test_an_article_no_context_answered_fails_instead_of_publishing_an_all_null_root():
    """Every root call cut off: no root, so no result. One bounded context answering keeps a partial root with the
    other's `call_failed`, never complete."""
    with pytest.raises(RootUnanswered, match=r"^article_root_unanswered: none of the 1 value context\(s\) .*cut off"):
        run.dispatch(None, finds_source(2000), finds_request(), Lister(cut=lambda user: True), counter=counters())
    bounded = finds_request(context="bounded", context_tokens=8192)
    with pytest.raises(RootUnanswered, match="none of the 2 value context"):
        run.dispatch(None, finds_source(2000, 2), bounded, Lister(cut=lambda user: True), counter=counters())
    result = run.dispatch(None, finds_source(2000, 2), bounded, Lister(cut=lambda user: "Part 1." in user),
                          counter=counters())
    assert result["records"][0]["finds"] == FINDS[:1000] and result["complete"] is False
    assert [issue["code"] for issue in result["issues"]] == ["call_failed"]


def test_a_bounded_root_context_keeps_as_many_reply_tokens_as_its_request_counts():
    """Two parts of about 3,100 tokens each fit one 11,264-token request beside a 4,096-token reply, but not beside a
    reply as large as that request: each part is its own context, and its reply may use all the rest."""
    result = run.dispatch(None, finds_source(3000, 2), finds_request(context="bounded", context_tokens=11264),
                          Lister(), counter=counters())
    roots = [call for call in result["calls"] if call["stage"] == "record"]
    assert len(result["value_contexts"][0]) == len(roots) == 2
    assert sum(call["counted_input_tokens"] for call in roots) + 4096 <= 11264  # one context under a fixed reserve
    assert all(call["ok"] and call["max_output_tokens"] == 11264 - call["counted_input_tokens"]
               >= call["counted_input_tokens"] for call in roots)
    assert result["records"][0]["finds"] == FINDS
