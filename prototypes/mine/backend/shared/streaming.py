from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from shared.think_splitter import ThinkSplitter

JSONL_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


class JsonLineEvent(BaseModel):
    event: str
    data: dict[str, Any]


class JSONLResponse(StreamingResponse):
    media_type = "application/jsonl"


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


async def jsonl_delta_events(
    splitter: ThinkSplitter,
    model_stream: AsyncIterator[tuple[str, str]],
    extra: dict[str, Any] | None = None,
) -> AsyncIterator[JsonLineEvent]:
    """Emit a delta JSON Lines event per chunk, carrying only the new text."""
    base = extra or {}
    async for reasoning_delta, content_delta in model_stream:
        think_delta, output_delta = splitter.feed(reasoning_delta, content_delta)
        if think_delta or output_delta:
            yield JsonLineEvent(
                event="delta",
                data={**base, "think": think_delta, "output": output_delta},
            )
    tail = splitter.close()
    if tail:
        yield JsonLineEvent(event="delta", data={**base, "think": tail, "output": ""})
