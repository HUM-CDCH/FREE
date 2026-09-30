"""The harness stages, each option shown to change behaviour: chunking, retrieval, groups, recovery, evidence, verification,
merging, sampling and signals, against a scripted reader on the synthetic catalogue. All of it is mocked; the live checks
are in test_harness_live.py."""
from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import replace

import pytest

from experiments.harness import synth
from experiments.harness.config import Config
from experiments.harness.data import case_of
from experiments.harness.evaluate import Eval, check_invariants, metrics, pool, score_case
from experiments.harness.model import Provider
from experiments.harness.run import meter_for, run_case
from tests.helpers.harness_chat import Reader

RULES = Eval()


def make(records: int = 6, **kwargs):
    return case_of(synth.catalogue("c", records=records, **kwargs))


def run(case, config: dict | None = None, reader: Reader | None = None, cache=None):
    cfg = Config.model_validate(config or {})
    reader = reader or Reader()
    provider = Provider(reader, cache=cache)
    return run_case(case, cfg, meter_for(provider, cfg)), reader


def scored(case, artifact):
    counts, outcomes = score_case(case, artifact, RULES)
    assert check_invariants(counts) == []
    return defaultdict(int, counts), outcomes


def status(artifact, record: int, field: str) -> str:
    return next(r for r in artifact["fields"] if r["record"] == record and r["field"] == field)["status"]


def test_the_baseline_reads_the_whole_document_and_every_value_is_right():
    case = make()
    artifact, reader = run(case)
    counts, _ = scored(case, artifact)
    assert len(reader.calls) == 1 and artifact["coverage"]["complete"] and artifact["coverage"]["recall"] == "unmeasured"
    assert counts["tp"] == counts["gold_value_fields"] and counts["absent_ok"] == counts["gold_absent_fields"]
    assert artifact["cost"]["fresh"]["calls"] == 1 and artifact["cost"]["replayed"]["calls"] == 0
    assert artifact["records"][0]["entry_no"] == 40


# --- chunking, retrieval, ledger ------------------------------------------------------------------------------------

def _chunks(case, **chunking):
    from experiments.harness.extract import chunks_of
    return chunks_of(list(case.evidence.passages), Config.model_validate({"chunking": chunking}))


def test_chunking_modes_cut_the_source_as_named():
    case = make()
    ids = [p.id for p in case.evidence.passages]
    whole = _chunks(case, mode="whole")
    assert len(whole) == 1 and [p.id for p in whole[0].context.primary] == ids
    fixed = _chunks(case, mode="fixed", max_chars=200)
    assert len(fixed) > 1 and [p.id for c in fixed for p in c.context.primary] == ids        # disjoint and complete
    assert all(not c.context.overlap for c in fixed)
    overlapped = _chunks(case, mode="fixed", max_chars=200, overlap=1)
    assert [p.id for c in overlapped for p in c.context.primary] == ids
    assert overlapped[1].context.overlap[-1].id == overlapped[0].context.primary[-1].id       # the previous tail, as context
    pages = _chunks(case, mode="page", max_chars=2000)
    assert [{p.page for p in c.context.primary} for c in pages] == [{1}, {2}]
    with_tail = _chunks(case, mode="page", max_chars=2000, overlap=1)
    assert with_tail[1].context.overlap[0].page == 1                                            # overlap may cross the page


def test_overlap_is_applied_on_top_of_the_chunk_budget_in_every_chunking_mode():
    case = case_of(synth.catalogue("tight", records=8, seed=8))         # a primary that nearly fills max_chars: no room left for overlap
    for mode in ("fixed", "structure", "page"):
        plain, over = _chunks(case, mode=mode, max_chars=300), _chunks(case, mode=mode, max_chars=300, overlap=1)
        assert len(over) > 1 and [c.context.primary for c in plain] == [c.context.primary for c in over]          # the primary text does not move
        assert not over[0].context.overlap and all(not c.context.overlap for c in plain)
        assert all(c.context.overlap == (plain[i - 1].context.primary[-1],) for i, c in enumerate(over) if i), mode   # the previous tail, always


def test_structure_chunks_keep_a_table_with_its_caption_where_fixed_chunks_split_them():
    passages = [{"id": "p1_s0", "page": 1, "text": "Intro " + "x" * 140, "label": "Text"},
                {"id": "p1_s1", "page": 1, "text": "Table 1. Finds by site", "label": "Caption"},
                {"id": "p1_s2", "page": 1, "text": "Aue 3\nBach 4 " + "y" * 62, "label": "Table"},
                {"id": "p1_s3", "page": 1, "text": "After " + "z" * 90, "label": "Text"}]
    inline = synth.catalogue("t")
    case = case_of({**inline, "passages": passages, "gold": []})
    def held_together(chunks):
        return any({"p1_s1", "p1_s2"} <= {p.id for p in c.context.primary} for c in chunks)
    assert not held_together(_chunks(case, mode="fixed", max_chars=200))
    assert held_together(_chunks(case, mode="structure", max_chars=200))


def test_lexical_retrieval_keeps_a_budget_and_the_ledger_never_calls_it_complete():
    case = make()
    exhaustive, _ = run(case, {"chunking": {"mode": "fixed", "max_chars": 200}})
    assert exhaustive["coverage"]["complete"] and exhaustive["coverage"]["exhaustive"]
    picked, reader = run(case, {"chunking": {"mode": "fixed", "max_chars": 200}, "retrieval": {"mode": "lexical", "top_k": 1}})
    coverage = picked["coverage"]
    assert len(reader.calls) == 1 and coverage["not_retrieved"] == coverage["chunks"] - 1 and not coverage["complete"]
    assert not coverage["exhaustive"] and coverage["recall"] == "unmeasured"
    assert all(row["score"] is not None for row in picked["ledger"]) and {"top_k", "skipped"} <= {r["retrieval"] for r in picked["ledger"]}
    counts, _ = scored(case, picked)
    assert counts["fn_missing_record"] > 0 or counts["missing_records"] > 0        # skipped chunks' records are missing, not absent
    wider, more = run(case, {"chunking": {"mode": "fixed", "max_chars": 200}, "retrieval": {"mode": "lexical", "top_k": 1, "expand": 1}})
    assert len(more.calls) > 1 and {r["retrieval"] for r in wider["ledger"]} & {"expanded"}     # expansion is separately visible


def test_a_provider_failure_is_a_failed_region_on_the_ledger_and_its_records_are_missing():
    case = make()
    artifact, reader = run(case, {"chunking": {"mode": "fixed", "max_chars": 200}}, Reader(raise_at={0}))
    assert artifact["coverage"]["failed"] == 1 and not artifact["coverage"]["complete"]
    assert artifact["issues"][0]["code"] == "region_failed" and "connection refused" in artifact["issues"][0]["detail"]
    assert artifact["cost"]["fresh"]["failed"] == 1                                     # the failed call still cost its slot
    counts, _ = scored(case, artifact)
    assert counts["missing_records"] > 0 and counts["tp"] > 0                          # the other chunks still count


def test_malformed_truncated_and_schema_invalid_replies_fail_their_region_and_lower_the_valid_rate():
    case = make()
    for knob, reason in (("garbage_at", "did not return JSON"), ("truncate_at", "cut off"), ("invalid_at", "does not match the schema")):
        artifact, _ = run(case, {"chunking": {"mode": "fixed", "max_chars": 200}}, Reader(**{knob: {0}}))
        assert artifact["coverage"]["failed"] == 1 and reason in artifact["issues"][0]["detail"], knob
        assert artifact["validity"]["valid"] == artifact["validity"]["total"] - 1
        counts, _ = scored(case, artifact)
        assert metrics(pool([counts]))["validity"]["schema_valid_reply_rate"] < 1.0


def test_retries_are_new_requests_and_a_failed_first_attempt_is_not_replayed_from_the_cache(tmp_path):
    case = make()
    config = {"recovery": {"retries": 1}}
    artifact, reader = run(case, config, Reader(garbage_at={0}), cache=tmp_path)
    assert len(reader.calls) == 2 and artifact["coverage"]["complete"] and artifact["validity"] == {"total": 2, "valid": 1}
    assert artifact["ledger"][0]["calls"] == 2
    again, second = run(case, config, Reader(), cache=tmp_path)                       # same cache, a healthy reader
    assert len(second.calls) == 0 and again["cost"]["replayed"]["calls"] == 2         # both attempts replay, in order, as recorded
    counts, _ = scored(case, artifact)
    assert counts["tp"] == counts["gold_value_fields"]


def test_subdividing_after_a_cut_off_reply_halves_the_fields_and_reads_the_same_source():
    case = make()
    artifact, reader = run(case, {"recovery": {"subdivide": True}}, Reader(truncate_at={0}))
    assert len(reader.calls) == 3 and artifact["coverage"]["complete"]                   # the cut call, then two smaller ones
    first, second = (set(c["schema"]["properties"]["records"]["items"]["properties"]) for c in reader.calls[1:])
    assert first | second == {"entry_no", "site", "kreis", "finds", "date"} and "entry_no" in first & second   # the key joins them
    counts, _ = scored(case, artifact)
    assert counts["tp"] == counts["gold_value_fields"]
    assert artifact["ledger"][0]["recovered_from"] and artifact["ledger"][0]["calls"] == 3
    assert artifact["validity"] == {"total": 3, "valid": 2}                                # the cut-off reply counts as an invalid one
    without, _ = run(case, {}, Reader(truncate_at={0}))
    assert without["coverage"]["failed"] == 1                                             # no recovery: the region stays failed


def test_output_constraint_and_recovery_are_separate_switches():
    case = make()
    native, reader = run(case, {"output": {"constraint": "schema"}})
    assert isinstance(reader.calls[0]["schema"], dict) and "JSON matching this schema" not in reader.calls[0]["system"]
    prompted, reader = run(case, {"output": {"constraint": "prompt"}})
    assert reader.calls[0]["schema"] is None and "JSON matching this schema" in reader.calls[0]["system"]
    assert native["records"] == prompted["records"]                                       # the mode changes the request, not the reading
    bad, _ = run(case, {"output": {"constraint": "prompt"}}, Reader(invalid_at={0}))
    assert bad["coverage"]["failed"] == 1                                                  # local validation applies without a constraint


def test_field_groups_join_on_the_key_and_a_failed_group_omits_its_fields_instead_of_calling_them_absent():
    case = make()
    groups = {"decompose": {"mode": "groups", "groups": [["entry_no", "site"], ["kreis", "finds", "date"]]}}
    artifact, reader = run(case, groups)
    assert len(reader.calls) == 2 and "entry_no" in reader.calls[1]["schema"]["properties"]["records"]["items"]["properties"]
    counts, _ = scored(case, artifact)
    assert counts["tp"] == counts["gold_value_fields"] and len(artifact["records"]) == 6
    failed, _ = run(case, groups, Reader(raise_at={1}))
    assert status(failed, 0, "kreis") == "omitted" and status(failed, 3, "date") == "omitted" and status(failed, 0, "site") == "value"
    counts, _ = scored(case, failed)
    assert counts["omitted_fields"] > 0 and counts["hallucinated_fields"] == 0 and counts["absent_ok"] == 0   # not "absent"
    sized, reader = run(case, {"decompose": {"mode": "max_fields", "max_fields": 2}})
    assert len(reader.calls) == 3
    unkeyed = replace(case, record_key=())
    with pytest.raises(ValueError, match="record_key"):
        run(unkeyed, groups)


def test_recovery_splits_what_failed_so_every_level_is_smaller_than_its_parent():
    case = make()
    artifact, reader = run(case, {"recovery": {"subdivide": True}}, Reader(truncate_at={0, 1}))
    sizes = [len(c["schema"]["properties"]["records"]["items"]["properties"]) for c in reader.calls]
    assert sizes == [5, 3, 2, 2, 3] and artifact["coverage"]["complete"]           # the cut half is halved again, not the original
    counts, _ = scored(case, artifact)
    assert counts["tp"] == counts["gold_value_fields"] and artifact["validity"] == {"total": 5, "valid": 3}


def test_a_half_that_still_fails_keeps_its_siblings_records_and_only_its_own_fields_are_unread():
    case = make()
    artifact, _ = run(case, {"recovery": {"subdivide": True}}, Reader(truncate_at={0, 1, 2}))     # entry_no + site fails at the depth limit
    assert artifact["ledger"][0]["status"] == "partial" and not artifact["coverage"]["complete"] and artifact["coverage"]["partial"] == 1
    assert artifact["issues"][0]["code"] == "region_partial" and len(artifact["records"]) == 6
    assert status(artifact, 0, "site") == "omitted" and status(artifact, 0, "kreis") == "value" and status(artifact, 0, "finds") == "value"
    no_date = next(i for i, r in enumerate(case.gold) if "absent" in r["fields"]["date"])
    assert status(artifact, no_date, "date") == "absent"                              # its own half answered: null there is an answer
    counts, _ = scored(case, artifact)
    assert counts["omitted_fields"] == 6 and counts["absent_ok"] == counts["gold_absent_fields"] > 0
    assert counts["hallucinated_fields"] == counts["wrong_values"] == counts["missed_as_absent"] == 0


def test_a_budget_that_runs_out_mid_recovery_keeps_what_the_finished_halves_read():
    case = make()
    artifact, reader = run(case, {"recovery": {"subdivide": True}, "budget": {"calls": 2}}, Reader(truncate_at={0}))
    assert len(reader.calls) == 2 and artifact["ledger"][0]["status"] == "partial" and len(artifact["records"]) == 6
    assert status(artifact, 0, "site") == "value" and status(artifact, 0, "finds") == "omitted"     # the unread half is omitted, not absent
    assert "budget exhausted" in artifact["issues"][0]["detail"] and artifact["cost"]["fresh"]["calls"] == 2
    assert artifact["validity"] == {"total": 2, "valid": 1} and artifact["calls"]                    # the first half's calls are still on record


def test_a_budget_that_runs_out_during_verification_leaves_the_rest_unverified_and_the_case_intact():
    case = make()
    artifact, reader = run(case, {**QUOTE, "verification": {"model": True}, "budget": {"calls": 2}})
    assert len(reader.calls) == 2                                                                    # the read, and one record's verification
    assert row_of(artifact, 0, "site")["verdict"]["supports_value"] is True
    unverified = row_of(artifact, 1, "site")
    assert unverified["status"] == "value" and unverified["verdict"]["supports_value"] is None and "budget exhausted" in unverified["verdict"]["error"]
    counts, _ = scored(case, artifact)
    assert counts["tp"] == counts["gold_value_fields"]


def test_verification_runs_on_the_studys_workers_and_changes_nothing_but_the_wall_clock():
    case = make(9, per_page=3)
    config = {**QUOTE, "verification": {"model": True, "gate": "flag"}, "chunking": {"mode": "fixed", "max_chars": 200}}
    serial, _ = run(case, config)
    parallel, _ = run(case, {**config, "budget": {"workers": 4}})
    assert [r["verdict"] for r in serial["fields"]] == [r["verdict"] for r in parallel["fields"]] and any(r["verdict"] for r in serial["fields"])
    assert serial["records"] == parallel["records"] and serial["cost"]["fresh"]["calls"] == parallel["cost"]["fresh"]["calls"]


def test_a_failed_sample_is_a_task_failure_on_the_issue_list_though_the_region_was_read():
    artifact, _ = run(make(), SAMPLED, Reader(raise_at={1}))
    assert artifact["ledger"][0]["status"] == "processed" and artifact["coverage"]["complete"]
    assert [i["code"] for i in artifact["issues"]] == ["task_failed"] and "connection refused" in artifact["issues"][0]["detail"]


# --- evidence ---------------------------------------------------------------------------------------------------------

QUOTE = {"evidence": {"mode": "quote"}}


def repeated_site_case():
    for seed in range(60):
        case = make(6, seed=seed)
        if any(not s.get("supports", True) for r in case.gold for s in r["fields"]["site"]["evidence"]):
            return case
    raise AssertionError("no seed repeats a site")


def row_of(artifact, record: int, field: str) -> dict:
    return next(r for r in artifact["fields"] if r["record"] == record and r["field"] == field)


def test_quote_evidence_resolves_to_exact_canonical_spans_and_the_baseline_cites_nothing():
    case = make()
    plain, _ = run(case)
    assert all(not r["evidence"] for r in plain["fields"])
    artifact, _ = run(case, QUOTE)
    counts, _ = scored(case, artifact)
    kreis = row_of(artifact, 0, "kreis")["evidence"][0]
    gold = case.gold[0]["fields"]["kreis"]["evidence"][0]
    assert kreis["method"] == "exact" and not kreis["approximate"] and kreis["spans"] == [gold]
    assert kreis["bbox_pt"] is None and kreis["pages"] == [1]                # no geometry in the source: none is invented
    assert counts["ev_span_hit"] > 0 and artifact["evidence"] and artifact["evidence"][0]["method"] == "exact"


def test_repeated_evidence_text_keeps_every_location_and_record_context_can_choose_the_right_one():
    case = repeated_site_case()
    first, _ = run(case, QUOTE)
    ambiguous = [r for r in first["fields"] if r["field"] == "site" and r["evidence"] and r["evidence"][0]["ambiguous"]]
    assert ambiguous and all(r["evidence"][0]["alternatives"] for r in ambiguous)     # ambiguity is preserved, not guessed away
    counts_first, _ = scored(case, first)
    chosen, _ = run(case, {"evidence": {"mode": "quote", "alignment": {"disambiguate": "record"}}})
    counts_chosen, _ = scored(case, chosen)
    assert counts_first["ev_decoy_hit"] > 0 and counts_chosen["ev_decoy_hit"] == 0
    assert any(e.get("disambiguated") for r in chosen["fields"] for e in r["evidence"])
    assert counts_chosen["tp"] == counts_first["tp"]                                    # the values never changed


def test_alignment_methods_are_separate_and_an_approximate_match_is_never_called_exact():
    case = make()
    site = case.gold[0]["fields"]["site"]["value"]
    line = case.evidence.passages[0].text
    typo = line[:30] + line[31:]                                                            # one character dropped from a long quote
    quotes = {(40, "site"): [site.lower()], (40, "finds"): [typo]}
    def evidence(align):
        artifact, _ = run(case, {"evidence": {"mode": "quote", "alignment": align}}, Reader(quotes=quotes))
        return row_of(artifact, 0, "site")["evidence"][0], row_of(artifact, 0, "finds")["evidence"][0]
    lower, typed = evidence({"exact": True, "normalized": False})
    assert lower["method"] is None and lower["spans"] == [] and not lower["exists"]        # a quote that is not found stays visible
    lower, typed = evidence({"exact": True, "normalized": True})
    assert lower["method"] == "normalized" and lower["spans"] and typed["spans"] == []
    lower, typed = evidence({"exact": True, "normalized": True, "fuzzy": True})
    assert typed["method"] == "fuzzy" and typed["approximate"] and 0.9 <= typed["score"] < 1 and typed["spans"]
    strict, typed = evidence({"exact": True, "normalized": True, "fuzzy": True, "fuzzy_threshold": 0.999})
    assert typed["spans"] == []                                                             # the threshold is a setting, not a guess


def test_normalised_quotes_map_back_to_raw_offsets_across_a_line_break():
    from experiments.harness.config import Alignment
    from experiments.harness.evidence import align, block_of
    from kei_exp.kie.passages import Passage
    box = (0.0, 0.0, 1.0, 1.0)
    text = "Ein Groß-\nsteingrab am Hang"
    method, found, score = align("großsteingrab", block_of([Passage("p1_s0", 1, 0, text, "Text", box, "block")]), Alignment())
    assert method == "normalized" and score == 1.0
    span = found[0][0]
    assert text[span.start:span.end] == "Groß-\nsteingrab"


def test_ids_evidence_cites_passages_refined_to_the_value_and_needs_the_layout_input():
    with pytest.raises(ValueError, match="layout"):
        Config.model_validate({"evidence": {"mode": "ids"}})
    case = make()
    artifact, reader = run(case, {"input": {"mode": "layout"}, "evidence": {"mode": "ids"}})
    assert "<block id=" in reader.calls[0]["user"] and "ids" in reader.calls[0]["system"]
    entries = row_of(artifact, 0, "site")["evidence"]
    assert {e["method"] for e in entries} == {"passage+value"} and entries[0]["ids"] == ["p1_s0"]
    counts, _ = scored(case, artifact)
    assert counts["ev_segment_hit"] == counts["ev_predicted"] and 0 < counts["ev_span_hit"] <= counts["ev_predicted"]
    stray, _ = run(case, {"input": {"mode": "layout"}, "evidence": {"mode": "ids"}, "output": {"constraint": "prompt"}},
                   Reader(ids={(40, "site"): ["p9_s9"]}))
    cited = row_of(stray, 0, "site")
    assert cited["evidence"][0]["exists"] is False and cited["checks"]["cited_exists"] is False   # a cited id nobody showed


def test_a_missing_id_beside_a_found_one_keeps_the_refined_span_and_marks_the_citation_unresolved():
    case = make()
    artifact, _ = run(case, {"input": {"mode": "layout"}, "evidence": {"mode": "ids"}, "output": {"constraint": "prompt"}},
                      Reader(ids={(40, "site"): ["p1_s0", "p9_s9"]}))
    row = row_of(artifact, 0, "site")
    assert {e["method"] for e in row["evidence"]} == {"passage+value"} and all(e["spans"] for e in row["evidence"])
    assert all(e["exists"] is False and e["missing_ids"] == ["p9_s9"] for e in row["evidence"])
    assert row["checks"]["cited_exists"] is False                                     # one citation nobody showed spoils the check


def test_the_verifier_sees_the_citation_however_far_into_a_long_passage_it_lies():
    from experiments.harness.evidence import _cited
    inline = synth.catalogue("long")
    long = "x" * 3000 + "Aue" + "y" * 3000
    case = case_of({**inline, "passages": [{"id": "p1_s0", "page": 1, "text": long, "label": "Text"}], "gold": []})
    shown = _cited(case, [{"spans": [{"segment": "p1_s0", "start": 3000, "end": 3003}]}])
    assert "[[Aue]]" in shown and shown.startswith("[p1_s0] …") and shown.endswith("…") and len(shown) < 2100         # a window, never a cut citation
    whole = _cited(case, [{"spans": [{"segment": "p1_s0", "start": 100, "end": 5900}]}])
    assert "[[" + long[100:5900] + "]]" in whole                                                       # a long citation is shown whole


def test_choosing_another_occurrence_moves_the_entry_to_its_own_page_and_box():
    from experiments.harness.evidence import disambiguate
    case = make()
    first, last = case.evidence.passages[0], case.evidence.passages[-1]
    assert first.page != last.page
    case = replace(case, geometry={first.id: (1.0, 2.0, 3.0, 4.0), last.id: (5.0, 6.0, 7.0, 8.0)})
    here, there = [{"segment": first.id, "start": 0, "end": 3}], [{"segment": last.id, "start": 0, "end": 3}]

    def entry(spans, alternatives=()):
        return {"spans": spans, "alternatives": list(alternatives), "ambiguous": bool(alternatives), "method": "exact",
                "pages": [first.page], "bbox_pt": [[1.0, 2.0, 3.0, 4.0]]}
    entries = {"kreis": [entry(there)], "site": [entry(here, [there])]}             # the record's other citation sits on the last page
    disambiguate(entries, case)
    moved = entries["site"][0]
    assert moved["spans"] == there and moved["alternatives"] == [here] and moved["disambiguated"] is True
    assert moved["pages"] == [last.page] and moved["bbox_pt"] == [[5.0, 6.0, 7.0, 8.0]]      # the page and box follow the span


def test_an_evidence_gate_flags_or_withholds_a_value_its_cited_text_does_not_state():
    case = make()
    wrong = Reader(wrong={(40, "site"): "Zzz"})
    off, _ = run(case, QUOTE, wrong)
    assert row_of(off, 0, "site")["status"] == "value" and row_of(off, 0, "site")["checks"]["literal"] is False
    flagged, _ = run(case, {**QUOTE, "verification": {"gate": "flag"}}, Reader(wrong={(40, "site"): "Zzz"}))
    assert row_of(flagged, 0, "site")["status"] == "value" and "unsupported" in row_of(flagged, 0, "site")["flags"]
    gated, _ = run(case, {**QUOTE, "verification": {"gate": "abstain"}}, Reader(wrong={(40, "site"): "Zzz"}))
    assert row_of(gated, 0, "site")["status"] == "unsupported" and row_of(gated, 0, "site")["raw"] == "Zzz"
    counts, _ = scored(case, gated)
    assert counts["withheld_fields"] == 1 and counts["withheld_correct"] == 0 and counts["wrong_values"] == 0
    with pytest.raises(ValueError, match="evidence gate"):
        Config.model_validate({"verification": {"gate": "flag"}})


def test_model_verification_sees_only_the_cited_text_and_its_verdict_is_recorded_apart_from_the_value():
    case = make()
    artifact, reader = run(case, {**QUOTE, "verification": {"model": True}})
    verify_calls = [c for c in reader.calls if c["system"].startswith("You check values")]
    assert len(verify_calls) == 6 and len(reader.calls) == 7                         # one counted call per record
    prompt = verify_calls[0]["user"]
    assert case.gold[0]["fields"]["site"]["value"] in prompt and "### C1: field entry_no" in prompt
    assert "41. " not in prompt and "42. " not in prompt                              # nothing from other records leaks in
    verdict = row_of(artifact, 0, "site")["verdict"]
    assert verdict == {"supports_value": True, "supports_field": True, "supports_record": True}
    assert row_of(artifact, 0, "site")["status"] == "value" and artifact["records"][0]["site"] == case.gold[0]["fields"]["site"]["value"]
    denied, _ = run(case, {**QUOTE, "verification": {"model": True, "gate": "abstain"}},
                    Reader(verdicts={"kreis": {"supports_record": False}}))
    assert row_of(denied, 1, "kreis")["status"] == "unsupported" and row_of(denied, 1, "kreis")["verdict"]["supports_record"] is False
    counts, _ = scored(case, denied)
    assert counts["withheld_fields"] == 6 and counts["withheld_correct"] == 6          # a fallible verifier withheld right values
    with pytest.raises(ValueError, match="evidence"):
        Config.model_validate({"verification": {"model": True}})


# --- merging ----------------------------------------------------------------------------------------------------------

PAGES = {"chunking": {"mode": "page", "max_chars": 2000}}


def test_a_record_cut_by_a_chunk_boundary_is_joined_by_overlap_or_flags_and_a_fragment_without_either():
    case = make()
    cut = 2                                                     # entry 42 continues on page 2
    fragmented, _ = run(case, PAGES)
    counts, _ = scored(case, fragmented)
    assert len(fragmented["records"]) == 7 and counts["hallucinated_records"] == 1 and counts["wrong_values"] >= 1   # a fragment
    flagged, reader = run(case, {**PAGES, "merge": {"continuation": "flags"}})
    assert len(flagged["records"]) == 6 and "begins_inside_record" in reader.calls[0]["system"]
    counts, _ = scored(case, flagged)
    assert counts["tp"] == counts["gold_value_fields"] and counts["cross_page_strict"] == 1
    overlapped, _ = run(case, {"chunking": {"mode": "page", "max_chars": 2000, "overlap": 1}})
    assert len(overlapped["records"]) == 6
    counts, _ = scored(case, overlapped)
    assert counts["tp"] == counts["gold_value_fields"] and counts["conflicts" if False else "duplicated_records"] == 0
    row = row_of(overlapped, cut, "finds")
    assert len(row["contributors"]) == 2 and row["value"] == case.gold[cut]["fields"]["finds"]["value"]     # a set: the union
    assert "conflict" not in row["flags"]


def test_conflicting_scalars_are_kept_with_every_alternative_and_a_costed_resolver_only_adds_a_choice():
    case = make()
    wrong = {1: {(no, "site"): "Zzz" for no in range(40, 46)}}
    config = {"chunking": {"mode": "page", "max_chars": 2000, "overlap": 1}}
    artifact, _ = run(case, config, Reader(wrong_at=wrong))
    site = row_of(artifact, 2, "site")
    assert site["status"] == "unresolved" and "conflict" in site["flags"] and site["value"] is None
    assert {a["value"] for a in site["alternatives"]} == {case.gold[2]["fields"]["site"]["value"], "Zzz"} and site["signals"]["conflict"] == 1.0
    assert artifact["records"][2]["site"] is None                                    # no last-wins and no first-wins
    counts, _ = scored(case, artifact)
    assert counts["unresolved_fields"] == 1
    resolved, reader = run(case, {**config, "merge": {"resolver": True}}, Reader(wrong_at=wrong))
    fixed = row_of(resolved, 2, "site")
    assert fixed["status"] == "value" and "model_resolved" in fixed["flags"] and len(fixed["alternatives"]) == 2
    assert fixed["value"] == case.gold[2]["fields"]["site"]["value"]                  # its choice: the first alternative
    assert resolved["calls"][-1]["stage"] == "arbitration" and len(reader.calls) == len(artifact["calls"]) + 1   # a separate, costed call


def test_distinct_records_that_look_alike_are_not_collapsed_and_the_key_is_an_ablation():
    inline = synth.catalogue("twins", records=2)
    inline["passages"] = [{"id": "p1_s0", "page": 1, "text": "40. Aue. Kreis Moor. Funde: Eisen, Bronze. Datiert: 1850.", "label": "Text"},
                          {"id": "p1_s1", "page": 1, "text": "41. Aue. Kreis Moor. Funde: Eisen, Bronze. Datiert: 1850.", "label": "Text"}]
    inline["gold"] = []
    twins = case_of(inline)
    for extra in ({}, {"merge": {"keys": False}}):
        artifact, _ = run(twins, extra)
        assert [r["entry_no"] for r in artifact["records"]] == [40, 41]              # everything else equal, still two records
    unkeyed = replace(twins, record_key=())
    artifact, _ = run(unkeyed, {"chunking": {"mode": "page", "max_chars": 2000, "overlap": 1}})
    assert len(artifact["records"]) == 2


def test_without_a_key_records_join_only_on_a_shared_citation_or_an_exact_repeat():
    case = replace(make(), record_key=())
    overlap = {"chunking": {"mode": "page", "max_chars": 2000, "overlap": 1}}
    apart, _ = run(case, overlap)
    assert len(apart["records"]) == 7                       # a partial and a whole reading of entry 42 are not an exact repeat
    cited, _ = run(case, {**overlap, **QUOTE})
    assert len(cited["records"]) == 6                       # both quote the same span of "42": one record, its finds a union
    assert row_of(cited, 2, "finds")["value"] == case.gold[2]["fields"]["finds"]["value"]
    sampled = {"sampling": {"n": 2, "temperature": 0.5}}
    repeated, _ = run(case, sampled)
    assert len(repeated["records"]) == 6 and row_of(repeated, 0, "site")["votes"] == [2, 2]
    unable, _ = run(case, {**sampled, "merge": {"min_fields": 9}})
    assert len(unable["records"]) == 12                     # 9 fields cannot repeat: min_fields is a real setting


def test_the_merger_never_chains_matches_that_would_put_two_values_in_one_record():
    from experiments.harness.merge import Coverage, cluster
    def cand(index, kreis, span):
        entry = {"quote": "Aue", "method": "exact", "spans": [span], "alternatives": [], "exists": True}
        return {"chunk": "c0", "group": 0, "sample": 0, "view": "field", "index": index, "begins": None, "ends": None,
                "fields": {"site": {"value": "Aue", "raw": "Aue", "entries": [entry], "typed": True},
                           "kreis": {"value": kreis, "raw": kreis, "entries": [], "typed": True}}}
    shared = {"segment": "p1_s0", "start": 4, "end": 7}
    a, b, c = cand(0, None, shared), cand(1, "Moor", shared), cand(2, "Ried", shared)     # a~b and a~c share a citation; b and c disagree
    groups = cluster([a, b, c], make(), Config(), Coverage(["c0"], {("c0", 0, 0): frozenset({"site", "kreis"})}, [["site", "kreis"]]))
    assert sorted(len(g) for g in groups) == [1, 2] and not any(b in g and c in g for g in groups)


def test_a_fragment_that_gains_its_key_in_the_next_chunk_brings_later_records_with_that_key_into_one_record():
    from experiments.harness.merge import Coverage, cluster

    def cand(chunk, no, *, begins=None, ends=None):
        fields = {"entry_no": {"value": no, "raw": no, "entries": [], "typed": True}, "site": {"value": "Aue", "raw": "Aue", "entries": [], "typed": True}}
        return {"chunk": chunk, "group": 0, "sample": 0, "view": "field", "index": 0, "begins": begins, "ends": ends, "fields": fields}
    unkeyed, keyed, later = cand("c0", None, ends=True), cand("c1", 42, begins=True), cand("c2", 42)
    cfg = Config.model_validate({"chunking": {"mode": "page", "max_chars": 2000}, "merge": {"continuation": "flags"}})
    groups = cluster([unkeyed, keyed, later], make(), cfg, Coverage(["c0", "c1", "c2"], {}, [["entry_no", "site"]]))
    assert [len(g) for g in groups] == [3]                                            # the key arrived late; the record is still one
    apart = cluster([unkeyed, keyed, later], make(), Config(), Coverage(["c0", "c1", "c2"], {}, [["entry_no", "site"]]))
    assert sorted(len(g) for g in apart) == [1, 2]                                    # without the flags the fragment stays a fragment


# --- sampling, views, signals -------------------------------------------------------------------------------------------

SAMPLED = {"sampling": {"n": 3, "temperature": 0.7, "seed": 11}}


def test_repeated_sampling_sends_distinct_requests_and_majority_outvotes_one_bad_sample_without_calling_it_independent():
    case = make()
    truth = case.gold[0]["fields"]["site"]["value"]
    wrong = {1: {(40, "site"): "Zzz"}}
    majority, reader = run(case, {"sampling": {**SAMPLED["sampling"], "aggregate": "majority"}}, Reader(wrong_at=wrong))
    assert [c["seed"] for c in reader.calls] == [11, 12, 13] and {c["temperature"] for c in reader.calls} == {0.7}
    site = row_of(majority, 0, "site")
    assert site["value"] == truth and site["votes"] == [2, 3] and site["signals"]["agreement"] == 2 / 3
    assert sorted(a["votes"] for a in site["alternatives"]) == [1, 2]                     # the dissent stays on record
    strict, _ = run(case, SAMPLED, Reader(wrong_at=wrong))
    site = row_of(strict, 0, "site")
    assert site["status"] == "unresolved" and site["value"] is None and "conflict" in site["flags"]
    assert row_of(strict, 0, "kreis")["votes"] == [3, 3] and row_of(strict, 0, "kreis")["signals"]["agreement"] == 1.0
    with pytest.raises(ValueError, match="temperature"):
        Config.model_validate({"sampling": {"n": 2}})
    with pytest.raises(ValueError, match="at least 3"):
        Config.model_validate({"sampling": {"n": 2, "temperature": 0.5, "aggregate": "majority"}})


MAJORITY = {"sampling": {**SAMPLED["sampling"], "aggregate": "majority"}}


def test_a_value_only_one_of_three_samples_states_is_no_majority_and_strict_calls_it_a_conflict():
    case = make()
    truth = case.gold[0]["fields"]["site"]["value"]
    two_nulls = {1: {(40, "site")}, 2: {(40, "site")}}                               # two samples find no site for entry 40
    site = row_of(run(case, MAJORITY, Reader(drop_at=two_nulls))[0], 0, "site")
    assert site["status"] == "absent" and site["value"] is None and site["votes"] == [2, 3]
    assert sorted(a["votes"] for a in site["alternatives"]) == [1, 2] and truth in {a["value"] for a in site["alternatives"]}   # the lone value stays
    site = row_of(run(case, SAMPLED, Reader(drop_at=two_nulls))[0], 0, "site")
    assert site["status"] == "unresolved" and "conflict" in site["flags"] and site["value"] is None
    one_null = row_of(run(case, MAJORITY, Reader(drop_at={2: {(40, "site")}}))[0], 0, "site")
    assert one_null["status"] == "value" and one_null["value"] == truth and one_null["votes"] == [2, 3]
    all_null = row_of(run(case, SAMPLED, Reader(drop_at={0: {(40, "site")}, 1: {(40, "site")}, 2: {(40, "site")}}))[0], 0, "site")
    assert all_null["status"] == "absent" and all_null["votes"] == [3, 3]            # unanimous silence is an answer, in either rule


def test_a_sample_that_disagrees_on_a_field_of_a_keyless_record_is_outvoted_and_makes_no_extra_record():
    case = replace(make(), record_key=())
    truth = case.gold[0]["fields"]["site"]["value"]
    majority, _ = run(case, MAJORITY, Reader(wrong_at={1: {(40, "site"): "Zzz"}}))
    assert len(majority["records"]) == 6                                             # one erroneous sample makes no seventh record
    site = row_of(majority, 0, "site")
    assert site["value"] == truth and site["votes"] == [2, 3] and site["signals"]["agreement"] == 2 / 3        # and its dissent is counted
    counts, _ = scored(case, majority)
    assert counts["tp"] == counts["gold_value_fields"] and counts["hallucinated_records"] == 0
    strict, _ = run(case, SAMPLED, Reader(wrong_at={1: {(40, "site"): "Zzz"}}))
    assert len(strict["records"]) == 6 and row_of(strict, 0, "site")["status"] == "unresolved"     # the conflict is on the one record


def test_a_record_only_one_of_three_samples_reports_is_outvoted_under_majority_and_unresolved_under_strict():
    case = make()
    ghost = {"no": 99, "site": "Nowhere", "kreis": "Moor", "tail": [], "ids": [], "cut": False, "finds": ["Eisen"], "date": None}
    majority, _ = run(case, MAJORITY, Reader(fake_records=[ghost]))
    assert len(majority["records"]) == 6 and [i["code"] for i in majority["issues"]] == ["record_outvoted"]   # counted, not silently dropped
    counts, _ = scored(case, majority)
    assert counts["hallucinated_records"] == 0 and counts["tp"] == counts["gold_value_fields"]
    strict, _ = run(case, SAMPLED, Reader(fake_records=[ghost]))
    assert len(strict["records"]) == 7 and all(row_of(strict, 6, f)["status"] == "unresolved" for f in ("entry_no", "site", "kreis"))
    single, _ = run(case, {}, Reader(fake_records=[ghost]))
    assert len(single["records"]) == 7                                               # with one sample there is nobody to outvote it


def test_records_are_aligned_across_samples_by_key_then_by_shared_values_never_two_of_one_sample():
    from experiments.harness.merge import align_samples

    def rec(first, **values):
        names = {"entry_no": None, "site": None, "kreis": None, "finds": None, "date": None, **values}
        return {"first": first, "chunks": ["c0"], "fields": {n: {"status": "value" if v is not None else "absent", "value": v, "entries": []}
                                                             for n, v in names.items()}}
    twins0 = [rec((0, 0), site="Aue", kreis="Moor", date="1850"), rec((0, 1), site="Bach", kreis="Ried", date="1900")]
    twins1 = [rec((0, 0), site="Bach", kreis="Ried", date="1901"), rec((0, 1), site="Aue", kreis="Moor", date="1850")]
    groups = align_samples([twins0, twins1], make(), Config())
    assert [[s for s, _ in g] for g in groups] == [[0, 1], [0, 1]]
    assert [g[1][1]["fields"]["site"]["value"] for g in groups] == ["Aue", "Bach"]     # by shared values, not by position, despite a wrong date
    keyless = rec((0, 0), site="Aue", kreis="Moor", date="1850")
    keyed = rec((0, 0), entry_no=42, site="Aue", kreis="Moor", date="1850")
    other = rec((0, 1), entry_no=43, site="Aue", kreis="Moor", date="1900")            # shares values with the record above, has another key
    later = rec((0, 0), entry_no=42, site="Bach", kreis="Ried")                         # the same key: the same record, whatever else it says
    groups = align_samples([[keyless], [keyed, other], [later]], make(), Config())
    assert sorted(len(g) for g in groups) == [1, 3]
    assert not any(len({s for s, _ in g}) != len(g) for g in groups)                   # at most one record of each sample per record


def test_a_sample_that_fails_is_left_out_of_the_vote_and_never_counts_as_dissent():
    case = make()
    artifact, _ = run(case, SAMPLED, Reader(raise_at={1}))                             # the second of three samples cannot be reached
    site = row_of(artifact, 0, "site")
    assert site["status"] == "value" and site["votes"] == [2, 2] and site["signals"]["agreement"] == 1.0
    counts, _ = scored(case, artifact)
    assert counts["tp"] == counts["gold_value_fields"] and counts["absent_ok"] == counts["gold_absent_fields"]
    dead, _ = run(case, SAMPLED, Reader(raise_at={0, 1, 2}))
    assert dead["coverage"]["failed"] == 1 and dead["records"] == [] and not dead["coverage"]["complete"]


def test_sets_keep_the_items_most_samples_state_and_strict_wants_the_same_set_every_time():
    case = make()
    k = next(i for i, r in enumerate(case.gold) if len(r["fields"]["finds"]["value"]) >= 2)
    no, finds = case.gold[k]["fields"]["entry_no"]["value"], case.gold[k]["fields"]["finds"]["value"]
    odd = {2: {(no, "finds"): [finds[0], "Zzz"]}}
    row = row_of(run(case, MAJORITY, Reader(wrong_at=odd))[0], k, "finds")
    assert row["status"] == "value" and sorted(row["value"]) == sorted(finds) and "Zzz" not in row["value"]   # items two of three state
    assert row["votes"] == [2, 3] and row["signals"]["agreement"] == 2 / 3                                   # two samples state exactly this set
    row = row_of(run(case, SAMPLED, Reader(wrong_at=odd))[0], k, "finds")
    assert row["status"] == "unresolved" and "conflict" in row["flags"] and row["value"] is None


def test_a_set_kept_by_majority_carries_only_the_evidence_of_the_samples_that_stated_it_and_the_rejected_set_stays_visible():
    case = make()
    k = next(i for i, r in enumerate(case.gold) if len(r["fields"]["finds"]["value"]) >= 2)
    no, finds = case.gold[k]["fields"]["entry_no"]["value"], case.gold[k]["fields"]["finds"]["value"]
    config = {"sampling": {**SAMPLED["sampling"], "aggregate": "majority"}, **QUOTE, "verification": {"gate": "abstain"}}
    artifact, _ = run(case, config, Reader(wrong_at={2: {(no, "finds"): [finds[0], "Zzz"]}}))
    row = row_of(artifact, k, "finds")
    assert row["status"] == "value" and sorted(row["value"]) == sorted(finds)                       # not withheld for a losing sample's "Zzz"
    assert row["checks"]["literal"] is True and row["votes"] == [2, 3]
    assert any("Zzz" in (a["value"] or []) for a in row["alternatives"])                             # the rejected set is on record


def test_a_resolved_conflict_keeps_the_chosen_values_checks_evidence_and_signals_through_the_gate():
    case = make()
    truth = case.gold[2]["fields"]["site"]["value"]
    config = {"chunking": {"mode": "page", "max_chars": 2000, "overlap": 1}, "evidence": {"mode": "quote"}, "merge": {"resolver": True},
              "verification": {"gate": "abstain"}, "signals": {"top_logprobs": 3}}
    artifact, _ = run(case, config, Reader(wrong_at={1: {(no, "site"): "Zzz" for no in range(40, 46)}}))
    site = row_of(artifact, 2, "site")
    assert site["status"] == "value" and site["value"] == truth and "model_resolved" in site["flags"] and len(site["alternatives"]) == 2
    assert site["checks"]["literal"] is True and site["evidence"] and site["signals"]["align"] == 1.0          # the chosen value's own
    assert site["signals"]["conflict"] == 1.0 and site["signals"]["p_first"] is not None
    assert row_of(artifact, 3, "site")["status"] == "unsupported"                    # a page-2 record the gate could check: "Zzz" is not cited text


def test_samples_are_distinct_cache_entries_even_without_a_seed_and_replay_in_full(tmp_path):
    case = make()
    config = {"sampling": {"n": 2, "temperature": 0.5}}
    first, reader = run(case, config, cache=tmp_path)
    assert len(reader.calls) == 2 and first["cost"]["fresh"]["calls"] == 2
    again, second = run(case, config, cache=tmp_path)
    assert len(second.calls) == 0 and again["cost"]["replayed"]["calls"] == 2 and again["cost"]["fresh"]["calls"] == 0
    assert again["records"] == first["records"]


def test_the_document_guided_view_adds_a_call_and_its_disagreement_is_a_signal_not_a_value():
    case = make()
    both = {"sampling": {"views": ["field", "document"]}}
    agree, reader = run(case, both)
    assert len(reader.calls) == 2 and "List every record in the SOURCE" in reader.calls[1]["system"]
    assert row_of(agree, 0, "site")["signals"]["view_agreement"] == 1.0 and row_of(agree, 3, "finds")["signals"]["view_agreement"] == 1.0
    disagree, _ = run(case, both, Reader(document_wrong={40: "Zzz"}))
    assert row_of(disagree, 0, "site")["signals"]["view_agreement"] == 0.0 and row_of(disagree, 1, "site")["signals"]["view_agreement"] == 1.0
    assert disagree["records"] == agree["records"]                                        # values come from the field view alone
    single, _ = run(case)
    assert row_of(single, 0, "site")["signals"]["view_agreement"] is None                # not run: missing, not zero
    with pytest.raises(ValueError, match="field-guided"):
        Config.model_validate({"sampling": {"views": ["document"]}})


LOGPROBS = {"signals": {"top_logprobs": 3}}


def test_value_token_probabilities_exclude_keys_and_punctuation_and_missing_signals_stay_missing():
    case = make()
    artifact, reader = run(case, LOGPROBS, Reader(logprob={(40, "site"): -0.7, (40, "finds"): -0.2}))
    assert reader.calls[0]["top_logprobs"] == 3
    site = row_of(artifact, 0, "site")["signals"]
    assert site["p_first"] == pytest.approx(math.exp(-0.7)) and site["p_mean"] == pytest.approx(math.exp(-0.7))   # not diluted by JSON
    assert site["p_span"] == pytest.approx(math.exp(-0.7)) and site["margin"] > 0 and site["entropy_topk"] > 0
    finds = row_of(artifact, 0, "finds")["signals"]
    assert finds["p_mean"] == pytest.approx(math.exp(-0.2)) and finds["p_span"] < finds["p_first"]               # a list: several value tokens
    assert row_of(artifact, 1, "site")["signals"]["p_first"] == pytest.approx(math.exp(-0.05))
    served, _ = run(case, LOGPROBS, Reader(logprob={(40, "site"): -0.7}, end_token=True))      # vLLM's end-of-turn token in the list
    assert row_of(served, 0, "site")["signals"]["p_first"] == pytest.approx(math.exp(-0.7))
    shifted, _ = run(case, LOGPROBS, Reader(offset_tokens=True))
    assert row_of(shifted, 0, "site")["signals"]["p_first"] is None                          # tokens that do not rebuild the text: no guess
    silent, _ = run(case, LOGPROBS, Reader(no_logprobs=True))
    signals = row_of(silent, 0, "site")["signals"]
    assert signals["p_first"] is None and signals["p_mean"] is None and signals["margin"] is None   # unavailable is not zero
    unsupported = Reader(supports_sampling=False)
    with pytest.raises(ValueError, match="token-probability"):
        run(case, LOGPROBS, unsupported)
    assert unsupported.calls == []                                                          # refused before any call


def test_token_statistics_of_a_nested_value_cover_its_leaves_only():
    from experiments.harness.model import ResearchReply
    from experiments.harness.signals import value_stats
    text = '{"r": {"name": "Zed", "gap": null, "n": 7}}'
    weights = {"Zed": -0.5, "7": -0.25}
    logprobs = tuple({"token": t, "logprob": weights.get(t, -0.01), "bytes": list(t.encode()), "top_logprobs": []}
                     for t in re.findall(r"\w+|[^\w\s]|\s+", text))
    stats = value_stats(ResearchReply(text, 5, 5, "stop", 0.1, logprobs=logprobs), ("r",))
    assert stats["tokens"] == 2 and stats["p_first"] == pytest.approx(math.exp(-0.5)) and stats["p_span"] == pytest.approx(math.exp(-0.75))
    assert value_stats(ResearchReply(text, 5, 5, "stop", 0.1, logprobs=logprobs), ("r", "gap")) is None       # a null has nothing to be sure of


def test_verbalized_confidence_alignment_ocr_and_validity_signals():
    case = make()
    artifact, reader = run(case, {**QUOTE, "signals": {"verbalized": True}}, Reader(confidence={(40, "site"): 0.42}))
    assert "confidence" in reader.calls[0]["system"]
    site = row_of(artifact, 0, "site")["signals"]
    assert site["verbalized"] == 0.42 and site["align"] == 1.0 and site["ocr"] == 0.99 and site["p_first"] is None
    weak = replace(case, ocr_confidence={**case.ocr_confidence, "p1_s1": 0.5})
    located, _ = run(weak, {"evidence": {"mode": "quote", "alignment": {"disambiguate": "record"}}})
    assert row_of(located, 1, "site")["signals"]["ocr"] == 0.5 and row_of(located, 0, "site")["signals"]["ocr"] == 0.99   # the cited segment's own
    plain, _ = run(case)
    assert row_of(plain, 0, "site")["signals"]["verbalized"] is None and row_of(plain, 0, "site")["signals"]["align"] is None
    blank, _ = run(case, {}, Reader(wrong={(40, "site"): "   "}))       # valid JSON for a string, but not a value
    row = row_of(blank, 0, "site")
    assert row["status"] == "unresolved" and row["flags"] == ["type_mismatch"] and row["raw"] == "   " and row["signals"]["invalid"] == 1.0
    lit, _ = run(case, QUOTE, Reader(wrong={(40, "site"): "Zzz"}))
    assert row_of(lit, 0, "site")["signals"]["invalid"] == 1.0 and row_of(lit, 1, "site")["signals"]["invalid"] == 0.0   # the printed value is not cited
    assert row_of(run(case)[0], 0, "site")["signals"]["invalid"] == 0.0
    typed, _ = run(case, {}, Reader(wrong={(40, "entry_no"): 40.0}))     # normalisation keeps the raw value beside the typed one
    row = row_of(typed, 0, "entry_no")
    assert row["value"] == 40 and row["raw"] == 40.0 and row["normalized"] is True


# --- cache, budgets, providers ---------------------------------------------------------------------------------------------

def test_the_cache_replays_only_an_identical_request_and_reports_replay_apart_from_real_inference(tmp_path):
    case = make()
    first, reader = run(case, cache=tmp_path)
    again, second = run(case, cache=tmp_path)
    assert len(second.calls) == 0 and again["cost"]["replayed"]["calls"] == 1 and again["cost"]["fresh"]["calls"] == 0
    assert again["cost"]["replayed"]["seconds"] == first["cost"]["fresh"]["seconds"] == 0.25      # the original latency, not zero
    assert again["cost"]["replayed"]["input_tokens"] == first["cost"]["fresh"]["input_tokens"] > 0
    for changed in ({"output": {"max_tokens": 4000}}, {"evidence": {"mode": "quote"}}, {"chunking": {"mode": "page", "max_chars": 2000}}):
        _, fresh = run(case, changed, cache=tmp_path)
        assert len(fresh.calls) >= 1, changed                                                # a different request is never replayed
    other = Provider(Reader(), cache=tmp_path, identity={"url": "http://elsewhere"})
    cfg = Config()
    assert run_case(case, cfg, other.view(5))["cost"]["fresh"]["calls"] == 1                # another endpoint, same model name


def test_identical_concurrent_requests_run_once():
    import threading
    import time

    from experiments.harness.model import ResearchReply

    class Slow:
        model = "fake/slow"

        def __init__(self):
            self.calls = []

        def complete(self, **kw):
            self.calls.append(kw)
            time.sleep(0.1)
            return ResearchReply("{}", 5, 2, "stop", 0.1)
    slow = Slow()
    provider = Provider(slow)
    barrier = threading.Barrier(2)
    replies = []

    def go(meter):
        barrier.wait()
        replies.append(meter.complete(system="s", user="u", schema=None, max_tokens=10))
    threads = [threading.Thread(target=go, args=(provider.view(5),)) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(slow.calls) == 1 and sorted(r.replayed for r in replies) == [False, True]


def test_call_and_token_budgets_stop_a_case_visibly_and_never_crash_it():
    case = make()
    artifact, reader = run(case, {"chunking": {"mode": "fixed", "max_chars": 200}, "budget": {"calls": 1}})
    assert len(reader.calls) == 1 and artifact["coverage"]["failed"] >= 1 and not artifact["coverage"]["complete"]
    assert any("budget exhausted" in i["detail"] for i in artifact["issues"])
    from experiments.harness.model import ResearchReply

    class Heavy(Reader):
        def complete(self, **kw):
            reply = super().complete(**kw)
            return ResearchReply(reply.text, 900, 200, reply.finish, reply.seconds)
    tokens, reader = run(case, {"chunking": {"mode": "fixed", "max_chars": 200}, "budget": {"tokens": 1000}}, Heavy())
    assert len(reader.calls) == 1 and not tokens["coverage"]["complete"]                    # the second call would exceed 1000 tokens
    assert any("tokens spent" in i["detail"] for i in tokens["issues"])


def test_a_refused_output_constraint_stops_the_cell_and_is_never_a_silent_prompt_only_run():
    from experiments.harness.model import OutputConstraintUnsupported
    class Refuses(Reader):
        def complete(self, **kw):
            raise OutputConstraintUnsupported("response_format json_schema is not supported")
    with pytest.raises(OutputConstraintUnsupported):
        run(make(), {"output": {"constraint": "schema"}}, Refuses())


def test_a_reply_without_usage_is_counted_unknown_and_not_as_zero_tokens():
    from experiments.harness.model import ResearchReply
    class Quiet(Reader):
        def complete(self, **kw):
            reply = super().complete(**kw)
            return ResearchReply(reply.text, None, None, reply.finish, reply.seconds)
    artifact, _ = run(make(), {}, Quiet())
    assert artifact["cost"]["fresh"]["unknown_usage"] == 1 and artifact["cost"]["fresh"]["input_tokens"] == 0


def test_grammar_masked_alternatives_reported_as_minus_9999_have_zero_probability_and_do_not_break_the_statistics():
    from experiments.harness.model import ResearchReply
    from experiments.harness.signals import value_stats
    text = '{"answer": "Zanzibar"}'
    tokens = [("{\"", -0.01, [("{\"", -0.01), ("{", -5.0)]), ("answer", -0.0, [("answer", 0.0)]), ("\":", -0.01, [("\":", -0.01)]),
              (" \"", 0.0, [(" \"", 0.0)]), ("Z", 0.0, [("Z", 0.0), ('"', -9999.0), ("!", -9999.0)]), ("anz", -0.28, [("anz", -0.28), ("a", -1.6)]),
              ("ibar", -0.005, [("ibar", -0.005)]), ('"}', -0.0, [('"}', 0.0)]), ("<|im_end|>", -0.0, [])]
    logprobs = tuple({"token": tok, "logprob": lp, "bytes": list(tok.encode()), "top_logprobs": [{"token": t, "logprob": p, "bytes": list(t.encode())} for t, p in top]}
                     for tok, lp, top in tokens)
    stats = value_stats(ResearchReply(text, 10, 9, "stop", 0.1, logprobs=logprobs), ("answer",))
    assert stats["tokens"] == 3 and stats["p_first"] == 1.0                                     # a forced first token looks certain
    assert stats["margin"] == 1.0 and stats["entropy_topk"] == 0.0                              # masked alternatives carry no probability
    assert stats["p_span"] == pytest.approx(math.exp(-0.28 - 0.005))


def test_concurrent_workers_change_nothing_but_the_wall_clock():
    case = make(9, per_page=3)
    serial, _ = run(case, {"chunking": {"mode": "fixed", "max_chars": 200}})
    parallel, _ = run(case, {"chunking": {"mode": "fixed", "max_chars": 200}, "budget": {"workers": 4}})
    assert len(serial["ledger"]) > 2 and serial["records"] == parallel["records"]
    assert [r["contributors"] for r in serial["fields"]] == [r["contributors"] for r in parallel["fields"]]    # same order, same provenance
    assert parallel["cost"]["fresh"]["calls"] == serial["cost"]["fresh"]["calls"]
