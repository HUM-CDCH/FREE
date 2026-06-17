from typing import Any
from dataclasses import dataclass

from fastapi import APIRouter, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse

from shared.model_call import ResultParseError
from shared.model_gateway import ModelGateway, ModelGatewayError, ModelRequest
from shared.parsing import normalize_template
from shared.result_parsers import AnswerParser, StructuredParser
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


@dataclass(frozen=True, slots=True)
class ExtractResult:
    result: Any
    reasoning: str | None
    raw: str
    pages: int


class ExtractPipeline:
    def __init__(
        self,
        model_gateway: ModelGateway,
        source_documents: SourceDocumentInputPreparer,
        source_context: SourceContextBuilder,
    ) -> None:
        self._model_gateway = model_gateway
        self._source_documents = source_documents
        self._source_context = source_context

    async def run(self, request: ExtractRequest) -> ExtractResult:
        instruction = (request.instruction or "").strip()
        template_json = normalize_template(request.template)
        use_structured = template_json != "{}"

        extra_parts = []
        if instruction:
            extra_parts.append(f"Instructions:\n{instruction}")
        if use_structured:
            extra_parts.append(f"Extraction template:\n```json\n{template_json}\n```")
        extra_text = "\n\n".join(extra_parts) or None

        document = (
            self._source_documents.prepare(request.source_document)
            if request.source_document is not None
            else None
        )
        text = (request.text or "").strip()
        source_text = (
            f"{text}\n\n{extra_text}" if text and extra_text else text or extra_text
        )
        source_context = self._source_context.build(
            SourceContextRequest(text=source_text, document=document)
        )

        chat_kwargs: dict[str, Any] = {
            "mode": "structured" if use_structured else "content",
            "enable_thinking": request.reasoning,
        }
        if use_structured:
            chat_kwargs["template"] = template_json
        if instruction:
            chat_kwargs["instructions"] = instruction

        result = await self._model_gateway.collect(
            ModelRequest(
                content=source_context.content,
                chat_kwargs=chat_kwargs,
                reasoning=request.reasoning,
                temperature=request.temperature,
            ),
            parser=StructuredParser() if use_structured else AnswerParser(),
        )
        return ExtractResult(
            result=result.value,
            reasoning=result.reasoning,
            raw=_reconstruct_raw(result.output, result.reasoning),
            pages=source_context.page_count,
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
        }
    )
