from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Form, HTTPException, Request, Response, UploadFile

from shared.model_stream import call_model_stream
from shared.parsing import (
    extract_answer_block,
    normalize_template,
    parse_json_object_result,
    parse_result,
    resolve_temperature,
)
from shared.pdf import make_image_content, pages_to_jpeg
from shared.streaming import (
    STREAM_RESPONSES,
    JsonLineEvent,
    jsonl_delta_events,
    jsonl_response,
)
from shared.think_splitter import ThinkSplitter

router = APIRouter()


async def extract_events(
    content: list[dict[str, Any]],
    chat_kwargs: dict[str, Any],
    temperature: float,
    reasoning: bool,
    pages: int,
) -> AsyncIterator[JsonLineEvent]:
    splitter = ThinkSplitter(reasoning)
    async for event in jsonl_delta_events(
        splitter, call_model_stream(content, chat_kwargs, temperature)
    ):
        yield event
    think = splitter.think.strip()
    answer = extract_answer_block(splitter.output)
    raw = (
        f"{splitter.think}\n</think>\n{splitter.output}"
        if think
        else splitter.output
    )
    if chat_kwargs.get("mode") == "structured":
        try:
            result = parse_json_object_result(answer)
        except ValueError as exc:
            yield JsonLineEvent(event="error", data={"detail": str(exc), "raw": raw})
            return
    else:
        result = parse_result(answer)
    yield JsonLineEvent(
        event="done",
        data={
            "result": result,
            "reasoning": think or None,
            "raw": raw,
            "pages": pages,
        },
    )


@router.post("/extract", responses=STREAM_RESPONSES)
async def extract(
    request: Request,
    file: UploadFile | None = None,
    text: str | None = Form(None),
    template: str | None = Form(None),
    instruction: str | None = Form(None),
    reasoning: bool = Form(False),
    temperature: float | None = Form(None),
) -> Response:
    text = (text or "").strip()
    if file is None and not text:
        raise HTTPException(400, "Provide a document file or text")

    instruction = (instruction or "").strip()
    template_json = normalize_template(template)
    use_structured = template_json != "{}"

    extra_parts = []
    if instruction:
        extra_parts.append(f"Instructions:\n{instruction}")
    if use_structured:
        extra_parts.append(f"Extraction template:\n```json\n{template_json}\n```")
    extra_text = "\n\n".join(extra_parts) or None
    embedded_extra_text = extra_text

    if file is not None:
        jpeg_pages = pages_to_jpeg(await file.read(), file.content_type)
        content = make_image_content(jpeg_pages, embedded_extra_text)
    else:
        jpeg_pages = []
        content = [
            {
                "type": "text",
                "text": (
                    f"{text}\n\n{embedded_extra_text}"
                    if embedded_extra_text
                    else text
                ),
            }
        ]

    chat_kwargs: dict[str, Any] = {
        "mode": "structured" if use_structured else "content",
        "enable_thinking": reasoning,
    }
    if use_structured:
        chat_kwargs["template"] = template_json
    if instruction:
        chat_kwargs["instructions"] = instruction

    return await jsonl_response(
        request,
        extract_events(
            content,
            chat_kwargs,
            resolve_temperature(temperature, reasoning),
            reasoning,
            len(jpeg_pages),
        ),
    )
