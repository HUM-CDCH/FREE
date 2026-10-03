"""Native fields through real Catalog discovery/planning/publication, with only model I/O scripted."""
import json
import os
from datetime import UTC, datetime
from types import SimpleNamespace
from pathlib import Path

import pytest
import requests
from pydantic import ValidationError

from kei_exp.kie.extract import gliformer, models, run, unified
from kei_exp.kie.extract.gliformer import GLiFormerFields, native_schema
from kei_exp.kie.extract.models import Router
from tests.test_extract_grounded import CountingChat, WordCounter
from tests.test_unified_catalog import Model, evidence

SCHEMA = {"recordDescription": "Only numbered grave catalogue entries, excluding narrative summaries.",
          "recordScope": "records", "schemaNodes": [
              {"id": "id", "name": "grave_id", "type": "string"},
              {"id": "sex", "name": "sex", "type": "string"},
              {"id": "m", "name": "leather_mentions", "type": "array", "children": [
                  {"id": "d", "name": "description", "type": "verbatim-string",
                   "description": "Leather, skins, hides and fur."}]}]}


@pytest.fixture(autouse=True)
def served(monkeypatch):
    monkeypatch.setattr(models, "EXTRACT_MODELS", models.registry({"KEI_GLIFORMER_URL": "http://native.test"}))
    monkeypatch.setattr(models, "DEFAULTS", models.defaults(models.EXTRACT_MODELS))


def request(schema=SCHEMA, **settings):
    return run.ExtractRequest.model_validate({"schema": schema, "options": {
        "models": {"fields": "gliformer"}, "unified": {"defaults": 1, **settings}}})


class Counter(WordCounter):
    context_tokens = 8192
    info = {"identity": {"revision": "frozen", "threshold": "0.05"}}

    def request_tokens(self, system, user, schema=None):
        assert system == ""  # no heading or instruction text contaminates native input
        assert "record" in schema
        return len(user.split()) + len(json.dumps(schema).split())

    def identity(self):
        return {"source": "native-test", **self.info["identity"]}


class Native(GLiFormerFields):
    def __init__(self):
        super().__init__("http://native.test")
        self.inputs = []

    def structure(self, text, schema, identity):
        self.inputs.append(text)
        # Deliberate bad/missing/duplicate predictions: transport must not fix any of them.
        return {"identity": identity, "input_tokens": Counter().request_tokens("", text, schema),
                "output": {"record": [{"grave_id": "10", "sex": None},
                                      {"grave_id": "017", "leather_mentions": []}, {"grave_id": "017"}]},
                "diagnostics": {"raw_score": None, "effective_score": 1, "span_score": 0.123456}}


def test_optional_fields_only_and_no_default_change():
    assert models.DEFAULTS == {"fields": "instruct", "reasoning": "instruct"}
    both = models.registry({"KEI_GLIFORMER_URL": "http://native", "KEI_NUEXTRACT_URL": "http://nu"})
    assert models.defaults(both)["fields"] == "nuextract"
    assert isinstance(models.chats_for(request().options).fields, GLiFormerFields)
    with pytest.raises(ValidationError, match="reasoning role"):
        run.Options(models={"reasoning": "gliformer"})
    with pytest.raises(ValueError, match="native unified Catalog"):
        Router(Native(), None).for_stage("document")


@pytest.mark.parametrize("case", json.loads((Path(__file__).parent / "fixtures/contracts/gliformer-compatibility.json")
                                          .read_text())["cases"], ids=lambda case: case["id"])
def test_studio_admission_contract_matches_service(case, monkeypatch):
    registry = models.registry({"KEI_GLIFORMER_URL": "http://native.test", "KEI_NUEXTRACT_URL": "http://nu.test"})
    monkeypatch.setattr(models, "EXTRACT_MODELS", registry)
    monkeypatch.setattr(models, "DEFAULTS", models.defaults(registry))
    method = case["method"]
    slot, settings = next(iter(method["settings"].items()))
    options = {"strategy": "article" if slot == "article" else "catalog"}
    if method["models"]:
        options["models"] = method["models"]
    if settings is not None:
        options[slot] = settings
    if slot == "recipe":
        options["catalog"] = {"recipe": "numbered-catalogue-de@1"}
    body = {"schema": case["schema"], "options": options}
    if case["accepted"]:
        run.ExtractRequest.model_validate(body)
    else:
        with pytest.raises(ValidationError):
            run.ExtractRequest.model_validate(body)


@pytest.mark.parametrize("field", [
    {"type": "boolean"}, {"type": "integer"}, {"type": "number"}, {"type": "date"},
    {"type": "string", "allowedValues": ["male", "female"]},
    {"type": "string", "valueSource": "source-filename"},
    {"type": "string", "valueSource": "document"},
    {"type": "array", "itemType": "string"},
    {"type": "object", "children": []},
])
def test_unsupported_semantics_are_rejected_before_any_call(field):
    schema = {**SCHEMA, "schemaNodes": [{"id": "x", "name": "value", **field}]}
    with pytest.raises(ValidationError, match="GLiFormer"):
        request(schema)


def test_unsupported_methods_and_explicit_controls_are_not_ignored():
    for options in ({"strategy": "article"}, {}, {"unified": {"defaults": 1, "headings": True}},
                    {"unified": {"defaults": 1, "verification": True}}):
        with pytest.raises(ValidationError):
            run.ExtractRequest.model_validate({"schema": {**SCHEMA, "recordScope": None},
                                               "options": {"models": {"fields": "gliformer"}, **options}})


def test_schema_keeps_material_guidance_without_synthesizing_a_boolean():
    shape = native_schema(request().schema_)
    assert shape["record"]["fields"] == ["grave_id", "sex"]
    assert "Leather, skins, hides and fur" in shape["record"]["children"]["leather_mentions"]["description"]


def test_entry_isolation_raw_values_scores_and_durable_resume(tmp_path):
    source = evidence("200. Male with goatskin.\n204. Adult male with twigs and matting.\nVorwort summary")
    native = Native()
    router = Router(native, CountingChat(Model(source)))
    counters = {"fields": Counter(), "reasoning": WordCounter()}
    result = run.dispatch(tmp_path, source, request(), router, counter=counters, extraction_id="native")
    assert native.inputs == ["200. Male with goatskin.", "204. Adult male with twigs and matting."]
    raw = result["native_fields"]["windows"]
    assert result["records"] == raw[0]["output"]["record"] + raw[1]["output"]["record"]
    assert len(result["records"]) == 6
    assert "sex" not in result["records"][2]
    assert result["records"][1]["leather_mentions"] == []
    assert raw[0]["diagnostics"]["raw_score"] is None
    assert raw[0]["diagnostics"]["effective_score"] == 1
    assert raw[1]["record_start"] == 3
    assert result["ungrounded"] == [["records", n, "grave_id"] for n in range(6)]
    assert result["evidence"] == [] and result["complete"] is False
    assert result["processing"]["verification"]["enabled"] is False
    assert result["execution"]["effective"]["stages"]["entry"]["output_tokens"] == 0
    assert {call["stage"] for call in result["calls"]} == {"entry", "discovery"}
    resumed = run.dispatch(tmp_path, source, request(), router, counter=counters, extraction_id="native")
    assert len(native.inputs) == 2
    assert resumed["records"] == result["records"]
    assert resumed["native_fields"] == result["native_fields"]
    assert resumed["fingerprint"] == result["fingerprint"]
    changed = Counter()
    changed.info = {"identity": {"revision": "different", "threshold": "0.05"}}
    with pytest.raises(unified.BudgetRefused, match="tokenizer is no longer"):
        run.dispatch(tmp_path, source, request(), router, counter={**counters, "fields": changed}, extraction_id="native")


def test_uncertain_end_is_not_sent_to_model():
    native = Native()
    budget = unified._Budget(Router(native, None), {"fields": Counter()}, {"entry": {"input_tokens": 1000}}, lambda: None)
    reader = unified._Run(request().schema_, budget, {"p1_s0": "200. Male"}, {"overlap": 1})
    work = reader.entry(0, {"end": "unresolved", "ranges": []})
    assert native.inputs == [] and work.failed == 1 and work.native == []


def test_backend_failure_resumes_only_the_unfinished_entry(tmp_path):
    class Interrupted(Native):
        failed = False

        def structure(self, text, schema, identity):
            if text.startswith("204.") and not self.failed:
                self.failed = True
                raise requests.Timeout("test interruption")
            return super().structure(text, schema, identity)

    source = evidence("200. Male with goatskin.\n204. Adult male.")
    native = Interrupted()
    router = Router(native, CountingChat(Model(source)))
    counters = {"fields": Counter(), "reasoning": WordCounter()}
    with pytest.raises(requests.Timeout):
        run.dispatch(tmp_path, source, request(), router, counter=counters, extraction_id="resume")
    assert (tmp_path / "extractions/resume" / unified.entry_name(0)).exists()
    assert not (tmp_path / "extractions/resume" / unified.entry_name(1)).exists()
    result = run.dispatch(tmp_path, source, request(), router, counter=counters, extraction_id="resume")
    assert native.inputs == ["200. Male with goatskin.", "204. Adult male."]
    assert len(result["records"]) == 6


def test_native_health_listing_does_not_probe_a_chat_api(monkeypatch):
    from fastapi.testclient import TestClient
    from kei_exp import api

    monkeypatch.setattr(api, "loaded_model", lambda _: (False, None))
    monkeypatch.setattr(GLiFormerFields, "info", lambda _: {"protocol": 1, "model": gliformer.MODEL})
    listing = TestClient(api.app).get("/api/extraction-models").json()
    native = next(row for row in listing["models"] if row["key"] == "gliformer")
    assert native["serving"] is True and native["roles"] == ["fields"]
    assert listing["defaults"]["fields"] == "instruct"


def test_long_entry_windows_keep_unicode_and_never_see_adjacent_entries():
    native = Native()
    text = "outside\n" + "αβ 🐐 goatskin.\n" * 180 + "neighbor"
    entry = {"ranges": [{"segment": "p1_s0", "start": 8, "end": len(text) - 8}]}
    windows, calls = gliformer.read_entry(native, Counter(), request().schema_, entry, {"p1_s0": text},
                                          ceiling=150, overlap=1, check=lambda: None, number=0)
    assert len(windows) > 1 and all(call.input_tokens <= 150 for call in calls)
    assert all("outside" not in part and "neighbor" not in part for part in native.inputs)
    covered = set()
    for window in windows:
        for span in window["ranges"]:
            covered.update(range(span["start"], span["end"]))
    assert all(index in covered for index in range(8, len(text) - 8) if not text[index].isspace())


def test_native_artifact_contract(tmp_path, monkeypatch):
    from kei_exp.kie.extract import calls
    from kei_exp.kie.passages import load
    from tests.helpers import catalogue
    from tests.helpers.contracts import FIXTURES

    case = {"transcriber": "native", "source_name": "catalogue.pdf", "pages": [{"page": 1, "units": [
        {"index": 0, "segments": ["200. Male with goatskin.", "204. Adult male. No objects."]}]}]}
    directory = catalogue.write(case, tmp_path / "source")
    source = load(directory)
    monkeypatch.setattr(unified, "datetime", SimpleNamespace(now=lambda tz=None: datetime(2026, 10, 3, tzinfo=UTC)))
    for module in (unified, calls):
        monkeypatch.setattr(module, "time", SimpleNamespace(monotonic=lambda: 100.0))
    requested = request()
    produced = run.dispatch(directory, source, requested, Router(Native(), CountingChat(Model(source))),
                            counter={"fields": Counter(), "reasoning": WordCounter()}, extraction_id="native-contract")
    fixture = {"extraction_id": "native-contract", "request": {
        "run_id": source.run_id, "generation": source.generation, "request": {
            "schema": SCHEMA, "options": {"strategy": "catalog", "models": {"fields": "gliformer"},
                                          "unified": {"defaults": 1}}}},
        "manifest": json.loads((directory / "result/result.json").read_text()),
        "pages": [json.loads((directory / "result/pages/1.json").read_text())], "artifact": produced}
    path = FIXTURES / "extract.gliformer.json"
    text = json.dumps(fixture, ensure_ascii=False, separators=(",", ":")) + "\n"
    if os.environ.get("FREE_UPDATE_GOLDEN") == "1":
        path.write_text(text)
    assert text == path.read_text()
