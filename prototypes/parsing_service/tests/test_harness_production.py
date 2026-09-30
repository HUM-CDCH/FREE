"""The service's own extraction artifacts scored by the harness evaluator, so production options and research variants
share one scoring path."""
import copy
import json
from pathlib import Path

from experiments.harness.data import case_of
from experiments.harness.evaluate import Eval, check_invariants, metrics, pool, score_case
from experiments.harness.production import adapt

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "contracts" / "extract.result.v3.json").read_text())
ARTIFACT = FIXTURE["artifact"]


def case(exhaustive: bool = True):
    segments = FIXTURE["pages"][0]["segments"]
    passages = [{"id": f"p1_s{i}", "page": 1, "text": s["text"], "label": s["label"], "bbox_pt": s["bbox_pt"]} for i, s in enumerate(segments)]
    span = lambda seg, a, b: {"segment": seg, "start": a, "end": b}    # noqa: E731
    gold = [{"fields": {"label": {"value": "12", "evidence": [span("p1_s1", 0, 2)]}, "site": {"value": "Adorf", "evidence": [span("p1_s1", 4, 9)]},
                        "material": {"value": "Bronze"}, "gilded": {"absent": True}, "finds": {"value": [{"name": "Nadel", "count": 2}]}}},
            {"fields": {"label": {"value": "第3号"}, "site": {"value": "北京出土 Material: Jade"}, "material": {"value": "Jade"},
                        "gilded": {"value": True}, "finds": {"absent": True}}}]
    return case_of({"id": "fixture", "group": "fixture", "split": "dev", "passages": passages, "schema": ARTIFACT["schema"], "gold": gold,
                    "record_key": ["label"], "exhaustive": exhaustive})


def scored(prediction, rules=Eval()):
    counts, outcomes = score_case(case(), prediction, rules)
    assert check_invariants(counts) == []
    return counts, outcomes


def test_a_version_3_artifact_is_scored_with_its_evidence_and_null_fields_read_as_absent():
    prediction = adapt(ARTIFACT, case())
    assert len(prediction["fields"]) == 10 and prediction["cost"]["fresh"]["calls"] == 6 and "unknown" in prediction["provenance"]["replay_status"]
    statuses = {(r["record"], r["field"]): r["status"] for r in prediction["fields"]}
    assert statuses[(0, "gilded")] == "absent" and statuses[(1, "finds")] == "absent" and statuses[(0, "site")] == "value"
    site = next(r for r in prediction["fields"] if (r["record"], r["field"]) == (0, "site"))
    assert site["evidence"][0]["spans"] == [{"segment": "p1_s1", "start": 4, "end": 9}] and site["evidence"][0]["method"] == "exact"
    counts, _ = scored(prediction)
    m = metrics(pool([counts]))
    assert m["field"]["precision"] == m["field"]["recall"] == 1.0 and counts["absent_ok"] == 2
    assert m["evidence"]["annotated_fields"] == 2 and m["evidence"]["joint"] == 1.0


def test_proposals_rejections_and_incomplete_processing_keep_their_own_states():
    artifact = copy.deepcopy(ARTIFACT)
    artifact["records"][1]["material"] = None
    artifact["proposed"] = [{"path": ["records", 1, "material"], "value": "Jade", "reason": "verification_disabled"}]
    artifact["records"][0]["site"] = None
    artifact["rejected"] = [{"path": ["records", 0, "site"], "value": "Adorf", "reason": "verification_rejected"},
                            {"path": ["records", 0, "gilded"], "value": None, "reason": "type_mismatch"}]
    prediction = adapt(artifact, case())
    rows = {(r["record"], r["field"]): r for r in prediction["fields"]}
    assert rows[(1, "material")]["status"] == "value" and rows[(1, "material")]["flags"] == ["proposed"]
    assert rows[(0, "site")]["status"] == "unsupported" and rows[(0, "site")]["raw"] == "Adorf"      # rejected by verification: withheld
    assert rows[(0, "gilded")]["status"] == "absent"                                                 # "the model said null" is not a rejection
    both, _ = scored(prediction)
    accepted_only, _ = scored(prediction, Eval(excluded_flags=("proposed",)))
    assert both["tp"] == 7 and accepted_only["tp"] == 6 and accepted_only["excluded_values"] == 1     # two views, two denominators
    assert both["withheld_fields"] == 1 and both["withheld_correct"] == 1
    artifact["completeness"]["processing"] = False
    unread = adapt(artifact, case())
    assert next(r for r in unread["fields"] if (r["record"], r["field"]) == (1, "finds"))["status"] == "omitted"   # not "absent": nothing was read


def test_the_score_command_prints_metrics_for_a_saved_artifact(tmp_path, capsys):
    from experiments.harness import study as st
    from experiments.harness import synth
    inline = synth.catalogue("c", records=3)
    (tmp_path / "data.json").write_text(json.dumps(synth.dataset([inline])))
    passages = inline["passages"]
    artifact = {"extraction_version": 3, "records": [{"entry_no": 40, "site": "x", "kreis": None, "finds": None, "date": None}],
                "evidence": [], "proposed": [], "rejected": [], "calls": [], "completeness": {"processing": True}}
    (tmp_path / "artifact.json").write_text(json.dumps(artifact))
    st.main(["score", str(tmp_path / "data.json"), "c", str(tmp_path / "artifact.json")])
    printed = json.loads(capsys.readouterr().out)
    assert printed["invariant_violations"] == [] and printed["metrics"]["records"]["missing"] == 2 and len(passages) >= 3
