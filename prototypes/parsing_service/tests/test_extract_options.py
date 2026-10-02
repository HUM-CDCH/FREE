"""The extract request takes no page scope: a sample was a workbench feature, removed on 2026-10-02."""
import pytest
from pydantic import ValidationError

from kei_exp.kie.extract.grounded import CatalogOptions
from kei_exp.kie.extract.run import Options


def test_a_page_scope_is_refused_as_an_unknown_option():
    with pytest.raises(ValidationError):
        Options(strategy="article", pages=[1])


def test_dumped_article_options_are_exactly_the_recorded_ones():
    assert Options(strategy="article").dumped() == {
        "strategy": "article", "models": None, "discovery_chars": 48_000, "record_chars": 24_000}


def test_dumped_recipe_catalog_options_are_exactly_the_recorded_ones():
    options = Options(strategy="catalog", catalog=CatalogOptions(recipe="numbered-catalogue-de@1"))
    assert options.dumped() == {
        "strategy": "catalog", "models": None, "discovery_chars": 48_000, "record_chars": 24_000,
        "catalog": {"recipe": "numbered-catalogue-de@1", "input_tokens": 4096, "output_tokens": 1024}}
