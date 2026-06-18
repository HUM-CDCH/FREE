from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Form, HTTPException, Request, Response

from shared.model_command import ChatTask, ModelCommand
from shared.model_executor import ModelExecutor
from shared.streaming import STREAM_RESPONSES, JsonLineEvent, jsonl_response

router = APIRouter()


@dataclass(frozen=True, slots=True)
class ChatRequest:
    text: str
    reasoning: bool = False
    temperature: float | None = None


class ChatPipeline:
    def __init__(self, model_executor: ModelExecutor) -> None:
        self._model_executor = model_executor

    async def stream(self, request: ChatRequest) -> AsyncIterator[JsonLineEvent]:
        content: list[dict[str, Any]] = [{"type": "text", "text": request.text}]
        command = ModelCommand(
            task=ChatTask(),
            content=content,
            reasoning=request.reasoning,
            temperature=request.temperature,
        )
        streamer = self._model_executor.stream(command)
        async for think_delta, output_delta in streamer:
            yield JsonLineEvent(
                event="delta", data={"think": think_delta, "output": output_delta}
            )
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
        request, request.app.state.services.chat.stream(chat_request)
    )
