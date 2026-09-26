"""GET /api/ingestion-models: what a new parse may run on, per role, and the default per role."""
import importlib

import pytest
from fastapi.testclient import TestClient

from kei_exp import api, models
from kei_exp.cut import DEFAULT_LAYOUT_MODEL, LAYOUT_MODELS
from kei_exp.models import DEFAULT_OCR_MODEL, MODELS


def test_the_listing_names_both_defaults_and_marks_only_the_loaded_ocr_model_serving(monkeypatch):
    monkeypatch.setattr(api, "loaded_model", lambda url: (True, MODELS["surya"].repo))
    body = TestClient(api.app).get("/api/ingestion-models").json()
    assert body["defaults"] == {"ocr": DEFAULT_OCR_MODEL, "layout": DEFAULT_LAYOUT_MODEL}
    ocr = {model["key"]: model for model in body["models"]["ocr"]}
    assert set(ocr) == set(MODELS)
    assert {key for key, model in ocr.items() if model["serving"]} == {"surya"}
    assert ocr["surya"]["label"] == MODELS["surya"].repo


def test_layout_detectors_run_inside_kei_and_are_always_selectable(monkeypatch):
    monkeypatch.setattr(api, "loaded_model", lambda url: (False, None))
    body = TestClient(api.app).get("/api/ingestion-models").json()
    assert [model["key"] for model in body["models"]["layout"]] == list(LAYOUT_MODELS)
    assert all(model["serving"] for model in body["models"]["layout"])


def test_an_unreachable_ocr_server_serves_no_ocr_model_and_the_listing_still_answers(monkeypatch):
    monkeypatch.setattr(api, "loaded_model", lambda url: (False, None))
    response = TestClient(api.app).get("/api/ingestion-models")
    assert response.status_code == 200
    assert not any(model["serving"] for model in response.json()["models"]["ocr"])


def test_an_unknown_ocr_default_stops_the_service_at_import(monkeypatch):
    saved = dict(vars(models))
    monkeypatch.setenv("KEI_OCR_MODEL", "no-such-model")
    try:
        with pytest.raises(ValueError, match="no-such-model"):
            importlib.reload(models)
    finally:
        # The failed reload rebound part of the module; put back the very objects other modules imported.
        vars(models).clear()
        vars(models).update(saved)
