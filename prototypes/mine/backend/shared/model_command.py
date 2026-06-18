from dataclasses import dataclass

from model_providers.base import ChatContent


@dataclass(frozen=True, slots=True)
class StructuredExtractionTask:
    template_json: str
    instruction: str = ""


@dataclass(frozen=True, slots=True)
class ChatTask:
    pass


@dataclass(frozen=True, slots=True)
class MarkdownTask:
    pass


@dataclass(frozen=True, slots=True)
class ContentExtractionTask:
    instruction: str = ""


@dataclass(frozen=True, slots=True)
class TemplateGenerationTask:
    guidance: str = ""


Task = (
    ChatTask
    | MarkdownTask
    | ContentExtractionTask
    | StructuredExtractionTask
    | TemplateGenerationTask
)


@dataclass(frozen=True, slots=True)
class ModelCommand:
    task: Task
    content: ChatContent
    reasoning: bool = False
    temperature: float | None = None
