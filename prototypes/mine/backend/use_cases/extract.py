from typing import Any
from dataclasses import dataclass

from fastapi import APIRouter, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse

from shared.evidence_template import wrap_template_with_evidence
from shared.few_shot_examples import STRUCTURED_EXTRACTION_EXAMPLE
from shared.model_call import ResultParseError
from shared.model_gateway import ModelGateway, ModelGatewayError
from shared.nuextract_request import NuExtractRequestBuilder
from shared.parsing import normalize_template
from shared.result_parsers import AnswerParser, EvidenceStructuredParser, StructuredParser
from shared.source_context import SourceContextBuilder, SourceContextRequest
from shared.source_document import (
    SourceDocumentError,
    SourceDocumentInput,
    SourceDocumentInputPreparer,
)
from shared.streaming import JSON_RESPONSES

router = APIRouter()


def _reconstruct_raw(output: str, reasoning: str | None) -> str:
    """Preserve the prior raw shape: reasoning is wrapped in a </think> marker
    ahead of the answer; without reasoning the output is used verbatim."""
    return f"{reasoning}\n</think>\n{output}" if reasoning else output


@dataclass(frozen=True, slots=True)
class ExtractRequest:
    text: str | None = None
    source_document: SourceDocumentInput | None = None
    template: str | None = None
    instruction: str | None = None
    reasoning: bool = False
    temperature: float | None = None
    include_evidence: bool = True


@dataclass(frozen=True, slots=True)
class ExtractResult:
    result: Any
    reasoning: str | None
    raw: str
    pages: int
    evidence: dict | None = None


class ExtractPipeline:
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

    async def run(self, request: ExtractRequest) -> ExtractResult:
        instruction = (request.instruction or "").strip()
        template_json = normalize_template(request.template)
        use_structured = template_json != "{}"
        use_evidence = request.include_evidence and use_structured

        if use_evidence:
            template_json = wrap_template_with_evidence(template_json)

        document = (
            self._source_documents.prepare(request.source_document)
            if request.source_document is not None
            else None
        )
        text = (request.text or "").strip()
        source_context = self._source_context.build(
            SourceContextRequest(text=text, document=document)
        )
        model_request = (
            self._nuextract_requests.structured_extraction(
                content=source_context.content,
                template_json=template_json,
                instruction=instruction,
                reasoning=request.reasoning,
                temperature=request.temperature,
                include_evidence=use_evidence,
                few_shot=STRUCTURED_EXTRACTION_EXAMPLE if use_structured else None,
            )
            if use_structured
            else self._nuextract_requests.content_extraction(
                content=source_context.content,
                instruction=instruction,
                reasoning=request.reasoning,
                temperature=request.temperature,
            )
        )

        parser = (
            EvidenceStructuredParser() if use_evidence
            else StructuredParser() if use_structured
            else AnswerParser()
        )
        result = await self._model_gateway.collect(model_request, parser=parser)

        if use_evidence:
            clean_result, evidence = result.value
        else:
            clean_result, evidence = result.value, None

        return ExtractResult(
            result=clean_result,
            reasoning=result.reasoning,
            raw=_reconstruct_raw(result.output, result.reasoning),
            pages=source_context.page_count,
            evidence=evidence,
        )


@router.post("/extract", responses=JSON_RESPONSES)
async def extract(
    request: Request,
    file: UploadFile | None = None,
    text: str | None = Form(None),
    template: str | None = Form(None),
    instruction: str | None = Form(None),
    reasoning: bool = Form(False),
    temperature: float | None = Form(None),
    include_evidence: bool = Form(False),
) -> Response:
    text = (text or "").strip()
    if file is None and not text:
        raise HTTPException(400, "Provide a document file or text")

    try:
        result = await request.app.state.services.extract.run(
            ExtractRequest(
                text=text,
                source_document=(
                    SourceDocumentInput(await file.read(), file.content_type)
                    if file is not None
                    else None
                ),
                template=template,
                instruction=instruction,
                reasoning=reasoning,
                temperature=temperature,
                include_evidence=include_evidence,
            )
        )
    except SourceDocumentError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ResultParseError as exc:
        raise HTTPException(
            502,
            detail={
                "message": str(exc),
                "raw": _reconstruct_raw(exc.output, exc.reasoning),
            },
        ) from exc
    except ModelGatewayError as exc:
        raise HTTPException(502, detail=str(exc)) from exc

    return JSONResponse(
        {
            "result": result.result,
            "reasoning": result.reasoning,
            "raw": result.raw,
            "pages": result.pages,
            "evidence": result.evidence,
        }
    )
