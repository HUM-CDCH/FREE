"""An extra measurement cannot disappear behind a correct projected field."""
import importlib.util
from pathlib import Path

path = Path(__file__).resolve().parents[3] / "docs/validation/extraction_ablation_accounting.py"
spec = importlib.util.spec_from_file_location("observation_accounting", path)
accounting = importlib.util.module_from_spec(spec)
spec.loader.exec_module(accounting)


def test_expected_measurement_does_not_hide_an_extra_wrong_or_duplicate_measurement():
    artifact = {"records": [{"thermal_data": [{"value": 35}, {"value": 92}, {"value": 35}]}], "evidence": []}
    fields = [{"prediction_path": ["records", 0, "thermal_data", 0, "value"],
               "expected_empty": False, "result": "correct"}]
    result = accounting.observations(artifact, fields)
    assert result["array_items"] == 3
    assert result["by_projection_status"] == {"used_by_gold_projection": 1, "not_selected_by_gold_projection": 2}
    assert result["exact_duplicate_items"] == 1
    assert result["items"][1]["value"] == {"value": 92}
    assert result["items"][1]["projection_status"] != "false_positive"


def test_unannotated_arrays_remain_unannotated_and_citations_do_not_change_labels():
    artifact = {"records": [{"finds": ["bead"]}], "evidence": [{"path": ["records", 0, "finds", 0], "segment": "p1_s0"}]}
    result = accounting.observations(artifact, None)
    assert result["by_projection_status"] == {"unannotated": 1}
    assert result["items"][0]["evidence"] == artifact["evidence"]


def test_grounding_comparison_flags_changed_upstream_content():
    a = {"records": [{"value": 35}], "inventory": []}
    b = {"records": [{"value": 92}], "inventory": []}
    rows = accounting.grounding_comparability({"paper--base--0": a, "paper--quote--0": b}, [{"id": "paper"}],
        [{"factor": "article.grounding", "control": "base", "treatment": "quote"}])
    assert not rows[0]["identical_upstream_records_and_inventory"]
