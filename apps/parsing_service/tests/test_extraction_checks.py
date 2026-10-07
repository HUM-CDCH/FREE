"""The version 1 Catalog and Article call their `before_entry` hook at every model-call boundary, and an error it raises
ends the extraction before the next call (`run.extract`'s documented call shape)."""
import pytest

from kei_exp import runs
from kei_exp.failures import KeiFailure
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


def version_1(events: list[str]):
    """A chat for the version 1 paths: every passage starts a record, and every record's site is a word the source
    does not contain, so verifying it asks the model."""
    def script(system, user, schema):
        stage = stage_of(schema)
        events.append(stage)
        if stage == "discovery":
            return {"starts": schema["properties"]["starts"]["items"]["enum"], "end": None}
        if stage == "records":
            labels = schema["properties"]["records"]["items"]["properties"]["passages"]["items"]["enum"]
            return {"records": [{"label": name, "identity": {}, "passages": [labels[0]]}
                                for name in ("Nowhere", "Elsewhere")]}
        return {"site_name": "Nowhere"} if stage == "record" else {}
    return script


def test_the_version_1_catalog_checks_before_discovery_and_each_record_and_verification(run_dir):
    events: list[str] = []
    extraction.extract(run_dir, request_for("catalog"), CountingChat(version_1(events)),
                       before_entry=lambda: events.append("check"))
    records = events.count("record")
    assert records > 1
    # Each record checks before verification and before its (here single) grounding batch.
    assert events == ["check", "discovery", *["check", "record"] * records, *["check", "check", "grounding"] * records]


def test_the_article_checks_before_its_value_call_and_its_verification(run_dir):
    """One document root: no inventory, one value call over the whole source, then its verification."""
    events: list[str] = []
    extraction.extract(run_dir, request_for("article"), CountingChat(version_1(events)),
                       before_entry=lambda: events.append("check"))
    assert events == ["check", "record", "check", "check", "grounding"]


@pytest.mark.parametrize("strategy, asked", [("catalog", ["discovery", "record"]),
    ("article", []), ("article", ["record"])])
def test_a_version_1_check_that_raises_ends_the_extraction_before_its_next_call(run_dir, strategy, asked):
    events: list[str] = []

    def before_entry():
        events.append("check")
        if events.count("check") == len(asked) + 1:
            raise KeiFailure("cancelled", "stop")
    with pytest.raises(KeiFailure, match="cancelled"):
        extraction.extract(run_dir, request_for(strategy), CountingChat(version_1(events)), before_entry=before_entry)
    assert [event for event in events if event != "check"] == asked


def test_an_extraction_publishes_nothing_beside_the_run(run_dir):
    """Durable execution retains results in the coordination schema; no implementation writes an extraction
    directory under the run."""
    extraction.extract(run_dir, request_for("article"), CountingChat(version_1([])))
    extraction.extract(run_dir, request_for("catalog"), CountingChat(version_1([])))
    assert not (run_dir / "extractions").exists()
