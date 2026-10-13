"""Which model serves which extraction call: the deployment's registry, its defaults per role, and a run's choice."""
import pytest
from pydantic import ValidationError

from kei_exp.kie.extract import models
from kei_exp.kie.extract.calls import complete
from kei_exp.kie.extract.llm import NuExtractChat, OpenAIChat
from kei_exp.kie.extract.models import ROLE, Router, chats_for, defaults, registry, routes
from kei_exp.kie.extract.run import Options
from tests.helpers.chat import FakeChat

BOTH = {"KEI_EXTRACT_URL": "http://instruct.test:8000/v1/chat/completions", "KEI_EXTRACT_MODEL": "Qwen/Qwen3.8-27B-FP8",
        "KEI_NUEXTRACT_URL": "http://nuextract.test:8000/v1/chat/completions",
        "KEI_NUEXTRACT_MODEL": "numind/NuExtract3-FP8"}
MINICPM = {"KEI_MINICPM_URL": "http://minicpm.test:8000/v1/chat/completions"}


@pytest.fixture
def deployed(monkeypatch):
    """The Compose deployment: an instruction model and NuExtract, each on its own server."""
    monkeypatch.setattr(models, "EXTRACT_MODELS", registry(BOTH))
    monkeypatch.setattr(models, "DEFAULTS", defaults(models.EXTRACT_MODELS))


def test_the_registry_serves_nuextract_only_where_the_deployment_names_its_server():
    assert set(registry(BOTH)) == {"instruct", "nuextract"}
    alone = registry({key: value for key, value in BOTH.items() if not key.startswith("KEI_NUEXTRACT")})
    assert set(alone) == {"instruct"}
    assert defaults(alone) == {"fields": "instruct", "reasoning": "instruct"}


def test_the_defaults_fill_fields_with_nuextract_and_reason_with_the_instruction_model(deployed):
    assert models.DEFAULTS == {"fields": "nuextract", "reasoning": "instruct"}
    router = chats_for(Options())
    assert isinstance(router.fields, NuExtractChat) and router.fields.model == "numind/NuExtract3-FP8"
    assert router.fields.url == BOTH["KEI_NUEXTRACT_URL"]
    assert isinstance(router.reasoning, OpenAIChat) and router.reasoning.model == "Qwen/Qwen3.8-27B-FP8"
    assert router.models == {"fields": "numind/NuExtract3-FP8", "reasoning": "Qwen/Qwen3.8-27B-FP8"}
    assert router.model == "numind/NuExtract3-FP8"  # the model that read the values off the source


def test_a_run_may_route_the_fields_to_the_instruction_model_too(deployed):
    options = Options(models={"fields": "instruct"})
    assert routes(options) == {"fields": "instruct", "reasoning": "instruct"}
    router = chats_for(options)
    assert router.fields is router.reasoning  # one server, one client


@pytest.fixture
def with_minicpm(monkeypatch):
    monkeypatch.setattr(models, "EXTRACT_MODELS", registry({**BOTH, **MINICPM}))
    monkeypatch.setattr(models, "DEFAULTS", defaults(models.EXTRACT_MODELS))


@pytest.mark.parametrize("environ", [{}, {"KEI_MINICPM_MODEL": "custom/minicpm"}, {"KEI_MINICPM_URL": ""}])
def test_minicpm_requires_a_configured_server(environ):
    assert "minicpm" not in registry({**BOTH, **environ})


def test_adding_minicpm_keeps_qwen_and_the_existing_role_defaults(with_minicpm):
    assert set(models.EXTRACT_MODELS) == {"instruct", "nuextract", "minicpm"}
    assert models.EXTRACT_MODELS["minicpm"].roles == frozenset({"fields", "reasoning"})
    router = chats_for(Options())
    assert isinstance(router.fields, NuExtractChat)
    assert router.fields.model == BOTH["KEI_NUEXTRACT_MODEL"]
    assert isinstance(router.reasoning, OpenAIChat)
    assert router.reasoning.model == BOTH["KEI_EXTRACT_MODEL"]
    assert router.reasoning.url == BOTH["KEI_EXTRACT_URL"]



@pytest.mark.parametrize("role", ["fields", "reasoning"])
def test_unconfigured_minicpm_is_refused_at_admission(deployed, role):
    with pytest.raises(ValidationError, match="unknown extraction model 'minicpm'"):
        Options(models={role: "minicpm"})


@pytest.mark.parametrize("choice, message", [
    ({"fields": "gpt"}, "unknown extraction model 'gpt'"),
    ({"reasoning": "nuextract"}, "cannot take the reasoning role"),
    ({"verification": "instruct"}, "verification"),
])
def test_a_route_the_deployment_cannot_serve_is_refused_at_admission(deployed, choice, message):
    with pytest.raises(ValidationError, match=message):
        Options(models=choice)


def test_a_legacy_single_model_is_refused():
    with pytest.raises(ValidationError):
        Options.model_validate({"model": "Qwen/Qwen3.8-27B"})


def test_every_stage_goes_to_its_role():
    fields, reasoning = FakeChat(lambda *_: {}), FakeChat(lambda *_: {})
    router = Router(fields=fields, reasoning=reasoning)
    for stage, role in ROLE.items():
        complete(router, stage=stage, record=None, system="S", user="U", schema={"type": "object"})
        assert (fields if role == "fields" else reasoning).calls[-1]["system"] == "S", stage
    assert len(fields.calls) == 3 and len(reasoning.calls) == 5
    assert set(ROLE) == {"document", "record", "entry", "discovery", "inventory", "grounding", "arbitration",
                         "verification"}
    with pytest.raises(ValueError, match="no role"):
        router.for_stage("summary")


def test_the_api_lists_the_deployment_s_extraction_models_with_their_state_and_the_defaults(deployed, monkeypatch):
    """What Studio's per-run choice offers. No lifespan: the listing needs no store."""
    from fastapi.testclient import TestClient

    from kei_exp import api
    served = {BOTH["KEI_NUEXTRACT_URL"]: (True, "numind/NuExtract3-FP8")}
    monkeypatch.setattr(api, "loaded_model", lambda url: served.get(url, (False, None)))
    response = TestClient(api.app).get("/api/extraction-models")
    assert response.status_code == 200
    assert response.json() == {"defaults": {"fields": "nuextract", "reasoning": "instruct"}, "models": [
        {"key": "instruct", "repo": "Qwen/Qwen3.8-27B-FP8", "roles": ["fields", "reasoning"], "reachable": False,
         "serving": False},
        {"key": "nuextract", "repo": "numind/NuExtract3-FP8", "roles": ["fields"], "reachable": True,
         "serving": True}]}
