"""One-shot probe for NuExtract prompt-control channels.

The backend can tell a NuExtract-style runtime what to do in two ways:

* message text: human-readable instructions and extraction template in the user
  message
* chat_template_kwargs: structured kwargs consumed by NuExtract-aware chat
  templates on some OpenAI-compatible servers

This script sends message-only, kwargs-only, and conflict requests for the
NuExtract workflows FREE uses, then prints JSONL results plus recommendations.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from config import settings
from model_providers import model_headers


DOCUMENT_VALUE = "CONTROL_VALUE_7391"
MESSAGE_KEY = "message_probe_channel"
KWARGS_KEY = "kwargs_probe_channel"
MESSAGE_MARKER = "MESSAGE_CHANNEL_MARKER"
KWARGS_MARKER = "KWARGS_CHANNEL_MARKER"


@dataclass(frozen=True, slots=True)
class ProbeCase:
    workflow: str
    name: str
    user_content: list[dict[str, Any]]
    chat_template_kwargs: dict[str, Any] | None
    expected_key: str | None
    expected_marker: str


def normalize_base_url(provider: str, base_url: str) -> str:
    normalized = base_url.rstrip("/")
    if provider == "ollama" and not normalized.endswith("/v1"):
        return f"{normalized}/v1"
    return normalized


def chat_completions_url(provider: str, base_url: str) -> str:
    return f"{normalize_base_url(provider, base_url)}/chat/completions"


def text_part(text: str) -> dict[str, Any]:
    return {"type": "text", "text": text}


def extraction_prompt(key: str) -> str:
    template = json.dumps({key: "verbatim-string"}, indent=2)
    return "\n".join(
        [
            "Extract the requested source-grounded value.",
            "Return only valid JSON matching the extraction template.",
            "",
            "Extraction template:",
            f"```json\n{template}\n```",
            "",
            "Document:",
            f"The probe value is {DOCUMENT_VALUE}.",
        ]
    )


def content_prompt(marker: str) -> str:
    return "\n".join(
        [
            "Extract source-grounded information from the supplied document.",
            f"Return the exact answer inside <answer>{marker}</answer>.",
            "",
            "Document:",
            f"The probe value is {DOCUMENT_VALUE}.",
        ]
    )


def schema_suggestion_prompt(field_name: str) -> str:
    return "\n".join(
        [
            "Generate an extraction template for this document.",
            f"Include a field named {field_name}.",
            "",
            "Document:",
            f"The probe value is {DOCUMENT_VALUE}.",
        ]
    )


def markdown_prompt(marker: str) -> str:
    return "\n".join(
        [
            "Convert the supplied document to markdown.",
            f"Include the heading '# {marker}'.",
            "",
            "Document:",
            f"The probe value is {DOCUMENT_VALUE}.",
        ]
    )


def source_content() -> list[dict[str, Any]]:
    return [text_part(f"Document: The probe value is {DOCUMENT_VALUE}.")]


def structured_cases() -> list[ProbeCase]:
    kwargs_template = json.dumps({KWARGS_KEY: "verbatim-string"}, indent=2)
    return [
        ProbeCase(
            workflow="structured",
            name="kwargs_only",
            user_content=source_content(),
            chat_template_kwargs={
                "mode": "structured",
                "enable_thinking": False,
                "template": kwargs_template,
            },
            expected_key=KWARGS_KEY,
            expected_marker=DOCUMENT_VALUE,
        ),
        ProbeCase(
            workflow="structured",
            name="message_only",
            user_content=[text_part(extraction_prompt(MESSAGE_KEY))],
            chat_template_kwargs=None,
            expected_key=MESSAGE_KEY,
            expected_marker=DOCUMENT_VALUE,
        ),
        ProbeCase(
            workflow="structured",
            name="conflict",
            user_content=[text_part(extraction_prompt(MESSAGE_KEY))],
            chat_template_kwargs={
                "mode": "structured",
                "enable_thinking": False,
                "template": kwargs_template,
            },
            expected_key=KWARGS_KEY,
            expected_marker=DOCUMENT_VALUE,
        ),
    ]


def content_cases() -> list[ProbeCase]:
    return [
        ProbeCase(
            workflow="content",
            name="kwargs_only",
            user_content=source_content(),
            chat_template_kwargs={
                "mode": "content",
                "enable_thinking": False,
                "instructions": f"Return exactly <answer>{KWARGS_MARKER}</answer>.",
            },
            expected_key=None,
            expected_marker=KWARGS_MARKER,
        ),
        ProbeCase(
            workflow="content",
            name="message_only",
            user_content=[text_part(content_prompt(MESSAGE_MARKER))],
            chat_template_kwargs=None,
            expected_key=None,
            expected_marker=MESSAGE_MARKER,
        ),
        ProbeCase(
            workflow="content",
            name="conflict",
            user_content=[text_part(content_prompt(MESSAGE_MARKER))],
            chat_template_kwargs={
                "mode": "content",
                "enable_thinking": False,
                "instructions": f"Return exactly <answer>{KWARGS_MARKER}</answer>.",
            },
            expected_key=None,
            expected_marker=KWARGS_MARKER,
        ),
    ]


def schema_suggestion_cases() -> list[ProbeCase]:
    return [
        ProbeCase(
            workflow="schema_suggestion",
            name="kwargs_only",
            user_content=[text_part(schema_suggestion_prompt(KWARGS_KEY))],
            chat_template_kwargs={
                "mode": "template-generation",
                "enable_thinking": False,
            },
            expected_key=KWARGS_KEY,
            expected_marker=KWARGS_KEY,
        ),
        ProbeCase(
            workflow="schema_suggestion",
            name="message_only",
            user_content=[text_part(schema_suggestion_prompt(MESSAGE_KEY))],
            chat_template_kwargs=None,
            expected_key=MESSAGE_KEY,
            expected_marker=MESSAGE_KEY,
        ),
        ProbeCase(
            workflow="schema_suggestion",
            name="conflict",
            user_content=[text_part(schema_suggestion_prompt(MESSAGE_KEY))],
            chat_template_kwargs={
                "mode": "template-generation",
                "enable_thinking": False,
            },
            expected_key=MESSAGE_KEY,
            expected_marker=MESSAGE_KEY,
        ),
    ]


def markdown_cases() -> list[ProbeCase]:
    return [
        ProbeCase(
            workflow="markdown",
            name="kwargs_only",
            user_content=source_content(),
            chat_template_kwargs={
                "mode": "markdown",
                "enable_thinking": False,
                "instructions": f"Include the heading '# {KWARGS_MARKER}'.",
            },
            expected_key=None,
            expected_marker=KWARGS_MARKER,
        ),
        ProbeCase(
            workflow="markdown",
            name="message_only",
            user_content=[text_part(markdown_prompt(MESSAGE_MARKER))],
            chat_template_kwargs=None,
            expected_key=None,
            expected_marker=MESSAGE_MARKER,
        ),
        ProbeCase(
            workflow="markdown",
            name="conflict",
            user_content=[text_part(markdown_prompt(MESSAGE_MARKER))],
            chat_template_kwargs={
                "mode": "markdown",
                "enable_thinking": False,
                "instructions": f"Include the heading '# {KWARGS_MARKER}'.",
            },
            expected_key=None,
            expected_marker=KWARGS_MARKER,
        ),
    ]


def build_probe_cases() -> list[ProbeCase]:
    return [
        *structured_cases(),
        *content_cases(),
        *schema_suggestion_cases(),
        *markdown_cases(),
    ]


def build_payload(args: argparse.Namespace, case: ProbeCase) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": args.model,
        "temperature": args.temperature,
        "max_tokens": args.max_tokens,
        "stream": False,
        "messages": [
            {"role": "system", "content": args.system_prompt},
            {"role": "user", "content": case.user_content},
        ],
    }
    if case.chat_template_kwargs is not None:
        payload["chat_template_kwargs"] = case.chat_template_kwargs
    return payload


def compact_payload(payload: dict[str, Any]) -> dict[str, Any]:
    compact = dict(payload)
    compact["messages"] = [
        {
            "role": message["role"],
            "content": message["content"]
            if message["role"] == "system"
            else summarize_content(message["content"]),
        }
        for message in payload["messages"]
    ]
    return compact


def summarize_content(content: Any) -> Any:
    if not isinstance(content, list):
        return content
    summary = []
    for part in content:
        if not isinstance(part, dict) or part.get("type") != "text":
            summary.append(part)
            continue
        text = part.get("text", "")
        if len(text) > 360:
            text = f"{text[:360]}..."
        summary.append({"type": "text", "text": text})
    return summary


def extract_response_text(response_json: dict[str, Any]) -> str:
    choices = response_json.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, list):
        return "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    return content or ""


def strip_fence(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    lines = stripped.splitlines()
    if len(lines) >= 3 and lines[-1].strip() == "```":
        return "\n".join(lines[1:-1]).strip()
    return stripped


def parse_json_object(text: str) -> dict[str, Any] | None:
    candidate = strip_fence(text)
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            parsed = json.loads(candidate[start : end + 1])
        except json.JSONDecodeError:
            return None
    return parsed if isinstance(parsed, dict) else None


def classify_case(case: ProbeCase, raw_text: str) -> dict[str, Any]:
    parsed = parse_json_object(raw_text)
    keys = sorted(parsed) if parsed is not None else []
    expected_value = (
        parsed.get(case.expected_key)
        if parsed is not None and case.expected_key is not None
        else None
    )
    has_expected_key = (
        parsed is not None
        and case.expected_key is not None
        and case.expected_key in parsed
    )
    has_expected_value = expected_value in {DOCUMENT_VALUE, "verbatim-string", "string"}
    has_message_key = parsed is not None and MESSAGE_KEY in parsed
    has_kwargs_key = parsed is not None and KWARGS_KEY in parsed
    has_expected_marker = case.expected_marker in raw_text
    has_message_marker = MESSAGE_MARKER in raw_text
    has_kwargs_marker = KWARGS_MARKER in raw_text
    return {
        "parsed_json": parsed,
        "json_keys": keys,
        "has_expected_key": has_expected_key,
        "has_expected_value": has_expected_value,
        "has_expected_marker": has_expected_marker,
        "has_message_key": has_message_key,
        "has_kwargs_key": has_kwargs_key,
        "has_message_marker": has_message_marker,
        "has_kwargs_marker": has_kwargs_marker,
        "success": (
            has_expected_key and (has_expected_value or has_expected_marker)
            if case.expected_key is not None
            else has_expected_marker
        ),
    }


async def run_case(
    client: httpx.AsyncClient,
    args: argparse.Namespace,
    case: ProbeCase,
) -> dict[str, Any]:
    payload = build_payload(args, case)
    if args.dry_run:
        return {
            "workflow": case.workflow,
            "case": case.name,
            "url": args.url,
            "request": compact_payload(payload),
        }

    started = time.perf_counter()
    try:
        response = await client.post(
            args.url,
            json=payload,
            headers=model_headers(args.api_key),
        )
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        response.raise_for_status()
        response_json = response.json()
    except Exception as exc:
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        return {
            "workflow": case.workflow,
            "case": case.name,
            "elapsed_ms": elapsed_ms,
            "request": compact_payload(payload),
            "error": f"{type(exc).__name__}: {exc}",
        }

    raw_text = extract_response_text(response_json)
    return {
        "workflow": case.workflow,
        "case": case.name,
        "elapsed_ms": elapsed_ms,
        "request": compact_payload(payload),
        "raw_text": raw_text,
        "classification": classify_case(case, raw_text),
    }


def recommend_workflow(workflow: str, results: list[dict[str, Any]]) -> dict[str, Any]:
    by_name = {result["case"]: result for result in results}

    def success(name: str) -> bool:
        classification = by_name.get(name, {}).get("classification") or {}
        return bool(classification.get("success"))

    conflict = (by_name.get("conflict", {}).get("classification") or {})
    conflict_kwargs = bool(
        conflict.get("has_kwargs_key") or conflict.get("has_kwargs_marker")
    )
    conflict_message = bool(
        conflict.get("has_message_key") or conflict.get("has_message_marker")
    )

    kwargs_ok = success("kwargs_only")
    message_ok = success("message_only")

    if kwargs_ok and message_ok:
        strategy = "both_single_channel"
        if conflict_kwargs and not conflict_message:
            reason = "both single-channel probes worked; the conflict probe followed chat_template_kwargs."
        elif conflict_message and not conflict_kwargs:
            reason = "both single-channel probes worked; the conflict probe followed message-embedded controls."
        else:
            reason = "both single-channel probes worked; the conflict probe did not show a single clear precedence."
    elif kwargs_ok and conflict_kwargs and not conflict_message:
        strategy = "kwargs_only"
        reason = "chat_template_kwargs produced the expected key/value and won the conflict probe."
    elif message_ok and conflict_message and not conflict_kwargs:
        strategy = "message_only"
        reason = "message-embedded controls produced the expected key/value and won the conflict probe."
    elif message_ok and not kwargs_ok:
        strategy = "message_only"
        reason = "message-embedded controls worked, while chat_template_kwargs alone did not."
    elif kwargs_ok and not message_ok:
        strategy = "kwargs_only"
        reason = "chat_template_kwargs worked, while message-embedded controls alone did not."
    else:
        strategy = "inconclusive"
        reason = "single-channel probes did not produce a clean expected JSON object."

    if conflict_kwargs and conflict_message:
        reason = (
            f"{reason} The conflict probe mixed both keys, so avoid automatic "
            "single-channel selection without inspecting the raw response."
        )
    return {"workflow": workflow, "strategy": strategy, "reason": reason}


def recommend(results: list[dict[str, Any]]) -> dict[str, Any]:
    workflows = sorted({result["workflow"] for result in results})
    return {
        "workflow_recommendations": [
            recommend_workflow(
                workflow,
                [result for result in results if result["workflow"] == workflow],
            )
            for workflow in workflows
        ]
    }


def write_json(value: dict[str, Any], pretty: bool) -> None:
    indent = 2 if pretty else None
    print(json.dumps(value, ensure_ascii=False, indent=indent), flush=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="One-shot NuExtract provider prompt-control probe."
    )
    parser.add_argument("--provider", default=settings.provider)
    parser.add_argument("--base-url", default=settings.base_url)
    parser.add_argument("--model", default=settings.model)
    parser.add_argument("--api-key", default=settings.api_key)
    parser.add_argument("--timeout", type=float, default=settings.timeout_seconds)
    parser.add_argument("--temperature", type=float, default=0.0)
    parser.add_argument("--max-tokens", type=int, default=512)
    parser.add_argument("--system-prompt", default=settings.system_prompt)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--pretty", action="store_true")
    return parser


async def async_main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    args.url = chat_completions_url(args.provider, args.base_url)

    write_json(
        {
            "event": "start",
            "provider": args.provider,
            "base_url": args.base_url,
            "url": args.url,
            "model": args.model,
            "dry_run": args.dry_run,
        },
        args.pretty,
    )

    cases = build_probe_cases()
    async with httpx.AsyncClient(timeout=args.timeout) as client:
        results = []
        for case in cases:
            result = await run_case(client, args, case)
            results.append(result)
            write_json(result, args.pretty)

    write_json({"event": "recommendation", **recommend(results)}, args.pretty)
    return 0


def main() -> int:
    try:
        return asyncio.run(async_main())
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
