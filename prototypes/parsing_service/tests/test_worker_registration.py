"""What the kei worker registers and the API serves: conversion, cleanup and durable Extraction only.

dbos 3.1.0 has no public read of a workflow's registration before launch, so the decorators are read from the source
of the modules `workflows.registered` imports."""
import ast
from pathlib import Path

import pytest

from kei_exp.workflows import config

WORKFLOWS = Path(config.__file__).parent
CURRENT = {"convert": "convert.py", "deleteRuns": "gc.py", "extractDurableV1": "durable_extract.py",
           "extractionCallV1": "durable_extract.py", "deleteDurableHistoryV1": "durable_extract.py"}


def registered_modules() -> list[str]:
    tree = ast.parse((WORKFLOWS / "registered.py").read_text())
    return sorted(alias.name for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
                  for alias in node.names)


def workflow_decorators(module: str) -> dict[str, dict[str, str]]:
    tree = ast.parse((WORKFLOWS / f"{module}.py").read_text())
    found = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef):
            continue
        for decorator in node.decorator_list:
            if isinstance(decorator, ast.Call) and ast.unparse(decorator.func) == "DBOS.workflow":
                keywords = {keyword.arg: ast.unparse(keyword.value) for keyword in decorator.keywords}
                found[ast.literal_eval(keywords["name"])] = keywords
    return found


def test_the_worker_registers_only_conversion_cleanup_and_durable_extraction():
    assert registered_modules() == ["convert", "durable_extract", "gc"]
    names = {name: f"{module}.py" for module in registered_modules() for name in workflow_decorators(module)}
    assert names == CURRENT
    assert not (WORKFLOWS / "extract.py").exists()


def test_every_recoverable_workflow_gives_up_after_five_recovery_attempts():
    assert config.MAX_RECOVERY_ATTEMPTS == 5
    for module in ("convert", "durable_extract"):
        for name, keywords in workflow_decorators(module).items():
            assert keywords["max_recovery_attempts"] == "config.MAX_RECOVERY_ATTEMPTS", name


def test_durable_attempts_run_on_the_kei_extract_lane_studio_names():
    assert config.EXTRACT == "kei-extract" and config.QUEUES[config.EXTRACT] == 2
    assert (config.PRIORITY_INTERACTIVE, config.PRIORITY_BATCH) == (1, 10)


@pytest.mark.parametrize("value, chunks", [(None, 1), ("4", 4), ("1", 1), ("64", 64)])
def test_the_chunk_setting(value, chunks):
    assert config.catalog_chunks({} if value is None else {"KEI_CATALOG_CHUNKS": value}) == chunks


@pytest.mark.parametrize("value", ["0", "-2", "four", "", "65", "400"])
def test_a_bad_chunk_setting_stops_the_worker(value):
    with pytest.raises(ValueError, match="KEI_CATALOG_CHUNKS"):
        config.catalog_chunks({"KEI_CATALOG_CHUNKS": value})


def test_the_durable_planner_reads_the_chunk_setting_from_config():
    source = (WORKFLOWS / "durable_extract.py").read_text()
    assert "chunks=config.CATALOG_CHUNKS" in source
    assert "workflows.extract" not in source


def test_the_api_serves_listings_and_run_files_but_no_extraction_artifact_or_progress():
    from kei_exp.api import app
    paths = sorted(route.path for route in app.routes if route.path.startswith("/api/"))
    assert paths == ["/api/extraction-models", "/api/ingestion-models", "/api/models",
                     "/api/runs/{run_id}/pages/{number}", "/api/runs/{run_id}/result"]
