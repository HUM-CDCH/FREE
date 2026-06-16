from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Form, HTTPException, Request, Response

from shared.model_stream import call_model_stream
from shared.parsing import resolve_temperature
from shared.streaming import (
    STREAM_RESPONSES,
    JsonLineEvent,
    jsonl_delta_events,
    jsonl_response,
)
from shared.think_splitter import ThinkSplitter

router = APIRouter()


async def chat_events(
    content: list[dict[str, Any]],
    chat_kwargs: dict[str, Any],
    temperature: float,
    reasoning: bool,
) -> AsyncIterator[JsonLineEvent]:
    splitter = ThinkSplitter(reasoning)
    async for event in jsonl_delta_events(
        splitter, call_model_stream(content, chat_kwargs, temperature)
    ):
        yield event
    message = splitter.output.strip()
    yield JsonLineEvent(
        event="done",
        data={
            "message": message,
            "reasoning": splitter.think.strip() or None,
            "raw": splitter.output,
        },
    )


@router.post("/chat", responses=STREAM_RESPONSES)
async def chat(
    request: Request,
    text: str | None = Form(None),
    reasoning: bool = Form(False),
    temperature: float | None = Form(None),
) -> Response:
    text = (text or "").strip()
    if not text:
        raise HTTPException(400, "Provide chat text")

    content = [{"type": "text", "text": text}]
    chat_kwargs: dict[str, Any] = {"enable_thinking": reasoning}
    return await jsonl_response(
        request,
        chat_events(
            content,
            chat_kwargs,
            resolve_temperature(temperature, reasoning),
            reasoning,
        ),
    )
