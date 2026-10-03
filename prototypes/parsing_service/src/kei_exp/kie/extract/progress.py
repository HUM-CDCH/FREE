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
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

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


_PAGE = re.compile(r"p([0-9]+)_s[0-9]+")  # a passage id names its page (`fullmatch`: ASCII digits, as Studio reads it)

# Studio's acceptance (`packages/extraction/src/partial-result.ts` `progressDocumentSchema`, its links `kei-artifact.ts`
# `evidenceSchema` and `unifiedEvidenceSchema`), mirrored at least as strictly: a stage file the reader serves is one
# Studio accepts, so a malformed file is skipped here, alone, and never nulls the whole view there. `[0-9]`, not `\d`:
# the pattern engine's `\d` is Unicode's, JavaScript's ASCII.
_Count = Annotated[int, Field(ge=0)]
_PageNumber = Annotated[int, Field(ge=1)]
_Path = list[str | _Count]
_Segment = Annotated[str, StringConstraints(pattern=r"^p[0-9]+_s[0-9]+$")]
_Cell = Annotated[str, StringConstraints(pattern=r"^r[0-9]+_c[0-9]+$")]
_Precision = Literal["cell", "segment", "input"]


class _Stage(BaseModel):
    """A stage file's layout; one outside it is skipped by the reader, never served."""
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    execution: str


class _Header(_Stage):
    strategy: Literal["catalog", "article"]
    start_page: _PageNumber | None


class _Marker(_Stage):
    index: _Count


class _Competitor(BaseModel):
    model_config = ConfigDict(extra="allow")
    value: Any


class _Arbitration(BaseModel):
    """A `work.contest` row as `_settle` writes it: the path (`records`, n, ...), its outcome and the verified values."""
    model_config = ConfigDict(extra="allow")
    path: _Path
    outcome: str
    candidates: list[_Competitor]


class _EntryWork(BaseModel):
    """The fields of a published entry's `work` the reader takes; the record's other fields ride along unread."""
    model_config = ConfigDict(extra="allow")
    record: dict[str, Any]
    contest: list[Any]  # a row that is no object is skipped; an object row must be an `_Arbitration`


class _FinishedEntry(BaseModel):
    model_config = ConfigDict(extra="allow")
    work: _EntryWork


class _CandidateRow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: _Path
    value: Any
    quote: str | None
    window: _Count


class _Candidates(_Stage):
    index: _Count
    discovery_sha256: str
    ranges: list[dict[str, Any]]
    candidates: list[_CandidateRow]
    record: dict[str, Any]
    failed: _Count


class _ContestRow(BaseModel):
    """`assemble_document`'s and `_settle`'s conflict: the path (record-relative) and the values that disagreed."""
    model_config = ConfigDict(extra="forbid")
    path: _Path
    candidates: list[Any]


class _Span(BaseModel):
    """A code-point span of a passage, as `spans_json` writes it."""
    model_config = ConfigDict(extra="allow")
    segment: _Segment
    start: _Count
    end: Annotated[int, Field(ge=1)]


class _Link(BaseModel):
    """The fields every artifact link has (`evidenceSchema`); a version's own fields ride along (`extra="allow"`), so
    the document carries the row as it was written. `cell` and `precision` are required: both writers always write
    them, so a dump never adds a key the file did not have."""
    model_config = ConfigDict(extra="allow", allow_inf_nan=False)
    path: _Path
    segment: _Segment
    page: _PageNumber
    bbox_pt: Annotated[list[float], Field(min_length=4, max_length=4)] | None
    verbatim: bool
    hits: _Count
    cell: _Cell | None
    precision: _Precision


class _ModelLink(_Link):
    """Article's link as `assembly.artifact` writes it (`stages.Link`)."""
    linked_by: Literal["lexical", "model"]


class _VerifiedLink(_Link):
    """A Catalog link as `unified._link` writes it (`unifiedEvidenceSchema`): the verified value with its spans."""
    linked_by: Literal["verification"]
    support: Literal["literal", "supporting"]
    spans: Annotated[list[_Span], Field(min_length=1)]
    alternatives: list[list[_Span]]
    raw: str
    item: list[_Span] | None


# Studio's `union(unifiedEvidenceSchema, evidenceSchema)`, told apart by `linked_by`.
_LinkRow = Annotated[_ModelLink | _VerifiedLink, Field(discriminator="linked_by")]


class _ContextFile(_Stage):
    context: _Count
    of: _Count
    answered: _Count
    failed: _Count
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
    index: _Count
    label: str | None
    page: _PageNumber | None
    stage: Literal["queued", "reading", "candidates", "finished"]
    candidates: list[_CandidateRow] | None  # {path, value, quote, window} rows, in the candidates stage
    record: dict[str, Any] | None           # the values so far (candidates placed, or the finished entry's record)
    evidence: list[_LinkRow] | None         # the artifact's own link dicts: a finished entry's, or Article's so far
    contested: list[_ContestRow] | None     # {path (record-relative), candidates}: scalars whose verified values disagree
    failed: _Count | None                   # values windows (Catalog) or contexts (Article) that failed: their nulls are unknown


class DocumentProgress(BaseModel):
    """Article's document: the contexts answered so far of all of them, and the links grounding made once complete."""
    model_config = ConfigDict(extra="forbid")
    contexts: list[Any]  # each context's passages (`Context.dumped`), in source order
    answered: _Count
    of: _Count
    failed_contexts: _Count
    links: list[_LinkRow]
    grounding_batches: _Count


class ProgressDocument(BaseModel):
    """What `GET /api/runs/{run}/extractions/{id}/progress` answers; `tests/fixtures/contracts/extract.progress.json`
    (Catalog) and `extract.progress.article.json` (Article) pin it for Studio's `partialFromProgress`."""
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    strategy: Literal["catalog", "article"]
    started_at_page: _PageNumber | None
    discovered: _Count
    finished: _Count
    entries: list[ProgressEntry]
    document: DocumentProgress | None  # Article's; None for Catalog


def read_progress(run_dir: Path, extraction_id: str) -> dict | None:
    """The progress document for `extraction_id` under `run_dir`, or None before the first stage of record work
    (`catalog-discovery.json`, or the first context file of this execution) exists. Files only: a missing, unreadable,
    malformed or other execution's stage file is skipped, and a finished entry is read before any marker beside it, so a
    stage never regresses. The document is checked against `ProgressDocument` before it is served: one outside it (a
    defect of the reader, the files having been checked one by one) is logged and answered as no progress, never a
    failure of the route."""
    directory = run_dir / "extractions" / extraction_id
    header = _stage(directory / PROGRESS_NAME, _Header)
    if header is None:
        return None
    document = _article(directory, header) if header.strategy == "article" else _catalog(directory, run_dir, header)
    if document is None:
        return None
    try:
        ProgressDocument.model_validate(document)
    except ValidationError as error:
        _LOG.warning("progress of extraction %s outside its contract, not served: %s", extraction_id, error)
        return None
    return document


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
        label = entry.get("label")  # kei's own record, read as the view needs it: a label that is no text is none
        row = {"index": number, "label": label if isinstance(label, str) else None, "page": _page_of(entry),
               "stage": "queued", "candidates": None, "record": None, "evidence": None, "contested": None,
               "failed": None}
        published = _json(directory / unified.entry_name(number))
        if (settled := _finished(published)) is not None:
            record, contested = settled
            row.update(stage="finished", record=record, evidence=_entry_evidence(published, passages),
                       contested=contested)
            finished += 1
            entries.append(row)
            continue
        if (candidates := _stage(directory / candidates_name(number), _Candidates, header.execution)) is not None:
            row.update(stage="candidates", candidates=[each.model_dump() for each in candidates.candidates],
                       record=candidates.record, failed=candidates.failed)
        elif _stage(directory / reading_name(number), _Marker, header.execution) is not None:
            row["stage"] = "reading"
        entries.append(row)
    return {"version": PROGRESS_VERSION, "strategy": "catalog", "started_at_page": header.start_page,
            "discovered": len(entries), "finished": finished, "entries": entries, "document": None}


def _finished(published: Any) -> tuple[dict[str, Any], list[dict[str, Any]]] | None:
    """A published entry's record and its unresolved arbitrations (record-relative paths), or None when the fields the
    view reads are outside their layout: such an entry is shown from its other stage files, as if unpublished."""
    try:
        work = _FinishedEntry.model_validate(published).work
        arbitrations = [_Arbitration.model_validate(row) for row in work.contest if isinstance(row, dict)]
    except ValidationError:
        return None
    return work.record, [_ContestRow(path=row.path[2:], candidates=[each.value for each in row.candidates]).model_dump()
                         for row in arbitrations if row.outcome == "unresolved"]


def _entry_evidence(published: dict, passages: dict[str, Passage] | None) -> list[dict]:
    """The finished entry's links, made by the artifact's own code; none when the result cannot be loaded or the links
    cannot be made from it (a passage the record names is gone): the entry stays finished either way (design §3)."""
    from kei_exp.kie.extract import unified  # as in `_catalog`
    if passages is None:
        return []
    try:
        return unified.entry_links(published, passages)
    except (KeyError, IndexError, TypeError, ValueError, AttributeError):
        return []


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
    """The page of the passage an entry's first range names; None when the entry names none the reader can read (no
    passage id, or a page before the first)."""
    ranges = entry.get("ranges")
    first = ranges[0] if isinstance(ranges, list) and ranges else None
    segment = first.get("segment") if isinstance(first, dict) else None
    match = _PAGE.fullmatch(segment) if isinstance(segment, str) else None
    return int(match[1]) or None if match else None


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
