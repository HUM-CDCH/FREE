from dataclasses import dataclass

from fastapi import APIRouter, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse

from model_providers import ModelProviderError
from shared.model_command import MarkdownTask, ModelCommand
from shared.model_executor import ModelExecutor
from shared.source_context import SourceContextBuilder, SourceContextRequest
from shared.source_document import (
    SourceDocumentError,
    SourceDocumentInput,
    SourceDocumentInputPreparer,
)
from shared.streaming import JSON_RESPONSES

router = APIRouter()


@dataclass(frozen=True, slots=True)
class MarkdownRequest:
    source_document: SourceDocumentInput
    reasoning: bool = False
    temperature: float | None = None


@dataclass(frozen=True, slots=True)
class MarkdownResult:
    markdown: str
    pages: int


class MarkdownPipeline:
    def __init__(
        self,
        model_executor: ModelExecutor,
        source_documents: SourceDocumentInputPreparer,
        source_context: SourceContextBuilder,
    ) -> None:
        self._model_executor = model_executor
        self._source_documents = source_documents
        self._source_context = source_context

    async def run(self, request: MarkdownRequest) -> MarkdownResult:
        document = self._source_documents.prepare(request.source_document)
        source_context = self._source_context.build(SourceContextRequest(document=document))
        result = await self._model_executor.collect(
            ModelCommand(
                task=MarkdownTask(),
                content=source_context.content,
                reasoning=request.reasoning,
                temperature=request.temperature,
            )
        )
        return MarkdownResult(
            markdown=result.output.strip(),
            pages=source_context.page_count,
        )


@router.post("/markdown", responses=JSON_RESPONSES)
async def markdown(
    request: Request,
    file: UploadFile,
    reasoning: bool = Form(False),
    temperature: float | None = Form(None),
) -> Response:
    try:
        result = await request.app.state.services.markdown.run(
            MarkdownRequest(
                source_document=SourceDocumentInput(await file.read(), file.content_type),
                reasoning=reasoning,
                temperature=temperature,
            )
        )
    except SourceDocumentError as exc:
        raise HTTPException(400, str(exc)) from exc
    except ModelProviderError as exc:
        raise HTTPException(502, detail=str(exc)) from exc

    return JSONResponse({"markdown": result.markdown, "pages": result.pages})
