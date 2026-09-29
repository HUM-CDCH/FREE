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

It makes no retries of its own; the adapter's single output-format fallback is the only second attempt.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

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


def complete(chat: Chat | Router, *, stage: str, record: int | None, system: str, user: str, schema: dict,
             max_tokens: int | None = None, counter: TokenCounter | None = None) -> tuple[Any, list[Call]]:
    """One call, read as JSON; a truncated or unreadable reply is a failed call and a null answer. The calls are the
    attempts in order, the last one the call whose reply this is: a refused earlier attempt is a failed call too.
    A router sends the call to the model serving the stage's role."""
    if isinstance(chat, Router):
        chat = chat.for_stage(stage)
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
    refused = [Call(stage, record, None, None, 0.0, None, False, attempt) for attempt in reply.attempts]
    parsed = None
    error = None
    if reply.finish == "length":
        error = "the reply was cut off (finish_reason length)"
    else:
        try:
            parsed = parse_json(reply.text)
        except ModelOutputError as exc:
            error = str(exc)
    if error is None and counted is not None and reply.input_tokens != counted:
        error = f"counted {counted} input tokens but the server reported {reply.input_tokens}"
    return parsed, [*refused, Call(stage, record, reply.input_tokens, reply.output_tokens, reply.seconds,
        reply.finish, error is None, error, counted, counter.context_tokens if counter else None, max_tokens)]
