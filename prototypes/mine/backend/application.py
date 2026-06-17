from dataclasses import dataclass

import httpx

from config import Settings
from model_providers import create_model_provider
from shared.model_gateway import ModelGateway
from shared.nuextract_request import NuExtractRequestBuilder
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
    provider = create_model_provider(settings, client)
    model_gateway = ModelGateway(provider, temperature=ReasoningTemperature())
    nuextract_requests = NuExtractRequestBuilder()
    source_documents = SourceDocumentInputPreparer(pdf_dpi=settings.pdf_dpi)
    source_context = SourceContextBuilder()
    return ApplicationServices(
        chat=ChatPipeline(model_gateway),
        extract=ExtractPipeline(
            model_gateway, source_documents, source_context, nuextract_requests
        ),
        generate_template=GenerateTemplatePipeline(
            model_gateway, source_documents, source_context, nuextract_requests
        ),
        markdown=MarkdownPipeline(
            model_gateway, source_documents, source_context, nuextract_requests
        ),
    )
