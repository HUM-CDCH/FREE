"""What a failed step means: another attempt may meet a backend that is ready again, or the failure is about this
document or request and repeats identically.

`classify` is the one judgement (moved from `jobs/tasks.py`). DBOS asks `should_retry` after each failed attempt of a
step and needs a bool: `classify` returns an exception, which DBOS would read as always true. `failure_of` turns what a
step finally raised into the portable code a workflow reports (`workflows/contracts.py`).
"""
from __future__ import annotations

import requests
from pydantic import ValidationError

from kei_exp.transcription.types import ConversionError, IncompleteConversionError

# Phrases the adapters put on a ConversionError that mean the backend, not the document. They are matched rather
# than typed because the adapters wrap Surya's and Docling's own exceptions into ConversionError by design. An
# incomplete recognition is excluded by type (IncompleteConversionError), not by matching phrases: see classify().
TRANSIENT = ("unreachable", "connection refused", "connection reset", "timed out", "timeout",
             "temporarily unavailable", "service unavailable", "bad gateway", "stream disconnected")

# Statuses an OpenAI-compatible server answers with when it is not ready rather than when the request is wrong:
# a vLLM still loading its weights, a proxy with nothing behind it yet, an overloaded or restarting server. They
# are the HTTP spelling of the phrases above, which reach classify() on a ConversionError from the conversion
# path but on a requests.HTTPError from the extraction path (kie/extract/llm.py's raise_for_status). Every other
# status — 400, 404, 422, and 500, which is the server failing on THIS request — fails the same way next time.
TRANSIENT_STATUS = (429, 502, 503, 504)

CODES = ("invalid_request", "source_missing", "source_mismatch", "source_unreadable", "too_many_pages",
         "model_unavailable", "conversion_failed", "conversion_incomplete", "no_result", "stale_generation",
         "extraction_failed", "cancelled")
REASON_CHARS = 2000


class TransientBackendError(RuntimeError):
    """A model or network failure that another attempt may not meet: the one retried class."""


class KeiFailure(Exception):
    """A refusal kei makes itself, reported under `code`. Never retried. Picklable: DBOS records step errors."""

    def __init__(self, code: str, reason: str) -> None:
        super().__init__(code, reason)
        self.code, self.reason = code, reason

    def __str__(self) -> str:
        return f"{self.code}: {self.reason}"


def classify(error: BaseException) -> BaseException:
    """`error` as a `TransientBackendError` when another attempt is worth making, else `error` itself."""
    # Body moved from jobs/tasks.py:61-75 without its `store.Unavailable` branch: a DBOS system-database outage
    # blocks inside DBOS's own retry loop and never reaches a step.
    if isinstance(error, (requests.ConnectionError, requests.Timeout, ConnectionError, TimeoutError)):
        return TransientBackendError(str(error))
    if isinstance(error, requests.HTTPError):
        status = getattr(error.response, "status_code", None)
        return TransientBackendError(str(error)) if status in TRANSIENT_STATUS else error
    if isinstance(error, IncompleteConversionError):
        return error
    if isinstance(error, ConversionError) and any(phrase in str(error).lower() for phrase in TRANSIENT):
        return TransientBackendError(str(error))
    return error


def should_retry(error: BaseException) -> bool:
    """DBOS's retry predicate for `convert_run` and `extract_run`."""
    return isinstance(classify(error), TransientBackendError)


# The keyword arguments of both model steps: three attempts, waiting 5 s then 10 s (Procrastinate's
# RetryStrategy(max_attempts=2, wait=5, linear_wait=5) at jobs/tasks.py:196,250).
STEP_RETRY = {"retries_allowed": True, "max_attempts": 3, "interval_seconds": 5.0, "backoff_rate": 2.0,
              "should_retry": should_retry}


def failure_of(error: BaseException, default: str) -> tuple[str, str]:
    """(code, reason) of a step's final error; `default` names a failure of the step's own work."""
    if isinstance(error, KeiFailure):
        return error.code, error.reason[:REASON_CHARS]
    if isinstance(error, IncompleteConversionError):
        code = "conversion_incomplete"
    elif should_retry(error):
        code = "model_unavailable"
    elif isinstance(error, ValidationError):
        code = "invalid_request"
    else:
        code = default
    reason = str(error) if isinstance(error, (ValueError, ConversionError)) else f"{type(error).__name__}: {error}"
    return code, reason[:REASON_CHARS]
