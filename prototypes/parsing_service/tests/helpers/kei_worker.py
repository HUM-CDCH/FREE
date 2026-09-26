"""A real `kei-worker worker` process with this suite's doubles, for recovery tests.

Child: `python -m tests.helpers.kei_worker [--crash-after result|artifact] -- worker --slot S --database-url URL`.
Doubles: the `fake` OCR record (tests/helpers/fake.py) served by a stand-in server; its native call writes
$KEI_TEST_CONTROL/started-<n> and waits until $KEI_TEST_CONTROL/release exists; extraction talks to the scripted
`honest` chat and counts words. `--crash-after` SIGKILLs this process right after the first publication of that kind
(the result manifest, or an extraction artifact); $KEI_TEST_CONTROL/crashed makes it happen once.
"""
from __future__ import annotations

import argparse
import contextlib
import os
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _install(control: Path, crash_after: str | None) -> contextlib.AbstractContextManager:
    """Patches the doubles in; returns the `fake` record's registration, which the caller holds open (an entered but
    unreferenced registration would be closed, and the record removed, by the garbage collector)."""
    from kei_exp import runtime
    from kei_exp.kie.extract import run as extraction
    from kei_exp.kie.stages import ocr
    from kei_exp.workflows import extract as extract_workflow
    from tests.helpers.fake import FakeTranscriber, registered
    from tests.test_extract_grounded import CountingChat, WordCounter, honest

    class Gated(FakeTranscriber):
        def transcribe(self, execution, crops, emit):
            count = len(list(control.glob("started-*"))) + 1
            (control / f"started-{count}").write_text(str(os.getpid()))
            while not (control / "release").exists():
                time.sleep(0.05)
            return super().transcribe(execution, crops, emit)

    runtime.loaded_model = lambda url: (True, "fake/model")
    extract_workflow.chats_for = lambda options: CountingChat(honest)
    extraction.counter_for = lambda client: WordCounter()

    def crashing(module, name, kind):
        original = getattr(module, name)

        def wrapped(*args, **kwargs):
            result = original(*args, **kwargs)
            if crash_after == kind and not (control / "crashed").exists():
                (control / "crashed").write_text(kind)
                os.kill(os.getpid(), signal.SIGKILL)
            return result
        setattr(module, name, wrapped)
    crashing(ocr, "write_result", "result")
    crashing(extract_workflow, "publish_extraction", "artifact")
    return registered(Gated())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--crash-after", choices=["result", "artifact"])
    parser.add_argument("worker_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    with _install(Path(os.environ["KEI_TEST_CONTROL"]), args.crash_after):  # for the process's lifetime
        from kei_exp.workflows import cli
        cli.main([arg for arg in args.worker_args if arg != "--"])


@dataclass
class WorkerProcess:
    process: subprocess.Popen[str]
    log: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        threading.Thread(target=self._drain, daemon=True).start()

    def _drain(self) -> None:
        assert self.process.stdout is not None
        while line := self.process.stdout.readline():
            self.log.append(line)

    def wait_serving(self, timeout: float = 120) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if any("serving" in line for line in self.log):
                return
            if self.process.poll() is not None:
                raise AssertionError(f"the worker exited with {self.process.returncode}:\n{''.join(self.log)}")
            time.sleep(0.05)
        raise AssertionError(f"the worker did not start serving:\n{''.join(self.log)}")

    def kill(self) -> None:
        os.kill(self.process.pid, signal.SIGKILL)
        self.process.wait(timeout=20)

    def pause(self) -> None:
        os.kill(self.process.pid, signal.SIGSTOP)

    def resume(self) -> None:
        os.kill(self.process.pid, signal.SIGCONT)

    def shutdown(self) -> None:
        """Kill and reap unconditionally; never raises (so it cannot mask a failed assertion)."""
        if self.process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.kill(self.process.pid, signal.SIGKILL)
        with contextlib.suppress(subprocess.TimeoutExpired):
            self.process.wait(timeout=20)


def spawn(slot: str, *, database_url: str, runs_root: Path, inbox: Path, control: Path,
          crash_after: str | None = None) -> WorkerProcess:
    command = [sys.executable, "-m", "tests.helpers.kei_worker"]
    if crash_after:
        command += ["--crash-after", crash_after]
    command += ["--", "worker", "--slot", slot, "--database-url", database_url]
    environment = {**os.environ, "KEI_RUNS": str(runs_root), "KEI_SOURCE_INBOX": str(inbox),
                   "KEI_TEST_CONTROL": str(control), "KEI_LOG_LEVEL": "INFO", "PYTHONUNBUFFERED": "1"}
    process = subprocess.Popen(command, cwd=ROOT, env=environment, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, bufsize=1)
    return WorkerProcess(process)


if __name__ == "__main__":
    main()
