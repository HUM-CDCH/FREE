"""Shared HTML export for OCR blocks and pages combining native and OCR evidence."""
from io import BytesIO

from docling.datamodel.backend_options import HTMLBackendOptions
from docling.datamodel.base_models import ConversionStatus, DocumentStream, InputFormat
from docling.document_converter import DocumentConverter, HTMLFormatOption


def converter() -> DocumentConverter:
    # Leading prose is evidence, not a web page's navigation/furniture.
    return DocumentConverter(format_options={InputFormat.HTML: HTMLFormatOption(
        backend_options=HTMLBackendOptions(infer_furniture=False)),  # pyright: ignore[reportCallIssue]
    })


def markdown(converter: DocumentConverter, html: str, name: str) -> tuple[str, str | None]:
    """Block HTML as Markdown, or an explicit conversion failure."""
    if not html.strip():
        return "", None
    source = DocumentStream(name=f"{name}.html", stream=BytesIO(f"<html><body>{html}</body></html>".encode()))
    result = converter.convert(source, raises_on_error=False)
    if result.status != ConversionStatus.SUCCESS:
        return "", "; ".join(error.error_message for error in result.errors) or result.status.value
    return result.document.export_to_markdown(), None
