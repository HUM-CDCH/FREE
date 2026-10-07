"""Table structure and offsets recorded during the same HTML-to-text projection as the parent segment."""
from kei_exp.transcription.types import _TextOf


class _Cells(_TextOf):
    def __init__(self) -> None:
        super().__init__()
        self.cells: list[dict] = []
        self.occupied: set[tuple[int, int]] = set()
        self.row = -1
        self.depth = 0
        self.current: dict | None = None
        self.valid = True

    def text_offset(self) -> int:
        return sum(map(len, self.parts))

    def handle_starttag(self, tag, attrs) -> None:
        super().handle_starttag(tag, attrs)
        if tag == "table":
            self.depth += 1
            if self.depth > 1:
                self.valid = False
        if self.depth != 1:
            return
        if tag == "tr":
            self.row += 1
        elif tag in ("td", "th"):
            if self.current is not None or self.row < 0:
                self.valid = False
                return
            attributes = dict(attrs)
            try:
                rowspan = int(attributes.get("rowspan") or 1)
                colspan = int(attributes.get("colspan") or 1)
            except ValueError:
                self.valid = False
                return
            if not (1 <= rowspan <= 1000 and 1 <= colspan <= 1000 and rowspan * colspan <= 10000):
                self.valid = False
                return
            column = 0
            while (self.row, column) in self.occupied:
                column += 1
            positions = {(r, c) for r in range(self.row, self.row + rowspan)
                         for c in range(column, column + colspan)}
            if self.occupied & positions:
                self.valid = False
            self.occupied |= positions
            self.current = {"cell_id": f"r{self.row}_c{column}", "row": self.row, "column": column,
                            "rowspan": rowspan, "colspan": colspan, "role": "column_header" if tag == "th" else "data",
                            "start": self.text_offset(), "bbox_pt": None}

    def handle_endtag(self, tag) -> None:
        if tag in ("td", "th") and self.depth == 1 and self.current is not None:
            self.cells.append({**self.current, "end": self.text_offset()})
            self.current = None
        if tag == "table":
            self.depth -= 1
        super().handle_endtag(tag)


def table_of_html(html: str) -> dict | None:
    parser = _Cells()
    parser.feed(html)
    parser.close()
    if not parser.valid or parser.current is not None or parser.depth or not parser.cells:
        return None
    text = "".join(parser.parts).rstrip()
    for cell in parser.cells:
        cell["start"] = min(cell["start"], len(text))
        cell["end"] = min(cell["end"], len(text))
        cell["text"] = text[cell["start"]:cell["end"]]
    return {"rows": max(c["row"] + c["rowspan"] for c in parser.cells),
            "columns": max(c["column"] + c["colspan"] for c in parser.cells),
            "cells": parser.cells, "producer": "docling"}
