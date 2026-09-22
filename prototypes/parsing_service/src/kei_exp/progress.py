"""Progress events: one JSON-serialisable dict per step, rendered by the CLI as today's stdout lines."""
from collections.abc import Callable
from threading import Lock
from typing import Any

Event = dict[str, Any]
# A sink may be called from several threads at once (Surya streams its pages from a thread pool): the API's
# Job.emit and the printer below both take a lock.
Emit = Callable[[Event], None]
# A model server's finish reason as the run's stop reason, the same words for every transcriber.
STOP_REASONS = {"stop": "end_of_sequence", "length": "length", "content_filter": "content_filter"}


def where(event: Event) -> str:
    """A page-bearing event's place: the PDF page, its unit when that is not the page itself, and its crop."""
    place = f"page {event['page']}"
    if event.get("unit"):
        place += f" unit {event['unit']}"
    if event.get("crop") is not None:
        place += f" crop {event['crop']}"
    return place


class _Printer:
    """CLI rendering of events: the text main() printed before events existed, with a `[page N ...]` label wherever
    the live text changes input, since Surya streams several crops at once."""

    def __init__(self) -> None:
        self.lock = Lock()
        self.page: str | None = None  # the place of the text printed last; None when the next token needs a label
        self.midline = False          # the text printed last did not end its line

    def _line(self, text: str = "") -> None:
        print(text, flush=True)
        self.page, self.midline = None, False

    def __call__(self, event: Event) -> None:
        with self.lock:
            match event["type"]:
                case "phase":
                    self.page = None  # one printer for every conversion of the process
                case "region":
                    self._line(f"{where(event).capitalize()} region {event['order']}: {event['kind']} at "
                               f"{[round(v) for v in event['bbox']]} pt, {event['width']}x{event['height']} px, "
                               f"ink={event['ink']:.0%}")
                case "page_start" if where(event) == self.page:
                    self.page = None  # a retry of the input being printed starts under a fresh label
                case "token":
                    if where(event) != self.page:
                        if self.midline:
                            print()
                        print(f"[{where(event)}] ", end="")
                        self.page = where(event)
                    print(event["text"], end="", flush=True)
                    self.midline = not event["text"].endswith("\n")
                case "page_end":
                    self._line()
                case "page_stats":
                    if "blocks" in event:
                        self._line(f"{where(event).capitalize()}: image={event['image']}, blocks={event['blocks']}, "
                                   f"errors={event['errors']}, skipped={event['skipped']}, "
                                   f"output_tokens={event['output_tokens']}, capped={event['capped']}")
                    else:
                        self._line(f"{where(event).capitalize()}: image={event['image']}, "
                                   f"input_tokens={event['input_tokens']}, output_tokens={event['output_tokens']}, "
                                   f"stop={event['stop']}")
                case "log":
                    self._line(event["text"])


print_event: Emit = _Printer()
