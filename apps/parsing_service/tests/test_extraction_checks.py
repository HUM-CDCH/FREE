"""The Catalog and Article, run through `run.extract`, publish nothing beside the run."""
import pytest

from kei_exp import runs
from kei_exp.kie.extract import run as extraction
from kei_exp.kie.extract import tokens
from tests.helpers import kei as kei_helper
from tests.helpers.extraction import CountingChat, WordCounter
from tests.test_unified_catalog import Model, request as catalog_request


@pytest.fixture
def run_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(tokens, "counter_for", lambda client: WordCounter())
    monkeypatch.setattr(runs, "RUNS", tmp_path / "runs")
    return runs.RUNS / kei_helper.converted_run(runs.RUNS, "kei-convert:ingest:p:a")


def article_request() -> extraction.ExtractRequest:
    return extraction.ExtractRequest.model_validate({"schema": {"recordDescription":"A site", "schemaNodes":[{"id":"s","name":"site_name","type":"string"}]}, "options": {"strategy": "article"}})


def article_answer(system, user, schema):
    """The record's site is a word the source does not contain, so verifying it asks the model."""
    return {"site_name": "Nowhere"} if "site_name" in schema.get("properties", {}) else {}


def test_an_extraction_publishes_nothing_beside_the_run(run_dir):
    """Durable execution retains results in the coordination schema; no implementation writes an extraction
    directory under the run."""
    extraction.extract(run_dir, article_request(), CountingChat(article_answer))
    extraction.extract(run_dir, catalog_request(), CountingChat(Model(__import__("kei_exp.kie.passages", fromlist=["load"]).load(run_dir))), counter=WordCounter())
    assert not (run_dir / "extractions").exists()
