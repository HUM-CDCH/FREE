from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_legacy_parsed_document_alias_is_not_registered() -> None:
    response = TestClient(app).get("/parsed-document")
    assert response.status_code == 404


def test_malformed_task_ids_are_rejected_the_same_way_on_every_route() -> None:
    client = TestClient(app)
    assert client.get("/tasks/not-a-uuid").status_code == 400
    assert client.post("/tasks/not-a-uuid/retry").status_code == 400


def test_source_and_document_publish_the_same_v2_schema() -> None:
    paths = app.openapi()["paths"]
    source_schema = paths["/tasks/{task_id}/source"]["get"]["responses"]["200"][
        "content"
    ]["application/json"]["schema"]
    document_schema = paths["/tasks/{task_id}/document"]["get"]["responses"][
        "200"
    ]["content"]["application/json"]["schema"]
    assert source_schema == document_schema
    assert "/tasks/{task_id}/parsed-document" not in paths


def test_task_status_schema_does_not_publish_cache_references() -> None:
    fields = set(app.openapi()["components"]["schemas"]["TaskStatusResponse"]["properties"])
    assert "diagnostic_id" not in fields
    assert "source_store_path" not in fields
    assert "source_path" not in fields
    assert "canonical_parsed_document_ref" not in fields
    assert "attempt" not in fields
    assert "attempt_history" not in fields
