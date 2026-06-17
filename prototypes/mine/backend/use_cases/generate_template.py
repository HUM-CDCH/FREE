from typing import Any, Sequence
from dataclasses import dataclass

from fastapi import APIRouter, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, TypeAdapter, ValidationError

from shared.model_gateway import ModelGateway, ModelGatewayError
from shared.nuextract_request import (
    NuExtractRequestBuilder,
    TEMPLATE_GENERATION_TASK_INSTRUCTIONS,
)
from shared.result_parsers import TemplateParser
from shared.source_context import (
    SourceAnnotation,
    SourceContextBuilder,
    SourceContextRequest,
)
from shared.source_document import (
    SourceDocumentError,
    SourceDocumentInput,
    SourceDocumentInputPreparer,
)
from shared.streaming import JSON_RESPONSES

router = APIRouter()

TEMPLATE_GUIDANCE = TEMPLATE_GENERATION_TASK_INSTRUCTIONS

ANNOTATION_MODES = ("hints", "fields")


class TemplateAnnotation(BaseModel):
    text: str
    pageNumber: int


TEMPLATE_ANNOTATIONS = TypeAdapter(list[TemplateAnnotation])


def parse_annotations(annotations: str | None) -> list[SourceAnnotation]:
    if not annotations:
        return []
    try:
        parsed = TEMPLATE_ANNOTATIONS.validate_json(annotations)
    except ValidationError as error:
        raise HTTPException(
            400, f"annotations must be a JSON array of {{text, pageNumber}} objects: {error}"
        ) from error
    return [
        SourceAnnotation(text=text, page_number=annotation.pageNumber)
        for annotation in parsed
        if (text := annotation.text.strip())
    ]


def template_guidance(annotations: Sequence[SourceAnnotation], mode: str) -> str:
    if not annotations:
        return TEMPLATE_GUIDANCE
    if mode == "fields":
        instruction = (
            "Use the annotations as the primary signal for which fields the "
            "extraction template should include, using the rest of the "
            "document only as context."
        )
    else:
        instruction = (
            "Design the extraction template from the whole source document, "
            "and treat annotations as additional guidance for field coverage."
        )
    return f"{TEMPLATE_GUIDANCE}\n\n{instruction}"


@dataclass(frozen=True, slots=True)
class GenerateTemplateRequest:
    source_document: SourceDocumentInput
    annotations: list[SourceAnnotation]
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
            SourceContextRequest(document=document, annotations=request.annotations)
        )
        result = await self._model_gateway.collect(
            self._nuextract_requests.schema_suggestion(
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
