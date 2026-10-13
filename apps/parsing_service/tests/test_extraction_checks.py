"""The version 1 Catalog and Article, run through `run.extract`, publish nothing beside the run."""
import pytest

from kei_exp import runs
from kei_exp.kie.extract import run as extraction
from kei_exp.kie.extract import tokens
from tests.helpers import kei as kei_helper
from tests.test_extract_grounded import SCHEMA, CountingChat, WordCounter

V1 = {"catalog": {"strategy": "catalog"}, "article": {"strategy": "article"}}  # no recipe: the version 1 paths


@pytest.fixture
def run_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(tokens, "counter_for", lambda client: WordCounter())
    monkeypatch.setattr(runs, "RUNS", tmp_path / "runs")
    return runs.RUNS / kei_helper.converted_run(runs.RUNS, "kei-convert:ingest:p:a")


def request_for(strategy: str) -> extraction.ExtractRequest:
    return extraction.ExtractRequest.model_validate({"schema": SCHEMA, "options": V1[strategy]})


def stage_of(schema: dict) -> str:
    properties = schema.get("properties", {})
    return ("discovery" if "starts" in properties else "records" if "records" in properties
            else "record" if "site_name" in properties else "grounding")


def version_1():
    """A chat for the version 1 paths: every passage starts a record, and every record's site is a word the source
    does not contain, so verifying it asks the model."""
    def script(system, user, schema):
        stage = stage_of(schema)
        if stage == "discovery":
            return {"starts": schema["properties"]["starts"]["items"]["enum"], "end": None}
        if stage == "records":
            labels = schema["properties"]["records"]["items"]["properties"]["passages"]["items"]["enum"]
            return {"records": [{"label": name, "identity": {}, "passages": [labels[0]]}
                                for name in ("Nowhere", "Elsewhere")]}
        return {"site_name": "Nowhere"} if stage == "record" else {}
    return script


def test_an_extraction_publishes_nothing_beside_the_run(run_dir):
    """Durable execution retains results in the coordination schema; no implementation writes an extraction
    directory under the run."""
    extraction.extract(run_dir, request_for("article"), CountingChat(version_1()))
    extraction.extract(run_dir, request_for("catalog"), CountingChat(version_1()))
    assert not (run_dir / "extractions").exists()
