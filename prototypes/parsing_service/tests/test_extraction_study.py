"""Study validity: immutable inputs, one-factor comparisons, exact resumption, paired uncertainty."""
import pytest

from experiments.extraction.analyze import document_fields, exact_projected_fields, paired_interval
from experiments.extraction.manifest import checked, differences, pin, read, validate, write_new
from experiments.extraction.study import Capture
from kei_exp.kie.extract.llm import Reply


def test_publication_is_exclusive_and_changed_inputs_are_refused(tmp_path):
    path = tmp_path / "artifact.json"
    write_new(path, {"complete": True})
    pinned = pin(path)
    with pytest.raises(FileExistsError):
        write_new(path, {"complete": False})
    assert read(path) == {"complete": True}
    path.write_text("changed")
    with pytest.raises(ValueError, match="changed pinned input"):
        checked(pinned)


def test_multi_factor_comparisons_are_rejected_before_any_execution(tmp_path):
    methods = {"a": {"context": "full", "grounding": "semantic"},
               "b": {"context": "bounded", "grounding": "quoted"}}
    study = {"id": "s", "version": 1, "sources": [{"id": "doc", "exposure": "development", "methods": ["a", "b"]}],
             "methods": methods, "repeats": 1,
             "comparisons": [{"control": "a", "treatment": "b", "factor": "context"}]}
    assert differences(methods["a"], methods["b"]) == {"context", "grounding"}
    with pytest.raises(ValueError, match="not exactly"):
        validate(study, tmp_path, verify_files=False)
    methods["b"]["grounding"] = "semantic"
    assert len(validate(study, tmp_path, verify_files=False)) == 2
    study["sources"][0]["exposure"] = "held-out"
    with pytest.raises(ValueError, match="no independent"):
        validate(study, tmp_path, verify_files=False)


class Chat:
    model = "fake"
    def __init__(self):
        self.calls = 0
    def complete(self, **kwargs):
        self.calls += 1
        return Reply('{"year": 1827}', 10, 5, "stop", 2.0)


def test_resume_reuses_exact_saved_replies_and_never_calls_them_fresh(tmp_path):
    request = {"system": "S", "user": "U", "schema": {}, "max_tokens": 100}
    chat = Chat()
    first = Capture(chat, tmp_path, "fields")
    reply = first.complete(**request)
    resumed = Capture(chat, tmp_path, "fields")
    assert resumed.complete(**request).text == reply.text
    assert chat.calls == 1 and resumed.fresh == 0 and resumed.reused == 1
    changed = Capture(chat, tmp_path, "fields")
    with pytest.raises(ValueError, match="diverged"):
        changed.complete(**{**request, "user": "different"})
    assert chat.calls == 1


def test_request_without_reply_is_counted_as_unknown_prior_completion(tmp_path):
    request = {"system": "S", "user": "U", "schema": {}, "max_tokens": 100}
    write_new(tmp_path / "fields-0001.request.json", request)
    capture = Capture(Chat(), tmp_path, "fields")
    capture.complete(**request)
    assert capture.uncertain == 1 and capture.fresh == 1 and capture.reused == 0


def test_uncertainty_resamples_documents_with_hand_calculated_effects():
    result = paired_interval([.1, .3], draws=1000)
    assert result["mean"] == pytest.approx(.2)
    assert result["percentile_95"] == pytest.approx([.1, .3])
    assert result["documents"] == 2 and result["unit"] == "document"
    assert paired_interval([0, 0, 0])["percentile_95"] == [0, 0]
    assert paired_interval([])["mean"] is None


def test_document_fields_keep_disagreements_and_review_regardless_of_row_order():
    fields = [{"source_id": "paper", "field": name, "result": result}
              for name, result in [("title", "incorrect"), ("title", "correct"),
                                   ("year", "needs_review"), ("year", "correct"),
                                   ("temperature", "incorrect")]]
    fields.append({"source_id": "other_paper", "field": "title", "result": "correct"})
    expected = {("paper", "title"): "incorrect", ("paper", "year"): "needs_review",
                ("other_paper", "title"): "correct"}
    for ordered in (fields, list(reversed(fields))):
        assert {(f["source_id"], f["field"]): f["result"]
                for f in document_fields(ordered, {"title", "year"})} == expected


def test_exact_projection_preserves_alignment_failures_and_distinguishes_normalization():
    fields = [{"expected": expected, "actual": actual, "result": result}
              for expected, actual, result in [
                  ("Scale", "scale", "correct"), ("a b", "a  b", "correct"),
                  (["A", "B"], ["B", "A"], "correct"), (1, 1.0, "correct"),
                  (None, "", "correct"), (None, None, "incorrect"),
                  ("same", "same", "needs_review"), ("same", "same", "correct")]]
    assert [f["result"] for f in exact_projected_fields(fields)] == ["incorrect"] * 7 + ["correct"]
    assert fields[0]["result"] == "correct"  # supplementary reporting never changes frozen scores


def test_exact_document_summary_does_not_hide_a_normalized_only_sample_row():
    fields = [{"source_id": "paper", "field": "title", "result": "correct",
               "expected": "Title", "actual": actual} for actual in ["title", "Title"]]
    assert document_fields(fields, {"title"})[0]["result"] == "correct"
    assert document_fields(exact_projected_fields(fields), {"title"})[0]["result"] == "incorrect"
