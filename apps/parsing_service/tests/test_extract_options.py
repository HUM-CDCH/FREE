"""Catalog has one method; retired knobs fail at the request boundary."""
import pytest
from pydantic import ValidationError
from kei_exp.kie.extract.run import Options
from kei_exp.kie.extract.method import REFERENCE


def test_catalog_defaults_to_unified_and_records_it():
    assert Options().dumped() == {"strategy": "catalog", "models": None, "unified": {"defaults": 10}}
    assert Options(strategy="article").dumped() == {"strategy": "article", "models": None}


def test_dumped_article_options_are_exactly_the_recorded_ones():
    assert Options(strategy="article").dumped() == {
        "strategy": "article", "models": None, "discovery_chars": 48_000, "record_chars": 24_000,
        "article": REFERENCE.model_dump()}


@pytest.mark.parametrize("retired", [{"discovery_chars": 1000}, {"record_chars": 1000},
                                     {"catalog": {"recipe": "numbered-catalogue-de@1"}}, {"pages": [1]}])
def test_retired_options_are_refused(retired):
    with pytest.raises(ValidationError):
        Options(**retired)


def test_strategy_settings_cannot_leak():
    with pytest.raises(ValidationError):
        Options(strategy="article", unified={"defaults": 10})
    with pytest.raises(ValidationError):
        Options(strategy="catalog", article={})
