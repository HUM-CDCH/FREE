"""The legacy Catalog executors, byte for byte, and the source they leave unread (unify-catalog-extraction 1.2).

Already admitted generic (version 1) and recipe (version 2) Catalog work keeps running on its original executor
until it is drained. These scripted runs, with a fixed clock, pin both executors' complete artifacts: a change to any
module they import that alters what they produce fails here, on every PR, until the executors are retired. Set
`FREE_UPDATE_GOLDEN=1` only when a legacy change is intended and reviewed.

The clipping tests characterize the budgets the unified Catalog replaces: generic Catalog cuts a record's text at
`record_chars` and its document text likewise, its grounding refuses over-budget evidence, and the recipe Catalog
reads document fields from a fitting prefix. A value that only occurs past the cut is never seen by the model.
"""
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from kei_exp.kie.extract import assembly, catalog, grounded, run
from kei_exp.kie.extract.models import as_router
from kei_exp.kie.passages import Evidence, Passage
from tests.helpers import catalogue
from tests.helpers.chat import FakeChat
from tests.test_extract_grounded import SCHEMA as RECIPE_SCHEMA
from tests.test_extract_grounded import CountingChat, WordCounter, honest

GOLDEN = Path(__file__).parent / "golden" / "legacy-catalog"
GENERIC_SCHEMA = {"recordDescription": "One numbered entry of a catalogue.", "schemaNodes": [
    {"id": "n", "name": "entry_no", "type": "string"},
    {"id": "s", "name": "site", "type": "string"},
    {"id": "f", "name": "fundart", "type": "string", "description": "find category after FA:"},
    {"id": "t", "name": "title", "type": "string", "valueSource": "document"},
]}


@pytest.fixture
def frozen(monkeypatch):
    """A fixed start time and a clock that never advances."""
    clock = SimpleNamespace(monotonic=lambda: 100.0)
    fixed = SimpleNamespace(now=lambda tz=None: datetime(2026, 9, 29, 12, tzinfo=UTC))
    for module in (catalog, grounded):
        monkeypatch.setattr(module, "datetime", fixed)
        monkeypatch.setattr(module, "time", clock)
    monkeypatch.setattr(assembly, "time", clock)


def generic_script(system, user, schema):
    properties = schema["properties"]
    if "starts" in properties:  # discovery: every numbered block opens a record
        return {"starts": re.findall(r"\[(B\d+)\] \d+\.", user), "end": None}
    if "title" in properties:
        return {"title": "Bezirk Nord"}
    if all(re.fullmatch(r"C\d+", name) for name in properties):  # grounding: the first passage shown
        return {claim: spec["enum"][0] for claim, spec in properties.items()}
    number = re.search(r"(\d+)\. (\w+)\. FA: (\w+)", user)
    return {"entry_no": number[1], "site": number[2], "fundart": number[3]}


def matches_golden(name: str, result: dict) -> None:
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    path = GOLDEN / f"{name}.json"
    if os.environ.get("FREE_UPDATE_GOLDEN") == "1":
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    assert text == path.read_text(encoding="utf-8")


def test_the_generic_catalog_artifact_is_unchanged(frozen, tmp_path):
    run_dir = catalogue.write("headings", tmp_path / "run")
    request = run.ExtractRequest.model_validate({"schema": GENERIC_SCHEMA, "options": {"strategy": "catalog"}})
    result = run.extract(run_dir, request, as_router(FakeChat(generic_script)))
    assert result["extraction_version"] == 1
    matches_golden("generic-v1", result)


def test_the_recipe_catalog_artifact_is_unchanged(frozen, tmp_path):
    run_dir = catalogue.write("headings", tmp_path / "run")
    schema = {**RECIPE_SCHEMA, "schemaNodes": [*RECIPE_SCHEMA["schemaNodes"], GENERIC_SCHEMA["schemaNodes"][-1]]}
    request = run.ExtractRequest.model_validate({"schema": schema, "options": {
        "strategy": "catalog", "catalog": {"recipe": "numbered-catalogue-de@1"}}})

    def script(system, user, reply_schema):
        if "title" in reply_schema["properties"]:
            return {"title": "Bezirk Nord"}
        return honest(system, user, reply_schema)
    result = run.extract(run_dir, request, CountingChat(script), counter=WordCounter())
    assert result["extraction_version"] == 2
    matches_golden("recipe-v2", result)


def long_evidence(tail: str) -> Evidence:
    """One record whose only mention of its find category lies past 24,000 characters."""
    passages = (Passage(id="p1_s0", page=1, index=0, text="1. Adorf. " + "Beschreibung. " * 2_000, label="Text",
                        bbox_pt=(0.0, 0.0, 1.0, 1.0), extent="block"),
                Passage(id="p2_s0", page=2, index=0, text=tail, label="Text", bbox_pt=(0.0, 0.0, 1.0, 1.0),
                        extent="block"))
    return Evidence(run_id="run-x", generation="g1", digest="d1", source_name="long.pdf", page_count=2,
                    passages=passages)


def test_generic_catalog_never_shows_a_record_value_past_record_chars():
    shown = []

    def script(system, user, schema):
        shown.append(user)
        if "starts" in schema["properties"]:
            return {"starts": ["B1"], "end": None}
        if "title" in schema["properties"]:
            return {"title": None}
        if all(re.fullmatch(r"C\d+", name) for name in schema["properties"]):
            return dict.fromkeys(schema["properties"], "NONE")
        return {"entry_no": "1", "site": "Adorf", "fundart": "EvG" if "FA: EvG" in user else None}
    request = run.ExtractRequest.model_validate({"schema": GENERIC_SCHEMA, "options": {"strategy": "catalog"}})
    result = catalog.extract(None, long_evidence("FA: EvG. Titel: Late"), request, as_router(FakeChat(script)))
    assert result["records"][0]["fundart"] is None
    record_calls = [user for user in shown if user.startswith("### Record")]
    assert record_calls and not any("FA: EvG" in user for user in record_calls)
    truncated = [issue for issue in result["issues"] if issue["code"] == "text_truncated"]
    assert [issue["record"] for issue in truncated] == [None, 0]  # the document call, then the record call
    assert any(issue["code"] == "grounding_exceeds_budget" for issue in result["issues"])


def test_the_recipe_catalog_reads_document_fields_from_a_fitting_prefix(tmp_path):
    entries = [f"{number}. Ort{number}. FA: G." for number in range(1, 81)]
    case = {"pages": [{"page": 1, "units": [{"index": 1, "crops": [{"segments": ["Kreis Heide", *entries]}]}]}]}
    run_dir = catalogue.write(case, tmp_path / "run")
    schema = {**RECIPE_SCHEMA, "schemaNodes": [*RECIPE_SCHEMA["schemaNodes"], GENERIC_SCHEMA["schemaNodes"][-1]]}
    request = run.ExtractRequest.model_validate({"schema": schema, "options": {
        "strategy": "catalog", "catalog": {"recipe": "numbered-catalogue-de@1", "input_tokens": 200}}})
    shown = []

    def script(system, user, reply_schema):
        if "title" in reply_schema["properties"]:
            shown.append(user)
            return {"title": None}
        return honest(system, user, reply_schema)
    result = run.extract(run_dir, request, CountingChat(script), counter=WordCounter())
    (issue,) = [issue for issue in result["issues"] if issue["code"] == "text_truncated"]
    assert issue["detail"].startswith("document fields were read from the first ")
    assert "80. Ort80" not in shown[0]  # the late entries' text never reached the document call
