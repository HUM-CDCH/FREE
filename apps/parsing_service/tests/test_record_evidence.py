"""Attribution context must be source-backed and must not make a wrong value acceptable."""
import pytest

from kei_exp.kie.extract import grounding, unified
from kei_exp.kie.extract.assembly import link_json
from kei_exp.kie.extract.discovery import Unit, Window
from kei_exp.kie.extract.models import as_router
from kei_exp.kie.extract.schema import Schema
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import passages
from tests.test_unified_catalog import candidate, evidence, extract, Model


def test_record_evidence_shares_the_source_but_reserves_the_complete_reply():
    import json
    fields = {f"field{n}": f"value{n}" for n in range(16)}
    schema = Schema.model_validate({"recordDescription": "One record", "schemaNodes": [
        {"id": key, "name": key, "type": "string"} for key in fields]})
    source = passages([" ".join(fields.values())] + ["Other source"] * 1000)
    seen = []
    class Chat(CountingChat):
        def complete(self, **kwargs):
            seen.append(kwargs)
            return super().complete(**kwargs)
    def answer(system, user, reply_schema):
        return {key: {"label": "E1", "context": [], "attribution": True} for key in reply_schema["properties"]}
    links, calls, issues = grounding.verify(source, fields, schema, Chat(answer), record=0, projected=True,
                                            counter=WordCounter())
    assert len(calls) == len(seen) == 1 and len(links) == 16 and not issues
    longest = {key: {"label": "E1001", "context": ["E1001"] * 8, "attribution": False}
               for key in seen[0]["schema"]["properties"]}
    assert seen[0]["max_tokens"] >= len(json.dumps(longest).encode("utf-8")) > 2048


def test_article_retains_separate_identity_evidence_and_rejects_unattested_or_invented_context():
    source = passages(["Author A¹", "¹ Institute B, Country C"])
    schema = Schema.model_validate({"recordDescription": "authors", "schemaNodes": [
        {"id": "a", "name": "authors", "type": "array", "children": [
            {"id": "n", "name": "name", "type": "string"},
            {"id": "i", "name": "institution", "type": "string"}]}]})
    fields = {"authors": [{"name": "Author A", "institution": "Institute B"}]}
    for extra, attested, accepted in [(["E1"], True, True), (["E99"], True, False), (["E1"], False, False)]:
        def answer(system, user, reply_schema):
            assert 'relationship to THIS record' in system and 'Author A' in user
            return {"C1": {"label": "E2", "context": extra, "attribution": attested}}
        links, _, _ = grounding.verify(source, fields, schema, CountingChat(answer), record=0, projected=True,
                                       located=True, skip_paths=frozenset({("records", 0, "authors", 0, "name")}))
        assert bool(links) == accepted
        if accepted:
            assert link_json(links[0])["context"] == [{"segment": source[0].id, "start": 0, "end": len(source[0].text)}]
            assert links[0].location["raw"] == "Institute B"


@pytest.mark.parametrize("reply", [{}, {"C1": {"context": [], "attribution": False}}])
def test_unanswered_record_claim_remains_incomplete(reply):
    schema = Schema.model_validate({"recordDescription": "One record", "schemaNodes": [
        {"id": "n", "name": "name", "type": "string"}]})
    links, _, issues = grounding.verify(passages(["Name A"]), {"name": "Name A"}, schema,
                                       CountingChat(lambda *_: reply), record=0, projected=True)
    assert not links
    assert [(issue.code, issue.path) for issue in issues] == [("missing_claim", ("records", 0, "name"))]


@pytest.mark.parametrize("reading,accepted", [(candidate("North", "Jail North"), True),
                                              (candidate("South", "Jail South"), False), (None, False)])
def test_heading_recovery_checks_intervening_source_even_when_discovery_misassigns_it(reading, accepted):
    text = "Jail North\n1. First.\nJail South\n2. Second, owner lives in North."
    source = evidence(text)
    schema = Schema.model_validate({"recordDescription": "One prisoner", "schemaNodes": [
        {"id": "j", "name": "jail", "type": "string"}]})
    seen = []
    def answer(system, user, reply_schema):
        seen.append(user)
        assert user.index("Jail North") < user.index("Jail South") < user.index("### RECORD")
        assert 'supersedes' in system
        assert ' = "North"' not in user  # the independent reading cannot copy the candidate
        return {"C1": reading}
    chat = as_router(CountingChat(answer))
    options = unified.UnifiedOptions(defaults=11)
    counters = dict.fromkeys(("fields", "reasoning"), WordCounter())
    effective = unified._execution(source, schema, options, chat, counters)["effective"]
    runner = unified._Run(schema, unified._Budget(chat, counters, effective["stages"]), {"p1_s0": text}, effective)
    start = text.index("2.")
    entry = {"ranges": [{"segment": "p1_s0", "start": start, "end": len(text)}],
             "context": [{"segment": "p1_s0", "start": 0, "end": 10}]}
    units = [Unit("p1_s0", start, len(text))]
    work = unified._Work(found=[unified._Found(("jail",), "North", "Jail North", 0,
                                               kind="rejected", reason="quote_not_in_source")])
    replies = runner._record_evidence(entry, [(Window(tuple(units)), {})], work, unified._view(units, runner.texts))
    runner._verify(0, replies, work)
    assert seen and (work.found[0].kind == "accepted") == accepted
    assert work.found[0].value == "North"
    if accepted:
        link = unified._link(work.found[0], 0, {p.id: p for p in source.passages})
        assert link["context"] == entry["ranges"] and link["linked_by"] == "verification"


def test_new_catalog_defaults_run_attachment_through_the_real_entry_path():
    source = evidence("Kreis Moor\n1. Adorf.")
    schema = {"recordDescription": "One numbered entry", "schemaNodes": [{"id": "r", "name": "region", "type": "string"}]}
    model = Model(source, entry=lambda *_: {"region": candidate("Moor", "Kreis Moor")})
    def answer(system, user, reply_schema):
        if system.startswith("Read the source independently"):
            return {"C1": candidate("Moor", "Kreis Moor")}
        return model(system, user, reply_schema)
    result, _ = extract(source, answer, schema=schema, defaults=11)
    assert result["records"] == [{"region": "Moor"}]
    assert result["evidence"][0]["context"] == result["discovery"]["entries"][0]["ranges"]
    assert result["evidence"][0]["linked_by"] == "verification"
