"""What a running extraction publishes for Studio's partial view, and (Task 4) the reader behind
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

import logging
import secrets
from pathlib import Path

from kei_exp.canonical import canonical_json
from kei_exp.files import publish

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
