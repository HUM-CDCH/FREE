"""Runtime admission for the one reviewed page-local continuation observation.

The positive result is bound to the checked-in capture digest. This is not a
general continuation heuristic: adjacency, similarity, geometry, and generated
references are never sufficient evidence.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any


@dataclass(frozen=True)
class ProducerReviewDecision:
    """Internal review result containing an immutable record snapshot."""

    continue_table: bool
    records: tuple[Mapping[str, Any], ...]
    following_content: tuple[Mapping[str, Any], ...]
    reason: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "records", _freeze(self.records))
        object.__setattr__(self, "following_content", _freeze(self.following_content))

    @property
    def groups(self) -> tuple[tuple[Mapping[str, Any], ...], ...]:
        return (
            (self.records,)
            if self.continue_table
            else tuple((record,) for record in self.records)
        )

    @property
    def pages(self) -> tuple[int, ...]:
        return tuple(_page_number(record) for record in self.records)

    @property
    def observed_provenance(self) -> tuple[tuple[Mapping[str, Any], ...], ...]:
        return tuple(
            tuple(record.get("prov", ()))
            if isinstance(record.get("prov"), Sequence)
            and not isinstance(record.get("prov"), (str, bytes))
            else ()
            for record in self.records
        )


def _freeze(value: Any) -> Any:
    """Snapshot nested producer values so a decision cannot drift later."""
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return tuple(_freeze(item) for item in value)
    return value


def _page_number(record: Mapping[str, Any] | Any) -> int:
    if not isinstance(record, Mapping):
        return 0
    provenance = record.get("prov")
    if not isinstance(provenance, Sequence) or isinstance(provenance, (str, bytes)):
        return 0
    for item in provenance:
        if isinstance(item, Mapping) and item.get("page_no") is not None:
            page_no = item["page_no"]
            return page_no if type(page_no) is int and page_no > 0 else 0
    return 0


def _positive_int(value: Any) -> bool:
    return type(value) is int and value > 0


def _valid_cell(cell: Any) -> bool:
    if not isinstance(cell, Mapping):
        return False
    return (
        isinstance(cell.get("text"), str)
        and _positive_int(cell.get("row_span"))
        and _positive_int(cell.get("col_span"))
        and type(cell.get("start_row_offset_idx")) is int
        and type(cell.get("start_col_offset_idx")) is int
        and cell["start_row_offset_idx"] >= 0
        and cell["start_col_offset_idx"] >= 0
        and isinstance(cell.get("column_header"), bool)
        and isinstance(cell.get("row_header"), bool)
        and isinstance(cell.get("row_section"), bool)
    )


def _valid_record(record: Any) -> bool:
    if not isinstance(record, Mapping):
        return False
    provenance = record.get("prov")
    data = record.get("data")
    cells = data.get("table_cells") if isinstance(data, Mapping) else None
    return (
        isinstance(record.get("self_ref"), str)
        and isinstance(provenance, Sequence)
        and not isinstance(provenance, (str, bytes))
        and bool(provenance)
        and len(provenance) == 1
        and all(
            isinstance(item, Mapping) and _positive_int(item.get("page_no"))
            for item in provenance
        )
        and isinstance(data, Mapping)
        and _positive_int(data.get("num_rows"))
        and _positive_int(data.get("num_cols"))
        and isinstance(cells, Sequence)
        and bool(cells)
        and all(_valid_cell(cell) for cell in cells)
    )


def _valid_following_item(item: Any) -> bool:
    if not isinstance(item, Mapping):
        return False
    kind = item.get("kind")
    if kind == "text":
        return isinstance(item.get("text"), str) and bool(item["text"])
    if kind == "table_boundary":
        return isinstance(item.get("self_ref"), str) and bool(item["self_ref"])
    return False


def _following_content(
    boundary: Mapping[str, Any],
) -> tuple[Mapping[str, Any], ...] | None:
    following = boundary.get("following_content", ())
    if not isinstance(following, Sequence) or isinstance(following, (str, bytes)):
        return None
    if not all(_valid_following_item(item) for item in following):
        return None
    return tuple(following)


def _interstitial(boundary: Mapping[str, Any]) -> tuple[Mapping[str, Any], ...] | None:
    items = boundary.get("interstitial", ())
    if not isinstance(items, Sequence) or isinstance(items, (str, bytes)):
        return None
    if not all(isinstance(item, Mapping) for item in items):
        return None
    return tuple(items)


def _doctags(boundary: Mapping[str, Any]) -> tuple[Mapping[str, Any], ...] | None:
    items = boundary.get("doctags", ())
    if not isinstance(items, Sequence) or isinstance(items, (str, bytes)):
        return None
    if not all(isinstance(item, Mapping) for item in items):
        return None
    return tuple(items)


_OTSL_TAG_RE = re.compile(r"</?([A-Za-z0-9_]+)>")


def _parse_otsl_matrix(value: str) -> tuple[tuple[Any, ...], ...] | None:
    """Parse the reviewed OTSL cell stream into an internal logical matrix."""
    if not value.startswith("<otsl>") or not value.endswith("</otsl>"):
        return None
    body = value[len("<otsl>") : -len("</otsl>")]
    cells: list[tuple[Any, ...]] = []
    row = 0
    col = 0
    active: tuple[int, int, str, bool] | None = None
    ended_row = False
    cursor = 0

    def append_text(text: str) -> bool:
        nonlocal active
        if not text.strip():
            return True
        if active is None:
            return False
        active = (active[0], active[1], active[2] + text, active[3])
        return True

    def finish_cell() -> bool:
        nonlocal active, col
        if active is None:
            return False
        cells.append((*active, False, False, 1, 1))
        col += 1
        active = None
        return True

    for match in _OTSL_TAG_RE.finditer(body):
        if not append_text(body[cursor : match.start()]):
            return None
        token = match.group(1)
        cursor = match.end()
        if token.startswith("loc_"):
            continue
        if token in {"ched", "fcel"}:
            if active is not None and not finish_cell():
                return None
            active = (row, col, "", token == "ched")
            ended_row = False
        elif token == "nl":
            if not finish_cell():
                return None
            row += 1
            col = 0
            ended_row = True
        else:
            return None
    if not append_text(body[cursor:]) or active is not None or not ended_row:
        return None
    return tuple(cells)


def _raw_record_matrix(record: Mapping[str, Any]) -> tuple[tuple[Any, ...], ...] | None:
    data = record.get("data")
    cells = data.get("table_cells", ()) if isinstance(data, Mapping) else ()
    if not isinstance(data, Mapping) or not isinstance(cells, Sequence):
        return None
    try:
        rows = int(data["num_rows"])
        cols = int(data["num_cols"])
    except (KeyError, TypeError, ValueError):
        return None
    expected: list[tuple[Any, ...]] = []
    coordinates: set[tuple[int, int]] = set()
    for cell in cells:
        if not isinstance(cell, Mapping):
            return None
        try:
            row = cell["start_row_offset_idx"]
            col = cell["start_col_offset_idx"]
            item = (
                row,
                col,
                cell["text"],
                cell["column_header"],
                cell["row_header"],
                cell["row_section"],
                cell["row_span"],
                cell["col_span"],
            )
        except KeyError:
            return None
        if item[4] or item[5] or item[6] != 1 or item[7] != 1:
            return None
        if type(row) is not int or type(col) is not int:
            return None
        if not (0 <= row < rows and 0 <= col < cols) or (row, col) in coordinates:
            return None
        coordinates.add((row, col))
        expected.append(item)
    if len(expected) != rows * cols:
        return None
    if coordinates != {(row, col) for row in range(rows) for col in range(cols)}:
        return None
    return tuple(sorted(expected, key=lambda item: (item[0], item[1])))


def _producer_observation_matches(
    records: Sequence[Mapping[str, Any]], boundary: Mapping[str, Any]
) -> bool:
    """Match page-local records to their page-local DocTags matrices."""
    doctags = _doctags(boundary)
    if doctags is None or len(records) != len(doctags) or not doctags:
        return False
    pages = tuple(_page_number(record) for record in records)
    doctag_pages = tuple(item.get("page_no") for item in doctags)
    if (
        pages != doctag_pages
        or any(not _positive_int(page) for page in doctag_pages)
        or any(right != left + 1 for left, right in zip(pages, pages[1:], strict=False))
    ):
        return False
    return all(
        (matrix := _parse_otsl_matrix(str(item.get("otsl", "")))) is not None
        and _raw_record_matrix(record) == matrix
        for record, item in zip(records, doctags, strict=True)
    )


def _boundary_reason(boundary: Mapping[str, Any]) -> str | None:
    """Inspect fixture-only raw tags for explicit terminating content."""
    interstitial = _interstitial(boundary)
    if interstitial is None:
        return None
    for item in interstitial:
        tag = item.get("tag")
        if tag == "<text>" and item.get("text"):
            return "intervening_narrative"
        if tag == "<caption>" and item.get("text"):
            return "caption"
        if tag == "<otsl>" and "<ched>" in str(item.get("otsl", "")):
            return "new_table_header_row"
    return None


def _same_column_count(records: Sequence[Mapping[str, Any]]) -> bool:
    first_data = records[0].get("data")
    second_data = records[1].get("data")
    if not isinstance(first_data, Mapping) or not isinstance(second_data, Mapping):
        return False
    return first_data.get("num_cols") == second_data.get("num_cols")


def _body_only_next_fragment(
    records: Sequence[Mapping[str, Any]], boundary: Mapping[str, Any]
) -> bool:
    """Match a header-bearing fragment followed by a body-only fragment."""
    if not _producer_observation_matches(records, boundary):
        return False
    doctags = _doctags(boundary)
    interstitial = _interstitial(boundary)
    if doctags is None or interstitial is None or len(doctags) < 2:
        return False
    first = str(doctags[0].get("otsl", ""))
    second = str(doctags[1].get("otsl", ""))
    return (
        _same_column_count(records)
        and first.startswith("<otsl>")
        and first.endswith("</otsl>")
        and second.startswith("<otsl>")
        and second.endswith("</otsl>")
        and "<ched>" in first
        and "<fcel>" in first
        and "<ched>" not in second
        and "<fcel>" in second
        and bool(interstitial)
        and all(item.get("tag") == "<page_break>" for item in interstitial)
    )


def _decision(
    records: tuple[Mapping[str, Any], ...],
    *,
    continue_table: bool,
    reason: str,
    following_content: tuple[Mapping[str, Any], ...],
) -> ProducerReviewDecision:
    return ProducerReviewDecision(
        continue_table=continue_table,
        records=records,
        following_content=following_content,
        reason=reason,
    )


def evaluate_reviewed_continuation(
    records: Sequence[Mapping[str, Any]],
    *,
    boundary: Mapping[str, Any],
) -> ProducerReviewDecision:
    """Evaluate a reviewed observation from concrete producer-shaped facts.

    The positive decision requires two valid page-local records, matching raw
    DocTags/OTSL page observations,
    a header-bearing first fragment, a body-only second fragment, and a
    page-break-only interstitial. Adjacency, matching text, matching geometry,
    and generated references are never evidence.
    """
    retained = tuple(records)
    following_content = _following_content(boundary)
    if following_content is None:
        return _decision(
            retained,
            continue_table=False,
            reason="malformed_observation",
            following_content=(),
        )
    if len(retained) != 2 or not all(_valid_record(record) for record in retained):
        return _decision(
            retained,
            continue_table=False,
            reason="malformed_observation",
            following_content=following_content,
        )

    if _doctags(boundary) is None or _interstitial(boundary) is None:
        return _decision(
            retained,
            continue_table=False,
            reason="malformed_observation",
            following_content=following_content,
        )

    reason = _boundary_reason(boundary)
    if reason is not None:
        return _decision(
            retained,
            continue_table=False,
            reason=reason,
            following_content=following_content,
        )
    if not _body_only_next_fragment(retained, boundary):
        return _decision(
            retained,
            continue_table=False,
            reason="insufficient_continuation_observation",
            following_content=following_content,
        )
    return _decision(
        retained,
        continue_table=True,
        reason="reviewed_capture_continuation",
        following_content=following_content,
    )


def reviewed_boundary_from_doctags(
    doctags: str,
    records: Sequence[Mapping[str, Any]],
) -> Mapping[str, Any] | None:
    """Build the narrow review input from physical-page DocTags.

    This adapter only extracts producer-observed OTSL fragments and explicit
    page boundaries. It does not infer a continuation from their proximity.
    """
    if not isinstance(doctags, str) or not records:
        return None
    segments = doctags.split("<page_break>")
    doctag_records: list[dict[str, Any]] = []
    for record in records:
        page = _page_number(record)
        if page < 1 or page > len(segments):
            return None
        segment = segments[page - 1]
        matches = list(re.finditer(r"<otsl>.*?</otsl>", segment, re.DOTALL))
        # A physical page may contain several tables. Select only the unique
        # OTSL fragment whose producer-observed matrix matches this record;
        # selecting the first fragment would silently bind the wrong table.
        matching = [
            match
            for match in matches
            if (
                (matrix := _parse_otsl_matrix(match.group(0))) is not None
                and matrix == _raw_record_matrix(record)
            )
        ]
        if len(matching) != 1:
            return None
        match = matching[0]
        doctag_records.append(
            {
                "page_no": page,
                "otsl": match.group(0),
                "following_raw": segment[match.end() :],
            }
        )
    following: list[dict[str, str]] = []
    last_page = _page_number(records[-1])
    if 1 <= last_page <= len(segments):
        segment = segments[last_page - 1]
        match = re.search(r"<otsl>.*?</otsl>(.*)", segment, re.DOTALL)
        if match:
            text = re.sub(
                r"<loc_[^>]+>|</?doctag>|</?(?:page_footer|page_header)>",
                "",
                match.group(1),
            )
            text = re.sub(r"<[^>]+>", "", text).strip()
            if text:
                following.append({"kind": "text", "text": text})
    return {
        "doctags": doctag_records,
        "interstitial": [{"tag": "<page_break>"}] if len(records) == 2 else [],
        "following_content": following
        or [
            {"kind": "table_boundary", "self_ref": str(records[-1].get("self_ref", ""))}
        ],
    }


__all__ = [
    "ProducerReviewDecision",
    "evaluate_reviewed_continuation",
    "reviewed_boundary_from_doctags",
]
