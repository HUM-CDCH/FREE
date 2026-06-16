from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, TypeAdapter, ValidationError

from shared.model_stream import call_model_stream
from shared.parsing import parse_result, pretty_json_or_text, resolve_temperature
from shared.pdf import make_image_content, pages_to_jpeg
from shared.streaming import (
    STREAM_RESPONSES,
    JsonLineEvent,
    jsonl_delta_events,
    jsonl_response,
)
from shared.think_splitter import ThinkSplitter

router = APIRouter()

TEMPLATE_GUIDANCE = (
    "Generate a concise JSON extraction template for this document. "
    "Use descriptive field names and simple type hints like string, "
    "number, YYYY-MM-DD, boolean, or arrays of objects. Return only "
    "the JSON template."
)

ANNOTATION_MODES = ("hints", "fields")


class TemplateAnnotation(BaseModel):
    text: str
    pageNumber: int


TEMPLATE_ANNOTATIONS = TypeAdapter(list[TemplateAnnotation])


def parse_annotations(annotations: str | None) -> list[TemplateAnnotation]:
    if not annotations:
        return []
    try:
        return TEMPLATE_ANNOTATIONS.validate_json(annotations)
    except ValidationError as error:
        raise HTTPException(
            400, f"annotations must be a JSON array of {{text, pageNumber}} objects: {error}"
        ) from error


def template_guidance(annotations: list[TemplateAnnotation], mode: str) -> str:
    if not annotations:
        return TEMPLATE_GUIDANCE
    lines = "\n".join(
        f"- page {item.pageNumber}: {item.text}" for item in annotations
    )
    if mode == "fields":
        instruction = (
            "Build the template primarily from these highlights - derive the "
            "fields from the highlighted information, using the rest of the "
            "document only as context."
        )
    else:
        instruction = (
            "Design the template from the whole document, but make sure every "
            "highlighted piece of information is covered by a field."
        )
    return (
        f"{TEMPLATE_GUIDANCE}\n\n"
        f"The user highlighted these passages in the document:\n{lines}\n"
        f"{instruction}"
    )


async def generate_template_events(
    content: list[dict[str, Any]],
    chat_kwargs: dict[str, Any],
    temperature: float,
    pages: int,
) -> AsyncIterator[JsonLineEvent]:
    splitter = ThinkSplitter(False)
    async for event in jsonl_delta_events(
        splitter, call_model_stream(content, chat_kwargs, temperature)
    ):
        yield event
    template = parse_result(pretty_json_or_text(splitter.output))
    yield JsonLineEvent(
        event="done",
        data={"template": template, "raw": splitter.output, "pages": pages},
    )


@router.post("/generate-template", responses=STREAM_RESPONSES)
async def generate_template(
    request: Request,
    file: UploadFile | None = None,
    temperature: float | None = Form(None),
    annotations: str | None = Form(None),
    annotations_mode: str | None = Form(None),
) -> Response:
    if file is None:
        raise HTTPException(400, "Provide a document file")
    mode = annotations_mode or "hints"
    if mode not in ANNOTATION_MODES:
        raise HTTPException(400, f"annotations_mode must be one of {ANNOTATION_MODES}")
    guidance = template_guidance(parse_annotations(annotations), mode)

    chat_kwargs: dict[str, Any] = {"mode": "template-generation", "enable_thinking": False}
    jpeg_pages = pages_to_jpeg(await file.read(), file.content_type)
    content = make_image_content(jpeg_pages, guidance)

    return await jsonl_response(
        request,
        generate_template_events(
            content,
            chat_kwargs,
            resolve_temperature(temperature, False),
            len(jpeg_pages),
        ),
    )
