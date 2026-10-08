"""One slot, one worker: supervised exclusive ownership.

The lock is an `flock` held on a file for the process's lifetime, because that is the one claim a process cannot
make on another's behalf and cannot keep after it dies: a merely stopped worker keeps it, so it never gets a
replacement and stays the supervisor's to kill, and a killed and reaped one loses it the moment the kernel
closes its descriptors.
"""
from __future__ import annotations

import fcntl
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from kei_exp import runs


class SlotTaken(RuntimeError):
    """Another live process holds this slot. It is the supervisor's to end, never this process's to step over."""


def lock_path(slot: str) -> Path:
    """`KEI_RUNS/.worker-<slot>.lock`: read per call, so a test that moves runs.RUNS moves the lock with it."""
    return runs.RUNS / f".worker-{slot}.lock"


@contextmanager
def hold_slot(slot: str) -> Iterator[None]:
    """Hold `slot` exclusively for the block, or raise `SlotTaken`."""
    path = lock_path(slot)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise SlotTaken(f"slot {slot} is held by another process ({path})") from error
        os.ftruncate(handle, 0)
        os.write(handle, f"{os.getpid()}\n".encode())
        yield
    finally:
        os.close(handle)  # the lock goes with the descriptor, and the descriptor goes with the process
