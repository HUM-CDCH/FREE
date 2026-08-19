"""One bounded FIFO and one in-process Docling worker."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import inspect
from collections.abc import Mapping
from contextlib import suppress
from pathlib import Path
from typing import Any

from .contracts import Parser
from .storage import MAX_UPLOAD_BYTES, TaskNotFoundError, TaskStorage, utc_now


DEFAULT_QUEUE_CAPACITY = 2
MAX_NUM_PAGES = 100


class QueueCapacityError(RuntimeError):
    pass


class ParserUnavailableError(RuntimeError):
    pass


def _package_version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "unavailable"


def task_parameters(source_name: str) -> dict[str, int | str]:
    """Retain the public shape while naming retired components honestly."""

    return {
        "pipeline": "docling_standard_pdf",
        "policy_revision": 1,
        "doctags_converter_revision": 0,
        "v2_renderer_revision": 1,
        "parsed_document_schema_revision": "parsed_document.v2",
        "docling_version": _package_version("docling"),
        "ocr_fallback_dpi": 0,
        "ocr_fallback_device_policy": "docling_default",
        "resolved_ocr_device": "unavailable",
        "paddleocr_model": "unavailable",
        "paddleocr_version": "unavailable",
        "source_name": source_name,
        "table_parser": "docling_default",
        "camelot_version": "unavailable",
    }


def preprocess_id(
    content_sha256: str,
    parameters: Mapping[str, int | str],
) -> str:
    policy = "\0".join(
        (
            content_sha256,
            str(parameters["parsed_document_schema_revision"]),
            str(parameters["pipeline"]),
            f"policy:{parameters['policy_revision']}",
            f"renderer:{parameters['v2_renderer_revision']}",
            f"docling:{parameters['docling_version']}",
        )
    )
    return f"sha256:{hashlib.sha256(policy.encode('utf-8')).hexdigest()}"


def new_task_metadata(
    *,
    task_id: str,
    source_name: str,
    content_sha256: str,
    byte_size: int,
) -> dict[str, Any]:
    now = utc_now()
    parameters = task_parameters(source_name)
    return {
        "task_id": task_id,
        "document_id": f"sha256:{content_sha256}",
        "content_sha256": content_sha256,
        "source_path": "source.pdf",
        "source_kind": "upload",
        "status": "pending",
        "created_at": now,
        "updated_at": now,
        "params": parameters,
        "stats": {"task": {"cache_status": "unknown"}},
        "parser_runs": [],
        "interrupted_attempt": None,
        "selected_parser": None,
        "canonical_parsed_document_ref": None,
        "preprocess_id": preprocess_id(content_sha256, parameters),
        "byte_size": byte_size,
        "error_code": None,
        "error": None,
    }


def _field(result: Any, name: str, default: Any = inspect.Parameter.empty) -> Any:
    if isinstance(result, Mapping):
        if name in result:
            return result[name]
    elif hasattr(result, name):
        return getattr(result, name)
    if default is inspect.Parameter.empty:
        raise ValueError(f"Parser result is missing {name}.")
    return default


def _json_mapping(value: Any, label: str) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValueError(f"Parser result {label} must be a mapping.")
    return {str(key): item for key, item in value.items()}


def _parser_runs(result: Any) -> list[dict[str, Any]]:
    raw = _field(result, "parser_runs", ())
    if raw is None:
        return []
    if isinstance(raw, (str, bytes)) or not hasattr(raw, "__iter__"):
        raise ValueError("Parser result parser_runs must be a sequence.")
    runs: list[dict[str, Any]] = []
    for item in raw:
        if isinstance(item, Mapping):
            run = dict(item)
        elif hasattr(item, "model_dump"):
            run = item.model_dump(mode="json")
        else:
            raise ValueError("Parser provenance must be a mapping.")
        runs.append(run)
    return runs


class TaskManager:
    """Coordinates admission and parsing; durable bytes stay in ``TaskStorage``."""

    def __init__(
        self,
        storage: TaskStorage,
        parser: Parser | Any | None = None,
        *,
        capacity: int = DEFAULT_QUEUE_CAPACITY,
    ) -> None:
        if not isinstance(capacity, int) or isinstance(capacity, bool) or capacity <= 0:
            raise ValueError("Queue capacity must be a positive integer.")
        self.storage = storage
        self.parser = parser
        self.capacity = capacity
        # Capacity is accounted by _active. An unbounded physical queue lets a
        # cancelled pending tombstone remain in FIFO order without blocking admission.
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._active: set[str] = set()
        self._lock = asyncio.Lock()
        self._worker: asyncio.Task[None] | None = None
        self._stopping = False
        self.health = "starting"
        self.state: str | None = None

    async def start(self) -> None:
        self.storage.recover_interrupted()
        try:
            if self.parser is None:
                from .docling_parser import DoclingParser

                self.parser = await asyncio.to_thread(DoclingParser)
            initializer = getattr(self.parser, "initialize", None)
            if callable(initializer):
                await asyncio.to_thread(initializer)
        except Exception:
            self.health = "unhealthy"
            self.state = "failed"
            return
        self.health = "healthy"
        self.state = "ready"
        self._worker = asyncio.create_task(
            self._run(),
            name="simple-parsing-worker",
        )

    async def stop(self) -> None:
        self._stopping = True
        worker = self._worker
        if worker is not None:
            worker.cancel()
            with suppress(asyncio.CancelledError):
                await worker
        self._worker = None
        self.state = "stopped"

    @property
    def ready(self) -> bool:
        return self.health == "healthy" and self.state in {"ready", "busy"}

    async def admit(self, metadata: Mapping[str, Any]) -> None:
        task_id = str(metadata["task_id"])
        async with self._lock:
            if not self.ready or self._stopping:
                raise ParserUnavailableError("Parser worker is not ready.")
            if len(self._active) >= self.capacity:
                raise QueueCapacityError("Parser queue capacity has been reached.")
            self.storage.save_metadata(metadata)
            self._active.add(task_id)
            self._queue.put_nowait(task_id)

    async def cancel(self, task_id: str) -> dict[str, Any]:
        async with self._lock:
            metadata = self.storage.load_metadata(task_id)
            status = metadata.get("status")
            if status == "pending":
                metadata["status"] = "cancelled"
                metadata["updated_at"] = utc_now()
                metadata["error_code"] = None
                metadata["error"] = None
                self._active.discard(metadata["task_id"])
                self.storage.save_metadata(metadata)
            elif status == "running":
                metadata["status"] = "cancelling"
                metadata["updated_at"] = utc_now()
                self.storage.save_metadata(metadata)
            elif status not in {
                "cancelling",
                "cancelled",
                "completed",
                "failed",
            }:
                raise ValueError("Task metadata has an invalid status.")
            return metadata

    def _parse(self, source_path: Path, context: Mapping[str, Any]) -> Any:
        parser = self.parser
        parse = getattr(parser, "parse", None)
        if not callable(parse):
            if callable(parser):
                parse = parser
            else:
                raise ParserUnavailableError("Parser has no parse method.")
        return parse(source_path, context)

    async def _begin(self, task_id: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
        async with self._lock:
            metadata = self.storage.load_metadata(task_id)
            if metadata.get("status") != "pending":
                return None
            started_at = utc_now()
            metadata["status"] = "running"
            metadata["updated_at"] = started_at
            self.storage.save_metadata(metadata)
            context = {
                "document_id": metadata["document_id"],
                "content_sha256": metadata["content_sha256"],
                "preprocess_id": metadata["preprocess_id"],
                "source_name": metadata["params"]["source_name"],
                "created_at": metadata["created_at"],
                "service_version": _package_version("parsing_service_simple"),
                "started_at": started_at,
                "max_num_pages": MAX_NUM_PAGES,
                "max_file_size": MAX_UPLOAD_BYTES,
            }
            return metadata, context

    async def _complete(
        self,
        task_id: str,
        original: Mapping[str, Any],
        result: Any,
    ) -> None:
        parsed_document = _field(result, "parsed_document")
        markdown = _field(result, "markdown")
        stats = _json_mapping(_field(result, "stats", {}), "stats")
        runs = _parser_runs(result)
        selected_parser = _field(result, "selected_parser", "docling")
        warnings = list(_field(result, "warnings", ()) or ())
        version = _field(result, "docling_version", None)

        if not runs:
            runs = [
                {
                    "parser": str(selected_parser or "docling"),
                    "version": version,
                    "status": "success",
                    "warnings": warnings,
                    "error": None,
                }
            ]
        async with self._lock:
            metadata = self.storage.load_metadata(task_id)
            if metadata.get("status") in {"cancelling", "cancelled"}:
                metadata["status"] = "cancelled"
                metadata["updated_at"] = utc_now()
                metadata["error_code"] = None
                metadata["error"] = None
                self.storage.save_metadata(metadata)
                return
        await asyncio.to_thread(
            self.storage.publish_result,
            task_id,
            parsed_document,
            markdown,
            content_sha256=str(original["content_sha256"]),
            preprocess_id=str(original["preprocess_id"]),
        )
        async with self._lock:
            metadata = self.storage.load_metadata(task_id)
            if metadata.get("status") in {"cancelling", "cancelled"}:
                self.storage.discard_result(task_id)
                metadata["status"] = "cancelled"
                metadata["updated_at"] = utc_now()
                metadata["error_code"] = None
                metadata["error"] = None
            else:
                metadata["status"] = "completed"
                metadata["updated_at"] = utc_now()
                metadata["stats"] = stats or metadata.get("stats", {})
                metadata["parser_runs"] = runs
                metadata["selected_parser"] = selected_parser
                metadata["canonical_parsed_document_ref"] = "parsed_document.json"
                metadata["error_code"] = None
                metadata["error"] = None
                if isinstance(version, str) and version:
                    metadata["params"]["docling_version"] = version
            self.storage.save_metadata(metadata)

    async def _fail(self, task_id: str, error: BaseException) -> None:
        async with self._lock:
            try:
                metadata = self.storage.load_metadata(task_id)
            except TaskNotFoundError:
                return
            if metadata.get("status") in {"cancelling", "cancelled"}:
                metadata["status"] = "cancelled"
                metadata["error_code"] = None
                metadata["error"] = None
            else:
                code = getattr(error, "code", None)
                public_message = getattr(error, "public_message", None)
                metadata["status"] = "failed"
                metadata["error_code"] = (
                    str(code)[:128] if code else "parsing_failed"
                )
                metadata["error"] = str(public_message or error or "Parsing failed.")[
                    :2048
                ]
            metadata["updated_at"] = utc_now()
            self.storage.save_metadata(metadata)

    async def _run(self) -> None:
        while True:
            task_id = await self._queue.get()
            try:
                begun = await self._begin(task_id)
                if begun is None:
                    continue
                metadata, context = begun
                self.state = "busy"
                try:
                    result = await asyncio.to_thread(
                        self._parse,
                        self.storage.source_path(task_id),
                        context,
                    )
                    await self._complete(task_id, metadata, result)
                except asyncio.CancelledError:
                    raise
                except BaseException as exc:
                    await self._fail(task_id, exc)
            except asyncio.CancelledError:
                raise
            except Exception:
                self.health = "unhealthy"
                self.state = "failed"
                return
            finally:
                async with self._lock:
                    self._active.discard(task_id)
                self._queue.task_done()
                if not self._stopping and self.state != "failed":
                    self.state = "ready"


__all__ = [
    "DEFAULT_QUEUE_CAPACITY",
    "ParserUnavailableError",
    "QueueCapacityError",
    "TaskManager",
    "new_task_metadata",
    "preprocess_id",
    "task_parameters",
]
