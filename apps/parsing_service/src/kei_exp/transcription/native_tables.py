"""Native word alignment constrains a learned table grid before it becomes canonical text.

A printed line's cells must share a logical row (rowspans count). A contradictory grid may not reorder the PDF's
values. Where its columns have disjoint horizontal extents, the native words themselves define physical rows and
cells. This preserves every printed word without guessing at entity boundaries. A grid whose columns cannot be
separated is left unreadable for the existing OCR/incomplete path. Consistent multiline and spanning grids stay intact.
"""
from bisect import bisect_right

from docling_core.types.doc import BoundingBox, TableCell


def align_native_table(table, words):
    cells = [c for c in table.table_cells if c.bbox is not None]
    if not cells or not words:
        return
    lines = []
    for word, box in sorted(((w, w.rect.to_bounding_box()) for w in words if w.text.strip()),
                            key=lambda pair: (pair[1].t, pair[1].l)):
        if lines and box.t < min(b.b for _, b in lines[-1]):
            lines[-1].append((word, box))
        else:
            lines.append([(word, box)])

    def owners(box):
        x, y = (box.l + box.r) / 2, (box.t + box.b) / 2
        return [c for c in cells if c.bbox.l <= x <= c.bbox.r and c.bbox.t <= y <= c.bbox.b]

    def consistent(line):
        rows = None
        for _, box in line:
            found = {r for c in owners(box) for r in range(c.start_row_offset_idx, c.end_row_offset_idx)}
            rows = found if rows is None else rows & found
        return bool(rows)

    if all(consistent(line) for line in lines):
        return
    columns = [[c for c in cells if c.col_span == 1 and c.start_col_offset_idx == column]
               for column in range(table.num_cols)]
    gaps = [(max(c.bbox.r for c in left), min(c.bbox.l for c in right))
            for left, right in zip(columns, columns[1:])] if all(columns) else None
    rebuilt = None
    if gaps is not None and not any(right <= left for left, right in gaps):
        cuts, rebuilt = [(left + right) / 2 for left, right in gaps], []
        for row, line in enumerate(lines):
            groups = [[] for _ in columns]
            for word, box in sorted(line, key=lambda pair: pair[1].l):
                groups[bisect_right(cuts, (box.l + box.r) / 2)].append((word, box))
            if not all(groups):
                # An incomplete physical line could be a logical row's continuation or a genuinely empty cell.
                # Geometry cannot choose between them after the learned grid contradicted the native words.
                rebuilt = None
                break
            rebuilt += [TableCell(text=" ".join(w.text for w, _ in group),
                bbox=BoundingBox.enclosing_bbox([b for _, b in group]),
                start_row_offset_idx=row, end_row_offset_idx=row + 1,
                start_col_offset_idx=column, end_col_offset_idx=column + 1,
                column_header=all(any(c.column_header for c in owners(b)) for _, b in group))
                for column, group in enumerate(groups)]
    if rebuilt is None:  # columns that cannot be separated: unreadable, for the existing OCR/incomplete path
        table.table_cells, table.num_rows, table.num_cols = [], 0, 0
    else:
        table.table_cells, table.num_rows, table.otsl_seq = rebuilt, len(lines), []
