from typing import Any

import httpx
from fastapi import APIRouter, Form, HTTPException, Response, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, TypeAdapter, ValidationError

from shared.model_call import ModelCall
from shared.model_stream import call_model_stream
from shared.pdf import make_image_content, pages_to_jpeg
from shared.result_parsers import TemplateParser
from shared.streaming import JSON_RESPONSES
from shared.temperature import ReasoningTemperature

router = APIRouter()

# Reasoning off, no reasoning splitting, JSON-or-text result parser.
GENERATE_TEMPLATE_CALL = ModelCall(
    temperature=ReasoningTemperature(), parser=TemplateParser()
)

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


@router.post("/generate-template", responses=JSON_RESPONSES)
async def generate_template(
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

    try:
        result = await GENERATE_TEMPLATE_CALL.collect(
            call_model_stream,
            content,
            chat_kwargs,
            reasoning=False,
            temperature=temperature,
        )
    except httpx.HTTPError as exc:
        raise HTTPException(502, detail=f"Model endpoint error: {exc}") from exc

    return JSONResponse(
        {"template": result.value, "raw": result.output, "pages": len(jpeg_pages)}
    )
