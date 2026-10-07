"""Model-facing structure over canonical text; never a second evidence representation.

Markup wraps the original text, including captions and text between cells. Removing the
markup and unescaping entities recovers each passage exactly. Offsets remain canonical
code-point offsets, not positions in the rendered request. This is tagged model input,
not XML: source text can contain control characters that XML 1.0 cannot represent.
"""
from collections.abc import Sequence
from html import escape

from kei_exp.kie.passages import Passage

RENDERING_VERSION = 1


def structured_source(passages: Sequence[Passage]) -> str:
    return "\n\n".join(_block(passage) for passage in passages)


def _block(passage: Passage) -> str:
    opening = (f'<block id="{escape(passage.id, quote=True)}" '
               f'label="{escape(passage.label, quote=True)}" page="{passage.page}">')
    table = passage.table
    if table is None:
        return opening + escape(passage.text, quote=False) + "</block>"
    parts = [opening, f'<table rows="{table.rows}" columns="{table.columns}">']
    cursor = 0
    for cell in sorted(table.cells, key=lambda cell: (cell.start, cell.end)):
        if cell.start < cursor or cell.end > len(passage.text) or passage.text[cell.start:cell.end] != cell.text:
            raise ValueError(f"{passage.id}/{cell.cell_id}: cell does not preserve canonical text")
        parts.append(escape(passage.text[cursor:cell.start], quote=False))
        role = f' role="{escape(cell.role, quote=True)}"' if cell.role is not None else ""
        parts.append(f'<cell id="{escape(cell.cell_id, quote=True)}" row="{cell.row}" column="{cell.column}" '
                     f'rowspan="{cell.rowspan}" colspan="{cell.colspan}"{role}>'
                     + escape(cell.text, quote=False) + "</cell>")
        cursor = cell.end
    parts.extend([escape(passage.text[cursor:], quote=False), "</table></block>"])
    return "".join(parts)
