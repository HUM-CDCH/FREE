import base64
import io
from dataclasses import dataclass

import pypdfium2 as pdfium
from PIL import Image

from model_providers import ChatContent


@dataclass(frozen=True, slots=True)
class SourceDocumentInput:
    data: bytes
    content_type: str | None


@dataclass(frozen=True, slots=True)
class PreparedSourceDocument:
    content: ChatContent
    page_count: int


class SourceDocumentError(ValueError):
    pass


def _make_image_content(jpeg_pages: list[bytes]) -> ChatContent:
    return [
        {
            "type": "image_url",
            "image_url": {
                "url": f"data:image/jpeg;base64,{base64.b64encode(page).decode()}",
                "detail": "high",
            },
        }
        for page in jpeg_pages
    ]


class SourceDocumentInputPreparer:
    def __init__(self, *, pdf_dpi: int) -> None:
        self._pdf_dpi = pdf_dpi

    def _pages_to_jpeg(self, source: SourceDocumentInput) -> list[bytes]:
        if source.data.startswith(b"%PDF") or source.content_type == "application/pdf":
            pdf = pdfium.PdfDocument(source.data)
            try:
                images = [
                    page.render(scale=self._pdf_dpi / 72).to_pil() for page in pdf
                ]
            finally:
                pdf.close()
        else:
            try:
                images = [Image.open(io.BytesIO(source.data))]
            except Exception as exc:
                raise SourceDocumentError(
                    "Unsupported file type: expected a PDF or an image"
                ) from exc

        pages = []
        for img in images:
            buffer = io.BytesIO()
            img.convert("RGB").save(buffer, format="JPEG", quality=95)
            pages.append(buffer.getvalue())
        return pages

    def prepare(self, source: SourceDocumentInput) -> PreparedSourceDocument:
        jpeg_pages = self._pages_to_jpeg(source)
        return PreparedSourceDocument(
            content=_make_image_content(jpeg_pages),
            page_count=len(jpeg_pages),
        )
