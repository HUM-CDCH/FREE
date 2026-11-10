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
    words = [w for w in words if w.text.strip()]
    lines = []
    for word in sorted(words, key=lambda w: (w.rect.to_bounding_box().t, w.rect.to_bounding_box().l)):
        box = word.rect.to_bounding_box()
        if lines and box.t < min(w.rect.to_bounding_box().b for w in lines[-1]):
            lines[-1].append(word)
        else:
            lines.append([word])

    def owners(word):
        box = word.rect.to_bounding_box()
        x, y = (box.l + box.r) / 2, (box.t + box.b) / 2
        return [c for c in cells if c.bbox.l <= x <= c.bbox.r and c.bbox.t <= y <= c.bbox.b]

    def consistent(line):
        rows = None
        for word in line:
            found = {r for c in owners(word) for r in range(c.start_row_offset_idx, c.end_row_offset_idx)}
            rows = found if rows is None else rows & found
        return bool(rows)

    if all(consistent(line) for line in lines):
        return
    columns = [[c for c in cells if c.col_span == 1 and c.start_col_offset_idx == column]
               for column in range(table.num_cols)]
    if not all(columns):
        table.table_cells, table.num_rows, table.num_cols = [], 0, 0
        return
    gaps = [(max(c.bbox.r for c in left), min(c.bbox.l for c in right))
            for left, right in zip(columns, columns[1:])]
    if any(right <= left for left, right in gaps):
        table.table_cells, table.num_rows, table.num_cols = [], 0, 0
        return
    cuts = [(left + right) / 2 for left, right in gaps]
    rebuilt = []
    for row, line in enumerate(lines):
        groups = [[] for _ in columns]
        for word in sorted(line, key=lambda w: w.rect.to_bounding_box().l):
            box = word.rect.to_bounding_box()
            groups[bisect_right(cuts, (box.l + box.r) / 2)].append(word)
        if not all(groups):
            # An incomplete physical line could be a logical row's continuation or a genuinely empty cell.
            # Geometry cannot choose between them after the learned grid contradicted the native words.
            table.table_cells, table.num_rows, table.num_cols = [], 0, 0
            return
        for column, group in enumerate(groups):
            boxes = [w.rect.to_bounding_box() for w in group]
            rebuilt.append(TableCell(text=" ".join(w.text for w in group),
                bbox=BoundingBox.enclosing_bbox(boxes) if boxes else None,
                start_row_offset_idx=row, end_row_offset_idx=row + 1,
                start_col_offset_idx=column, end_col_offset_idx=column + 1,
                column_header=bool(group) and all(any(c.column_header for c in owners(w)) for w in group)))
    table.table_cells, table.num_rows, table.otsl_seq = rebuilt, len(lines), []
