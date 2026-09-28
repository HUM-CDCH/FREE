"""The parsing API after kei moved to DBOS: file reads only, no database (spec, *kei worker → Read API*)."""
import shutil
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient

from kei_exp import api, runs
from tests.helpers import kei as kei_helper


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(runs, "RUNS", tmp_path)
    for name in ("KEI_DATABASE_URL", "KEI_SYSTEM_DATABASE_URL"):
        monkeypatch.delenv(name, raising=False)
    with TestClient(api.app) as served:  # the lifespan runs, and needs no database
        yield served


@pytest.mark.parametrize("module", ["kei_exp.models", "kei_exp.api"])
def test_api_and_model_records_load_no_database_or_model_stack(module):
    """Check a fresh process: test collection may already have loaded the worker's dependencies."""
    code = (f"import sys, {module}\n"
            "loaded = {name.split('.')[0] for name in sys.modules} | set(sys.modules)\n"
            "print(sorted(loaded & {'psycopg', 'psycopg_pool', 'procrastinate', 'dbos', 'kei_exp.workflows', "
            "'docling', 'torch', 'surya'}))")
    loaded = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout
    assert loaded.strip() == "[]"


def test_a_published_result_and_its_pages_are_served_byte_for_byte(client, tmp_path):
    run_id = kei_helper.converted_run(tmp_path, "kei-convert:ingest:p:r")
    directory = tmp_path / run_id / "result"
    for route, path in [("result", directory / "result.json"), ("pages/1", directory / "pages" / "1.json")]:
        response = client.get(f"/api/runs/{run_id}/{route}")
        assert response.status_code == 200 and response.content == path.read_bytes(), route
    assert client.get(f"/api/runs/{run_id}/pages/999").status_code == 404
    assert client.get("/api/runs/run-unknown/result").status_code == 404


def test_a_published_extraction_is_served_and_an_unpublished_one_is_404(client, tmp_path):
    run_id = kei_helper.converted_run(tmp_path, "kei-convert:ingest:p:r")
    target = tmp_path / run_id / "extractions" / "x-1" / "result.json"
    assert client.get(f"/api/runs/{run_id}/extractions/x-1").status_code == 404
    target.parent.mkdir(parents=True)
    target.write_text('{"records": []}')
    response = client.get(f"/api/runs/{run_id}/extractions/x-1")
    assert response.status_code == 200 and response.json() == {"records": []}


@pytest.mark.parametrize("path", ["/api/runs/.deleting-r/result", "/api/runs/run-x/extractions/..%2Fresult.json"])
def test_hidden_runs_and_escaping_ids_are_not_found(client, path):
    assert client.get(path).status_code == 404


def test_an_id_with_a_trailing_newline_is_not_found_even_when_its_directory_exists(client, tmp_path):
    """IDs are matched whole (`COMPONENT.fullmatch`): the pattern's `$` alone would accept a trailing newline."""
    run_id = kei_helper.converted_run(tmp_path, "kei-convert:ingest:p:r")
    shutil.copytree(tmp_path / run_id, tmp_path / f"{run_id}\n")
    artifact = tmp_path / run_id / "extractions" / "x-1\n" / "result.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_text('{"records": []}')
    assert client.get(f"/api/runs/{run_id}%0A/result").status_code == 404
    assert client.get(f"/api/runs/{run_id}/extractions/x-1%0A").status_code == 404


@pytest.mark.parametrize("method, path", [("post", "/api/runs"), ("get", "/api/runs/run-x"),
                                          ("post", "/api/runs/run-x/extract")])
def test_the_submission_and_status_routes_are_gone(client, method, path):
    assert getattr(client, method)(path).status_code in (404, 405)


def test_the_models_route_answers_without_a_store(client):
    assert client.get("/api/models").status_code == 200
