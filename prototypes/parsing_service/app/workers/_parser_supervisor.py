"""One-shot parser child supervision; no reusable native process state."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any, Mapping, Sequence

from app.storage.atomic_json import read_json
from app.storage.paths import SERVICE_ROOT

if os.name == "nt":
    import ctypes
    from ctypes import wintypes

    _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
    _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000

    class _IoCounters(ctypes.Structure):
        _fields_ = [
            (name, ctypes.c_ulonglong)
            for name in (
                "ReadOperationCount",
                "WriteOperationCount",
                "OtherOperationCount",
                "ReadTransferCount",
                "WriteTransferCount",
                "OtherTransferCount",
            )
        ]

    class _BasicLimitInformation(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class _ExtendedLimitInformation(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", _BasicLimitInformation),
            ("IoInfo", _IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    def _kernel32() -> Any:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = (wintypes.LPVOID, wintypes.LPCWSTR)
        kernel32.SetInformationJobObject.argtypes = (
            wintypes.HANDLE,
            ctypes.c_int,
            wintypes.LPVOID,
            wintypes.DWORD,
        )
        kernel32.AssignProcessToJobObject.argtypes = (
            wintypes.HANDLE,
            wintypes.HANDLE,
        )
        kernel32.TerminateJobObject.argtypes = (wintypes.HANDLE, wintypes.UINT)
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        return kernel32

    def _kill_on_close_job() -> wintypes.HANDLE:
        kernel32 = _kernel32()
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            raise ctypes.WinError(ctypes.get_last_error())
        info = _ExtendedLimitInformation()
        info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(
            job,
            _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(info),
            ctypes.sizeof(info),
        ):
            error = ctypes.get_last_error()
            kernel32.CloseHandle(job)
            raise ctypes.WinError(error)
        return job


class ParserDeadlineExceeded(RuntimeError):
    pass


class ParserProcessFailed(RuntimeError):
    def __init__(self, exit_code: int) -> None:
        super().__init__(f"Parser child exited with status {exit_code}.")
        self.exit_code = exit_code


class ParserChildProtocolError(RuntimeError):
    pass


@dataclass(frozen=True)
class ParserChildOutcome:
    pid: int
    exit_code: int
    payload: dict[str, Any]


class SupervisedProcess:
    """A child whose whole descendant tree the operating system can end.

    Windows binds the tree to a kill-on-close job object; POSIX puts it in its
    own session. Both hold every descendant, including the ones a native parser
    spawns and abandons between two polls of the process table.
    """

    def __init__(
        self,
        command: Sequence[str],
        *,
        cwd: Path,
        env: Mapping[str, str] | None = None,
        stdout: IO[bytes] | None = None,
        stderr: IO[bytes] | None = None,
    ) -> None:
        self._job = _kill_on_close_job() if os.name == "nt" else None
        try:
            self.process = subprocess.Popen(
                list(command),
                cwd=cwd,
                env=dict(env) if env is not None else None,
                stdout=stdout,
                stderr=stderr,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                start_new_session=os.name != "nt",
            )
        except BaseException:
            self._close_job()
            raise
        if self._job is not None:
            # ponytail: a descendant spawned in the microseconds before the
            # assignment escapes the job. A cold interpreter cannot start one
            # that early; CREATE_SUSPENDED would need a thread handle Popen
            # does not expose.
            _kernel32().AssignProcessToJobObject(self._job, int(self.process._handle))

    def _close_job(self) -> None:
        if self._job is not None:
            _kernel32().CloseHandle(self._job)
            self._job = None

    def terminate_tree(self, timeout: float = 10) -> None:
        """End the child and every descendant, then reap the child."""
        if self._job is not None:
            _kernel32().TerminateJobObject(self._job, 1)
            self._close_job()
        else:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except OSError:
                pass
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=timeout)


def supervise_process(
    command: Sequence[str],
    *,
    result_path: Path,
    deadline_seconds: float,
    cwd: Path = SERVICE_ROOT,
) -> ParserChildOutcome:
    child = SupervisedProcess(command, cwd=cwd)
    try:
        try:
            exit_code = child.process.wait(timeout=deadline_seconds)
        except subprocess.TimeoutExpired as exc:
            raise ParserDeadlineExceeded(
                f"Parser child exceeded {deadline_seconds:g} seconds."
            ) from exc
    finally:
        # Native helpers must not outlive the parser child and retain
        # generation handles while the parent publishes the directory.
        child.terminate_tree()

    try:
        payload = read_json(result_path)
    except (OSError, ValueError) as exc:
        if exit_code != 0:
            raise ParserProcessFailed(exit_code) from exc
        raise ParserChildProtocolError("Parser child result is unavailable.") from exc
    if not isinstance(payload, dict) or payload.get("status") not in {
        "completed",
        "failed",
    }:
        raise ParserChildProtocolError("Parser child result is invalid.")
    if (exit_code == 0) != (payload["status"] == "completed"):
        raise ParserChildProtocolError(
            "Parser child exit status contradicts its result."
        )
    return ParserChildOutcome(child.process.pid, exit_code, payload)


def run_parser_child(
    *,
    task_id: str,
    task_root: Path,
    source_path: Path,
    artifact_root: Path,
    result_path: Path,
    deadline_seconds: float,
) -> ParserChildOutcome:
    return supervise_process(
        [
            sys.executable,
            "-m",
            "app.workers.parser_child",
            "--task-id",
            task_id,
            "--task-root",
            str(task_root),
            "--source-path",
            str(source_path),
            "--artifact-root",
            str(artifact_root),
            "--result-path",
            str(result_path),
        ],
        result_path=result_path,
        deadline_seconds=deadline_seconds,
    )
