"""Real worker processes for the ownership tests: spawned, stopped, killed and reaped as a supervisor would."""
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

HOLDER = (
    "import sys, time;"
    "sys.path.insert(0, 'src');"
    "from kei_exp.jobs import worker;"
    "worker.LOCK_DIR = __import__('pathlib').Path(sys.argv[2]);"
    "ctx = worker.hold_slot(sys.argv[1]);"
    "ctx.__enter__();"
    "print('held', flush=True);"
    "time.sleep(600)"
)


class Holder:
    """A process that holds one slot's lock and nothing else."""

    def __init__(self, process: subprocess.Popen[str]) -> None:
        self.process = process

    def wait_started(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            assert self.process.stdout is not None
            if (self.process.stdout.readline() or "").strip() == "held":
                return
            if self.process.poll() is not None:
                raise AssertionError(f"the holder exited with {self.process.returncode}")
        raise AssertionError(f"the holder did not take the slot within {timeout} s")

    def pause(self) -> None:
        os.kill(self.process.pid, signal.SIGSTOP)

    def resume(self) -> None:
        os.kill(self.process.pid, signal.SIGCONT)

    def kill(self) -> None:
        os.kill(self.process.pid, signal.SIGKILL)

    def reap(self) -> None:
        self.process.wait(timeout=20)


def holder(slot: str, lock_dir: Path) -> Holder:
    process = subprocess.Popen([sys.executable, "-c", HOLDER, slot, str(lock_dir)],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    return Holder(process)


class Worker(Holder):
    """A real `kei-jobs worker` child, supervised by the test as a deployment would supervise it."""

    def wait_serving(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        assert self.process.stdout is not None
        while time.monotonic() < deadline:
            line = self.process.stdout.readline()
            if "reconciled" in line:
                return
            if self.process.poll() is not None:
                raise AssertionError(f"the worker exited with {self.process.returncode}")
        raise AssertionError(f"the worker did not start serving within {timeout} s")

    def stop(self) -> None:
        self.process.terminate()
        self.process.wait(timeout=30)


def worker(slot: str, *, database: str, runs_root: Path) -> Worker:
    environment = {**os.environ, "KEI_DATABASE_URL": database, "KEI_RUNS": str(runs_root), "KEI_SLOT": slot,
                   "PYTHONPATH": "src", "PYTHONUNBUFFERED": "1"}
    process = subprocess.Popen([sys.executable, "-m", "kei_exp.jobs.cli", "worker", "--slot", slot],
                               env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, bufsize=1)
    return Worker(process)


def until(predicate, timeout: float, what: str):
    """Poll `predicate` until it is truthy; the value, or an assertion naming what never happened."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found = predicate()
        if found:
            return found
        time.sleep(0.05)
    raise AssertionError(f"{what} did not happen within {timeout} s")
