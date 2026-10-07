"""One text-in, JSON-out chat completion against an OpenAI-compatible vLLM server, and how its reply is read.

A call asks for a reply constrained to a JSON schema through `response_format`, with thinking switched off in the
chat template. Only a refusal that positively says structured output is unsupported is asked once more without it
(the prompt's own "return only the JSON object" then has to do); a malformed schema, an overlong input or any other
refusal surfaces unchanged. The refused attempt is kept on the reply, so the artifact records every call. `finish`
is the server's finish_reason: "length" means the reply was cut off, which the caller treats as a failed call
rather than a short answer. `tokenize_body` is the same request as vLLM's `/tokenize` counts it. A chat `bounded` to a
whitespace limit sends the schema instead as xgrammar's grammar for it admitting at most that much whitespace between
JSON tokens (`bounded_grammar`), never falling back to unconstrained generation; only the version 1 Catalog's
recovery of a record call that looped on whitespace uses it.
"""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field, replace
from typing import Any, Protocol

import requests

from kei_exp.files import load_dotenv

load_dotenv()
EXTRACT_URL = os.environ.get("KEI_EXTRACT_URL", "http://127.0.0.1:8002/v1/chat/completions")
EXTRACT_MODEL = os.environ.get("KEI_EXTRACT_MODEL", "Qwen/Qwen3.8-27B-FP8")
EXTRACT_TIMEOUT = float(os.environ.get("KEI_EXTRACT_TIMEOUT", "1800"))
# The template extractor's server; unset, the deployment has none and every call goes to the instruction model.
NUEXTRACT_URL = os.environ.get("KEI_NUEXTRACT_URL", "")
NUEXTRACT_MODEL = os.environ.get("KEI_NUEXTRACT_MODEL", "numind/NuExtract3-FP8")


class ModelOutputError(ValueError):
    """The model answered, but not with the JSON asked for; the message carries the start of the reply."""


class TemplateError(ValueError):
    """A reply schema a NuExtract template cannot express. NuExtract takes only the fields role, whose schemas are
    built from FREE fields and always expressible; anything else reaching it is an error, not a fallback."""


@dataclass(frozen=True)
class Reply:
    text: str
    input_tokens: int | None
    output_tokens: int | None
    finish: str | None
    seconds: float
    attempts: tuple[str, ...] = ()      # refused earlier attempts of this call, each as the server's words


# A refusal that names structured output as unsupported, in the wordings vLLM and OpenAI-compatible proxies
# use; nothing else earns a second attempt without the schema.
UNSUPPORTED = re.compile(r"(?is)(response_format|json_schema|structured output|guided).{0,80}"
                         r"(not supported|unsupported|not implemented)|(not supported|unsupported|does not support|"
                         r"not implemented).{0,80}(response_format|json_schema|structured output|guided)")


# No thinking: under greedy decoding a thinking model (Qwen3.x) can loop in its reasoning until max_tokens and return
# no answer at all. vLLM passes this to the chat template; the Qwen3.x and NuExtract3 templates honour it.
THINKING_OFF = {"enable_thinking": False}


def _messages(system: str, user: str) -> list[dict]:
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


class Chat(Protocol):
    model: str

    def complete(self, *, system: str, user: str, schema: dict | None, max_tokens: int | None = None) -> Reply: ...


@dataclass
class OpenAIChat:
    url: str = EXTRACT_URL
    model: str = EXTRACT_MODEL
    timeout: float = EXTRACT_TIMEOUT
    headers: dict[str, str] = field(default_factory=dict)
    max_tokens: int = 8192
    max_whitespace: int | None = None   # set: the schema goes as a bounded grammar (`bounded_grammar`)

    def tokenize_body(self, *, system: str, user: str, schema: dict | None = None) -> dict:
        """The body vLLM's /tokenize renders into exactly the prompt `complete` sends (the schema does not enter it)."""
        return {"model": self.model, "add_generation_prompt": True, "messages": _messages(system, user),
                "chat_template_kwargs": dict(THINKING_OFF)}

    def request_body(self, *, system: str, user: str, schema: dict | None, max_tokens: int | None = None) -> dict:
        payload: dict[str, Any] = {
            "model": self.model, "temperature": 0, "max_tokens": max_tokens or self.max_tokens,
            "messages": _messages(system, user), "chat_template_kwargs": dict(THINKING_OFF),
        }
        if schema is None:
            constrained = payload
        elif self.max_whitespace is not None:
            constrained = {**payload, "structured_outputs": {
                "grammar": bounded_grammar(_plain(schema), self.max_whitespace)}}
        else:
            constrained = {**payload, "response_format": {"type": "json_schema", "json_schema": {
                "name": "reply", "schema": _plain(schema), "strict": True}}}
        return constrained

    def complete(self, *, system: str, user: str, schema: dict | None, max_tokens: int | None = None) -> Reply:
        constrained = self.request_body(system=system,user=user,schema=schema,max_tokens=max_tokens)
        payload = {key:value for key,value in constrained.items() if key != "response_format"}
        started = time.monotonic()
        attempts: tuple[str, ...] = ()
        response = requests.post(self.url, json=constrained, headers=self.headers, timeout=self.timeout)
        refusal = getattr(response, "text", "") or ""
        if "response_format" in constrained and response.status_code == 400 and UNSUPPORTED.search(refusal):
            attempts = (f"HTTP 400: {refusal[:300]}",)
            response = requests.post(self.url, json=payload, headers=self.headers, timeout=self.timeout)
        return _reply(response, started, attempts)


def bounded(chat: Chat, max_whitespace: int) -> Chat | None:
    """`chat` sending its schema as a grammar admitting at most `max_whitespace` whitespace characters between JSON
    tokens, or None when it is not exactly an `OpenAIChat` (a subclass may override `complete` and ignore the limit)."""
    return replace(chat, max_whitespace=max_whitespace) if type(chat) is OpenAIChat else None


def bounded_grammar(schema: dict, max_whitespace: int) -> str:
    """xgrammar's EBNF for `schema` admitting at most `max_whitespace` whitespace characters between JSON tokens.
    Imported here: xgrammar imports torch, which the API process and ordinary calls must not load."""
    import xgrammar
    return str(xgrammar.Grammar.from_json_schema(json.dumps(schema), any_whitespace=True,
                                                 max_whitespace_cnt=max_whitespace))


@dataclass
class NuExtractChat:
    """NuExtract3: the reply schema becomes its template and the call's instructions its `instructions`, both in the
    chat template's kwargs; the user message is the source text alone. The June 2026 provider probe found vLLM
    follows message text over conflicting kwargs, so the controls travel in that one channel only. The template
    shapes the reply, so no `response_format` is sent."""
    url: str = NUEXTRACT_URL
    model: str = NUEXTRACT_MODEL
    timeout: float = EXTRACT_TIMEOUT
    headers: dict[str, str] = field(default_factory=dict)
    max_tokens: int = 8192

    def _controls(self, system: str, schema: dict | None) -> dict:
        if schema is None:
            raise TemplateError("NuExtract extracts into a template, and a call without a reply schema has none")
        template = json.dumps(nuextract_template(schema), ensure_ascii=False)
        return {"template": template, "instructions": system, **THINKING_OFF}

    def tokenize_body(self, *, system: str, user: str, schema: dict | None = None) -> dict:
        return {"model": self.model, "add_generation_prompt": True, "messages": [{"role": "user", "content": user}],
                "chat_template_kwargs": self._controls(system, schema)}

    def request_body(self, *, system: str, user: str, schema: dict | None, max_tokens: int | None = None) -> dict:
        payload = {"model": self.model, "temperature": 0, "max_tokens": max_tokens or self.max_tokens,
                   "messages": [{"role": "user", "content": user}],
                   "chat_template_kwargs": self._controls(system, schema)}
        return payload

    def complete(self, *, system: str, user: str, schema: dict | None, max_tokens: int | None = None) -> Reply:
        payload = self.request_body(system=system,user=user,schema=schema,max_tokens=max_tokens)
        started = time.monotonic()
        return _reply(requests.post(self.url, json=payload, headers=self.headers, timeout=self.timeout), started, ())


def _reply(response, started: float, attempts: tuple[str, ...]) -> Reply:
    response.raise_for_status()
    body = response.json()
    choice = body["choices"][0]
    usage = body.get("usage") or {}
    return Reply(text=choice["message"].get("content") or "", input_tokens=usage.get("prompt_tokens"),
                 output_tokens=usage.get("completion_tokens"), finish=choice.get("finish_reason"),
                 seconds=time.monotonic() - started, attempts=attempts)


# The annotations FREE writes into a reply schema (`schema.json_schema`); constrained decoding never sees them.
_FREE_ANNOTATIONS = frozenset({"x-free-type"})


def _plain(schema: Any) -> Any:
    """The schema without FREE's own annotations. A `properties` map's keys are field names, not keywords, so each
    field survives whatever its name and loses only FREE's annotations on its own schema."""
    if isinstance(schema, dict):
        return {key: ({name: _plain(field) for name, field in value.items()} if key == "properties" else _plain(value))
                for key, value in schema.items() if key not in _FREE_ANNOTATIONS}
    if isinstance(schema, list):
        return [_plain(item) for item in schema]
    return schema


def nuextract_template(schema: dict) -> Any:
    """The NuExtract template with the shape of a reply `schema` built by `schema.json_schema` or the grounded
    candidate schema: an object maps its properties, an array wraps its item's template in a list, an enum is the
    list of its values (at least two, else it would read as an array of one type), a scalar is a type name. A
    nullable union collapses: NuExtract returns null (or []) for what the source does not give."""
    if not isinstance(schema, dict):
        raise TemplateError(f"not a schema: {schema!r}")
    if "enum" in schema:
        values = [value for value in schema["enum"] if value is not None]
        if len(values) < 2 or not all(isinstance(value, str) for value in values):
            raise TemplateError(f"a template enum lists two or more strings, not {schema['enum']!r}")
        return values
    kinds = schema.get("type")
    kinds = [kind for kind in ([kinds] if isinstance(kinds, str) else kinds or []) if kind != "null"]
    if len(kinds) != 1:
        raise TemplateError(f"a template field has exactly one type besides null, not {schema.get('type')!r}")
    if kinds[0] == "object":
        return {name: nuextract_template(item) for name, item in (schema.get("properties") or {}).items()}
    if kinds[0] == "array":
        return [nuextract_template(schema.get("items"))]
    if "x-free-type" in schema:
        return _free_leaf(schema["x-free-type"])
    # Unannotated strings are the grounded candidate's quote and key: text copied from the source.
    return {"string": "verbatim-string"}.get(kinds[0], kinds[0])


# FREE scalar types whose NuExtract type has the same name and meaning.
_SAME = {"verbatim-string", "string", "integer", "number", "boolean"}


def _free_leaf(free_type: str) -> str:
    """The NuExtract type a FREE scalar field is extracted as."""
    if free_type in _SAME:
        return free_type
    if free_type == "date":
        # Grounding matches printed dates; it has no ISO-date normalisation.
        return "verbatim-string"
    raise TemplateError(f"FREE field type {free_type!r} has no NuExtract type")


_THINK = re.compile(r"\A\s*<think>.*?</think>\s*", re.DOTALL)
_FENCE = re.compile(r"\A```(?:json)?\s*|\s*```\Z")


def parse_json(text: str) -> Any:
    """Read a reply without rewriting copied source strings.

    Permit literal control characters inside strings (the decoder's sole extension
    to JSON syntax). Tables and native PDF text can contain them. This preserves
    their exact value, like their escaped JSON spelling; malformed structure still
    raises. Never repair missing delimiters or a truncated response.
    """
    cleaned = _FENCE.sub("", _THINK.sub("", text).strip()).strip()
    try:
        return json.loads(cleaned, strict=False)
    except json.JSONDecodeError as error:
        raise ModelOutputError(f"the model did not return JSON ({error}): {text[:500]!r}") from error
