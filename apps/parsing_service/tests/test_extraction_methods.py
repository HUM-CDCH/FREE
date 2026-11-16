"""Experimental switches preserve source ownership and make uncertainty observable."""
import pytest

from kei_exp.kie.extract import assembly, run
from experiments.extraction.legacy_article import inventory, reconcile_identities, reconcile_values
from kei_exp.kie.extract.contexts import partition
from kei_exp.kie.extract.method import ArticleOptions
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.grounding import verify
from tests.helpers import article_options
from tests.helpers.contracts import fixture
from tests.helpers.extraction import CountingChat, WordCounter
from tests.test_extract_stages import SCHEMA, evidence, passages


def test_same_name_partial_keys_do_not_collapse_distinct_subjects():
    method = ArticleOptions(identity="conservative", identity_fields=("site", "year"))
    items = [{"label": label, "identity": {"site": "Edouard"}, "passages": ["p1_s0"]}
             for label in ("Edouard in Paris", "Edouard in Lyon")]
    found, _, issues = inventory(passages(), SCHEMA, CountingChat(lambda *_: {"records": items}),
                                 counter=WordCounter(), method=method)
    assert len(found) == 2
    assert [issue.code for issue in issues] == ["partial_identity", "partial_identity"]
    items = [{"label": "Hill", "identity": {"site": "Hill", "year": 1827}, "passages": [ref]}
             for ref in ("p1_s0", "p1_s1")]
    merged, issues = reconcile_identities(items, method)
    assert len(merged) == 1 and merged[0]["passages"] == ["p1_s0", "p1_s1"] and not issues
    items[1]["identity"]["year"] = 1828
    assert len(reconcile_identities(items, method)[0]) == 2


def test_context_primary_ownership_is_exhaustive_and_overlap_never_owns_or_cuts():
    source = passages(["one", "two", "table " * 100, "late"])
    contexts = partition(source, lambda group: sum(len(p.text) for p in group) <= 9, overlap=1)
    assert [p for context in contexts for p in context.primary] == source
    assert any(context.primary == (source[2],) for context in contexts)
    assert all(p in source for context in contexts for p in context.passages)
    assert contexts[-1].primary[0].text == "late"


def test_conflicts_remain_null_even_when_a_third_window_repeats_one_candidate():
    fields, conflicts = reconcile_values([{"year": 1827, "items": ["a"]}, {"year": 1828, "items": ["b"]},
                                          {"year": 1827, "items": ["a"]}])
    assert fields == {"year": None, "items": ["a", "b"]}
    assert conflicts == [{"path": ["year"], "candidates": [1827, 1828]}]


@pytest.mark.parametrize("settings", [
    {"identity": "conservative"}, {"overlap_passages": 1}, {"context_tokens": 100},
    {"identity_fields": ["site", "site"]}, {"grounding": "guess"}, {"unknown": True},
])
def test_invalid_method_settings_are_rejected(settings):
    with pytest.raises(ValueError):
        ArticleOptions(**settings)


def test_options_validate_schema_identity_fields_and_change_fingerprint():
    with pytest.raises(ValueError, match="scalar record fields"):
        run.ExtractRequest(schema=SCHEMA, options={"strategy": "article", "article": {"identity_fields": ["nope"]}})
    base = run.ExtractRequest(schema=SCHEMA, options={"strategy": "article"})
    selected = run.ExtractRequest(schema=SCHEMA, options={"strategy": "article", "article": {"grounding": "off"}})
    assert "article" not in base.options.dumped()
    assert assembly.fingerprint({"generation": "g", "digest": "d"}, base, {}) != assembly.fingerprint(
        {"generation": "g", "digest": "d"}, selected, {})


def test_bounded_pipeline_reaches_late_evidence_and_never_claims_measured_recall(monkeypatch):
    source = passages(["Hill " + "context " * 3000, "methods " * 3000, "Late result: Hill 1827."])
    monkeypatch.setattr(run, "load", lambda _: evidence(source))
    def reason(system, user, schema):
        assert "starting materials" not in system
        return {"records": [{"label": "Hill", "identity": {"site": "Hill"},
                             "passages": [p.id for p in source if f"[{p.id}]" in user][:1]}]}
    def fields(system, user, schema):
        return {"year": 1827 if "Late result" in user else None}
    request = run.ExtractRequest(schema=SCHEMA, options={"strategy": "article", "article": {
        "context": "bounded", "context_tokens": 8192, "identity": "conservative", "identity_fields": ["site"],
        "prompt": "schema", "grounding": "off"}})
    result = run.extract(None, request, Router(CountingChat(fields), CountingChat(reason)),
                         counter={role: WordCounter() for role in ("fields", "reasoning")})
    assert result["records"][0]["year"] == 1827 and len(result["contexts"]) >= 2
    assert not result["complete"] and result["completion"]["record_recall"] == "unmeasured"
    assert result["completion"]["grounding"] == "disabled" and not result["evidence"] and result["ungrounded"]
    assert all(c["counted_input_tokens"] + c["max_output_tokens"] <= 8192 for c in result["calls"])


@pytest.mark.parametrize("quote,attribution,accepted", [("Hill 1827", True, True),
                                                      ("invented sentence", True, False),
                                                      ("Hill 1827", False, False)])
def test_quoted_verifier_requires_source_substring_and_attribution(quote, attribution, accepted):
    chat = CountingChat(lambda s, u, schema: {claim: {"label": "E1", "quote": quote, "attribution": attribution}
                                             for claim in schema["properties"]})
    links, _, issues = verify(passages(["Hill 1827"]), {"year": 1827}, SCHEMA, chat, record=0,
                              counter=WordCounter(), record_context="Hill", quoted=True)
    assert bool(links) is accepted
    assert bool(issues) is not accepted










def test_contract_cases_and_their_dumps_match_the_shared_fixture():
    shared = fixture("article-options")
    for case in shared["cases"]:
        assert article_options.accepted(case["input"]) is case["accepted"], case["id"]
        if case["accepted"]:
            assert ArticleOptions.model_validate(case["input"]).model_dump(mode="json") == case["canonical"], case["id"]
    assert len(shared["cases"]) == 20


def test_categorical_inventory_verdicts_match_the_shared_fixture():
    inventory = fixture("article-options")["inventory"]
    assert article_options.verdicts(inventory) == inventory["verdicts"]
    # The specification's receipt (contract-check.json) pins 1560/4584 at one ceiling and key set; `grounding_overflow`
    # doubles the inventory and is refused with grounding off.
    assert (inventory["accepted"], inventory["rejected"]) == (3016, 9272)


def test_identity_fields_are_checked_against_the_schema_as_the_shared_fixture_says():
    shared = fixture("identity-fields")
    for case in shared["cases"]:
        options = {"strategy": "article", "article": {"identity_fields": case["fields"]}}
        if not case["issues"]:
            run.ExtractRequest(schema=shared["schema"], options=options)
            continue
        with pytest.raises(ValueError) as refused:
            run.ExtractRequest(schema=shared["schema"], options=options)
        assert str(sorted(issue["name"] for issue in case["issues"])) in str(refused.value)
