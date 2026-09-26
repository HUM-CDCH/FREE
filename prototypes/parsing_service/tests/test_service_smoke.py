"""One parse, end to end, over the real service: a `kei-worker worker` process on the session's disposable PostgreSQL,
a portable enqueue as Studio will send it (M4), and the HTTP API reading the result back. No model server takes part:
the document is born-digital.

What it stands up is the deployment's own pair rather than a stand-in for it: one real `kei-worker worker` child (the
CLI itself, no doubles), which takes its slot, launches kei's DBOS application in `kei_dbos` and serves its lanes, and
this process serving the API through `TestClient`, with no database at all. The conversion is enqueued through a
`DBOSClient` by name with portable JSON, and its result and page files are fetched back over HTTP.

What it proves is the contract a consumer builds on, in the order Studio meets it: the `convert` workflow succeeds and
names the run its ID derives, the source's hash and its page count; the source PDF is kept byte for byte; the manifest
and every page file verify against each other through the shared reader (`kei_exp.pagefile`), covering every page;
every segment's evidence lies on the page it claims; the run records its workflow; and the worker writes no Markdown,
no token log and no `debug/` it was not asked for.

Env: KEI_SMOKE_PDF — a readable PDF to parse instead of the generated native-text fixture (one of the consumer's own
examples, say). It must be born-digital, for the reason above.

Marked slow: it spawns a real worker process against the session's PostgreSQL and converts a whole document, most of
the time being the worker's startup and Docling's model loading.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pypdfium2 as pdfium
import pytest
from dbos import DBOSClient
from fastapi.testclient import TestClient

from kei_exp import api, runs
from kei_exp.pagefile import RESULT_VERSION, PageResult, read_manifest, read_page
from kei_exp.workflows import config
from tests.helpers import kei as kei_helper
from tests.helpers import kei_worker
from tests.helpers import postgres as postgres_helper
from tests.helpers.contracts import convert_timeout_ms, fixture

pytestmark = [pytest.mark.slow, pytest.mark.live_model]

CONVERSION_TIMEOUT = 180.0  # generous: the eight-page fixture converts in a few seconds, more on a CPU-only host
SERVING_TIMEOUT = 120.0


@dataclass(frozen=True)
class Service:
    """The deployment under test: the API to call, the kei client to enqueue with, the roots both sides share and
    the worker, whose log a draining thread keeps."""
    client: TestClient
    kei: kei_helper.Kei
    runs_root: Path
    inbox: Path
    worker: kei_worker.WorkerProcess


@pytest.fixture(scope="session")
def smoke_pdf(request: pytest.FixtureRequest) -> Path:
    """The document this test parses: `KEI_SMOKE_PDF` when it names a readable file, else the repository's."""
    chosen = os.environ.get("KEI_SMOKE_PDF")
    if not chosen:
        return request.getfixturevalue("digital_pdf")  # generated locally; no external PDF fixture
    path = Path(chosen).expanduser()
    if not path.is_file() or not os.access(path, os.R_OK):
        pytest.fail(f"KEI_SMOKE_PDF names {path}, which is not a readable file")
    return path


@pytest.fixture
def service(database: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Service]:
    """One `kei-worker worker` process and the API, wired to one runs root and one source inbox under `tmp_path`."""
    runs_root, inbox = tmp_path / "runs", tmp_path / "inbox"
    runs_root.mkdir()
    inbox.mkdir()
    monkeypatch.setattr(runs, "RUNS", runs_root)
    url = postgres_helper.url(database)
    # The database URL goes in the environment, as a deployment sets it, not on the command line (visible in ps).
    environment = {**os.environ, "KEI_SYSTEM_DATABASE_URL": url, "KEI_RUNS": str(runs_root),
                   "KEI_SOURCE_INBOX": str(inbox), "KEI_LOG_LEVEL": "INFO", "PYTHONUNBUFFERED": "1"}
    worker = kei_worker.WorkerProcess(subprocess.Popen(
        [sys.executable, "-m", "kei_exp.workflows.cli", "worker", "--slot", "smoke"], cwd=kei_worker.ROOT,
        env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        bufsize=1))
    client = None
    try:
        worker.wait_serving(SERVING_TIMEOUT)
        # Only now: kei_dbos exists once the worker has launched. Never a DBOS launch in this process, which would
        # be a second executor on the same lanes.
        client = DBOSClient(system_database_url=url, dbos_system_schema=config.SCHEMA,
                            application_name=config.APP_NAME)
        with TestClient(api.app) as http:
            yield Service(http, kei_helper.Kei(url, client, runs_root, inbox), runs_root, inbox, worker)
    finally:
        if client is not None:
            client.destroy()
        worker.shutdown()
        print(f"--- worker (exit {worker.process.returncode}) ---\n{''.join(worker.log)}")  # shown on failure


def _alive(worker: kei_worker.WorkerProcess, what: str) -> None:
    """Fail now — with the exit code and everything the worker printed — rather than wait out a bound on a
    process that is already gone. Every poll on what the worker is to do goes through this."""
    assert worker.process.poll() is None, \
        f"the worker exited with {worker.process.returncode} {what}:\n{''.join(worker.log)}"


def _terminal(service: Service, workflow_id: str, timeout: float):
    """The workflow's status once it is terminal: polled on that state, never on a duration, so the bound is only a
    bound and never the proof. A worker that dies mid-conversion fails the wait at once, with its log."""
    def finished():
        status = service.kei.client.retrieve_workflow(workflow_id).get_status()
        if status.status in kei_helper.TERMINAL:
            return status  # a workflow that ended has ended, whatever becomes of the worker after
        _alive(service.worker, "before the conversion ended")
        return None
    return kei_helper.until(finished, timeout, f"{workflow_id} ending")


def test_a_document_is_parsed_and_its_evidence_served_over_http(service: Service, smoke_pdf: Path,
                                                                tmp_path: Path) -> None:
    client, runs_root = service.client, service.runs_root
    source = smoke_pdf.read_bytes()
    source_sha256 = hashlib.sha256(source).hexdigest()
    staged = service.inbox / "project-1" / "attempt-1.pdf"  # where Studio stages an upload (M4)
    staged.parent.mkdir(parents=True)
    shutil.copyfile(smoke_pdf, staged)
    with pdfium.PdfDocument(str(staged)) as document:
        pages = len(document)

    # The enqueue Studio sends: by name, portable, on the lane the page count picks, with the per-page deadline.
    workflow_id = "kei-convert:ingest:project-1:attempt-1"
    lane = config.CONVERT_SMALL if pages <= fixture("queues")["small_document_pages"] else config.CONVERT_LARGE
    service.kei.enqueue("convert", lane, workflow_id,
                        kei_helper.convert_request("project-1/attempt-1.pdf", source_sha256,
                                                   source_name=smoke_pdf.name),
                        timeout_ms=convert_timeout_ms(pages))

    # The worker runs it. A failed conversion reports the workflow's own failure, not a timeout.
    status = _terminal(service, workflow_id, CONVERSION_TIMEOUT)
    assert status.status == "SUCCESS", (status.status, status.error, status.output)
    output = status.output
    assert output["ok"], output
    run_id = output["run_id"]
    assert run_id == runs.run_id_for(workflow_id)
    assert output["source_sha256"] == source_sha256 and output["page_count"] == pages

    # The source is kept byte for byte: a consumer holding `source_sha256` can re-hash what was parsed.
    directory = runs_root / run_id
    kept = (directory / "input.pdf").read_bytes()
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
    assert manifest.generation == output["generation"]
    assert manifest.page_count == pages
    assert sorted(manifest.pages) == list(range(1, pages + 1))
    assert manifest.recipe["source_sha256"] == source_sha256
    assert manifest.recipe["transcriber"] == "native", "a born-digital document must need no model server"

    parsed: dict[int, PageResult] = {}
    for number in sorted(manifest.pages):
        page_response = client.get(f"/api/runs/{run_id}/pages/{number}")
        assert page_response.status_code == 200, page_response.text
        (fetched / "pages" / f"{number}.json").write_bytes(page_response.content)
        parsed[number] = read_page(fetched, number, manifest)
        assert parsed[number].page == number

    # Evidence geometry: every segment's box is a real rectangle on the page it claims, in that page's points.
    blocks = 0
    for number, page in parsed.items():
        width, height = page.size_pt
        for segment in page.segments:
            x0, y0, x1, y1 = segment.bbox_pt
            assert x0 < x1 and y0 < y1, (number, segment.label, segment.bbox_pt)
            assert 0 <= x0 and x1 <= width and 0 <= y0 and y1 <= height, (number, segment.bbox_pt, page.size_pt)
        blocks += sum(1 for segment in page.segments if segment.extent == "block")
    assert blocks, "no page published a block segment: this parse grounded nothing on the engine's own boxes"
    assert not [line for line in service.worker.log if "Traceback" in line], "".join(service.worker.log)

    # What the run left on disk: its canonical outputs and the request that names its workflow; no worker
    # Markdown, no token log and no debug directory it was never asked for.
    assert json.loads((directory / "params.json").read_text(encoding="utf-8"))["workflow_id"] == workflow_id
    assert (directory / "result" / "result.json").is_file()
    assert not (directory / "debug").exists()
    assert not (directory / "output.md").exists()
    assert not (directory / "tokens.jsonl").exists()
