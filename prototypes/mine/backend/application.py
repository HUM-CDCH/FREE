from dataclasses import dataclass

import httpx

from config import Settings
from model_providers import ProviderHTTPTransport
from shared.model_executor import ModelExecutor
from shared.request_compiler import RequestCompiler
from shared.source_context import SourceContextBuilder
from shared.source_document import SourceDocumentInputPreparer
from shared.temperature import ReasoningTemperature
from use_cases.chat import ChatPipeline
from use_cases.extract import ExtractPipeline
from use_cases.generate_template import GenerateTemplatePipeline
from use_cases.markdown import MarkdownPipeline


@dataclass(frozen=True, slots=True)
class ApplicationServices:
    chat: ChatPipeline
    extract: ExtractPipeline
    generate_template: GenerateTemplatePipeline
    markdown: MarkdownPipeline


def build_application_services(
    settings: Settings,
    client: httpx.AsyncClient,
) -> ApplicationServices:
    compiler = RequestCompiler(settings, temperature=ReasoningTemperature())
    transport = ProviderHTTPTransport(client)
    model_executor = ModelExecutor(compiler, transport)
    source_documents = SourceDocumentInputPreparer(pdf_dpi=settings.pdf_dpi)
    source_context = SourceContextBuilder()
    return ApplicationServices(
        chat=ChatPipeline(model_executor),
        extract=ExtractPipeline(
            model_executor, source_documents, source_context
        ),
        generate_template=GenerateTemplatePipeline(
            model_executor, source_documents, source_context
        ),
        markdown=MarkdownPipeline(
            model_executor, source_documents, source_context
        ),
    )
