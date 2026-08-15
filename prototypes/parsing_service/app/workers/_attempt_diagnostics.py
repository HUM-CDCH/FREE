"""Private diagnostics for one parsing attempt."""

from __future__ import annotations

import datetime
import os
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Literal

import psutil
from filelock import FileLock

from app.parsing.orchestrator import PhaseEvent, PhaseName
from app.storage.atomic_json import read_json, write_json_atomic
from app.storage.manifests import load_task_metadata, save_task_metadata
from app.storage.paths import task_store_lock_path
from app.timing import utc_now

ATTEMPT_METRICS_FILENAME = ".attempt-metrics.json"
AttemptOutcome = Literal["completed", "failed"]


class TaskStateError(Exception):
    pass


def duration_ms(started_at: object, finished_at: object) -> int | None:
    if not isinstance(started_at, str) or not isinstance(finished_at, str):
        return None
    try:
        elapsed = datetime.datetime.fromisoformat(
            finished_at
        ) - datetime.datetime.fromisoformat(started_at)
    except ValueError:
        return None
    return max(0, int(elapsed.total_seconds() * 1000))


def persist_task_metadata(task_dir: Path, metadata: dict[str, Any]) -> None:
    with FileLock(str(task_store_lock_path())):
        try:
            save_task_metadata(task_dir, metadata)
        except (OSError, TypeError, ValueError) as exc:
            raise TaskStateError from exc


def _failure_details(
    exc: Exception | None,
    failing_phase: PhaseName | None,
) -> dict[str, object]:
    return {
        "exception_type": (
            f"{type(exc).__module__}.{type(exc).__qualname__}"
            if exc is not None
            else "worker_process_exit"
        ),
        "traceback": (
            "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
            if exc is not None
            else None
        ),
        "failing_phase": failing_phase,
    }


def finish_attempt(
    metadata: dict[str, Any],
    *,
    outcome: AttemptOutcome,
    exc: Exception | None = None,
    now: str | None = None,
) -> PhaseName | None:
    attempt = metadata["attempt"]
    existing_failure = attempt.get("failure")
    if outcome == "failed" and isinstance(existing_failure, dict):
        return existing_failure.get("failing_phase")

    finished_at = now or utc_now()
    phase = attempt.get("current_phase")
    if phase is None and attempt["phases"]:
        phase = next(reversed(attempt["phases"]))
    if phase is not None:
        record = attempt["phases"].get(phase)
        if isinstance(record, dict) and record.get("finished_at") is None:
            record["finished_at"] = finished_at
            record["duration_ms"] = duration_ms(
                record.get("started_at"), finished_at
            )
            record["outcome"] = outcome
    attempt["finished_at"] = finished_at
    attempt["current_phase"] = None
    attempt["failure"] = (
        None if outcome == "completed" else _failure_details(exc, phase)
    )
    return phase


class _ProcessSampler:
    """Sample native process high-water marks while one attempt runs."""

    def __init__(self, metrics_path: Path, diagnostic_id: str) -> None:
        self._process = psutil.Process(os.getpid())
        self._metrics_path = metrics_path
        self._diagnostic_id = diagnostic_id
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._peak_private_memory_bytes = 0
        self._peak_thread_count = 0

    def _sample(self) -> tuple[int, int]:
        try:
            memory = self._process.memory_info()
            private_bytes = getattr(memory, "private", None)
            if not isinstance(private_bytes, int) or private_bytes <= 0:
                full_memory = self._process.memory_full_info()
                private_bytes = int(getattr(full_memory, "uss", memory.rss))
            thread_count = self._process.num_threads()
        except (OSError, psutil.Error):
            return 0, 0
        self._peak_private_memory_bytes = max(
            self._peak_private_memory_bytes, private_bytes
        )
        self._peak_thread_count = max(self._peak_thread_count, thread_count)
        return private_bytes, thread_count

    def _sample_loop(self) -> None:
        next_persist = time.monotonic() + 1
        while not self._stop.wait(0.25):
            self._sample()
            if time.monotonic() >= next_persist:
                self._persist_snapshot()
                next_persist = time.monotonic() + 1

    def _persist_snapshot(self) -> None:
        try:
            write_json_atomic(
                self._metrics_path,
                {
                    "diagnostic_id": self._diagnostic_id,
                    "worker": self.snapshot(),
                },
            )
        except (OSError, TypeError, ValueError):
            pass

    def start(self) -> dict[str, int]:
        self._sample()
        self._persist_snapshot()
        self._thread = threading.Thread(
            target=self._sample_loop,
            name="parse-attempt-metrics",
            daemon=True,
        )
        self._thread.start()
        return self.snapshot()

    @property
    def active(self) -> bool:
        return self._thread is not None

    def snapshot(self) -> dict[str, int]:
        _, thread_count = self._sample()
        return {
            "pid": self._process.pid,
            "peak_private_memory_bytes": self._peak_private_memory_bytes,
            "thread_count": thread_count,
            "peak_thread_count": self._peak_thread_count,
        }

    def finish(self) -> dict[str, int]:
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
            self._thread = None
        return self.snapshot()

    def cleanup(self) -> None:
        try:
            self._metrics_path.unlink()
        except OSError:
            pass


class AttemptTracker:
    def __init__(self, task_dir: Path, metadata: dict[str, Any]) -> None:
        self.task_dir = task_dir
        self.metadata = metadata
        self.attempt = metadata["attempt"]
        self._sampler = _ProcessSampler(
            task_dir / ATTEMPT_METRICS_FILENAME,
            metadata["diagnostic_id"],
        )
        self._phase_started: dict[PhaseName, float] = {}
        self._last_phase: PhaseName | None = None

    def refresh(self) -> None:
        self.metadata = load_task_metadata(self.task_dir)
        self.attempt = self.metadata["attempt"]

    def _persist(self, now: str | None = None) -> None:
        self.metadata["updated_at"] = now or utc_now()
        persist_task_metadata(self.task_dir, self.metadata)

    def _update_worker(self, snapshot: dict[str, int] | None = None) -> None:
        if snapshot is not None:
            self.attempt["worker"] = snapshot
        elif self._sampler.active:
            self.attempt["worker"] = self._sampler.snapshot()

    def start(self) -> None:
        now = utc_now()
        if self.attempt.get("started_at") is None:
            self.attempt["started_at"] = now
            self.attempt["finished_at"] = None
            self.attempt["current_phase"] = None
            self.attempt["phases"] = {}
            self.attempt["failure"] = None
            self._last_phase = None
        self._update_worker(self._sampler.start())
        self._persist(now)

    @property
    def sampling_active(self) -> bool:
        return self._sampler.active

    def stop_sampling(self) -> None:
        now = utc_now()
        self._update_worker(self._sampler.finish())
        self._persist(now)
        self._sampler.cleanup()

    def observe(self, phase: PhaseName, event: PhaseEvent) -> None:
        if event == "started":
            self._start_phase(phase)
        elif event == "completed":
            self._finish_phase(phase, "completed")
        else:
            self._finish_phase(phase, "failed", keep_current=True)

    def _start_phase(self, phase: PhaseName) -> None:
        phases = self.attempt["phases"]
        current = self.attempt.get("current_phase")
        if current == phase and phases.get(phase, {}).get("finished_at") is None:
            return
        if current is not None:
            self._finish_phase(current, "completed")
        now = utc_now()
        phases[phase] = {
            "started_at": now,
            "finished_at": None,
            "duration_ms": None,
            "outcome": "running",
        }
        self._phase_started[phase] = time.perf_counter()
        self._last_phase = phase
        self.attempt["current_phase"] = phase
        self._update_worker()
        self._persist(now)

    def _finish_phase(
        self,
        phase: PhaseName,
        outcome: AttemptOutcome,
        *,
        keep_current: bool = False,
    ) -> None:
        record = self.attempt["phases"].get(phase)
        if record is None:
            self._start_phase(phase)
            record = self.attempt["phases"][phase]
        now = utc_now()
        started = self._phase_started.get(phase)
        record["finished_at"] = now
        record["duration_ms"] = (
            max(0, int((time.perf_counter() - started) * 1000))
            if started is not None
            else duration_ms(record.get("started_at"), now)
        )
        record["outcome"] = outcome
        self._last_phase = phase
        self.attempt["current_phase"] = phase if keep_current else None
        self._update_worker()
        self._persist(now)

    def finish_failure(self, exc: Exception) -> None:
        failing_phase = self.attempt.get("current_phase") or self._last_phase
        if failing_phase is not None:
            self._finish_phase(failing_phase, "failed", keep_current=True)
        now = utc_now()
        self._update_worker(self._sampler.finish())
        finish_attempt(self.metadata, outcome="failed", exc=exc, now=now)
        self._persist(now)
        self._sampler.cleanup()


def merge_attempt_metrics(task_dir: Path, metadata: dict[str, Any]) -> None:
    try:
        payload = read_json(task_dir / ATTEMPT_METRICS_FILENAME)
    except (OSError, ValueError):
        return
    if (
        isinstance(payload, dict)
        and payload.get("diagnostic_id") == metadata.get("diagnostic_id")
        and isinstance(payload.get("worker"), dict)
    ):
        metadata["attempt"]["worker"] = payload["worker"]


def remove_attempt_metrics(task_dir: Path) -> None:
    try:
        (task_dir / ATTEMPT_METRICS_FILENAME).unlink()
    except OSError:
        pass
