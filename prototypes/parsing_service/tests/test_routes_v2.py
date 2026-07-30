from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_legacy_parsed_document_alias_is_not_registered() -> None:
    response = TestClient(app).get("/parsed-document")
    assert response.status_code == 404


def test_task_status_schema_does_not_publish_cache_references() -> None:
    fields = set(app.openapi()["components"]["schemas"]["TaskStatusResponse"]["properties"])
    assert "source_store_path" not in fields
    assert "source_path" not in fields
    assert "canonical_parsed_document_ref" not in fields
