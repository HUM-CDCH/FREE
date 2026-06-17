from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Form, HTTPException, Request, Response

from shared.model_gateway import ModelGateway, ModelGatewayError, ModelRequest
from shared.streaming import STREAM_RESPONSES, JsonLineEvent, jsonl_response

router = APIRouter()


@dataclass(frozen=True, slots=True)
class ChatRequest:
    text: str
    reasoning: bool = False
    temperature: float | None = None


class ChatPipeline:
    def __init__(self, model_gateway: ModelGateway) -> None:
        self._model_gateway = model_gateway

    async def stream(self, request: ChatRequest) -> AsyncIterator[JsonLineEvent]:
        content: list[dict[str, Any]] = [{"type": "text", "text": request.text}]
        model_request = ModelRequest(
            content=content,
            template_kwargs={"enable_thinking": request.reasoning},
            reasoning=request.reasoning,
            temperature=request.temperature,
        )
        streamer = self._model_gateway.stream(model_request)
        try:
            async for think_delta, output_delta in streamer:
                yield JsonLineEvent(
                    event="delta", data={"think": think_delta, "output": output_delta}
                )
        except ModelGatewayError as exc:
            yield JsonLineEvent(event="error", data={"detail": str(exc)})
            return
        result = streamer.result
        if result is None:
            raise RuntimeError("Model stream ended without producing a result")
        yield JsonLineEvent(
            event="done",
            data={
                "message": result.output.strip(),
                "reasoning": result.reasoning,
                "raw": result.output,
            },
        )


async def chat_events(
    pipeline: ChatPipeline,
    request: ChatRequest,
) -> AsyncIterator[JsonLineEvent]:
    async for event in pipeline.stream(request):
        yield event


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

    chat_request = ChatRequest(text=text, reasoning=reasoning, temperature=temperature)
    return await jsonl_response(
        request, chat_events(request.app.state.services.chat, chat_request)
    )
