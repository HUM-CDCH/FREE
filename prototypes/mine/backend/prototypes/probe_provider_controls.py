"""One-shot probe for NuExtract prompt-control channels.

The backend can tell a NuExtract-style runtime what to do in two ways:

* message text: human-readable instructions and extraction template in the user
  message
* chat_template_kwargs: structured kwargs consumed by NuExtract-aware chat
  templates on some OpenAI-compatible servers

This script sends three small requests to the configured OpenAI-compatible
chat/completions endpoint and prints JSONL results plus a recommendation.
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


@dataclass(frozen=True, slots=True)
class ProbeCase:
    name: str
    user_content: list[dict[str, Any]]
    chat_template_kwargs: dict[str, Any] | None
    expected_key: str


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


def build_probe_cases() -> list[ProbeCase]:
    kwargs_template = json.dumps({KWARGS_KEY: "verbatim-string"}, indent=2)
    return [
        ProbeCase(
            name="kwargs_only",
            user_content=[
                text_part(f"Document: The probe value is {DOCUMENT_VALUE}.")
            ],
            chat_template_kwargs={
                "mode": "structured",
                "enable_thinking": False,
                "template": kwargs_template,
            },
            expected_key=KWARGS_KEY,
        ),
        ProbeCase(
            name="message_only",
            user_content=[text_part(extraction_prompt(MESSAGE_KEY))],
            chat_template_kwargs=None,
            expected_key=MESSAGE_KEY,
        ),
        ProbeCase(
            name="conflict",
            user_content=[text_part(extraction_prompt(MESSAGE_KEY))],
            chat_template_kwargs={
                "mode": "structured",
                "enable_thinking": False,
                "template": kwargs_template,
            },
            expected_key=KWARGS_KEY,
        ),
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
    expected_value = parsed.get(case.expected_key) if parsed is not None else None
    has_expected_key = parsed is not None and case.expected_key in parsed
    has_expected_value = expected_value == DOCUMENT_VALUE
    has_message_key = parsed is not None and MESSAGE_KEY in parsed
    has_kwargs_key = parsed is not None and KWARGS_KEY in parsed
    return {
        "parsed_json": parsed,
        "json_keys": keys,
        "has_expected_key": has_expected_key,
        "has_expected_value": has_expected_value,
        "has_message_key": has_message_key,
        "has_kwargs_key": has_kwargs_key,
        "success": has_expected_key and has_expected_value,
    }


async def run_case(
    client: httpx.AsyncClient,
    args: argparse.Namespace,
    case: ProbeCase,
) -> dict[str, Any]:
    payload = build_payload(args, case)
    if args.dry_run:
        return {
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
            "case": case.name,
            "elapsed_ms": elapsed_ms,
            "request": compact_payload(payload),
            "error": f"{type(exc).__name__}: {exc}",
        }

    raw_text = extract_response_text(response_json)
    return {
        "case": case.name,
        "elapsed_ms": elapsed_ms,
        "request": compact_payload(payload),
        "raw_text": raw_text,
        "classification": classify_case(case, raw_text),
    }


def recommend(results: list[dict[str, Any]]) -> dict[str, Any]:
    by_name = {result["case"]: result for result in results}

    def success(name: str) -> bool:
        classification = by_name.get(name, {}).get("classification") or {}
        return bool(classification.get("success"))

    conflict = (by_name.get("conflict", {}).get("classification") or {})
    conflict_kwargs = bool(conflict.get("has_kwargs_key"))
    conflict_message = bool(conflict.get("has_message_key"))

    if success("kwargs_only") and conflict_kwargs and not conflict_message:
        strategy = "kwargs_only"
        reason = "chat_template_kwargs produced the expected key/value and won the conflict probe."
    elif success("message_only") and not success("kwargs_only"):
        strategy = "message_only"
        reason = "message-embedded controls worked, while chat_template_kwargs alone did not."
    elif success("kwargs_only") and success("message_only"):
        strategy = "kwargs_preferred"
        reason = "both single-channel probes worked; prefer kwargs if this deployment is known to use NuExtract chat templates."
    else:
        strategy = "inconclusive"
        reason = "single-channel probes did not produce a clean expected JSON object."

    if conflict_kwargs and conflict_message:
        reason = (
            f"{reason} The conflict probe mixed both keys, so avoid automatic "
            "single-channel selection without inspecting the raw response."
        )
    return {"strategy": strategy, "reason": reason}


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
