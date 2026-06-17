from dataclasses import dataclass, field
from typing import Sequence

from model_providers import ChatContent
from shared.source_document import PreparedSourceDocument


@dataclass(frozen=True, slots=True)
class SourceAnnotation:
    text: str
    page_number: int


@dataclass(frozen=True, slots=True)
class SourceContextRequest:
    text: str | None = None
    document: PreparedSourceDocument | None = None
    annotations: Sequence[SourceAnnotation] = field(default_factory=tuple)


@dataclass(frozen=True, slots=True)
class SourceContext:
    content: ChatContent
    page_count: int


class SourceContextBuilder:
    def build(self, request: SourceContextRequest) -> SourceContext:
        content: ChatContent = []
        page_count = 0
        if request.document is not None:
            content.extend(request.document.content)
            page_count = request.document.page_count
        text = (request.text or "").strip()
        if text:
            content.append({"type": "text", "text": text})
        return SourceContext(content=content, page_count=page_count)
