"""Experimental switches preserve source ownership and make uncertainty observable."""
import pytest

from kei_exp.kie.extract import assembly, run
from kei_exp.kie.extract.article import inventory, reconcile_identities
from kei_exp.kie.extract.contexts import partition, reconcile_values
from kei_exp.kie.extract.method import ArticleOptions
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.grounding import verify
from tests.test_extract_grounded import CountingChat, GLOSSED, WordCounter, run as catalog_run
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


def test_cancel_during_partition_prevents_model_calls(monkeypatch):
    monkeypatch.setattr(run, "load", lambda _: evidence(passages()))
    chat = CountingChat(lambda *_: pytest.fail("cancelled call"))
    def cancel():
        raise RuntimeError("cancelled")
    with pytest.raises(RuntimeError, match="cancelled"):
        run.extract(None, run.ExtractRequest(schema=SCHEMA, options={"strategy": "article", "article": {
            "context": "bounded"}}), chat, before_entry=cancel,
            counter={role: WordCounter() for role in ("fields", "reasoning")})


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


def test_catalog_verification_off_keeps_candidates_proposed_not_grounded(tmp_path):
    result, _, _ = catalog_run("two-in-one-segment", tmp_path, factors={"verification": False})
    assert result["raw_candidates"]
    assert result["records"][0]["mbl_old"] is None
    assert any(item["reason"] == "verification_disabled" for item in result["proposed"])
    assert not result["completeness"]["grounding"] and not result["complete"]
    assert not any(link["path"][-1] == "mbl_old" for link in result["evidence"])


def test_catalog_heading_factor_disables_inheritance_and_changes_prompt(tmp_path):
    enabled, enabled_chat, _ = catalog_run("headings", tmp_path / "on", factors={})
    disabled, disabled_chat, _ = catalog_run("headings", tmp_path / "off", factors={"headings": False})
    assert enabled["fingerprint"] != disabled["fingerprint"]
    assert enabled["records"][0]["kreis"] and disabled["records"][0]["kreis"] is None
    assert "### Headings" in enabled_chat.calls[0]["user"]
    assert "### Headings" not in disabled_chat.calls[0]["user"]


def test_catalog_glossary_factor_changes_context_and_normalization_only(tmp_path):
    enabled, on, _ = catalog_run(GLOSSED, tmp_path / "on", factors={})
    disabled, off, _ = catalog_run(GLOSSED, tmp_path / "off", factors={"glossary": False})
    assert enabled["records"] == disabled["records"]
    assert any("### Glossary" in call["user"] for call in on.calls)
    assert not any("### Glossary" in call["user"] for call in off.calls)
    assert any(link["normalized"] for link in enabled["evidence"])
    assert all(link["normalized"] is None for link in disabled["evidence"])
    assert disabled["normalization"]["rules"] == []


def test_catalog_overlap_factor_removes_neighbors_without_changing_primary_entries(tmp_path):
    enabled, on, _ = catalog_run("two-in-one-segment", tmp_path / "on", factors={})
    disabled, off, _ = catalog_run("two-in-one-segment", tmp_path / "off", factors={"overlap": False})
    assert enabled["record_blocks"] == disabled["record_blocks"]
    assert enabled["coverage"] == disabled["coverage"]
    assert enabled["records"] == disabled["records"]
    assert on.calls[0]["user"] != off.calls[0]["user"]
