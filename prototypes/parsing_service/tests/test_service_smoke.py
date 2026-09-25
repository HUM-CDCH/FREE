"""One parse, end to end, over the real service: PostgreSQL, the HTTP API and a `kei-jobs worker` process.

What it stands up is the deployment's own trio rather than a stand-in for it: the session's throwaway
PostgreSQL with the schema applied, this process serving the API through `TestClient` (whose lifespan installs
the deferring connector exactly as a served API's does), and one real `kei-jobs worker` child sharing that
database, the runs root and the slot. The run is submitted over HTTP and its result and page files are
fetched back over HTTP; nothing is called in process and no adapter is faked.

What it proves is the client contract a consumer builds on (README, "Client contract"), in the order a client
meets it: a submission is accepted and queued with its source identified by hash; the worker finishes it; the
source PDF is kept byte for byte; the manifest and every page file verify against each other through the
shared reader (`kei_exp.pagefile`), covering every page of the document; every segment's evidence lies on the
page it claims; the Markdown carries the pages in order; the store's lifecycle events end with the run's terminal
status and hold no token; and a submission with no `debug` field writes no `debug/` directory.

No model server takes part: the document is born-digital, so the worker resolves the native Docling path.

Env: KEI_SMOKE_PDF — a readable PDF to submit instead of the generated native-text fixture (one of the
consumer's own examples, say). It must be born-digital, for the reason above, and have at least two pages, so
that the reading-order assertion has a first page and a different last one.

Marked slow: it spawns a real worker process against the session's PostgreSQL container and converts a whole
document. About ten seconds in total for the eight-page fixture on this host, most of it the worker's startup
and Docling's model loading — the conversion itself takes a few seconds, more where Docling's layout model
runs on the CPU.
"""
from __future__ import annotations

import contextlib
import hashlib
import os
import signal
import subprocess
import threading
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pypdfium2 as pdfium
import pytest
from fastapi.testclient import TestClient

from kei_exp import api, runs
from kei_exp.jobs import schema, store
from kei_exp.pagefile import RESULT_VERSION, PageResult, read_manifest, read_page
from tests.helpers import slot as slot_helper

pytestmark = [pytest.mark.slow, pytest.mark.live_model]

CONVERSION_TIMEOUT = 180.0  # generous: the eight-page fixture converts in a few seconds, more on a CPU-only host
SERVING_TIMEOUT = 60.0
PHRASE_WORDS = 6            # long enough for a run of words to be one page's own, short enough to be found


@dataclass(frozen=True)
class Service:
    """The deployment under test: the API to call, the runs root both sides share, the worker and its log."""
    client: TestClient
    runs_root: Path
    worker: slot_helper.Worker  # the process that is to do the work: every wait on it watches it live
    log: list[str]              # every line the worker has printed so far, appended by the draining thread


@pytest.fixture(scope="session")
def smoke_pdf(request: pytest.FixtureRequest) -> Path:
    """The document this test submits: `KEI_SMOKE_PDF` when it names a readable file, else the repository's."""
    chosen = os.environ.get("KEI_SMOKE_PDF")
    if not chosen:
        return request.getfixturevalue("digital_pdf")  # generated locally; no external PDF fixture
    path = Path(chosen).expanduser()
    if not path.is_file() or not os.access(path, os.R_OK):
        pytest.fail(f"KEI_SMOKE_PDF names {path}, which is not a readable file")
    return path


@pytest.fixture
def service(database: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Service]:
    """PostgreSQL, the API and one worker, wired to each other and to a runs root under `tmp_path`.

    The store is pointed at this test's throwaway database and `runs.RUNS` at that root before the API starts,
    as tests/test_api_jobs.py's `client` does, so the lifespan confirms the pool already open by that name
    instead of refusing a conflicting conninfo. The worker is given the same database, the same root and the
    slot the API defers to, as tests/test_jobs_recovery.py's workers are.
    """
    schema.apply(database)
    store.close_pool()
    store.pool(database)
    runs_root = tmp_path / "runs"
    runs_root.mkdir(parents=True)
    monkeypatch.setattr(runs, "RUNS", runs_root)
    monkeypatch.setattr(api, "DATABASE_URL", database)
    try:
        with TestClient(api.app) as client:
            log: list[str] = []
            worker = slot_helper.worker("slot-1", database=database, runs_root=runs_root)
            reader = threading.Thread(target=_drain, args=(worker, log), daemon=True)
            reader.start()
            try:
                _serving(worker, log, SERVING_TIMEOUT)
                yield Service(client, runs_root, worker, log)
            finally:
                _shutdown(worker)
                reader.join(timeout=20)
    finally:
        store.close_pool()  # the pool this fixture opened is this fixture's to close, on every exit path


def _drain(worker: slot_helper.Worker, log: list[str]) -> None:
    """Keep the worker's pipe empty for the whole run, and keep every line it wrote.

    Both halves matter. The pipe holds a few dozen KiB, and a conversion logging at INFO past that with nobody
    reading would block the worker mid-document; and the lines are the evidence for the traceback assertion,
    which wants the log from the first one rather than from wherever a startup wait happened to stop.
    """
    assert worker.process.stdout is not None
    while line := worker.process.stdout.readline():  # "" only at EOF, once the worker's pipe is closed
        log.append(line)


def _alive(worker: slot_helper.Worker, log: list[str], what: str) -> None:
    """Fail now — with the exit code and everything the worker printed — rather than wait out a bound on a
    process that is already gone. Every poll below what the worker is to do goes through this."""
    assert worker.process.poll() is None, \
        f"the worker exited with {worker.process.returncode} {what}:\n{''.join(log)}"


def _serving(worker: slot_helper.Worker, log: list[str], timeout: float) -> None:
    """Wait for the line `worker.serve` prints once it has taken the slot and settled what was in flight."""
    def reconciled() -> bool:
        _alive(worker, log, "before it started serving")
        return any("reconciled" in line for line in log)
    slot_helper.until(reconciled, timeout=timeout, what="the worker starting to serve")


def _shutdown(worker: slot_helper.Worker) -> None:
    """Kill and reap the worker unconditionally; never raises, so it cannot mask a failed assertion or leave an
    orphan holding the slot's lock file (tests/test_jobs_recovery.py's `_shutdown`, for the same reasons)."""
    if worker.process.poll() is None:
        with contextlib.suppress(ProcessLookupError):
            os.kill(worker.process.pid, signal.SIGKILL)
    with contextlib.suppress(subprocess.TimeoutExpired):
        worker.process.wait(timeout=20)


def _terminal(service: Service, run_id: str, timeout: float) -> dict:
    """The run's summary once `GET /api/runs/{id}` reports a terminal status: polled on that state, never on a
    duration, so the bound is only a bound and never the proof.

    The poll watches the worker as well as the run, as `_serving`'s does. A worker that dies mid-conversion
    would otherwise spend the whole bound to report only that nothing happened, when the process that was to
    make it happen is gone and its log says why.
    """
    def finished() -> dict | None:
        body = service.client.get(f"/api/runs/{run_id}").json()
        if body["status"] in ("done", "failed", "cancelled"):
            return body  # a run that reached a terminal state is terminal, whatever becomes of the worker after
        _alive(service.worker, service.log, "before the run reached a terminal state")
        return None
    return slot_helper.until(finished, timeout=timeout, what=f"run {run_id} reaching a terminal state")


def _flat(text: str) -> str:
    """`text` with every run of whitespace as one space: a segment's text and the Markdown wrap differently."""
    return " ".join(text.split())


def _phrases(text: str) -> Iterator[str]:
    """Every window of PHRASE_WORDS consecutive plain words in `text`.

    Plain, and consecutive within one such run: Markdown escapes some punctuation, so a window that spans a
    comma or an asterisk may be spelled differently in the document than in the segment that carries it.
    """
    words: list[str] = []
    for token in [*text.split(), "."]:
        if token.isalnum():
            words.append(token)
            continue
        for start in range(len(words) - PHRASE_WORDS + 1):
            yield " ".join(words[start:start + PHRASE_WORDS])
        words = []


def _locate(page: PageResult, markdown: str) -> int | None:
    """Where this page's text sits in `markdown`, by the first phrase of its segments that occurs there exactly
    once. Exactly once, so the position found is this page's own and not the first of several."""
    for segment in page.segments:
        for phrase in _phrases(segment.text):
            if markdown.count(phrase) == 1:
                return markdown.index(phrase)
    return None


def _persisted(run_id: str) -> list[dict]:
    """Every event the store holds for `run_id`, read one bounded page at a time, as the worker's readers do."""
    events: list[dict] = []
    after = -1
    while True:
        page = store.events_after(run_id, after)
        events += page
        if len(page) < store.EVENT_PAGE:
            return events
        after = page[-1]["seq"]


def test_a_document_is_parsed_and_its_evidence_served_over_http(service: Service, smoke_pdf: Path,
                                                                tmp_path: Path) -> None:
    client, runs_root = service.client, service.runs_root
    source = smoke_pdf.read_bytes()
    with pdfium.PdfDocument(str(smoke_pdf)) as document:
        page_count = len(document)
    assert page_count >= 2, f"{smoke_pdf} has {page_count} page(s); the reading-order assertion needs two"

    # Submission: accepted, committed, queued, and the source identified by the hash of the bytes sent.
    with smoke_pdf.open("rb") as handle:
        response = client.post("/api/runs", files={"pdf": (smoke_pdf.name, handle, "application/pdf")},
                               data={"model": "surya"})  # no debug field: off is the service's default
    assert response.status_code == 202, response.text
    submitted = response.json()
    run_id = submitted["id"]
    source_sha256 = hashlib.sha256(source).hexdigest()
    assert submitted["status"] == "queued"
    assert submitted["params"]["source_sha256"] == source_sha256

    # The worker takes the job and finishes it. A failed run reports the attempt's error, not a timeout.
    summary = _terminal(service, run_id, CONVERSION_TIMEOUT)
    assert summary["status"] == "done", summary.get("error")

    # The source is kept byte for byte: a consumer holding `source_sha256` can re-hash what was parsed.
    kept = (runs_root / run_id / "input.pdf").read_bytes()
    assert kept == source and hashlib.sha256(kept).hexdigest() == source_sha256

    # The manifest and the page files, verified the way a consumer verifies them: the bytes the routes served
    # are written to this client's own directory and read back through the shared reader, which proves each
    # page file is listed, names this generation and hashes to the manifest's entry for it.
    fetched = tmp_path / "fetched"
    (fetched / "pages").mkdir(parents=True)
    result = client.get(f"/api/runs/{run_id}/result")
    assert result.status_code == 200, result.text
    (fetched / "result.json").write_bytes(result.content)
    manifest = read_manifest(fetched)
    assert manifest.result_version == RESULT_VERSION  # the version this client contract is written for
    assert manifest.status == "success" and manifest.incomplete is None
    assert manifest.page_count == page_count
    assert sorted(manifest.pages) == list(range(1, page_count + 1))
    assert manifest.recipe["source_sha256"] == source_sha256
    assert manifest.recipe["transcriber"] == "native", "a born-digital document must need no model server"

    pages: dict[int, PageResult] = {}
    for number in sorted(manifest.pages):
        page_response = client.get(f"/api/runs/{run_id}/pages/{number}")
        assert page_response.status_code == 200, page_response.text
        (fetched / "pages" / f"{number}.json").write_bytes(page_response.content)
        pages[number] = read_page(fetched, number, manifest)
        assert pages[number].page == number

    # Evidence geometry: every segment's box is a real rectangle on the page it claims, in that page's points.
    blocks = 0
    for number, page in pages.items():
        width, height = page.size_pt
        for segment in page.segments:
            x0, y0, x1, y1 = segment.bbox_pt
            assert x0 < x1 and y0 < y1, (number, segment.label, segment.bbox_pt)
            assert 0 <= x0 and x1 <= width and 0 <= y0 and y1 <= height, (number, segment.bbox_pt, page.size_pt)
        blocks += sum(1 for segment in page.segments if segment.extent == "block")
    assert blocks, "no page published a block segment: this parse grounded nothing on the engine's own boxes"

    # Text order: the run's Markdown carries the pages in page order, as the page files number them.
    markdown = _flat((runs_root / run_id / "output.md").read_text(encoding="utf-8"))
    opening, closing = _locate(pages[1], markdown), _locate(pages[page_count], markdown)
    assert opening is not None, "no phrase of page 1's segments occurs exactly once in the run's output.md"
    assert closing is not None, f"no phrase of page {page_count}'s segments occurs exactly once in the run's output.md"
    assert opening < closing, f"page {page_count}'s text precedes page 1's in the run's output.md"

    persisted = _persisted(run_id)
    # The store holds O(stages) lifecycle events for this run, ending in its terminal status, and no token.
    assert persisted and persisted[-1]["type"] == "status" and persisted[-1]["status"] == "done"
    assert [event for event in persisted if event["type"] == "token"] == []
    assert not [line for line in service.log if "Traceback" in line], "".join(service.log)

    # What the run left on disk: its canonical outputs, and no debug directory it was never asked for.
    directory = runs_root / run_id
    assert not (directory / "debug").exists()
    assert (directory / "result" / "result.json").is_file()
    assert (directory / "output.md").is_file()
