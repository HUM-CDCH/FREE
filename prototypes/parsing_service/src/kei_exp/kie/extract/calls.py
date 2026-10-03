"""Extraction call execution: one model call from a finished request to its JSON answer and its artifact diagnostics.

`complete` is the one seam every extraction model call goes through — Article inventory, Catalog discovery,
document and record values, grounding, and the recipe Catalog's entry and arbitration calls. Its callers own
everything purpose-specific: the source they render, the prompt and reply schema, what the answer means,
conformance to the schema, reconciliation and grounding, and cancellation checks, which they make before calling.
This module owns only what every call shares:

- routing: a `models.Router` sends the call to the chat serving its stage's role (`models.ROLE`);
- served-context admission: with a counter, the request is counted on the serving endpoint first, and one that does
  not fit beside its output allowance is a failed call that is never sent;
- invocation through the chat adapter (`llm.OpenAIChat`, `llm.NuExtractChat`), whose protocol, output-format
  fallback and HTTP request are its own;
- reading the reply: a cut-off reply (`finish_reason` length) or text `llm.parse_json` cannot read is a failed call
  and a null answer, never repaired; a counted request whose served prompt count differs is a failed call too;
- accounting: every attempt, in order, as a `Call`, the artifact's record of a model call. A failed call's `error`
  may quote the start of the server's refusal or of the unreadable reply; it never carries the request.

It makes no retries of its own; the adapter's single output-format fallback is its only second attempt. The version 1
Catalog's one recovery of a record call that looped on whitespace (`looped`) is its caller's (`catalog.py`), made as a
second `complete`.

Each call is also a trace span (Phoenix, docs/operations/local-development.md) under the extraction's DBOS step, with
its model, tokens, outcome and refused attempts; each request it sends is a child span when the worker instruments
`requests`. The prompt, the raw reply and the parsed answer are recorded only when FREE_TRACE_CAPTURE lists
`prompts`, `responses` or `parsed`. Without a tracer provider the span is a no-op.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any

from opentelemetry import trace
from opentelemetry.trace import Span, StatusCode

from kei_exp.kie.extract.llm import Chat, ModelOutputError, parse_json
from kei_exp.kie.extract.models import Router
from kei_exp.kie.extract.tokens import BudgetUnavailable, TokenCounter


@dataclass(frozen=True)
class Call:
    """One model call as the artifact reports it."""
    stage: str                          # a `models.ROLE` stage, or the recipe Catalog's tokenizer_probe
    record: int | None
    input_tokens: int | None
    output_tokens: int | None
    seconds: float
    finish: str | None
    ok: bool
    error: str | None = None
    counted_input_tokens: int | None = None
    context_tokens: int | None = None
    max_output_tokens: int | None = None
    recovered: bool = False             # a failed call whose one recovery call was read: it cost tokens, lost no value


_TRACER = trace.get_tracer("kei")
WHITESPACE_LOOP = "the reply ran into a whitespace loop"
CAPTURE = set(os.environ.get("FREE_TRACE_CAPTURE", "").split(","))


def _cut_off(text: str) -> str:
    """A reply the server cut at max_tokens: a whitespace loop when at least half of it is trailing whitespace (constrained
    decoding admits unlimited whitespace between JSON tokens, and a looping model spends the whole allowance on it)."""
    trailing = len(text) - len(text.rstrip())
    if text and trailing * 2 >= len(text):
        return (f"{WHITESPACE_LOOP} ({trailing} of {len(text)} characters trailing whitespace; "
                "finish_reason length)")
    return "the reply was cut off (finish_reason length)"


def looped(call: Call) -> bool:
    """Whether `call` failed on a whitespace loop."""
    return not call.ok and (call.error or "").startswith(WHITESPACE_LOOP)


def complete(chat: Chat | Router, *, stage: str, record: int | None, system: str, user: str, schema: dict,
             max_tokens: int | None = None, counter: TokenCounter | None = None) -> tuple[Any, list[Call]]:
    """One call, read as JSON; a truncated or unreadable reply is a failed call and a null answer. The calls are the
    attempts in order, the last one the call whose reply this is: a refused earlier attempt is a failed call too.
    A router sends the call to the model serving the stage's role."""
    if isinstance(chat, Router):
        chat = chat.for_stage(stage)
    # Errors can quote source text or a provider's credentials. Capture only their type, including exceptions the
    # OTel context manager would otherwise record automatically; raw model replies have their own capture below.
    with _TRACER.start_as_current_span(stage, attributes={"openinference.span.kind": "LLM",
                                                           "llm.model_name": chat.model},
                                       record_exception=False, set_status_on_exception=False) as span:
        try:
            if "prompts" in CAPTURE:
                span.set_attributes({"input.value": json.dumps({"system": system, "user": user}, ensure_ascii=False),
                                     "input.mime_type": "application/json"})
            parsed, calls = _complete(chat, stage, record, system, user, schema, max_tokens, counter, span)
            _trace(span, parsed, calls)
            return parsed, calls
        except Exception as error:
            span.add_event("exception", {"exception.type": type(error).__name__})
            span.set_status(StatusCode.ERROR)
            raise


def _trace(span: Span, parsed: Any, calls: list[Call]) -> None:
    last = calls[-1]
    for attempt, _ in enumerate(calls[:-1], start=1):
        span.add_event("refused attempt", {"attempt": attempt})
    span.set_attributes({key: value for key, value in {
        "llm.token_count.prompt": last.input_tokens, "llm.token_count.completion": last.output_tokens,
        "free.record": last.record}.items() if value is not None})
    if not last.ok:
        span.set_status(StatusCode.ERROR)
    if parsed is not None and "parsed" in CAPTURE:
        span.set_attributes({"output.value": json.dumps(parsed, ensure_ascii=False),
                             "output.mime_type": "application/json"})


def structure(backend, *, record: int, text: str, schema: dict, identity: dict,
              counted: int, context: int) -> tuple[dict, Call]:
    """A native encoder call: no generated reply budget, JSON repair or value conversion."""
    with _TRACER.start_as_current_span("entry", attributes={"openinference.span.kind": "LLM",
                                                           "llm.model_name": backend.model},
                                       record_exception=False, set_status_on_exception=False) as span:
        try:
            if counted > context:
                raise ValueError("native fields request exceeds the served input context")
            if "prompts" in CAPTURE:
                span.set_attributes({"input.value": json.dumps({"text": text, "schema": schema}, ensure_ascii=False),
                                     "input.mime_type": "application/json"})
            started = time.monotonic()
            reply = backend.structure(text, schema, identity)
            if reply.get("input_tokens") != counted:
                raise ValueError("native fields tokenizer and inference counts disagree")
            call = Call("entry", record, counted, 0, time.monotonic() - started, None, True,
                        counted_input_tokens=counted, context_tokens=context, max_output_tokens=0)
            if "responses" in CAPTURE:
                span.set_attribute("llm.output_messages.0.message.content", json.dumps(reply, ensure_ascii=False))
            _trace(span, reply, [call])
            return reply, call
        except Exception as error:
            span.add_event("exception", {"exception.type": type(error).__name__})
            span.set_status(StatusCode.ERROR)
            raise


def _complete(chat: Chat, stage: str, record: int | None, system: str, user: str, schema: dict, max_tokens: int | None,
              counter: TokenCounter | None, span: Span) -> tuple[Any, list[Call]]:
    counted = None
    if counter is not None:
        assert max_tokens is not None
        counted = counter.request_tokens(system, user, schema)
        context = counter.context_tokens
        if type(context) is not int or context <= 0:
            raise BudgetUnavailable("Article requires the serving endpoint's context size")
        if counted + max_tokens > context:
            return None, [Call(stage, record, None, None, 0.0, None, False,
                f"{counted} input + {max_tokens} output tokens exceed the served context {context}; "
                "complete source was not sent", counted, context, max_tokens)]
    try:
        reply = chat.complete(system=system, user=user, schema=schema, max_tokens=max_tokens)
    except ModelOutputError as error:  # a fake or a client that already judged the reply
        return None, [Call(stage, record, None, None, 0.0, None, False, str(error),
                           counted, counter.context_tokens if counter else None, max_tokens)]
    if "responses" in CAPTURE:
        span.set_attributes({"llm.output_messages.0.message.role": "assistant",
                             "llm.output_messages.0.message.content": reply.text})
    refused = [Call(stage, record, None, None, 0.0, None, False, attempt) for attempt in reply.attempts]
    parsed = None
    error = None
    if reply.finish == "length":
        error = _cut_off(reply.text)
    else:
        try:
            parsed = parse_json(reply.text)
        except ModelOutputError as exc:
            error = str(exc)
    if error is None and counted is not None and reply.input_tokens != counted:
        error = f"counted {counted} input tokens but the server reported {reply.input_tokens}"
    return parsed, [*refused, Call(stage, record, reply.input_tokens, reply.output_tokens, reply.seconds,
        reply.finish, error is None, error, counted, counter.context_tokens if counter else None, max_tokens)]
