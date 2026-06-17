from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Form, HTTPException, Request, Response

from shared.model_call import ModelCall
from shared.model_stream import call_model_stream
from shared.streaming import STREAM_RESPONSES, JsonLineEvent, jsonl_response
from shared.temperature import ReasoningTemperature
from shared.think_splitter import ThinkSplitter

router = APIRouter()

# Composed once; stateless, so safe to share across concurrent requests.
CHAT_CALL = ModelCall(temperature=ReasoningTemperature(), splitter=ThinkSplitter)


async def chat_events(
    content: list[dict[str, Any]],
    chat_kwargs: dict[str, Any],
    temperature: float | None,
    reasoning: bool,
) -> AsyncIterator[JsonLineEvent]:
    streamer = CHAT_CALL.stream(
        call_model_stream, content, chat_kwargs, reasoning=reasoning, temperature=temperature
    )
    async for think_delta, output_delta in streamer:
        yield JsonLineEvent(
            event="delta", data={"think": think_delta, "output": output_delta}
        )
    result = streamer.result
    if result is None:
        raise HTTPException(500, "Model stream ended without producing a result")
    yield JsonLineEvent(
        event="done",
        data={
            "message": result.output.strip(),
            "reasoning": result.reasoning,
            "raw": result.output,
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
        request, chat_events(content, chat_kwargs, temperature, reasoning)
    )
