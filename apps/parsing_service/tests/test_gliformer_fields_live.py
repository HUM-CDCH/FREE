"""Explicit opt-in smoke against the private native server; no database or production defaults."""
import os

import pytest
import requests

from kei_exp.kie.extract.gliformer import GLiFormerFields

pytestmark = [pytest.mark.live_model,
              pytest.mark.skipif(not os.environ.get("KEI_GLIFORMER_TEST_URL"), reason="set KEI_GLIFORMER_TEST_URL")]


def test_schema_instructions_reach_the_encoder_and_count_matches_inference():
    backend = GLiFormerFields(os.environ["KEI_GLIFORMER_TEST_URL"])
    counter = backend.counter()
    text = "204. Adult male without objects. Covered with twigs and matting bound with string."
    bare = {"record": {"fields": ["grave_id", "sex"], "children": {}}}
    described = {"record": {**bare["record"], "description":
                            "One numbered grave catalogue entry. Extract only explicit source text. "
                            "grave_id is the printed catalogue number; sex is the stated sex of the burial."}}
    count = counter.request_tokens("", text, described)
    assert count > counter.request_tokens("", text, bare)
    reply = backend.structure(text, described, counter.info["identity"])
    assert reply["input_tokens"] == count
    assert reply["identity"]["prompt_version"] == "1"
    assert isinstance(reply["diagnostics"], dict)
    # This is a protocol test, not a correctness assertion about the model's predicted values.


def test_overlong_source_and_foreign_identity_are_refused():
    backend = GLiFormerFields(os.environ["KEI_GLIFORMER_TEST_URL"])
    counter = backend.counter()
    shape = {"record": {"fields": ["grave_id"]}}
    text = "goatskin " * 3000
    assert counter.request_tokens("", text, shape) > counter.context_tokens
    with pytest.raises(requests.HTTPError) as refused:
        backend.structure(text, shape, counter.info["identity"])
    assert refused.value.response.status_code == 413
    with pytest.raises(requests.HTTPError) as foreign:
        backend.structure("204. Male.", shape, {**counter.info["identity"], "revision": "foreign"})
    assert foreign.value.response.status_code == 409
