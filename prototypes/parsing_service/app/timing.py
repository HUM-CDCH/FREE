import datetime
import time


def utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def duration_ms(start: float) -> int:
    try:
        return int((time.time() - start) * 1000)
    except (OverflowError, ValueError):
        return 0
