"""Origin hints may be wrong; routed verification must retain unresolved coverage."""
from dataclasses import replace

import pytest

from kei_exp.kie.extract import run
from kei_exp.kie.extract.contexts import Context, reconcile_values
from kei_exp.kie.extract.method import ArticleOptions
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.grounding import spans
from kei_exp.kie.extract.routing import rank_units, value_origins, verify_routed
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_extract_stages import SCHEMA, evidence, passages
from tests.test_extraction_rendering import table_passage


def test_origins_follow_reconciled_array_items_and_never_equal_values_in_other_fields():
    a, b = {"label": "A", "value": 37}, {"label": "B", "value": 37}
    candidates = [{"site": "Hill", "year": 1800, "items": [a], "other": {"left": 37}},
                  {"site": "Hill", "year": 1801, "items": [b, a], "other": {"right": 37}}]
    merged, conflicts = reconcile_values(candidates)
    assert merged["year"] is None and conflicts
    origins = {tuple(item["path"]): item for item in value_origins(candidates, merged, {"site": "Hill"}, ["p1_s0"])}
    assert ("year",) not in origins
    assert origins[("site",)] == {"path": ["site"], "kind": "inventory", "passages": ["p1_s0"]}
    assert origins[("items", 0, "value")]["sources"] == [
        {"unit": 0, "path": ["items", 0, "value"]}, {"unit": 1, "path": ["items", 1, "value"]}]
    assert origins[("items", 1, "value")]["sources"] == [{"unit": 1, "path": ["items", 0, "value"]}]
    assert origins[("other", "left")]["sources"] == [{"unit": 0, "path": ["other", "left"]}]
    assert origins[("other", "right")]["sources"] == [{"unit": 1, "path": ["other", "right"]}]


def test_single_reply_preserves_duplicate_array_positions_and_rejects_untraceable_values():
    fields = {"finds": ["same", "same"], "blank": None, "flag": False}
    origins = value_origins([fields], fields, {}, [])
    assert [item["sources"] for item in origins] == [
        [{"unit": 0, "path": ["finds", 0]}], [{"unit": 0, "path": ["finds", 1]}]]
    with pytest.raises(ValueError, match="no extraction origin"):
        value_origins([fields], {"year": 1800}, {}, [])


def fixture():
    source = passages(["Hill background", "Other subject: year 1827", "Hill: eighteen twenty-seven"])
    contexts = [Context((p,)) for p in source]
    fields = {"site": "Hill", "year": 1827}
    origins = value_origins([fields], fields, {"site": "Hill"}, [source[0].id])
    return source, contexts, fields, origins


def test_origin_and_lexical_order_retain_every_unit_including_normalized_late_support():
    _, contexts, fields, origins = fixture()
    ranked = rank_units(contexts, [contexts[0]], origins[1], fields["year"], "year")
    assert ranked["order"] == [0, 1, 2]
    assert ranked["origin_units"] == [0] and ranked["value_match_units"] == [1]


def test_routing_batches_shared_candidates_and_finds_support_in_exhaustive_fallback():
    source, contexts, fields, origins = fixture()
    def reason(system, user, schema):
        first = "p1_s0@" in user
        late = "p1_s2@" in user
        return {claim: {"label": (f"{source[0].id}@0:{len(source[0].text)}"
                       if first and f"{claim} (site)" in user else
                       f"{source[2].id}@0:{len(source[2].text)}" if late else "NONE"), "attribution": True}
                for claim in schema["properties"]}
    chat = CountingChat(reason)
    links, calls, issues, routes = verify_routed(contexts, fields, SCHEMA, chat,
        origins=origins, value_contexts=[contexts[0]], record=3, counter=WordCounter(),
        verifier=spans, record_context="Hill")
    assert not issues and len(calls) == 3
    assert [len(call["schema"]["required"]) for call in chat.calls] == [2, 1, 1]
    assert [(link.path, link.segment) for link in links] == [
        (("records", 3, "site"), source[0].id), (("records", 3, "year"), source[2].id)]
    assert routes[0]["attempted"] == [0] and set(routes[0]["remaining"]) == {1, 2}
    assert routes[1]["attempted"] == [0, 1, 2] and routes[1]["remaining"] == []
    assert all(route["supported"] and route["coverage"] == "stopped_after_support" for route in routes)


@pytest.mark.parametrize("outcome", ["NONE", "missing", "invalid", "negative", "truncated"])
def test_unsuccessful_decisions_never_stop_fallback(outcome):
    source, contexts, _, origins = fixture()
    def reason(system, user, schema):
        if outcome == "missing":
            return {}
        return {claim: {"label": "absent" if outcome == "invalid" else
                       f"{source[0].id}@0:{len(source[0].text)}" if outcome == "negative" else "NONE",
                       "attribution": outcome != "negative"} for claim in schema["properties"]}
    class ReplyChat(CountingChat):
        def complete(self, **kwargs):
            reply = super().complete(**kwargs)
            return replace(reply, finish="length") if outcome == "truncated" else reply
    chat = ReplyChat(reason)
    links, calls, issues, routes = verify_routed(contexts, {"year": 1827}, SCHEMA, chat,
        origins=origins, value_contexts=[contexts[0]], record=0, counter=WordCounter(),
        verifier=spans, record_context="Hill")
    assert not links and len(calls) == 3 and bool(issues) == (outcome != "NONE")
    assert routes[0]["attempted"] == [0, 1, 2] and routes[0]["remaining"] == []
    assert routes[0]["coverage"] == "attempted_all" and not routes[0]["supported"]


def test_refused_units_are_distinct_from_attempts_and_cancellation_is_retained():
    _, contexts, _, origins = fixture()
    class Counter(WordCounter):
        def request_tokens(self, system, user, schema=None):
            return self.context_tokens if "p1_s0@" in user else super().request_tokens(system, user, schema)
    chat = CountingChat(lambda s, u, schema: {claim: {"label": "NONE", "attribution": False}
                                            for claim in schema["properties"]})
    _, calls, issues, routes = verify_routed(contexts, {"year": 1827}, SCHEMA, chat,
        origins=origins, value_contexts=[contexts[0]], record=0, counter=Counter(),
        verifier=spans, record_context="Hill")
    assert len(calls) == 2 and issues[0].code == "grounding_exceeds_budget"
    assert routes[0]["refused"] == [0] and routes[0]["attempted"] == [1, 2]
    assert routes[0]["remaining"] == [] and routes[0]["coverage"] == "partial"
    def cancel():
        raise RuntimeError("cancelled")
    with pytest.raises(RuntimeError, match="cancelled"):
        verify_routed(contexts, {"year": 1827}, SCHEMA, chat, origins=origins,
            value_contexts=[contexts[0]], record=0, counter=Counter(), verifier=spans,
            record_context="Hill", before_call=cancel)
    assert len(chat.calls) == 2


def test_routing_preserves_table_header_and_qualifier_context_and_skips_policy_paths():
    table = table_passage()
    heading = replace(passages(["Measurements in water"], page=2)[0], label="SectionHeader")
    context = Context((table,), heading=heading)
    fields = {"year": 37, "site": "A"}
    origins = value_origins([fields], fields, {}, [])
    proofs = []
    chat = CountingChat(lambda s, u, schema: {claim: {"label": "p1_s0/r2_c0", "attribution": True}
                                            for claim in schema["properties"]})
    links, _, issues, routes = verify_routed([context], fields, SCHEMA, chat,
        origins=origins, value_contexts=[context], record=0, counter=WordCounter(),
        verifier=spans, record_context="A", proofs=proofs, skip_paths=frozenset({("records", 0, "site")}))
    assert not issues and [link.path for link in links] == [("records", 0, "year")]
    assert len(routes) == 1 and "Measurements in water" in chat.calls[0]["user"]
    assert "colspan=2" in chat.calls[0]["user"] and "in water" in chat.calls[0]["user"]
    assert proofs[0]["cell"] == "r2_c0" and proofs[0]["quote"] == "37"


def test_assembled_routing_changes_only_grounding_and_publishes_origin_paths(monkeypatch):
    source = passages(["Hill background", "Hill year 1827"])
    contexts = [Context((p,)) for p in source]
    monkeypatch.setattr(run, "load", lambda _: evidence(source))
    monkeypatch.setattr("kei_exp.kie.extract.article.source_contexts", lambda *_: contexts)
    monkeypatch.setattr("kei_exp.kie.extract.article.partition", lambda *_args, **_kwargs: contexts)
    def reason(system, user, schema):
        if "records" in schema["properties"]:
            offered = schema["properties"]["records"]["items"]["properties"]["passages"]["items"]["enum"]
            return {"records": [{"label": "Hill", "identity": {"site": "Hill"}, "passages": offered}]}
        return {claim: {"label": prop["properties"]["label"]["enum"][0], "attribution": True}
                for claim, prop in schema["properties"].items()}
    results, requests = [], []
    for routing in (None, "origin_lexical"):
        values = CountingChat(lambda s, u, schema: {"year": 1827 if "1827" in u else None})
        reasoning = CountingChat(reason)
        request = run.ExtractRequest(schema=SCHEMA, options={"strategy": "article", "article": {
            "context": "bounded", "identity": "conservative", "identity_fields": ["site"],
            "grounding": "spans", "grounding_schedule": "unresolved", "grounding_routing": routing}})
        results.append(run.extract(None, request, Router(values, reasoning),
            counter={role: WordCounter() for role in ("fields", "reasoning")}))
        requests.append(values.calls + [call for call in reasoning.calls if "### Claims" not in call["user"]])
    plain, routed = results
    assert requests[0] == requests[1] and plain["records"] == routed["records"]
    assert plain["fingerprint"] != routed["fingerprint"] and "value_origins" not in plain
    assert routed["grounding_routing_version"] == 1
    assert routed["value_origins"][1] == {"path": ["records", 0, "year"], "kind": "value",
        "sources": [{"unit": 1, "path": ["year"]}]}
    assert routed["grounding_routes"][1]["attempted"] == [1]


@pytest.mark.parametrize("settings", [{"grounding": "off"}, {"grounding": "spans"},
    {"grounding": "semantic", "grounding_schedule": "unresolved"}])
def test_routing_requires_an_explicit_unresolved_quoted_method(settings):
    with pytest.raises(ValueError, match="routing requires"):
        ArticleOptions(grounding_routing="origin_lexical", **settings)
    assert "grounding_routing" not in ArticleOptions().model_dump()
