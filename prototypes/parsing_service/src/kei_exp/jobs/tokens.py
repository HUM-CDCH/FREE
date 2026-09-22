"""Replayable token previews on the worker/API's shared local filesystem.

Each line follows the database event named by its seq. Its ending byte offset distinguishes it from other
tokens after that event. Only complete lines are visible; a restarted writer removes an unfinished tail.
These are provisional previews, not accepted document content, and are flushed without per-batch fsync.
"""
from __future__ import annotations

import json
from pathlib import Path

from kei_exp.progress import Event


class TokenLog:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._offset: int | None = None

    @property
    def offset(self) -> int:
        if self._offset is None:
            self._offset = self._repair_tail()
        return self._offset

    def _repair_tail(self) -> int:
        try:
            with self.path.open("r+b") as file:
                end = file.seek(0, 2)
                while end:
                    start = max(0, end - 4096)
                    file.seek(start)
                    chunk = file.read(end - start)
                    newline = chunk.rfind(b"\n")
                    if newline >= 0:
                        end = start + newline + 1
                        break
                    end = start
                file.truncate(end)
                return end
        except FileNotFoundError:
            return 0

    def append(self, events: list[Event]) -> None:
        offset = self.offset
        data = "".join(json.dumps(event, ensure_ascii=False) + "\n" for event in events).encode("utf-8")
        try:
            with self.path.open("ab") as file:
                file.write(data)
        except OSError:
            self._offset = None  # repair any partial write before recording the failure's control event
            raise
        self._offset = offset + len(data)


def read_after(path: Path, offset: int, through: int) -> tuple[list[Event], int]:
    """Read complete lines through the latest database event the subscriber has actually observed.

    A worker may append after a newer control commit while the API is reading an older database snapshot.
    Leave that line for the next poll, so its tokens cannot overtake their page_start or phase event.
    """
    events = []
    try:
        with path.open("rb") as file:
            file.seek(offset)
            while line := file.readline():
                if not line.endswith(b"\n"):
                    break
                event = json.loads(line)
                if event["seq"] > through:
                    break
                offset = file.tell()
                events.append({**event, "token_offset": offset})
    except FileNotFoundError:
        pass  # no token has been flushed for this run
    return events, offset
