"""Article reads one document root with complete input and served-token admission; the inventory of
noncontiguous records it used to take stays for the research replays and is tested here as a unit."""
import dataclasses

import pytest

from kei_exp.kie.extract import run
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.llm import Reply
from kei_exp.kie.extract.article import DOCUMENT_LABEL, inventory
from kei_exp.kie.extract.calls import complete
from kei_exp.kie.extract.grounding import verify
from kei_exp.kie.extract.stages import DOCUMENT, extract_record
from kei_exp.kie.extract.schema import Schema
from kei_exp.kie.extract.tokens import BudgetUnavailable
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
    assert not result["issues"] and result["article_version"] == 3
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
