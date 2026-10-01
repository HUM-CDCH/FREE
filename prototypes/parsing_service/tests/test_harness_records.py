"""Offline records-path checks; scripted replies are not extraction observations."""
from copy import deepcopy

import pytest

from experiments.harness.config import Config
from experiments.harness.data import case_of, resolve
from experiments.harness.evidence import entries_for
from experiments.harness.merge import Coverage, cluster, consolidate
from experiments.harness.model import Provider
from experiments.harness.run import meter_for, run_case
from kei_exp.kie.extract.llm import Reply
from tests.helpers.chat import FakeChat


class ScriptedChat(FakeChat):
    def complete(self, *, system, user, schema, max_tokens=None, **_):
        return super().complete(system=system, user=user, schema=schema, max_tokens=max_tokens)


def case(key=()):
    return case_of({"id": "rows", "group": "rows", "split": "dev", "gold": [],
        "record_key": list(key), "record_scope": "records",
        "schema": {"recordDescription": "One source row", "schemaNodes": [
            {"id": "entry_no", "name": "entry_no", "type": "integer"},
            {"id": "site", "name": "site", "type": "string"}]},
        "passages": [{"id": "p1_s0", "page": 1, "text": "7 Rome"},
                     {"id": "p2_s0", "page": 2, "text": "7 Rome"}]})


def candidate(chunk="c0", index=0, no=7, site="Rome", segment=None, **extra):
    fields = {name: {"value": value, "raw": value, "typed": True, "normalized": False,
                     "entries": [], "stats": None, "verbalized": None}
              for name, value in (("entry_no", no), ("site", site))}
    if segment:
        fields["entry_no"]["entries"] = [{"spans": [{"segment": segment, "start": 0, "end": 1}],
            "ambiguous": False, "approximate": False, "exists": True}]
    return {"chunk": chunk, "group": 0, "sample": 0, "view": "field", "index": index,
            "begins": None, "ends": None, "fields": fields, **extra}


COVERAGE = Coverage(["c0", "c1", "c2"], {}, [["entry_no", "site"]])


@pytest.mark.parametrize("chunk,index,site", [("c0", 1, "Rome"), ("c1", 0, "Rome"), ("c1", 0, " ROME ")])
def test_equal_values_never_establish_source_identity(chunk, index, site):
    rows = [candidate(), candidate(chunk, index, site=site)]
    assert len(cluster(rows, case().inference(), Config(), COVERAGE)) == 2
    assert all(r.get("identity_ambiguous") for r in rows)


def test_same_reply_and_ambiguous_citations_cannot_erase_occurrences():
    a = candidate(segment="p1_s0")
    b = candidate(index=1, segment="p1_s0")
    assert len(cluster([a, b], case().inference(), Config(), COVERAGE)) == 2
    b = candidate("c1", segment="p1_s0")
    b["fields"]["entry_no"]["entries"][0]["ambiguous"] = True
    assert len(cluster([deepcopy(a), b], case().inference(), Config(), COVERAGE)) == 2


def test_overlap_repeated_source_occurrence_keeps_both_contributions():
    rows = [candidate(segment="p1_s0"), candidate("c1", segment="p1_s0")]
    groups = cluster(rows, case(("entry_no",)).inference(), Config.model_validate({"merge": {"keys": False}}), COVERAGE)
    assert groups == [rows]
    fields = consolidate(groups[0], case().schema.record_nodes, COVERAGE)
    assert len(fields["entry_no"]["contributors"]) == len(fields["entry_no"]["entries"]) == 2


def test_a_shared_field_citation_without_declared_identity_is_only_context():
    rows = [candidate(segment="p1_s0"), candidate("c1", segment="p1_s0")]
    assert len(cluster(rows, case().inference(), Config(), COVERAGE)) == 2


def test_cross_page_continuation_is_explicit_and_requires_adjacent_source():
    cfg = Config.model_validate({"chunking": {"mode": "page"}, "merge": {"continuation": "flags"}})
    a = candidate(no=7, site=None, ends=True, primary=["p1_s0"])
    b = candidate("c1", no=None, begins=True, primary=["p2_s0"])
    groups = cluster([a, b], case().inference(), cfg, COVERAGE)
    assert len(groups) == 1
    fields = consolidate(groups[0], case().schema.record_nodes, COVERAGE)
    assert fields["entry_no"]["value"] == 7 and fields["site"]["value"] == "Rome"


def test_missing_repeated_and_conflicting_extracted_keys():
    keyed = case(("entry_no",)).inference()  # synthetic task declares document-unique numbering
    missing = [candidate(no=None), candidate("c1", no=None)]
    assert len(cluster(missing, keyed, Config(), COVERAGE)) == 2
    repeated = [candidate(), candidate(index=1), candidate("c1")]
    assert len(cluster(repeated, keyed, Config(), COVERAGE)) == 3
    assert all(r.get("identity_ambiguous") for r in repeated)
    # A declared key can hold conflicting non-key values without choosing one.
    groups = cluster([candidate(), candidate("c1", site="Paris")], keyed, Config(), COVERAGE)
    field = consolidate(groups[0], case().schema.record_nodes, COVERAGE)["site"]
    assert field["status"] == "unresolved" and len(field["alternatives"]) == 2
    assert len(cluster([candidate(), candidate("c1", no=8)], keyed, Config(), COVERAGE)) == 2


@pytest.mark.parametrize("mode", ["none", "ids"])
def test_records_schema_parsing_normalization_and_evidence_survive_assembly(mode):
    cfg = Config.model_validate({"input": {"mode": "layout"}, "evidence": {"mode": mode}})
    records = [{"entry_no": 7.0, "site": "Rome"}, {"entry_no": 7, "site": "Rome"}]
    if mode == "ids":
        records = [{name: {"value": value, "ids": [segment]} for name, value in row.items()}
                   for row, segment in zip(records, ["p1_s0", "p2_s0"], strict=True)]
    chat = ScriptedChat(lambda system, user, schema: {"records": records})
    provider = Provider(chat)
    artifact = run_case(case(), cfg, meter_for(provider, cfg))
    assert len(artifact["records"]) == 2 and artifact["coverage"]["complete"]
    assert next(f for f in artifact["fields"] if f["field"] == "entry_no")["normalized"]
    assert len([i for i in artifact["issues"] if i["code"] == "record_identity_ambiguous"]) == 2
    assert chat.calls[0]["schema"]["properties"]["records"]["items"]["required"] == ["entry_no", "site"]
    rows = [f for f in artifact["fields"] if f["field"] == "site"]
    if mode == "none":
        assert all(not f["evidence"] for f in rows)
    else:
        for row, segment in zip(rows, ["p1_s0", "p2_s0"], strict=True):
            entry = row["evidence"][0]
            assert entry["spans"] == [{"segment": segment, "start": 2, "end": 6}]
            assert resolve(case().evidence, entry["spans"][0]) == "Rome"
            assert entry["raw_spans"] == [{"segment": segment, "start": 0, "end": 6}]
            assert entry["semantic_support"] is None and entry["bbox_pt"] is None
        assert [e["path"] for e in artifact["evidence"] if e["path"][-1] == "site"] == [
            ["records", 0, "site"], ["records", 1, "site"]]


def test_evidence_ambiguity_missing_ids_and_multiple_support_spans_stay_visible():
    field = {"value": "Rome", "raw": "Rome", "quotes": ["7 Rome"], "ids": ["p1_s0", "p2_s0", "missing"]}
    quote = Config.model_validate({"evidence": {"mode": "quote"}})
    entry = entries_for(field, "Rome", case().inference(), case().evidence.passages, quote)[0]
    assert entry["ambiguous"] and entry["alternatives"]
    assert entry["semantic_support"] is None
    ids = Config.model_validate({"input": {"mode": "layout"}, "evidence": {"mode": "ids"}})
    entry = entries_for(field, "Rome", case().inference(), case().evidence.passages, ids)[0]
    assert entry["missing_ids"] == ["missing"] and not entry["exists"]
    assert len(entry["raw_spans"]) == 2 and entry["ambiguous"]


def test_evidence_from_both_pages_survives_a_justified_key_merge():
    keyed = case(("entry_no",))
    cfg = Config.model_validate({"input": {"mode": "layout"}, "chunking": {"mode": "page"}, "evidence": {"mode": "ids"}})
    def answer(system, user, schema):
        segment = "p1_s0" if "p1_s0" in user else "p2_s0"
        return {"records": [{"entry_no": {"value": 7, "ids": [segment]}, "site": {"value": "Rome", "ids": [segment]}}]}
    provider = Provider(ScriptedChat(answer))
    artifact = run_case(keyed, cfg, meter_for(provider, cfg))
    assert len(artifact["records"]) == 1
    site = next(f for f in artifact["fields"] if f["field"] == "site")
    assert [e["spans"][0]["segment"] for e in site["evidence"]] == ["p1_s0", "p2_s0"]
    assert len(site["contributors"]) == 2


def test_truncation_retains_required_processed_and_failed_source_regions():
    cfg = Config.model_validate({"input": {"mode": "layout"}, "chunking": {"mode": "page"}})
    def answer(system, user, schema):
        if "p2_s0" in user:
            return Reply('{"records":[', 10, 5, "length", 0.0)
        return {"records": [{"entry_no": 7, "site": "Rome"}]}
    provider = Provider(ScriptedChat(answer))
    artifact = run_case(case(), cfg, meter_for(provider, cfg))
    assert not artifact["coverage"]["complete"] and artifact["coverage"]["failed"] == 1
    assert [r["required_passages"] for r in artifact["ledger"]] == [["p1_s0"], ["p2_s0"]]
    assert [(region["status"], region["passages"]) for row in artifact["ledger"] for region in row["regions"]] == [
        ("processed", ["p1_s0"]), ("failed", ["p2_s0"])]


def test_free_native_grounding_and_artifact_keep_item_field_paths():
    import time

    from kei_exp.kie.extract.assembly import artifact, ground_records
    from kei_exp.kie.extract.models import as_router
    from kei_exp.kie.extract.run import ExtractRequest

    source = case()
    values = [{"entry_no": 7, "site": "Rome"}] * 2
    chat = as_router(FakeChat(lambda system, user, schema: {claim: "E1" for claim in schema["properties"]}))
    support = ground_records([([p], row) for p, row in zip(source.evidence.passages, values, strict=True)],
                             source.schema, chat, check=lambda: None, budget=24000)
    result = artifact(source.evidence, ExtractRequest(schema=source.schema), chat, started="synthetic",
                      clock=time.monotonic(), fields=values, document={}, links=support.links,
                      calls=support.calls, issues=support.issues)
    sites = [e for e in result["evidence"] if e["path"][-1] == "site"]
    assert [(e["path"], e["segment"], e["page"]) for e in sites] == [
        (["records", 0, "site"], "p1_s0", 1), (["records", 1, "site"], "p2_s0", 2)]
    assert len(result["records"]) == 2 and not result["ungrounded"]
