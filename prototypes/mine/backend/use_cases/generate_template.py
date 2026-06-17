from typing import Any
from dataclasses import dataclass

from fastapi import APIRouter, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, TypeAdapter, ValidationError

from shared.model_gateway import ModelGateway, ModelGatewayError
from shared.nuextract_request import NuExtractRequestBuilder
from shared.result_parsers import TemplateParser
from shared.source_context import SourceContextBuilder, SourceContextRequest
from shared.source_document import (
    SourceDocumentError,
    SourceDocumentInput,
    SourceDocumentInputPreparer,
)
from shared.streaming import JSON_RESPONSES

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


@dataclass(frozen=True, slots=True)
class GenerateTemplateRequest:
    source_document: SourceDocumentInput
    annotations: list[TemplateAnnotation]
    annotations_mode: str
    temperature: float | None = None


@dataclass(frozen=True, slots=True)
class GenerateTemplateResult:
    template: Any
    raw: str
    pages: int


class GenerateTemplatePipeline:
    def __init__(
        self,
        model_gateway: ModelGateway,
        source_documents: SourceDocumentInputPreparer,
        source_context: SourceContextBuilder,
        nuextract_requests: NuExtractRequestBuilder,
    ) -> None:
        self._model_gateway = model_gateway
        self._source_documents = source_documents
        self._source_context = source_context
        self._nuextract_requests = nuextract_requests

    async def run(self, request: GenerateTemplateRequest) -> GenerateTemplateResult:
        guidance = template_guidance(request.annotations, request.annotations_mode)
        document = self._source_documents.prepare(request.source_document)
        source_context = self._source_context.build(
            SourceContextRequest(document=document)
        )
        result = await self._model_gateway.collect(
            self._nuextract_requests.template_generation(
                content=source_context.content,
                guidance=guidance,
                temperature=request.temperature,
            ),
            parser=TemplateParser(),
        )
        return GenerateTemplateResult(
            template=result.value,
            raw=result.output,
            pages=source_context.page_count,
        )


@router.post("/generate-template", responses=JSON_RESPONSES)
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

    try:
        result = await request.app.state.services.generate_template.run(
            GenerateTemplateRequest(
                source_document=SourceDocumentInput(await file.read(), file.content_type),
                annotations=parse_annotations(annotations),
                annotations_mode=mode,
                temperature=temperature,
            )
        )
    except SourceDocumentError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ModelGatewayError as exc:
        raise HTTPException(502, detail=str(exc)) from exc

    return JSONResponse(
        {"template": result.template, "raw": result.raw, "pages": result.pages}
    )
