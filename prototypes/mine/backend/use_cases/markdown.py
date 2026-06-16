from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Form, Request, Response, UploadFile

from shared.model_stream import call_model_stream
from shared.parsing import resolve_temperature
from shared.pdf import make_image_content, pages_to_jpeg
from shared.streaming import (
    STREAM_RESPONSES,
    JsonLineEvent,
    jsonl_delta_events,
    jsonl_response,
)
from shared.think_splitter import ThinkSplitter

router = APIRouter()


async def markdown_events(
    jpeg_pages: list[bytes],
    chat_kwargs: dict[str, Any],
    temperature: float,
    reasoning: bool,
) -> AsyncIterator[JsonLineEvent]:
    results = []
    for index, page in enumerate(jpeg_pages):
        page_content = make_image_content([page], None)
        splitter = ThinkSplitter(reasoning)
        async for event in jsonl_delta_events(
            splitter,
            call_model_stream(page_content, chat_kwargs, temperature),
            extra={"page": index},
        ):
            yield event
        output = splitter.output.strip()
        results.append(output)
        yield JsonLineEvent(
            event="page_done",
            data={
                "page": index,
                "markdown": output,
                "reasoning": splitter.think.strip() or None,
            },
        )
    yield JsonLineEvent(event="done", data={"pages": results, "count": len(results)})


@router.post("/markdown", responses=STREAM_RESPONSES)
async def markdown(
    request: Request,
    file: UploadFile,
    reasoning: bool = Form(False),
    temperature: float | None = Form(None),
) -> Response:
    jpeg_pages = pages_to_jpeg(await file.read(), file.content_type)
    chat_kwargs: dict[str, Any] = {"mode": "markdown", "enable_thinking": reasoning}
    return await jsonl_response(
        request,
        markdown_events(
            jpeg_pages,
            chat_kwargs,
            resolve_temperature(temperature, reasoning),
            reasoning,
        ),
    )
