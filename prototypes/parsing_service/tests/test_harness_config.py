"""One validated configuration: incompatible or unsupported choices are refused before any model call, and every
behaviour-affecting setting is in the hash."""
import pytest
from pydantic import ValidationError

from experiments.harness.config import Config


@pytest.mark.parametrize("config, message", [
    ({"input": {"mode": "images"}}, "vision model"),
    ({"input": {"mode": "text+images"}}, "vision model"),
    ({"evidence": {"mode": "coords"}}, "coordinate output"),
    ({"evidence": {"mode": "ids"}}, "layout"),
    ({"verification": {"model": True}}, "cites none"),
    ({"verification": {"gate": "abstain"}}, "evidence gate"),
    ({"retrieval": {"mode": "lexical"}}, "chunking.mode=whole"),
    ({"retrieval": {"expand": 1}}, "lexical retrieval only"),
    ({"decompose": {"mode": "groups"}}, "needs decompose.groups"),
    ({"decompose": {"groups": [["a"]]}}, "only with decompose.mode=groups"),
    ({"sampling": {"n": 3}}, "temperature"),
    ({"sampling": {"n": 2, "temperature": 0.5, "aggregate": "majority"}}, "at least 3"),
    ({"sampling": {"views": ["document"]}}, "field-guided"),
    ({"sampling": {"views": ["field", "field"]}}, "unique"),
    ({"merge": {"continuation": "flags"}}, "chunk boundaries"),
    ({"chunking": {"mode": "fixed", "max_chars": 20000}}, "exceeds budget.input_chars"),
    ({"unknown": 1}, "Extra inputs"),
    ({"chunking": {"mode": "fixed", "overlap": 9}}, "less than or equal to 4"),
    ({"chunking": {"mode": "whole", "overlap": 1}}, "chunking.overlap repeats text between chunks"),
    ({"evidence": {"alignment": {"disambiguate": "record"}}}, "would change nothing"),
])
def test_an_unsupported_or_incoherent_configuration_is_refused_with_its_reason(config, message):
    with pytest.raises((ValueError, ValidationError), match=message):
        Config.model_validate(config)


def test_the_supported_combinations_validate_and_the_baseline_is_the_default():
    assert Config().sha256() == Config.model_validate({}).sha256()
    Config.model_validate({"input": {"mode": "layout"}, "evidence": {"mode": "ids"}, "verification": {"model": True, "gate": "abstain"},
                           "chunking": {"mode": "structure", "overlap": 1}, "retrieval": {"mode": "lexical", "expand": 1},
                           "decompose": {"mode": "max_fields", "max_fields": 2}, "sampling": {"n": 3, "temperature": 0.5, "aggregate": "majority"},
                           "merge": {"continuation": "flags", "resolver": True}, "recovery": {"retries": 1, "subdivide": True},
                           "signals": {"verbalized": True, "top_logprobs": 5}})


def test_every_behaviour_affecting_section_changes_the_hash():
    base = Config().sha256()
    for change in ({"chunking": {"mode": "fixed"}}, {"evidence": {"mode": "quote"}}, {"output": {"constraint": "prompt"}},
                   {"recovery": {"retries": 1}}, {"merge": {"keys": False}}, {"sampling": {"seed": 1}}, {"signals": {"top_logprobs": 3}},
                   {"budget": {"workers": 2}}, {"input": {"mode": "layout"}},
                   {"decompose": {"mode": "max_fields"}}, {"retrieval": {"top_k": 5}}, {"verification": {"model": False, "gate": "off"}}):
        hashed = Config.model_validate(change).sha256()
        assert hashed != base or change == {"verification": {"model": False, "gate": "off"}}, change
    quote = Config.model_validate({"evidence": {"mode": "quote"}}).sha256()
    assert Config.model_validate({"evidence": {"mode": "quote", "alignment": {"fuzzy": True}}}).sha256() != quote      # a nested setting counts
