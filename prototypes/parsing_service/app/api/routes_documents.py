"""Parsed document routes: canonical ParsedDocument JSON and markdown views."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse

from app.api.deps import http_task_dir, load_metadata, require_completed
from app.models.parsed_document import ParsedDocument
from app.storage.manifests import read_parsed_document
from app.storage.paths import SOURCE_FILENAME

router = APIRouter()


class MarkdownResponse(Response):
    media_type = "text/markdown"


def read_stored_parsed_document(task_id: str) -> ParsedDocument:
    task_dir = http_task_dir(task_id)
    try:
        return read_parsed_document(task_dir)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=500, detail="Could not read parsed document JSON."
        ) from exc


def canonical_markdown(task_id: str) -> str:
    parsed_document = read_stored_parsed_document(task_id)
    return (
        parsed_document.text_views.llm_markdown
        or parsed_document.text_views.doc_tags_simplified
        or parsed_document.text_views.page_marked_text
    )


@router.api_route(
    "/tasks/{task_id}/source",
    methods=["GET", "HEAD"],
    response_class=FileResponse,
    responses={
        200: {
            "content": {
                "application/pdf": {"schema": {"type": "string", "format": "binary"}}
            },
            "description": "The retained source PDF of this task.",
        }
    },
)
async def get_task_source(task_id: str):
    """Serve the retained upload itself.

    Deliberately not `require_completed`: the source exists from task creation and
    stays readable whatever the parse did.
    """
    metadata = load_metadata(task_id)
    # The recorded name, bounded to a bare filename so metadata cannot traverse.
    stored_name = Path(str(metadata.get("source_path") or SOURCE_FILENAME)).name
    source_path = http_task_dir(task_id) / stored_name
    if not source_path.is_file() or source_path.is_symlink():
        raise HTTPException(status_code=404, detail="Task source PDF not found")
    # FileResponse answers Range with 206/416 and HEAD without a body.
    return FileResponse(source_path, media_type="application/pdf")


@router.get(
    "/tasks/{task_id}/markdown",
    response_class=MarkdownResponse,
)
async def get_task_markdown(task_id: str):
    metadata = load_metadata(task_id)
    require_completed(metadata, "markdown")
    return MarkdownResponse(content=canonical_markdown(task_id))


@router.get("/tasks/{task_id}/document", response_model=ParsedDocument)
@router.get(
    "/tasks/{task_id}/parsed-document",
    response_model=ParsedDocument,
    include_in_schema=False,
)
async def get_task_document(task_id: str):
    metadata = load_metadata(task_id)
    require_completed(metadata, "parsed document")
    return read_stored_parsed_document(task_id)
