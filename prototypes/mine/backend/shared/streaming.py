from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

JSONL_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


class JsonLineEvent(BaseModel):
    event: str
    data: dict[str, Any]


class JSONLResponse(StreamingResponse):
    media_type = "application/jsonl"


# OpenAPI 200 block for the one streaming endpoint (/chat).
STREAM_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {
        "description": (
            "JSON Lines stream of JsonLineEvent objects. Clients that accept "
            "only application/json (e.g. Swagger UI) get a buffered array."
        ),
        "content": {
            "application/json": {"schema": {"type": "array"}},
            "application/jsonl": {"schema": {"type": "string"}},
        },
    }
}

# OpenAPI 200 block for the buffered endpoints (/extract, /generate-template,
# /markdown): a single JSON result object, never JSON Lines.
JSON_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {
        "description": "A single JSON result object.",
        "content": {"application/json": {"schema": {"type": "object"}}},
    }
}


async def catch_model_errors(
    events: AsyncIterator[JsonLineEvent],
) -> AsyncIterator[JsonLineEvent]:
    try:
        async for event in events:
            yield event
    except httpx.HTTPError as exc:
        yield JsonLineEvent(
            event="error", data={"detail": f"Model endpoint error: {exc}"}
        )


async def jsonl_response(
    request: Request, events: AsyncIterator[JsonLineEvent]
) -> Response:
    events = catch_model_errors(events)
    accept = request.headers.get("accept", "")
    if "application/json" in accept and "application/jsonl" not in accept:
        return JSONResponse(
            [event.model_dump(mode="json") async for event in events],
            headers=JSONL_HEADERS,
        )
    return JSONLResponse(
        (f"{event.model_dump_json()}\n" async for event in events),
        headers=JSONL_HEADERS,
    )
