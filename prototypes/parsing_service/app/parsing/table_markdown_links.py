"""Link table geometry to the canonical Markdown coordinate system."""

from collections.abc import Sequence
from typing import Any

from app.models.parsed_document import ParsedTable


def link_tables_to_canonical_markdown(
    tables: Sequence[ParsedTable], markdown: str, page_spans: Sequence[Any]
) -> list[ParsedTable]:
    """Attach offsets only when a table view occurs once on its physical page."""
    linked: list[ParsedTable] = []
    for table in tables:
        view = (table.markdown_view or "").strip()
        span = next(
            (item for item in page_spans if getattr(item, "page", None) == table.page_number),
            None,
        )
        if not view or span is None:
            linked.append(table)
            continue
        start = int(getattr(span, "llm_markdown_start"))
        end = int(getattr(span, "llm_markdown_end"))
        first = markdown.find(view, start, end)
        second = markdown.find(view, first + len(view), end) if first >= 0 else -1
        if first < 0 or second >= 0:
            linked.append(table)
            continue
        linked.append(
            table.model_copy(
                update={
                    "canonical_markdown_start": first,
                    "canonical_markdown_end": first + len(view),
                }
            )
        )
    return linked
