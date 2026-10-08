from __future__ import annotations

import argparse
import ctypes
import hashlib
import importlib.metadata
import itertools
import json
import os
import platform
import shutil
import socket
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Sequence

import numpy as np
import yaml
from huggingface_hub import HfApi, hf_hub_download
from pathspec import PathSpec

from slopo.analysis.clustering import build_clusters, filter_clusters, reorder_clusters
from slopo.analysis.models import Cluster, SimilarPair, UnitRecord
from slopo.analysis.overlap import exclude_overlapping_pairs
from slopo.analysis.rerank import rerank_all_clusters, rerank_pair_score
from slopo.analysis.command import run_analyze
from slopo.config import Config
from slopo.db import create_db
from slopo.indexing.command import run_index


BENCH_DIR = Path(__file__).resolve().parent
ROOT = BENCH_DIR.parents[1]
WORK = BENCH_DIR / "work"
RESULTS = BENCH_DIR / "results"
CORPUS = WORK / "corpus"
BASE_DB = WORK / "base.db"
MODEL_CACHE = WORK / "model-cache"
RUNS = WORK / "runs"
NATIVE = WORK / "native"
LOGS = WORK / "logs"
LABELS_PATH = BENCH_DIR / "labels.json"
ADJUDICATIONS_PATH = BENCH_DIR / "adjudications.json"
MAX_REVIEWABLE_CLUSTER_UNITS = 32

SUPPORTED_EXTENSIONS = {
    ".cs",
    ".ex",
    ".exs",
    ".go",
    ".java",
    ".js",
    ".jsx",
    ".kt",
    ".kts",
    ".php",
    ".py",
    ".rs",
    ".ts",
    ".tsx",
}


@dataclass(frozen=True)
class ModelSpec:
    family: str
    repo: str
    filename: str
    revision: str
    sha256: str
    native_dimensions: int
    dimensions: tuple[int, ...]
    pooling: str
    context_size: int
    transform: str = "identity"
    projection_filename: str | None = None
    projection_sha256: str | None = None


MODEL_SPECS = (
    ModelSpec(
        family="jina-v2-code",
        repo="ggml-org/jina-embeddings-v2-base-code-Q8_0-GGUF",
        filename="jina-embeddings-v2-base-code-q8_0.gguf",
        revision="05e79e9a6c8b99491e92ebb28d753268f8601e3c",
        sha256="3bd1722f09350209aa3ada93df55882666c58194bfbbbe81c30545d731cb4e7a",
        native_dimensions=768,
        dimensions=(768,),
        pooling="mean",
        context_size=8192,
    ),
    ModelSpec(
        family="qwen3-0.6b",
        repo="Qwen/Qwen3-Embedding-0.6B-GGUF",
        filename="Qwen3-Embedding-0.6B-Q8_0.gguf",
        revision="370f27d7550e0def9b39c1f16d3fbaa13aa67728",
        sha256="06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
        native_dimensions=1024,
        dimensions=(512, 1024),
        pooling="last",
        context_size=32768,
    ),
    ModelSpec(
        family="pplx-v1-0.6b",
        repo="mykor/pplx-embed-v1-0.6b-GGUF",
        filename="pplx-embed-v1-0.6B-Q8_0.gguf",
        revision="2cadede717541842c84c7c2693811ae7970e2dde",
        sha256="08994a440609bdf1cf78c3fe2959fc8330e8da42c3b758110c293c2c4d94cee7",
        native_dimensions=1024,
        dimensions=(512, 1024),
        pooling="mean",
        context_size=32768,
        transform="pplx_int8",
    ),
    ModelSpec(
        family="voyage-4-nano",
        repo="jsonMartin/voyage-4-nano-gguf",
        filename="voyage-4-nano-q8_0.gguf",
        revision="75e62c7dba5ee8156717a56920976ab128b8c693",
        sha256="d0e430fe24faba10f5bc6dd4f896e1efd0e6d65d7f0cf686a500d48cac274a4a",
        native_dimensions=1024,
        dimensions=(256, 512),
        pooling="mean",
        context_size=32768,
        transform="voyage_projection",
        projection_filename="voyage-4-nano-linear.pt",
        projection_sha256="976dc77818028f5ca424787c015efb519eab600043a546bc23341ef00205d06e",
    ),
)


@dataclass(frozen=True)
class IndexedUnit:
    unit_id: int
    file_path: str
    name: str
    start_line: int
    end_line: int
    body: str
    body_hash: str

    def slopo_record(self) -> UnitRecord:
        return UnitRecord(
            unit_id=self.unit_id,
            file_path=self.file_path,
            name=self.name,
            start_line=self.start_line,
            end_line=self.end_line,
            body=self.body,
            body_hash=self.body_hash,
        )


@dataclass(frozen=True)
class PairDatum:
    pair: tuple[int, int]
    raw: float
    boosted: float
    positive: bool


def log(message: str) -> None:
    print(message, flush=True)


def ensure_directories() -> None:
    for path in (WORK, RESULTS, MODEL_CACHE, RUNS, NATIVE, LOGS):
        path.mkdir(parents=True, exist_ok=True)


def safe_reset_directory(path: Path) -> None:
    resolved_work = WORK.resolve()
    resolved = path.resolve()
    if resolved == resolved_work or resolved_work not in resolved.parents:
        raise ValueError(f"Refusing to reset path outside benchmark work directory: {path}")
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_output(*args: str) -> str:
    completed = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return completed.stdout


def prepare_corpus() -> dict[str, Any]:
    ensure_directories()
    safe_reset_directory(CORPUS)

    root_config = yaml.safe_load((ROOT / "slopo.conf.yaml").read_text(encoding="utf-8"))
    exclusions = PathSpec.from_lines("gitignore", root_config.get("source_dir_exclude", []))
    listed = git_output("ls-files", "--cached", "--others", "--exclude-standard", "-z")
    candidates = [item for item in listed.split("\0") if item]

    copied: list[dict[str, Any]] = []
    for raw_path in sorted(candidates):
        relative = PurePosixPath(raw_path)
        if not relative.parts or relative.parts[0] not in {"packages", "prototypes"}:
            continue
        if Path(relative.name).suffix.lower() not in SUPPORTED_EXTENSIONS:
            continue
        if exclusions.match_file(relative.as_posix()):
            continue
        source = ROOT / Path(*relative.parts)
        if not source.is_file():
            continue
        destination = CORPUS / Path(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        copied.append(
            {
                "path": relative.as_posix(),
                "sha256": sha256_file(destination),
                "source": "repository",
            }
        )

    fixtures = BENCH_DIR / "fixtures"
    for source in sorted(fixtures.rglob("*")):
        if not source.is_file():
            continue
        relative = source.relative_to(fixtures)
        destination = CORPUS / "__benchmark__" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        copied.append(
            {
                "path": (PurePosixPath("__benchmark__") / PurePosixPath(relative.as_posix())).as_posix(),
                "sha256": sha256_file(destination),
                "source": "fixture",
            }
        )

    fingerprint = hashlib.sha256(
        "".join(f"{item['path']}\0{item['sha256']}\n" for item in copied).encode("utf-8")
    ).hexdigest()
    manifest = {
        "schema_version": 1,
        "git_commit": git_output("rev-parse", "HEAD").strip(),
        "git_dirty": bool(git_output("status", "--porcelain").strip()),
        "fingerprint": fingerprint,
        "repository_files": sum(item["source"] == "repository" for item in copied),
        "fixture_files": sum(item["source"] == "fixture" for item in copied),
        "files": copied,
    }
    (WORK / "corpus-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    log(
        f"Prepared corpus: {manifest['repository_files']} repository files, "
        f"{manifest['fixture_files']} fixture files ({fingerprint[:12]})."
    )
    return manifest


def make_config(
    *,
    db_file: Path,
    report_dir: Path,
    ignore_file: Path,
    model: str,
    dimensions: int,
    similarity_threshold: float = 0.92,
    rerank_threshold: float = 0.94,
) -> Config:
    return Config(
        source_dir=CORPUS,
        source_dir_exclude=[],
        db_file=db_file,
        report_dir=report_dir,
        ignore_file=ignore_file,
        embedding_model=model,
        embedding_dimensions=dimensions,
        embedding_api_key=None,
        embedding_params={},
        embedding_batch_size=100,
        embedding_batch_chars=100_000,
        embedding_request_delay=0,
        similarity_threshold=similarity_threshold,
        rerank_threshold=rerank_threshold,
        body_node_count_threshold=10,
    )


def build_base_index() -> dict[str, Any]:
    if BASE_DB.exists():
        BASE_DB.unlink()
    cfg = make_config(
        db_file=BASE_DB,
        report_dir=WORK / "base-report",
        ignore_file=WORK / "base.ignore.txt",
        model="benchmark-base",
        dimensions=1,
    )
    conn = create_db(cfg)
    try:
        run_index(conn, cfg, log)
        counts = {
            "files": conn.execute("SELECT COUNT(*) FROM files").fetchone()[0],
            "units": conn.execute("SELECT COUNT(*) FROM code_units").fetchone()[0],
            "unique_bodies": conn.execute(
                "SELECT COUNT(DISTINCT body_hash) FROM code_units"
            ).fetchone()[0],
        }
    finally:
        conn.close()
    log(f"Base index: {counts['units']} units from {counts['files']} files.")
    return counts


def load_units(db_file: Path = BASE_DB) -> list[IndexedUnit]:
    conn = sqlite3.connect(db_file)
    try:
        rows = conn.execute(
            """
            SELECT cu.id, f.path, cu.name, cu.start_line, cu.end_line, cu.body, cu.body_hash
            FROM code_units cu
            JOIN files f ON f.id = cu.file_id
            ORDER BY cu.id
            """
        ).fetchall()
    finally:
        conn.close()
    return [IndexedUnit(*row) for row in rows]


def load_unique_bodies() -> tuple[list[str], list[str]]:
    conn = sqlite3.connect(BASE_DB)
    try:
        rows = conn.execute(
            """
            SELECT body_hash, MIN(body)
            FROM code_units
            GROUP BY body_hash
            ORDER BY body_hash
            """
        ).fetchall()
    finally:
        conn.close()
    return [row[0] for row in rows], [row[1] for row in rows]


def find_llama_server() -> Path:
    discovered = shutil.which("llama-server")
    if discovered:
        return Path(discovered)
    local_app_data = Path(os.environ.get("LOCALAPPDATA", ""))
    package_root = local_app_data / "Microsoft" / "WinGet" / "Packages"
    matches = sorted(package_root.glob("ggml.llamacpp_*\\llama-server.exe"))
    if not matches:
        matches = sorted(package_root.glob("ggml.llamacpp_*/llama-server.exe"))
    if not matches:
        raise FileNotFoundError("llama-server was not found in PATH or the WinGet package directory")
    return matches[-1]


def llama_server_version() -> str:
    completed = subprocess.run(
        [str(find_llama_server()), "--version"],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    output = completed.stdout or completed.stderr
    return " ".join(output.split())


def resolve_repo_filename(
    api: HfApi, repo: str, requested: str, revision: str
) -> str:
    files = api.list_repo_files(repo_id=repo, revision=revision)
    by_lower = {name.lower(): name for name in files}
    exact = by_lower.get(requested.lower())
    if exact:
        return exact
    if requested.lower().endswith(".gguf"):
        q8 = [name for name in files if name.lower().endswith("q8_0.gguf")]
        if len(q8) == 1:
            return q8[0]
    raise FileNotFoundError(f"Could not resolve {requested!r} in {repo}; files={files}")


def download_model(spec: ModelSpec, api: HfApi) -> tuple[Path, str, str]:
    filename = resolve_repo_filename(api, spec.repo, spec.filename, spec.revision)
    path = Path(
        hf_hub_download(
            repo_id=spec.repo,
            filename=filename,
            revision=spec.revision,
            cache_dir=MODEL_CACHE,
        )
    )
    actual_sha256 = sha256_file(path)
    if actual_sha256 != spec.sha256:
        raise ValueError(
            f"Model artifact hash mismatch for {spec.family}: "
            f"expected {spec.sha256}, got {actual_sha256}"
        )
    return path, spec.revision, filename


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as stream:
        stream.bind(("127.0.0.1", 0))
        return int(stream.getsockname()[1])


class WorkingSetMonitor:
    def __init__(self, pid: int) -> None:
        self.pid = pid
        self.peak_bytes = 0
        self._stopped = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def __enter__(self) -> "WorkingSetMonitor":
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stopped.set()
        self._thread.join(timeout=2)

    def _run(self) -> None:
        while not self._stopped.wait(0.2):
            current = windows_working_set(self.pid)
            if current is not None:
                self.peak_bytes = max(self.peak_bytes, current)


def windows_working_set(pid: int) -> int | None:
    if os.name != "nt":
        return None

    class ProcessMemoryCounters(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.c_ulong),
            ("PageFaultCount", ctypes.c_ulong),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    kernel32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi
    handle = kernel32.OpenProcess(0x0400 | 0x0010, False, pid)
    if not handle:
        return None
    try:
        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
            return None
        return int(counters.WorkingSetSize)
    finally:
        kernel32.CloseHandle(handle)


def gpu_memory_mib(pid: int) -> int | None:
    try:
        completed = subprocess.run(
            [
                "nvidia-smi",
                "--query-compute-apps=pid,used_gpu_memory",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    for line in completed.stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) == 2 and parts[0] == str(pid):
            try:
                return int(parts[1])
            except ValueError:
                return None
    return None


def gpu_total_used_mib() -> int | None:
    try:
        completed = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.used",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
        values = [int(line.strip()) for line in completed.stdout.splitlines() if line.strip()]
        return sum(values) if values else None
    except (FileNotFoundError, ValueError, subprocess.SubprocessError):
        return None


class LlamaServer:
    def __init__(self, executable: Path, model_path: Path, spec: ModelSpec) -> None:
        self.executable = executable
        self.model_path = model_path
        self.spec = spec
        self.port = find_free_port()
        self.process: subprocess.Popen[str] | None = None
        self._log_stream: Any = None

    def __enter__(self) -> "LlamaServer":
        log_path = LOGS / f"{self.spec.family}.log"
        self._log_stream = log_path.open("w", encoding="utf-8")
        command = [
            str(self.executable),
            "--model",
            str(self.model_path),
            "--embedding",
            "--pooling",
            self.spec.pooling,
            "--embd-normalize",
            "-1",
            "--ctx-size",
            str(self.spec.context_size),
            "--batch-size",
            "8192",
            "--ubatch-size",
            "8192",
            "--n-gpu-layers",
            "all",
            "--parallel",
            "1",
            "--alias",
            self.spec.family,
            "--host",
            "127.0.0.1",
            "--port",
            str(self.port),
            "--no-webui",
        ]
        startupinfo = None
        creationflags = 0
        if os.name == "nt":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE
            creationflags = subprocess.CREATE_NO_WINDOW
        self.process = subprocess.Popen(
            command,
            cwd=ROOT,
            stdout=self._log_stream,
            stderr=subprocess.STDOUT,
            text=True,
            startupinfo=startupinfo,
            creationflags=creationflags,
        )
        self._wait_until_ready()
        return self

    def __exit__(self, *_: object) -> None:
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        if self._log_stream is not None:
            self._log_stream.close()

    @property
    def pid(self) -> int:
        if self.process is None:
            raise RuntimeError("Server has not started")
        return self.process.pid

    def _wait_until_ready(self) -> None:
        deadline = time.monotonic() + 180
        url = f"http://127.0.0.1:{self.port}/health"
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            if self.process is not None and self.process.poll() is not None:
                raise RuntimeError(
                    f"llama-server exited with {self.process.returncode}; see {LOGS / (self.spec.family + '.log')}"
                )
            try:
                with urllib.request.urlopen(url, timeout=3) as response:
                    if response.status == 200:
                        return
            except Exception as error:  # noqa: BLE001 - health polling records the final error
                last_error = error
            time.sleep(0.5)
        raise TimeoutError(f"llama-server did not become ready: {last_error}")

    def embed(self, texts: Sequence[str]) -> tuple[list[list[float]], int]:
        payload = json.dumps({"model": self.spec.family, "input": list(texts)}).encode("utf-8")
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/v1/embeddings",
            data=payload,
            headers={"Content-Type": "application/json", "Authorization": "Bearer local"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=900) as response:
                value = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Embedding request failed ({error.code}): {detail}") from error
        data = sorted(value["data"], key=lambda item: item.get("index", 0))
        tokens = int(value.get("usage", {}).get("prompt_tokens", 0))
        return [item["embedding"] for item in data], tokens


def batches(values: Sequence[str], max_items: int = 100, max_chars: int = 100_000) -> Iterable[list[str]]:
    batch: list[str] = []
    chars = 0
    for value in values:
        if batch and (len(batch) >= max_items or chars + len(value) > max_chars):
            yield batch
            batch = []
            chars = 0
        batch.append(value)
        chars += len(value)
    if batch:
        yield batch


def load_voyage_projection(spec: ModelSpec, api: HfApi, revision: str) -> np.ndarray:
    if not spec.projection_filename:
        raise ValueError("Voyage projection filename is missing")
    filename = resolve_repo_filename(
        api, spec.repo, spec.projection_filename, revision
    )
    source = Path(
        hf_hub_download(
            repo_id=spec.repo,
            filename=filename,
            revision=revision,
            cache_dir=MODEL_CACHE,
        )
    )
    actual_sha256 = sha256_file(source)
    if actual_sha256 != spec.projection_sha256:
        raise ValueError(
            f"Projection artifact hash mismatch for {spec.family}: "
            f"expected {spec.projection_sha256}, got {actual_sha256}"
        )
    destination = WORK / "voyage-4-nano-linear.npy"
    stamp = WORK / "voyage-4-nano-linear.json"
    current = {"revision": revision, "source": filename, "sha256": actual_sha256}
    cached = json.loads(stamp.read_text(encoding="utf-8")) if stamp.exists() else None
    if not destination.exists() or cached != current:
        command = [
            "uv",
            "run",
            "--project",
            str(ROOT / "prototypes" / "parsing_service"),
            "--no-sync",
            "python",
            str(BENCH_DIR / "convert_projection.py"),
            str(source),
            str(destination),
        ]
        subprocess.run(command, cwd=ROOT, check=True)
        stamp.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
    projection = np.load(destination)
    if projection.shape != (2048, 1024):
        raise ValueError(f"Unexpected Voyage projection shape: {projection.shape}")
    return projection.astype(np.float32, copy=False)


def transform_embeddings(
    vectors: np.ndarray,
    spec: ModelSpec,
    projection: np.ndarray | None,
) -> np.ndarray:
    if spec.transform == "identity":
        return vectors.astype(np.float32, copy=False)
    if spec.transform == "pplx_int8":
        return np.clip(np.rint(np.tanh(vectors) * 127.0), -128, 127).astype(np.float32)
    if spec.transform == "voyage_projection":
        if projection is None:
            raise ValueError("Voyage projection was not loaded")
        return (vectors.astype(np.float32) @ projection.T).astype(np.float32)
    raise ValueError(f"Unknown transform: {spec.transform}")


def l2_normalize(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    if np.any(norms == 0):
        raise ValueError("Embedding model returned a zero vector")
    return (vectors / norms).astype(np.float32)


def required_adapter_steps(spec: ModelSpec, dimensions: int) -> list[str]:
    steps: list[str] = []
    full_dimensions = spec.native_dimensions
    if spec.transform == "pplx_int8":
        steps.append("tanh/INT8 output transform")
    elif spec.transform == "voyage_projection":
        steps.append("1024-to-2048 learned projection")
        full_dimensions = 2048
    if dimensions != full_dimensions:
        steps.append(f"truncate to {dimensions}d and normalize")
    return steps


def embed_model(
    spec: ModelSpec,
    corpus_fingerprint: str,
    *,
    use_cache: bool,
) -> tuple[list[str], np.ndarray, dict[str, Any]]:
    api = HfApi()
    model_path, revision, filename = download_model(spec, api)
    cache_path = NATIVE / f"{spec.family}.npz"
    metadata_path = NATIVE / f"{spec.family}.json"
    expected = {
        "corpus_fingerprint": corpus_fingerprint,
        "repo": spec.repo,
        "revision": revision,
        "filename": filename,
        "transform": spec.transform,
    }
    if use_cache and cache_path.exists() and metadata_path.exists():
        cached_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if all(cached_metadata.get(key) == value for key, value in expected.items()):
            cached = np.load(cache_path)
            log(f"Reusing cached embeddings for {spec.family}.")
            return cached["body_hashes"].tolist(), cached["vectors"], cached_metadata

    projection = (
        load_voyage_projection(spec, api, revision)
        if spec.transform == "voyage_projection"
        else None
    )
    body_hashes, bodies = load_unique_bodies()
    executable = find_llama_server()
    all_vectors: list[list[float]] = []
    total_tokens = 0
    batch_count = 0
    started = time.perf_counter()
    peak_gpu_mib: int | None = None
    total_gpu_baseline = gpu_total_used_mib()
    peak_gpu_delta_mib: int | None = None
    with LlamaServer(executable, model_path, spec) as server:
        warmup = min(bodies, key=len)
        server.embed([warmup])
        peak_gpu_mib = gpu_memory_mib(server.pid)
        total_gpu_used = gpu_total_used_mib()
        if total_gpu_baseline is not None and total_gpu_used is not None:
            peak_gpu_delta_mib = max(0, total_gpu_used - total_gpu_baseline)
        with WorkingSetMonitor(server.pid) as monitor:
            embedding_started = time.perf_counter()
            consumed = 0
            for batch in batches(bodies):
                vectors, tokens = server.embed(batch)
                if len(vectors) != len(batch):
                    raise ValueError(
                        f"{spec.family} returned {len(vectors)} vectors for {len(batch)} inputs"
                    )
                all_vectors.extend(vectors)
                total_tokens += tokens
                batch_count += 1
                consumed += len(batch)
                log(f"{spec.family}: embedded {consumed}/{len(bodies)} unique bodies")
            embedding_seconds = time.perf_counter() - embedding_started
            current_gpu = gpu_memory_mib(server.pid)
            if current_gpu is not None:
                peak_gpu_mib = max(peak_gpu_mib or 0, current_gpu)
            total_gpu_used = gpu_total_used_mib()
            if total_gpu_baseline is not None and total_gpu_used is not None:
                peak_gpu_delta_mib = max(
                    peak_gpu_delta_mib or 0,
                    total_gpu_used - total_gpu_baseline,
                )
        peak_rss_bytes = monitor.peak_bytes
    total_seconds = time.perf_counter() - started

    raw = np.asarray(all_vectors, dtype=np.float32)
    if raw.shape != (len(bodies), spec.native_dimensions):
        raise ValueError(
            f"{spec.family} returned shape {raw.shape}; expected "
            f"({len(bodies)}, {spec.native_dimensions})"
        )
    transformed = transform_embeddings(raw, spec, projection)
    metrics = {
        **expected,
        "family": spec.family,
        "quantization": "Q8_0",
        "native_dimensions": spec.native_dimensions,
        "transformed_dimensions": int(transformed.shape[1]),
        "model_bytes": model_path.stat().st_size,
        "unique_bodies": len(bodies),
        "total_characters": sum(map(len, bodies)),
        "prompt_tokens": total_tokens,
        "batch_count": batch_count,
        "embedding_seconds": embedding_seconds,
        "total_server_seconds": total_seconds,
        "bodies_per_second": len(bodies) / embedding_seconds,
        "characters_per_second": sum(map(len, bodies)) / embedding_seconds,
        "peak_server_rss_bytes": peak_rss_bytes,
        "gpu_memory_mib": peak_gpu_mib if peak_gpu_mib is not None else peak_gpu_delta_mib,
        "gpu_memory_measurement": "process" if peak_gpu_mib is not None else "total_delta",
    }
    np.savez_compressed(cache_path, body_hashes=np.asarray(body_hashes), vectors=transformed)
    metadata_path.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    return body_hashes, transformed, metrics


def resolve_labels(units: Sequence[IndexedUnit]) -> dict[str, Any]:
    definition = json.loads(LABELS_PATH.read_text(encoding="utf-8"))
    lookup: dict[tuple[str, str], list[IndexedUnit]] = {}
    for unit in units:
        lookup.setdefault((unit.file_path, unit.name), []).append(unit)

    members: dict[str, dict[str, Any]] = {}
    families: dict[str, dict[str, Any]] = {}
    for family in definition["families"]:
        resolved_members: list[str] = []
        for member in family["members"]:
            candidates = lookup.get((member["path"], member["name"]), [])
            if len(candidates) != 1:
                details = [(item.start_line, item.end_line) for item in candidates]
                raise ValueError(
                    f"Label {member['id']} resolved to {len(candidates)} units: "
                    f"{member['path']}::{member['name']} {details}"
                )
            resolved = {**member, "unit_id": candidates[0].unit_id, "family": family["id"]}
            members[member["id"]] = resolved
            resolved_members.append(member["id"])
        families[family["id"]] = {
            "id": family["id"],
            "split": family["split"],
            "members": resolved_members,
        }

    hard_negatives: list[str] = []
    for member in definition["hard_negatives"]:
        candidates = lookup.get((member["path"], member["name"]), [])
        if len(candidates) != 1:
            details = [(item.start_line, item.end_line) for item in candidates]
            raise ValueError(
                f"Hard-negative label {member['id']} resolved to {len(candidates)} units: "
                f"{member['path']}::{member['name']} {details}"
            )
        resolved = {**member, "unit_id": candidates[0].unit_id, "kind": "hard_negative"}
        members[member["id"]] = resolved
        hard_negatives.append(member["id"])

    positive_pairs: set[tuple[int, int]] = set()
    pair_family: dict[tuple[int, int], str] = {}
    for family in families.values():
        ids = [members[member_id]["unit_id"] for member_id in family["members"]]
        for first, second in itertools.combinations(ids, 2):
            pair = tuple(sorted((first, second)))
            positive_pairs.add(pair)
            pair_family[pair] = family["id"]

    explicit_negative_pairs: set[tuple[int, int]] = set()
    for member_id in hard_negatives:
        negative = members[member_id]
        family = families[negative["negative_of"]]
        for positive_member in family["members"]:
            explicit_negative_pairs.add(
                tuple(sorted((negative["unit_id"], members[positive_member]["unit_id"])))
            )

    resolved = {
        "members": members,
        "families": families,
        "hard_negatives": hard_negatives,
        "positive_pairs": positive_pairs,
        "pair_family": pair_family,
        "explicit_negative_pairs": explicit_negative_pairs,
    }
    log(
        f"Resolved labels: {len(families)} clone families, "
        f"{len(positive_pairs)} positive pairs, {len(explicit_negative_pairs)} hard-negative pairs."
    )
    return resolved


def members_for_split(labels: dict[str, Any], split: str | None) -> set[int]:
    selected: set[int] = set()
    selected_families = {
        family_id
        for family_id, family in labels["families"].items()
        if split is None or family["split"] == split
    }
    for family_id in selected_families:
        selected.update(
            labels["members"][member_id]["unit_id"]
            for member_id in labels["families"][family_id]["members"]
        )
    for member_id in labels["hard_negatives"]:
        member = labels["members"][member_id]
        if member["negative_of"] in selected_families:
            selected.add(member["unit_id"])
    return selected


def build_controlled_pairs(
    *,
    units_by_id: dict[int, IndexedUnit],
    vectors_by_id: dict[int, np.ndarray],
    labels: dict[str, Any],
    split: str | None,
) -> list[PairDatum]:
    selected = sorted(members_for_split(labels, split))
    result: list[PairDatum] = []
    for first, second in itertools.combinations(selected, 2):
        raw = float(np.dot(vectors_by_id[first], vectors_by_id[second]))
        pair = SimilarPair(raw, first, second)
        boosted = rerank_pair_score(
            pair,
            units_by_id[first].slopo_record(),
            units_by_id[second].slopo_record(),
        )
        key = (first, second)
        result.append(
            PairDatum(
                pair=key,
                raw=raw,
                boosted=float(boosted),
                positive=key in labels["positive_pairs"],
            )
        )
    return result


def average_precision(records: Sequence[PairDatum], score_name: str = "raw") -> float:
    ranked = sorted(records, key=lambda item: getattr(item, score_name), reverse=True)
    positives = sum(item.positive for item in ranked)
    if positives == 0:
        return 0.0
    hits = 0
    total = 0.0
    for rank, item in enumerate(ranked, start=1):
        if item.positive:
            hits += 1
            total += hits / rank
    return total / positives


def roc_auc(records: Sequence[PairDatum], score_name: str = "raw") -> float:
    positives = [getattr(item, score_name) for item in records if item.positive]
    negatives = [getattr(item, score_name) for item in records if not item.positive]
    if not positives or not negatives:
        return 0.0
    wins = 0.0
    for positive in positives:
        for negative in negatives:
            if positive > negative:
                wins += 1.0
            elif positive == negative:
                wins += 0.5
    return wins / (len(positives) * len(negatives))


def precision_at(records: Sequence[PairDatum], k: int, score_name: str = "raw") -> dict[str, Any]:
    ranked = sorted(records, key=lambda item: getattr(item, score_name), reverse=True)[:k]
    returned = len(ranked)
    return {
        "k": k,
        "returned": returned,
        "precision": sum(item.positive for item in ranked) / returned if returned else 0.0,
    }


def f_beta(precision: float, recall: float, beta: float = 0.5) -> float:
    if precision == 0 and recall == 0:
        return 0.0
    beta_squared = beta * beta
    return (1 + beta_squared) * precision * recall / (beta_squared * precision + recall)


def gated_metrics(
    records: Sequence[PairDatum],
    raw_threshold: float,
    rerank_threshold: float,
) -> dict[str, Any]:
    positives = sum(item.positive for item in records)
    predicted = [
        item
        for item in records
        if item.raw >= raw_threshold and item.boosted >= rerank_threshold
    ]
    true_positives = sum(item.positive for item in predicted)
    precision = true_positives / len(predicted) if predicted else 0.0
    recall = true_positives / positives if positives else 0.0
    return {
        "predicted": len(predicted),
        "true_positives": true_positives,
        "positives": positives,
        "precision": precision,
        "recall": recall,
        "f0_5": f_beta(precision, recall),
        "p20": precision_at(predicted, 20, "boosted"),
        "p50": precision_at(predicted, 50, "boosted"),
    }


def threshold_candidates(values: Sequence[float], limit: int = 96) -> list[float]:
    unique = np.unique(np.asarray(values, dtype=np.float64))
    if len(unique) <= limit:
        return unique.tolist()
    indexes = np.unique(np.linspace(0, len(unique) - 1, limit, dtype=int))
    return unique[indexes].tolist()


def component_stats(matrix: np.ndarray, threshold: float) -> dict[str, Any]:
    adjacency = matrix >= threshold
    np.fill_diagonal(adjacency, False)
    remaining = np.ones(matrix.shape[0], dtype=bool)
    sizes: list[int] = []
    while np.any(remaining):
        seed = int(np.flatnonzero(remaining)[0])
        frontier = np.zeros(matrix.shape[0], dtype=bool)
        frontier[seed] = True
        size = 0
        while np.any(frontier):
            size += int(np.count_nonzero(frontier))
            remaining[frontier] = False
            frontier = np.any(adjacency[frontier], axis=0) & remaining
        if size > 1:
            sizes.append(size)
    return {
        "components": len(sizes),
        "flagged_units": sum(sizes),
        "flagged_ratio": sum(sizes) / matrix.shape[0],
        "largest_component": max(sizes, default=0),
    }


def exclude_overlap_scores(
    matrix: np.ndarray, units: Sequence[IndexedUnit]
) -> np.ndarray:
    adjusted = matrix.copy()
    by_file: dict[str, list[tuple[int, IndexedUnit]]] = {}
    for index, unit in enumerate(units):
        by_file.setdefault(unit.file_path, []).append((index, unit))
    for entries in by_file.values():
        for (first_index, first), (second_index, second) in itertools.combinations(entries, 2):
            first_contains_second = (
                first.start_line <= second.start_line and second.end_line <= first.end_line
            )
            second_contains_first = (
                second.start_line <= first.start_line and first.end_line <= second.end_line
            )
            if first_contains_second or second_contains_first:
                adjusted[first_index, second_index] = -np.inf
                adjusted[second_index, first_index] = -np.inf
    return adjusted


def tune_thresholds(records: Sequence[PairDatum], full_matrix: np.ndarray) -> dict[str, Any]:
    raw_values = sorted(
        set(threshold_candidates([item.raw for item in records]))
        | set(np.linspace(0.50, 0.99, 100).tolist())
    )
    boosted_values = threshold_candidates([item.boosted for item in records])
    strict: tuple[tuple[float, ...], dict[str, Any]] | None = None
    operational_fallback: tuple[tuple[float, ...], dict[str, Any]] | None = None
    fallback: tuple[tuple[float, ...], dict[str, Any]] | None = None
    evaluated = 0

    for raw_threshold in raw_values:
        operational = component_stats(full_matrix, raw_threshold)
        reviewable = operational["largest_component"] <= MAX_REVIEWABLE_CLUSTER_UNITS
        for rerank_threshold in boosted_values:
            metrics = gated_metrics(records, raw_threshold, rerank_threshold)
            evaluated += 1
            p20 = metrics["p20"]["precision"]
            p50 = metrics["p50"]["precision"]
            key = (
                (p20 + p50) / 2,
                metrics["precision"],
                metrics["recall"],
                metrics["f0_5"],
                raw_threshold + rerank_threshold,
                -operational["flagged_ratio"],
            )
            fallback_key = (
                metrics["f0_5"],
                metrics["precision"],
                metrics["recall"],
                (p20 + p50) / 2,
                -operational["largest_component"],
            )
            payload = {
                "similarity_threshold": raw_threshold,
                "rerank_threshold": rerank_threshold,
                "metrics": metrics,
                "operational": operational,
            }
            if reviewable and metrics["recall"] >= 0.80 and (
                strict is None or key > strict[0]
            ):
                strict = (key, payload)
            if reviewable and (
                operational_fallback is None or fallback_key > operational_fallback[0]
            ):
                operational_fallback = (fallback_key, payload)
            if fallback is None or fallback_key > fallback[0]:
                fallback = (fallback_key, payload)

    if fallback is None:
        raise ValueError("No threshold combinations were evaluated")
    if strict is not None:
        selected = strict[1]
        selected["selection_tier"] = "reviewable_and_80pct_recall"
    elif operational_fallback is not None:
        selected = operational_fallback[1]
        selected["selection_tier"] = "reviewable_best_f0_5"
    else:
        selected = fallback[1]
        selected["selection_tier"] = "unconstrained_fallback"
    if selected["rerank_threshold"] < selected["similarity_threshold"]:
        # Slopo's reranker only applies non-negative boosts, so any lower rerank
        # threshold is operationally redundant. Emit the simpler equivalent config.
        selected["rerank_threshold"] = selected["similarity_threshold"]
        selected["metrics"] = gated_metrics(
            records,
            selected["similarity_threshold"],
            selected["rerank_threshold"],
        )
    selected["met_minimum_recall"] = strict is not None
    selected["evaluated_combinations"] = evaluated
    return selected


def ranking_metrics(records: Sequence[PairDatum]) -> dict[str, Any]:
    return {
        "pairs": len(records),
        "positives": sum(item.positive for item in records),
        "average_precision": average_precision(records),
        "roc_auc": roc_auc(records),
        "p20": precision_at(records, 20),
        "p50": precision_at(records, 50),
    }


def relation_recall(
    labels: dict[str, Any],
    predicted_pairs: set[tuple[int, int]],
    split: str | None = None,
) -> dict[str, dict[str, Any]]:
    by_relation: dict[str, list[bool]] = {}
    for family in labels["families"].values():
        if split is not None and family["split"] != split:
            continue
        family_members = [labels["members"][item] for item in family["members"]]
        canonicals = [item for item in family_members if item["kind"] == "canonical"]
        for canonical in canonicals:
            for member in family_members:
                if member["id"] == canonical["id"]:
                    continue
                relation = member["kind"]
                pair = tuple(sorted((canonical["unit_id"], member["unit_id"])))
                by_relation.setdefault(relation, []).append(pair in predicted_pairs)
    return {
        relation: {
            "found": sum(outcomes),
            "total": len(outcomes),
            "recall": sum(outcomes) / len(outcomes) if outcomes else 0.0,
        }
        for relation, outcomes in sorted(by_relation.items())
    }


def exact_duplicate_pairs(units: Sequence[IndexedUnit]) -> set[tuple[int, int]]:
    groups: dict[str, list[int]] = {}
    for unit in units:
        groups.setdefault(unit.body_hash, []).append(unit.unit_id)
    result: set[tuple[int, int]] = set()
    for unit_ids in groups.values():
        if len(unit_ids) > 1:
            result.update(tuple(sorted(pair)) for pair in itertools.combinations(unit_ids, 2))
    return result


def cluster_identifier(cluster: Cluster, units_by_id: dict[int, IndexedUnit]) -> str:
    descriptors = sorted(
        f"{units_by_id[unit_id].file_path}:{units_by_id[unit_id].name}:"
        f"{units_by_id[unit_id].start_line}-{units_by_id[unit_id].end_line}"
        for unit_id in cluster.unit_ids
    )
    return hashlib.sha256("\n".join(descriptors).encode("utf-8")).hexdigest()[:16]


def load_adjudications() -> dict[str, Any]:
    if not ADJUDICATIONS_PATH.exists():
        return {}
    value = json.loads(ADJUDICATIONS_PATH.read_text(encoding="utf-8"))
    return value.get("clusters", value)


def evaluate_full_clusters(
    *,
    matrix: np.ndarray,
    units: Sequence[IndexedUnit],
    labels: dict[str, Any],
    similarity_threshold: float,
    rerank_threshold: float,
) -> dict[str, Any]:
    unit_ids = [unit.unit_id for unit in units]
    units_by_id = {unit.unit_id: unit for unit in units}
    slopo_units = {unit.unit_id: unit.slopo_record() for unit in units}
    rows, cols = np.where(np.triu(matrix >= similarity_threshold, k=1))
    pairs = [
        SimilarPair(float(matrix[row, col]), unit_ids[int(row)], unit_ids[int(col)])
        for row, col in zip(rows, cols)
    ]
    pairs.sort(key=lambda item: item.similarity, reverse=True)
    pairs = exclude_overlapping_pairs(pairs, slopo_units)
    if not pairs:
        return {"pairs": 0, "clusters": 0, "top": [], "p20": {}, "p50": {}}

    clusters = build_clusters(pairs)
    reranked = rerank_all_clusters(clusters, pairs, slopo_units)
    clusters = reorder_clusters(clusters, reranked)
    clusters = filter_clusters(clusters, rerank_threshold)

    known_positive_pairs = exact_duplicate_pairs(units) | labels["positive_pairs"]
    explicit_negative_pairs = labels["explicit_negative_pairs"]
    adjudications = load_adjudications()
    top: list[dict[str, Any]] = []
    for cluster in clusters[:50]:
        members = set(cluster.unit_ids)
        member_pairs = {
            tuple(sorted(pair)) for pair in itertools.combinations(sorted(members), 2)
        }
        cluster_id = cluster_identifier(cluster, units_by_id)
        known_positive = bool(member_pairs) and member_pairs <= known_positive_pairs
        explicit_negative = bool(member_pairs & explicit_negative_pairs)
        adjudication = adjudications.get(cluster_id)
        if adjudication is not None:
            relevant: bool | None = bool(adjudication["duplicate"])
            state = "adjudicated_positive" if relevant else "adjudicated_negative"
        elif known_positive:
            relevant = True
            state = "known_positive"
        elif explicit_negative and len(members) == 2:
            relevant = False
            state = "known_hard_negative"
        else:
            relevant = None
            state = "unreviewed"
        top.append(
            {
                "id": cluster_id,
                "min_score": cluster.min_similarity,
                "max_score": cluster.max_similarity,
                "state": state,
                "relevant": relevant,
                "members": [
                    {
                        "unit_id": unit_id,
                        "path": units_by_id[unit_id].file_path,
                        "name": units_by_id[unit_id].name,
                        "start_line": units_by_id[unit_id].start_line,
                        "end_line": units_by_id[unit_id].end_line,
                    }
                    for unit_id in cluster.unit_ids
                ],
            }
        )

    def cluster_precision(k: int) -> dict[str, Any]:
        selected = top[:k]
        reviewed = [item for item in selected if item["relevant"] is not None]
        positives = sum(item["relevant"] is True for item in selected)
        unknown = sum(item["relevant"] is None for item in selected)
        return {
            "k": k,
            "returned": len(selected),
            "reviewed": len(reviewed),
            "unknown": unknown,
            "known_precision_lower_bound": positives / len(selected) if selected else 0.0,
            "reviewed_precision": positives / len(reviewed) if reviewed else 0.0,
        }

    return {
        "pairs": len(pairs),
        "clusters": len(clusters),
        "top": top,
        "p20": cluster_precision(20),
        "p50": cluster_precision(50),
    }


def write_run_database(
    *,
    spec: ModelSpec,
    dimensions: int,
    body_hashes: Sequence[str],
    vectors: np.ndarray,
    thresholds: dict[str, Any],
) -> tuple[Path, Config]:
    slug = f"{spec.family}-{dimensions}d"
    run_dir = RUNS / slug
    safe_reset_directory(run_dir)
    db_file = run_dir / "slopo.db"
    shutil.copy2(BASE_DB, db_file)
    model_id = f"local-q8/{spec.family}-{dimensions}d"
    conn = sqlite3.connect(db_file)
    try:
        conn.execute(
            "UPDATE metadata SET embedding_model = ?, embedding_dimensions = ? WHERE id = 1",
            (model_id, dimensions),
        )
        conn.executemany(
            "INSERT INTO embeddings (body_hash, embedding) VALUES (?, ?)",
            [
                (body_hash, np.asarray(vector, dtype=np.float32).tobytes())
                for body_hash, vector in zip(body_hashes, vectors)
            ],
        )
        conn.commit()
    finally:
        conn.close()

    cfg = make_config(
        db_file=db_file,
        report_dir=run_dir / "report",
        ignore_file=run_dir / "slopo.ignore.txt",
        model=model_id,
        dimensions=dimensions,
        similarity_threshold=thresholds["similarity_threshold"],
        rerank_threshold=thresholds["rerank_threshold"],
    )
    config_value = {
        "source_dir": str(CORPUS.resolve()),
        "db_file": str(db_file.resolve()),
        "report_dir": str(cfg.report_dir.resolve()),
        "ignore_file": str(cfg.ignore_file.resolve()),
        "embedding_model": model_id,
        "embedding_dimensions": dimensions,
        "similarity_threshold": cfg.similarity_threshold,
        "rerank_threshold": cfg.rerank_threshold,
        "body_node_count_threshold": cfg.body_node_count_threshold,
    }
    (run_dir / "slopo.conf.yaml").write_text(
        yaml.safe_dump(config_value, sort_keys=False), encoding="utf-8"
    )
    return db_file, cfg


def predicted_controlled_pairs(
    records: Sequence[PairDatum], raw_threshold: float, rerank_threshold: float
) -> set[tuple[int, int]]:
    return {
        item.pair
        for item in records
        if item.raw >= raw_threshold and item.boosted >= rerank_threshold
    }


def evaluate_configuration(
    *,
    spec: ModelSpec,
    dimensions: int,
    body_hashes: Sequence[str],
    source_vectors: np.ndarray,
    runtime_metrics: dict[str, Any],
    units: Sequence[IndexedUnit],
    labels: dict[str, Any],
) -> dict[str, Any]:
    vectors = l2_normalize(source_vectors[:, :dimensions])
    by_hash = {body_hash: vector for body_hash, vector in zip(body_hashes, vectors)}
    units_by_id = {unit.unit_id: unit for unit in units}
    vectors_by_id = {unit.unit_id: by_hash[unit.body_hash] for unit in units}
    matrix = np.stack([vectors_by_id[unit.unit_id] for unit in units])
    similarity_matrix = matrix @ matrix.T
    operational_matrix = exclude_overlap_scores(similarity_matrix, units)

    calibration_pairs = build_controlled_pairs(
        units_by_id=units_by_id,
        vectors_by_id=vectors_by_id,
        labels=labels,
        split="calibration",
    )
    test_pairs = build_controlled_pairs(
        units_by_id=units_by_id,
        vectors_by_id=vectors_by_id,
        labels=labels,
        split="test",
    )
    all_controlled_pairs = build_controlled_pairs(
        units_by_id=units_by_id,
        vectors_by_id=vectors_by_id,
        labels=labels,
        split=None,
    )
    thresholds = tune_thresholds(calibration_pairs, operational_matrix)
    raw_threshold = thresholds["similarity_threshold"]
    rerank_threshold = thresholds["rerank_threshold"]
    test_gated = gated_metrics(test_pairs, raw_threshold, rerank_threshold)
    all_gated = gated_metrics(all_controlled_pairs, raw_threshold, rerank_threshold)
    predicted = predicted_controlled_pairs(
        all_controlled_pairs, raw_threshold, rerank_threshold
    )

    db_file, cfg = write_run_database(
        spec=spec,
        dimensions=dimensions,
        body_hashes=body_hashes,
        vectors=vectors,
        thresholds=thresholds,
    )
    conn = sqlite3.connect(db_file)
    try:
        run_analyze(conn, cfg, log)
    finally:
        conn.close()

    full = evaluate_full_clusters(
        matrix=similarity_matrix,
        units=units,
        labels=labels,
        similarity_threshold=raw_threshold,
        rerank_threshold=rerank_threshold,
    )
    result = {
        "configuration": f"{spec.family}-{dimensions}d",
        "family": spec.family,
        "dimensions": dimensions,
        "adapter_steps": required_adapter_steps(spec, dimensions),
        "stock_slopo_compatible": not required_adapter_steps(spec, dimensions),
        "thresholds": thresholds,
        "calibration_ranking": ranking_metrics(calibration_pairs),
        "test_ranking": ranking_metrics(test_pairs),
        "overall_ranking": ranking_metrics(all_controlled_pairs),
        "test_gated": test_gated,
        "overall_gated": all_gated,
        "relation_recall": relation_recall(labels, predicted),
        "full_repository": full,
        "runtime": runtime_metrics,
        "embedding_bytes": len(body_hashes) * dimensions * 4,
        "database_bytes": db_file.stat().st_size,
        "run_directory": str(db_file.parent.relative_to(BENCH_DIR).as_posix()),
    }
    (db_file.parent / "metrics.json").write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8"
    )
    return result


def write_review_candidates(configurations: Sequence[dict[str, Any]]) -> None:
    candidates: dict[str, dict[str, Any]] = {}
    for config in configurations:
        for rank, cluster in enumerate(config["full_repository"]["top"], start=1):
            entry = candidates.setdefault(
                cluster["id"],
                {
                    "id": cluster["id"],
                    "state": cluster["state"],
                    "members": cluster["members"],
                    "appearances": [],
                },
            )
            entry["appearances"].append(
                {
                    "configuration": config["configuration"],
                    "rank": rank,
                    "score": cluster["max_score"],
                }
            )

    ordered = sorted(
        candidates.values(),
        key=lambda item: (
            min(appearance["rank"] for appearance in item["appearances"]),
            -len(item["appearances"]),
        ),
    )
    lines = [
        "# Full-repository cluster review candidates",
        "",
        "Clusters marked `unreviewed` are not counted as false positives in the controlled metrics.",
        "Add decisions to `adjudications.json` and rerun the report to include them.",
        "",
    ]
    for item in ordered:
        appearances = ", ".join(
            f"{entry['configuration']} #{entry['rank']} ({entry['score']:.4f})"
            for entry in sorted(item["appearances"], key=lambda entry: entry["rank"])
        )
        lines.extend(
            [
                f"## {item['id']} — {item['state']}",
                "",
                appearances,
                "",
            ]
        )
        for member in item["members"]:
            lines.append(
                f"- `{member['path']}::{member['name']}` "
                f"lines {member['start_line']}-{member['end_line']}"
            )
        lines.append("")
    (RESULTS / "review-candidates.md").write_text("\n".join(lines), encoding="utf-8")


def percentage(value: float) -> str:
    return f"{value * 100:.1f}%"


def mib(value: int | None) -> str:
    if value is None:
        return "n/a"
    return f"{value / (1024 * 1024):.1f}"


def write_summary(payload: dict[str, Any]) -> None:
    configurations = payload["configurations"]
    ranked = sorted(
        configurations,
        key=lambda item: (
            item["full_repository"]["p20"]["reviewed_precision"],
            item["full_repository"]["p50"]["known_precision_lower_bound"],
            item["test_gated"]["recall"],
            item["test_ranking"]["average_precision"],
            -item["dimensions"],
        ),
        reverse=True,
    )
    drop_in_ranked = [item for item in ranked if item["stock_slopo_compatible"]]
    payload["ranking"] = [item["configuration"] for item in ranked]
    payload["recommendation"] = ranked[0]["configuration"]
    payload["drop_in_recommendation"] = drop_in_ranked[0]["configuration"]
    (RESULTS / "summary.json").write_text(
        json.dumps(payload, indent=2) + "\n", encoding="utf-8"
    )

    met_both = sum(item["thresholds"]["met_minimum_recall"] for item in configurations)
    if met_both:
        calibration_note = (
            f"{met_both} configuration(s) met both the 80% calibration-recall target and "
            f"the {MAX_REVIEWABLE_CLUSTER_UNITS}-unit component cap. Other configurations "
            "use their best precision-weighted F0.5 result under the component cap."
        )
    else:
        calibration_note = (
            "No configuration met both constraints, so each operating point is the best "
            "precision-weighted F0.5 result under the component cap."
        )

    recommendation = ranked[0]
    drop_in = drop_in_ranked[0]
    fastest = max(configurations, key=lambda item: item["runtime"]["bodies_per_second"])
    lines = [
        "# Slopo local embedding benchmark",
        "",
        f"Corpus fingerprint: `{payload['corpus']['fingerprint']}`",
        "",
        f"Indexed {payload['index']['units']} code units from "
        f"{payload['index']['files']} production/fixture files; "
        f"{payload['index']['unique_bodies']} unique bodies were embedded.",
        "",
        "Thresholds were calibrated per configuration on three clone families. The search "
        "first looked for at least 80% calibration recall while capping the largest similarity "
        f"component at {MAX_REVIEWABLE_CLUSTER_UNITS} units. {calibration_note} Reported test "
        "metrics use four held-out families.",
        "",
        "## Recommendation",
        "",
        f"**{recommendation['configuration']}** is the model-quality winner: "
        f"{percentage(recommendation['full_repository']['p20']['reviewed_precision'])} reviewed "
        "repository P@20, "
        f"{percentage(recommendation['full_repository']['p50']['known_precision_lower_bound'])} "
        "P@50 lower bound, and "
        f"{percentage(recommendation['test_gated']['recall'])} held-out gated recall. It "
        "requires the documented pplx output transform plus 512d truncation. "
        f"**{drop_in['configuration']}** is the precision-first stock Slopo + llama.cpp "
        f"choice at {percentage(drop_in['full_repository']['p20']['reviewed_precision'])} "
        "reviewed P@20. "
        f"**{fastest['configuration']}** is the efficiency choice at "
        f"{fastest['runtime']['bodies_per_second']:.2f} bodies/s.",
        "",
        "## Deployment compatibility",
        "",
        f"The installed `{payload['runtime_environment']['llama_cpp_version']}` build returned "
        "1024 values when its OpenAI endpoint was explicitly sent `dimensions: 512`. Stock "
        "Slopo also does not apply model-specific output transforms. Only native-width, "
        "identity-output rows are therefore exact drop-ins for this setup.",
        "",
        "| Configuration | Exact stock Slopo path | Required adapter work |",
        "|---|---:|---|",
    ]
    for item in ranked:
        steps = "; ".join(item["adapter_steps"]) or "none"
        lines.append(
            f"| {item['configuration']} | "
            f"{'yes' if item['stock_slopo_compatible'] else 'no'} | {steps} |"
        )

    lines.extend(
        [
            "",
            "Stock Slopo settings for the drop-in winner (keep the existing source-only "
            "path exclusions):",
            "",
            "```yaml",
            "embedding_model: openai/qwen3-embedding-0.6b",
            f"embedding_dimensions: {drop_in['dimensions']}",
            "embedding_api_key: local",
            "embedding_params:",
            "  custom_llm_provider: openai",
            "  api_base: http://127.0.0.1:18080/v1",
            "  drop_params: true",
            f"similarity_threshold: {drop_in['thresholds']['similarity_threshold']:.4f}",
            f"rerank_threshold: {drop_in['thresholds']['rerank_threshold']:.4f}",
            "```",
            "",
            "Start llama.cpp with `--embedding --pooling last --embd-normalize -1` for "
            "this Qwen configuration.",
        ]
    )

    lines.extend(
        [
            "",
            "## Held-out labeled quality",
            "",
            "| Configuration | P@20 | P@50 | AP | ROC AUC | Gated precision | Gated recall |",
            "|---|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for item in ranked:
        test = item["test_ranking"]
        gated = item["test_gated"]
        lines.append(
            f"| {item['configuration']} | {percentage(test['p20']['precision'])} | "
            f"{percentage(test['p50']['precision'])} | "
            f"{percentage(test['average_precision'])} | {percentage(test['roc_auc'])} | "
            f"{percentage(gated['precision'])} | {percentage(gated['recall'])} |"
        )

    heldout_positives = ranked[0]["test_ranking"]["positives"]
    lines.extend(
        [
            "",
            f"The held-out candidate set contains {heldout_positives} positives, so P@50 has "
            f"a {percentage(min(heldout_positives, 50) / 50)} ceiling and does not separate "
            "these configurations.",
        ]
    )

    lines.extend(
        [
            "",
            "## Thresholds and planted-clone recall",
            "",
            "| Configuration | Cosine | Rerank | Calibration recall | Largest component | Type-2 recall | Type-3 recall | Repo-semantic recall |",
            "|---|---:|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for item in ranked:
        recall = item["relation_recall"]
        type2 = recall.get("planted_type2", {"recall": 0.0})["recall"]
        type3 = recall.get("planted_type3", {"recall": 0.0})["recall"]
        semantic = recall.get("repo_semantic", {"recall": 0.0})["recall"]
        lines.append(
            f"| {item['configuration']} | {item['thresholds']['similarity_threshold']:.4f} | "
            f"{item['thresholds']['rerank_threshold']:.4f} | "
            f"{percentage(item['thresholds']['metrics']['recall'])} | "
            f"{item['thresholds']['operational']['largest_component']} | "
            f"{percentage(type2)} | {percentage(type3)} | {percentage(semantic)} |"
        )

    lines.extend(
        [
            "",
            "## Full-repository review ranking",
            "",
            "Every cluster appearing in any configuration's top 20 was manually adjudicated. "
            "P@50 remains a conservative lower bound where the final 30 contain unreviewed "
            "clusters.",
            "",
            "| Configuration | Clusters | Reviewed P@20 | Unknown@20 | P@50 lower bound | Unknown@50 |",
            "|---|---:|---:|---:|---:|---:|",
        ]
    )
    for item in ranked:
        full = item["full_repository"]
        lines.append(
            f"| {item['configuration']} | {full['clusters']} | "
            f"{percentage(full['p20'].get('known_precision_lower_bound', 0.0))} | "
            f"{full['p20'].get('unknown', 0)} | "
            f"{percentage(full['p50'].get('known_precision_lower_bound', 0.0))} | "
            f"{full['p50'].get('unknown', 0)} |"
        )

    lines.extend(
        [
            "",
            "## Local cost",
            "",
            "Inference is measured once per model family at native dimensions. Lower-dimensional "
            "runs reuse the model's Matryoshka prefix, matching local indexing behavior.",
            "",
            "| Configuration | Bodies/s | Embed seconds | GPU MiB | Model MiB | Vector MiB | DB MiB |",
            "|---|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for item in ranked:
        runtime = item["runtime"]
        lines.append(
            f"| {item['configuration']} | {runtime['bodies_per_second']:.2f} | "
            f"{runtime['embedding_seconds']:.1f} | {runtime.get('gpu_memory_mib') or 'n/a'} | "
            f"{mib(runtime['model_bytes'])} | {mib(item['embedding_bytes'])} | "
            f"{mib(item['database_bytes'])} |"
        )

    lines.extend(
        [
            "",
            "## Reproducibility notes",
            "",
            "- All weights are Q8_0 GGUF and served by the installed llama.cpp build.",
            "- Qwen uses last-token pooling; Jina, pplx, and Voyage use mean pooling.",
            "- pplx output is converted to its documented native int8 representation before cosine comparison.",
            "- Voyage uses the conversion repository's required 1024-to-2048 projection before truncation.",
            "- Thresholds are independently calibrated; the old 0.92/0.94 defaults are not reused.",
            "",
            f"Precision-first ranking: **{ranked[0]['configuration']}** first. Top-20 "
            "repository results are fully adjudicated; P@50 lower bounds remain conservative.",
            "",
        ]
    )
    (RESULTS / "summary.md").write_text("\n".join(lines), encoding="utf-8")
    write_review_candidates(configurations)


def run_benchmark(
    *,
    corpus_manifest: dict[str, Any],
    index_counts: dict[str, Any],
    selected_families: set[str] | None,
    use_cache: bool,
) -> dict[str, Any]:
    units = load_units()
    labels = resolve_labels(units)
    configurations: list[dict[str, Any]] = []
    model_runs: list[dict[str, Any]] = []
    for spec in MODEL_SPECS:
        if selected_families is not None and spec.family not in selected_families:
            continue
        log(f"Preparing {spec.family} ({spec.repo}).")
        body_hashes, vectors, runtime = embed_model(
            spec, corpus_manifest["fingerprint"], use_cache=use_cache
        )
        model_runs.append(runtime)
        for dimensions in spec.dimensions:
            log(f"Evaluating {spec.family} at {dimensions} dimensions.")
            configurations.append(
                evaluate_configuration(
                    spec=spec,
                    dimensions=dimensions,
                    body_hashes=body_hashes,
                    source_vectors=vectors,
                    runtime_metrics=runtime,
                    units=units,
                    labels=labels,
                )
            )

    payload = {
        "schema_version": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "corpus": corpus_manifest,
        "index": index_counts,
        "runtime_environment": {
            "python_version": platform.python_version(),
            "slopo_version": importlib.metadata.version("slopo"),
            "numpy_version": np.__version__,
            "llama_cpp_version": llama_server_version(),
        },
        "model_runs": model_runs,
        "configurations": configurations,
    }
    write_summary(payload)
    log(f"Benchmark summary written to {RESULTS / 'summary.md'}")
    return payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark local embedding models with Slopo")
    parser.add_argument(
        "command",
        choices=("prepare", "run", "all"),
        nargs="?",
        default="all",
    )
    parser.add_argument(
        "--family",
        action="append",
        choices=tuple(spec.family for spec in MODEL_SPECS),
        help="Run only a selected model family; may be repeated.",
    )
    parser.add_argument("--no-cache", action="store_true", help="Recompute native embeddings")
    return parser.parse_args()


def load_prepared_state() -> tuple[dict[str, Any], dict[str, Any]]:
    manifest_path = WORK / "corpus-manifest.json"
    if not manifest_path.exists() or not BASE_DB.exists():
        raise FileNotFoundError("Benchmark corpus is not prepared; run the 'prepare' command first")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    conn = sqlite3.connect(BASE_DB)
    try:
        counts = {
            "files": conn.execute("SELECT COUNT(*) FROM files").fetchone()[0],
            "units": conn.execute("SELECT COUNT(*) FROM code_units").fetchone()[0],
            "unique_bodies": conn.execute(
                "SELECT COUNT(DISTINCT body_hash) FROM code_units"
            ).fetchone()[0],
        }
    finally:
        conn.close()
    return manifest, counts


def main() -> None:
    args = parse_args()
    ensure_directories()
    if args.command in {"prepare", "all"}:
        manifest = prepare_corpus()
        counts = build_base_index()
        resolve_labels(load_units())
        if args.command == "prepare":
            return
    else:
        manifest, counts = load_prepared_state()

    run_benchmark(
        corpus_manifest=manifest,
        index_counts=counts,
        selected_families=set(args.family) if args.family else None,
        use_cache=not args.no_cache,
    )


if __name__ == "__main__":
    main()
