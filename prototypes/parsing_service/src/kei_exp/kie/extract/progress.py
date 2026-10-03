"""What a running extraction publishes for Studio's partial view, and the reader behind
`GET /api/runs/{run}/extractions/{id}/progress` (design, *What kei publishes during a run*, *kei's progress route*).

Stage files are best effort for the view only: written by atomic rename, a write that fails logged and dropped, never
read by a resume path (`unified.read` and `_entry_reusable` know only `entry_name`), and removed with the extraction
directory by garbage collection. Every file carries the token of the execution that wrote it: the header is written
first by each execution of the step, and the reader skips files of another execution, so a retry's view never mixes
with the previous attempt's. Under `runs/<run>/extractions/<extraction>/`:

  extraction-progress.json                the strategy, the start page and this execution's token, written first
  catalog-entry-<n>.reading.v1.json       the entry's values windows are in flight
  catalog-entry-<n>.candidates.v1.json    the values call returned these candidates; verification runs
  article-context-<k>.v1.json             one value context's answered fields and the root assembled so far
  article-grounding-<b>.v1.json           the links one grounding batch made
"""
from __future__ import annotations

import json
import logging
import re
import secrets
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError

from kei_exp.canonical import canonical_json
from kei_exp.files import publish
from kei_exp.kie.extract.stages import leaves
from kei_exp.kie.passages import EvidenceUnavailable, Passage, load

PROGRESS_VERSION = 1       # the header's layout
CANDIDATES_VERSION = 1     # the reading marker's and the candidates file's layout
ARTICLE_STAGE_VERSION = 1  # the context and grounding files' layout
PROGRESS_NAME = "extraction-progress.json"
_LOG = logging.getLogger(__name__)


def reading_name(number: int) -> str:
    return f"catalog-entry-{number}.reading.v{CANDIDATES_VERSION}.json"


def candidates_name(number: int) -> str:
    """Distinct from `unified.entry_name`, so no resume path can mistake it for a finished entry."""
    return f"catalog-entry-{number}.candidates.v{CANDIDATES_VERSION}.json"


def context_name(index: int) -> str:
    return f"article-context-{index}.v{ARTICLE_STAGE_VERSION}.json"


def grounding_name(batch: int) -> str:
    return f"article-grounding-{batch}.v{ARTICLE_STAGE_VERSION}.json"


def write_stage(path: Path, record: dict) -> None:
    """`record` at `path`, renamed into place: a reader finds the previous file or the whole new one, never a part.
    Best effort: a write that fails (a full disk, a permission) is logged and dropped; the extraction never fails for
    its view (design, Error handling)."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with publish(path) as part:
            part.write_bytes(canonical_json(record))
    except OSError as error:
        _LOG.warning("progress stage %s not written: %s", path.name, error)


def started(directory: Path, strategy: str, start_page: int | None) -> str:
    """The header every reader starts from, and the token this execution marks its stage files with."""
    execution = secrets.token_hex(8)
    write_stage(directory / PROGRESS_NAME, {"version": PROGRESS_VERSION, "execution": execution, "strategy": strategy,
                                            "start_page": start_page})
    return execution


_PAGE = re.compile(r"^p(\d+)_s\d+$")  # a passage id names its page


class _Stage(BaseModel):
    """A stage file's layout; one outside it is skipped by the reader, never served."""
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    execution: str


class _Header(_Stage):
    strategy: Literal["catalog", "article"]
    start_page: int | None


class _Marker(_Stage):
    index: int


class _CandidateRow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: list[str | int]
    value: Any
    quote: str | None
    window: int


class _Candidates(_Stage):
    index: int
    discovery_sha256: str
    ranges: list[dict[str, Any]]
    candidates: list[_CandidateRow]
    record: dict[str, Any]
    failed: int


class _ContestRow(BaseModel):
    """`assemble_document`'s and `_settle`'s conflict: the path (record-relative) and the values that disagreed."""
    model_config = ConfigDict(extra="forbid")
    path: list[str | int]
    candidates: list[Any]


class _LinkRow(BaseModel):
    """An artifact link as `assembly.artifact` or `unified._link` writes it: the fields every link has; a version's own
    fields ride along (`extra="allow"`), so the document carries the row as it was written."""
    model_config = ConfigDict(extra="allow")
    path: list[str | int]
    segment: str
    page: int
    bbox_pt: list[float] | None
    verbatim: bool
    hits: int
    linked_by: str


class _ContextFile(_Stage):
    context: int
    of: int
    answered: int
    failed: int
    passages: dict[str, Any]
    fields: dict[str, Any]
    root: dict[str, Any]
    contested: list[_ContestRow]
    ok: bool
    calls: list[dict[str, Any]]


class _GroundingFile(_Stage):
    links: list[_LinkRow]


class ProgressEntry(BaseModel):
    """One record of the partial view (design §3): where it is in its reading, and what exists of it so far."""
    model_config = ConfigDict(extra="forbid")
    index: int
    label: str | None
    page: int | None
    stage: Literal["queued", "reading", "candidates", "finished"]
    candidates: list[dict[str, Any]] | None  # {path, value, quote, window} rows, in the candidates stage
    record: dict[str, Any] | None            # the values so far (candidates placed, or the finished entry's record)
    evidence: list[dict[str, Any]] | None    # the artifact's own link dicts: a finished entry's, or Article's so far
    contested: list[dict[str, Any]] | None   # {path (record-relative), candidates}: scalars whose verified values disagree
    failed: int | None                       # values windows (Catalog) or contexts (Article) that failed: their nulls are unknown


class ProgressDocument(BaseModel):
    """What `GET /api/runs/{run}/extractions/{id}/progress` answers; `tests/fixtures/contracts/extract.progress.json`
    pins it for Studio's `partialFromProgress`."""
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    strategy: Literal["catalog", "article"]
    started_at_page: int | None
    discovered: int
    finished: int
    entries: list[ProgressEntry]
    document: dict[str, Any] | None  # Article: {contexts, answered, of, failed_contexts, links, grounding_batches}; Catalog: None


def read_progress(run_dir: Path, extraction_id: str) -> dict | None:
    """The progress document for `extraction_id` under `run_dir`, or None before the first stage of record work
    (`catalog-discovery.json`, or the first context file of this execution) exists. Files only: a missing, unreadable,
    malformed or other execution's stage file is skipped, and a finished entry is read before any marker beside it, so a
    stage never regresses."""
    directory = run_dir / "extractions" / extraction_id
    header = _stage(directory / PROGRESS_NAME, _Header)
    if header is None:
        return None
    if header.strategy == "article":
        return _article(directory, header)
    return _catalog(directory, run_dir, header)


def _stage[M: _Stage](path: Path, model: type[M], execution: str | None = None) -> M | None:
    """A stage file as `model`, or None when absent, unreadable, outside its layout (its rows included: a link, a
    contest or a candidate row outside its shape fails the whole file) or (when `execution` is given) written by
    another execution of the step. A file skipped leaves the progress of the files that read: never a failure."""
    try:
        record = model.model_validate_json(path.read_bytes())
    except (OSError, ValueError, ValidationError):  # absent, half-written, or not this layout
        return None
    return None if execution is not None and record.execution != execution else record


def _catalog(directory: Path, run_dir: Path, header: _Header) -> dict | None:
    from kei_exp.kie.extract import unified  # unified imports this module's names: imported here, not at load
    found = _json(directory / "catalog-discovery.json")
    if not isinstance(found, dict) or not isinstance(found.get("entries"), list) \
            or not all(isinstance(entry, dict) for entry in found["entries"]):
        return None  # kei's own write-once record, or nothing: a discovery outside its layout is no progress
    passages = _passages(run_dir)
    entries, finished = [], 0
    for number, entry in enumerate(found["entries"]):
        row = {"index": number, "label": entry.get("label"), "page": _page_of(entry), "stage": "queued",
               "candidates": None, "record": None, "evidence": None, "contested": None, "failed": None}
        published = _json(directory / unified.entry_name(number))
        if isinstance(published, dict):
            try:
                contests = [_ContestRow(path=contest["path"][2:], candidates=[each["value"] for each in contest["candidates"]])
                            for contest in published["work"]["contest"]
                            if isinstance(contest, dict) and contest.get("outcome") == "unresolved"]
                row.update(stage="finished", record=published["work"]["record"],
                           evidence=unified.entry_links(published, passages) if passages is not None else [],
                           contested=[contest.model_dump() for contest in contests])
                finished += 1
                entries.append(row)
                continue
            except (KeyError, TypeError, AttributeError, ValidationError):  # a record outside its own layout: this view does not guess
                row = {**row, "stage": "queued", "record": None, "evidence": None, "contested": None}
        if (candidates := _stage(directory / candidates_name(number), _Candidates, header.execution)) is not None:
            row.update(stage="candidates", candidates=[each.model_dump() for each in candidates.candidates],
                       record=candidates.record, failed=candidates.failed)
        elif _stage(directory / reading_name(number), _Marker, header.execution) is not None:
            row["stage"] = "reading"
        entries.append(row)
    return {"version": PROGRESS_VERSION, "strategy": "catalog", "started_at_page": header.start_page,
            "discovered": len(entries), "finished": finished, "entries": entries, "document": None}


def _article(directory: Path, header: _Header) -> dict | None:
    contexts = sorted((row for path in directory.glob(f"article-context-*.v{ARTICLE_STAGE_VERSION}.json")
                       if (row := _stage(path, _ContextFile, header.execution)) is not None), key=lambda row: row.context)
    if not contexts:
        return None
    latest = max(contexts, key=lambda row: row.answered)  # the root assembled over every context answered so far
    # Grounding verifies the final root (`article.extract` grounds after `document_root`): its links belong to that root
    # alone, so they are attached only once the latest file shows every context answered. A dropped final context write,
    # or a read between that write and a grounding file's, shows the root it has, without links that are not its own.
    complete = latest.answered >= latest.of
    batches = [row for path in sorted(directory.glob(f"article-grounding-*.v{ARTICLE_STAGE_VERSION}.json"))
               if (row := _stage(path, _GroundingFile, header.execution)) is not None] if complete else []
    links = [link.model_dump() for batch in batches for link in batch.links]
    return {"version": PROGRESS_VERSION, "strategy": "article", "started_at_page": header.start_page,
            "discovered": 1, "finished": 0,
            "entries": [{"index": 0, "label": None, "page": None, "stage": "candidates",
                         "candidates": [{"path": list(path), "value": value, "quote": None, "window": 0}
                                        for path, value in leaves(latest.root)],
                         "record": latest.root, "evidence": links,
                         "contested": [contest.model_dump() for contest in latest.contested], "failed": latest.failed}],
            "document": {"contexts": [row.passages for row in contexts], "answered": latest.answered, "of": latest.of,
                         "failed_contexts": latest.failed, "links": links, "grounding_batches": len(batches)}}


def _page_of(entry: dict) -> int | None:
    """The page of the passage an entry's first range names; None when the entry names none the reader can read."""
    ranges = entry.get("ranges")
    first = ranges[0] if isinstance(ranges, list) and ranges else None
    segment = first.get("segment") if isinstance(first, dict) else None
    match = _PAGE.match(segment) if isinstance(segment, str) else None
    return int(match[1]) if match else None


def _json(path: Path) -> Any:
    """A write-once record kei's own code wrote (`unified.py`), or None when absent or half-written."""
    try:
        return json.loads(path.read_bytes())
    except (OSError, ValueError):
        return None


def _passages(run_dir: Path) -> dict[str, Passage] | None:
    """The run's passages by id, for the links a finished entry makes; None when the result cannot be read."""
    try:
        return _loaded(str(run_dir), (run_dir / "result" / "result.json").stat().st_mtime_ns)
    except (OSError, EvidenceUnavailable):
        return None


@lru_cache(maxsize=8)
def _loaded(run_dir: str, _mtime_ns: int) -> dict[str, Passage]:
    """Loaded once per result (a re-conversion rewrites the manifest), so a two-second poll does not re-verify pages."""
    return {passage.id: passage for passage in load(Path(run_dir)).passages}
