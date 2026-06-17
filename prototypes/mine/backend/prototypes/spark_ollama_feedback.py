"""PROTOTYPE: sweep NuExtract3 settings against a Spark-hosted Ollama API.

This is intentionally throwaway code for agent feedback loops. It uses the
native ollama-python client, prints one JSON result per trial, and keeps all
state in memory.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[4]


def load_parsing_helpers() -> tuple[Any, Any]:
    parsing_path = BACKEND_ROOT / "shared" / "parsing.py"
    spec = importlib.util.spec_from_file_location("backend_parsing", parsing_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {parsing_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.extract_answer_block, module.parse_result


extract_answer_block, parse_result = load_parsing_helpers()


@dataclass
class SourceInput:
    prompt_text: str
    images: list[bytes]
    summary: dict[str, Any]


DEFAULT_HOST = "http://spark.cdch-dgxspark.lan.ku.dk:11434"
DEFAULT_MODEL = "hf.co/numind/NuExtract3-GGUF:Q4_K_M"
DEFAULT_SOURCE = (
    "On 2026-06-16, Ada bought two field notebooks and a USB cable at "
    "North Archive Supplies for EUR 34.50. The receipt lists card payment."
)
DEFAULT_TEMPLATE = {
    "store": "verbatim-string",
    "date": "date",
    "total": "number",
    "currency": "currency",
    "payment_method": "verbatim-string",
    "items": [
        {
            "name": "verbatim-string",
            "quantity": "integer",
        }
    ],
}

OPTION_KEYS = {
    "temperature",
    "top_k",
    "top_p",
    "num_ctx",
    "num_predict",
    "repeat_last_n",
    "repeat_penalty",
    "presence_penalty",
    "frequency_penalty",
    "seed",
    "stop",
    "mirostat",
    "mirostat_tau",
    "mirostat_eta",
}


def parse_json_value(value: str, label: str) -> Any:
    try:
        return json.loads(value)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON for {label}: {exc}") from exc


def resolve_existing_path(value: str | None) -> Path | None:
    if value is None:
        return None
    raw_path = Path(value)
    candidates = [
        raw_path,
        BACKEND_ROOT / raw_path,
        REPO_ROOT / raw_path,
    ]
    for path in candidates:
        try:
            if path.exists():
                return path.resolve()
        except OSError:
            continue
    return None


def read_text_arg(value: str | None, fallback: str) -> str:
    if value is None:
        return fallback
    path = resolve_existing_path(value)
    if path is not None:
        return path.read_text(encoding="utf-8")
    return value


def render_pdf_pages(path: Path, max_pages: int, dpi: int) -> list[bytes]:
    try:
        import io

        import pypdfium2 as pdfium
    except ImportError as exc:
        raise SystemExit("Missing PDF dependency: install `pypdfium2`.") from exc

    pdf = pdfium.PdfDocument(path)
    try:
        total_pages = len(pdf)
        page_count = total_pages if max_pages <= 0 else min(max_pages, total_pages)
        pages: list[bytes] = []
        for page_number in range(page_count):
            image = pdf[page_number].render(scale=dpi / 72).to_pil()
            buffer = io.BytesIO()
            image.convert("RGB").save(buffer, format="JPEG", quality=95)
            pages.append(buffer.getvalue())
        return pages
    finally:
        pdf.close()


def load_source_arg(value: str | None, pdf_pages: int, pdf_dpi: int) -> SourceInput:
    path = resolve_existing_path(value)
    if path is None:
        source = value or DEFAULT_SOURCE
        return SourceInput(
            prompt_text=source,
            images=[],
            summary={"kind": "text", "characters": len(source)},
        )

    suffix = path.suffix.lower()
    if suffix == ".pdf":
        images = render_pdf_pages(path, pdf_pages, pdf_dpi)
        return SourceInput(
            prompt_text=f"Attached PDF page images from {path.name}.",
            images=images,
            summary={
                "kind": "pdf",
                "path": str(path),
                "pages_sent": len(images),
                "image_bytes": [len(image) for image in images],
                "dpi": pdf_dpi,
            },
        )
    if suffix in {".jpg", ".jpeg", ".png", ".webp"}:
        image = path.read_bytes()
        return SourceInput(
            prompt_text=f"Attached image from {path.name}.",
            images=[image],
            summary={
                "kind": "image",
                "path": str(path),
                "image_bytes": [len(image)],
            },
        )

    text = path.read_text(encoding="utf-8")
    return SourceInput(
        prompt_text=text,
        images=[],
        summary={"kind": "text_file", "path": str(path), "characters": len(text)},
    )


def read_template_arg(value: str | None) -> dict[str, Any]:
    if value is None:
        return DEFAULT_TEMPLATE
    raw = read_text_arg(value, "{}")
    parsed = parse_json_value(raw, "--template")
    if not isinstance(parsed, dict):
        raise SystemExit("--template must be a JSON object or a path to one")
    return parsed


def default_trials() -> list[dict[str, Any]]:
    return [
        {
            "name": "baseline-fast",
            "mode": "structured",
            "enable_thinking": False,
            "temperature": 0.2,
            "num_ctx": 4096,
            "num_predict": 1024,
            "format": "json",
        },
        {
            "name": "reasoning-medium",
            "mode": "structured",
            "enable_thinking": True,
            "temperature": 0.6,
            "num_ctx": 8192,
            "num_predict": 2048,
            "think": "medium",
        },
    ]


def load_trials(values: list[str]) -> list[dict[str, Any]]:
    if not values:
        return default_trials()
    trials: list[dict[str, Any]] = []
    for index, value in enumerate(values, start=1):
        parsed = parse_json_value(read_text_arg(value, value), "--config")
        if isinstance(parsed, list):
            trial_values = parsed
        else:
            trial_values = [parsed]
        for trial in trial_values:
            if not isinstance(trial, dict):
                raise SystemExit("--config entries must be JSON objects")
            trial.setdefault("name", f"trial-{index}")
            trials.append(trial)
    return trials


def build_prompt(source: SourceInput, template: dict[str, Any], trial: dict[str, Any]) -> str:
    mode = trial.get("mode", "structured")
    instructions = trial.get(
        "instructions",
        "Extract source-grounded information. Return only valid JSON matching "
        "the extraction template. Use each top-level key exactly once.",
    )
    parts = [
        f"Mode: {mode}",
        f"enable_thinking: {bool(trial.get('enable_thinking', False))}",
        "",
        "Instructions:",
        instructions,
        "",
        "Extraction template:",
        json.dumps(template, indent=2, ensure_ascii=False),
        "",
        "Input:",
        source.prompt_text,
    ]
    return "\n".join(parts)


def build_message(
    source: SourceInput, template: dict[str, Any], trial: dict[str, Any]
) -> dict[str, Any]:
    message: dict[str, Any] = {
        "role": "user",
        "content": build_prompt(source, template, trial),
    }
    if source.images:
        message["images"] = source.images
    return message


def summarize_message(message: dict[str, Any]) -> dict[str, Any]:
    if "images" not in message:
        return message
    return {
        **message,
        "images": [f"<{len(image)} bytes>" for image in message["images"]],
    }


def split_chat_args(trial: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    options = {key: trial[key] for key in OPTION_KEYS if key in trial}
    think = trial.get("think", "medium" if trial.get("enable_thinking") else False)
    chat_args: dict[str, Any] = {"think": think}
    if "format" in trial:
        chat_args["format"] = trial["format"]
    if "keep_alive" in trial:
        chat_args["keep_alive"] = trial["keep_alive"]
    return options, chat_args


def parse_output(raw_text: str) -> Any:
    answer = extract_answer_block(raw_text)
    duplicate_keys: list[str] = []

    def reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        seen: set[str] = set()
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in seen:
                duplicate_keys.append(key)
            seen.add(key)
            result[key] = value
        return result

    try:
        parsed = json.loads(answer, object_pairs_hook=reject_duplicate_keys)
    except Exception:
        return parse_result(answer)
    if duplicate_keys:
        return {
            "parse_warning": "duplicate_json_keys",
            "duplicate_keys": sorted(set(duplicate_keys)),
            "best_effort": parsed,
        }
    return parsed
    return parse_result(answer)


def dry_run_result(
    args: argparse.Namespace,
    source: SourceInput,
    template: dict[str, Any],
    trial: dict[str, Any],
) -> dict[str, Any]:
    options, chat_args = split_chat_args(trial)
    message = build_message(source, template, trial)
    return {
        "trial": trial.get("name"),
        "host": args.host,
        "model": args.model,
        "source": source.summary,
        "request": {
            "messages": [summarize_message(message)],
            "options": options,
            **chat_args,
        },
    }


def run_trial(
    client: Any,
    args: argparse.Namespace,
    source: SourceInput,
    template: dict[str, Any],
    trial: dict[str, Any],
) -> dict[str, Any]:
    options, chat_args = split_chat_args(trial)
    started = time.perf_counter()
    message = build_message(source, template, trial)
    request = {
        "model": args.model,
        "messages": [message],
        "options": options,
        **chat_args,
    }
    try:
        response = client.chat(**request)
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        raw_text = response.message.content or ""
        thinking = getattr(response.message, "thinking", None)
        return {
            "trial": trial.get("name"),
            "elapsed_ms": elapsed_ms,
            "source": source.summary,
            "request": {
                "host": args.host,
                "model": args.model,
                "options": options,
                **chat_args,
            },
            "thinking": thinking,
            "raw_text": raw_text,
            "parsed": parse_output(raw_text),
        }
    except Exception as exc:
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        return {
            "trial": trial.get("name"),
            "elapsed_ms": elapsed_ms,
            "source": source.summary,
            "request": {
                "host": args.host,
                "model": args.model,
                "options": options,
                **chat_args,
            },
            "error": f"{type(exc).__name__}: {exc}",
        }


def write_result(handle: Any, result: dict[str, Any], pretty: bool) -> None:
    indent = 2 if pretty else None
    handle.write(json.dumps(result, ensure_ascii=False, indent=indent))
    handle.write("\n")
    handle.flush()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="PROTOTYPE: try NuExtract3 settings through ollama-python."
    )
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument(
        "--source",
        help="Inline source text, or path to text/image/PDF. Relative paths "
        "are checked from the current directory, backend root, and repo root.",
    )
    parser.add_argument("--template", help="Inline JSON template or path to JSON.")
    parser.add_argument(
        "--config",
        action="append",
        default=[],
        help="Trial JSON object/list, or a path to one. May be repeated.",
    )
    parser.add_argument(
        "--pdf-pages",
        type=int,
        default=0,
        help="First N PDF pages to send. 0 means all pages.",
    )
    parser.add_argument("--pdf-dpi", type=int, default=64)
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--pretty", action="store_true")
    parser.add_argument("--output", help="Write JSON results to this file.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    source = load_source_arg(args.source, args.pdf_pages, args.pdf_dpi)
    template = read_template_arg(args.template)
    trials = load_trials(args.config)

    output_handle = (
        Path(args.output).open("w", encoding="utf-8") if args.output else sys.stdout
    )
    try:
        if args.dry_run:
            for trial in trials:
                write_result(
                    output_handle,
                    dry_run_result(args, source, template, trial),
                    args.pretty,
                )
            return 0

        try:
            from ollama import Client
        except ImportError as exc:
            raise SystemExit(
                "Missing dependency: install with `uv run --with ollama ...` "
                "or `pip install ollama`."
            ) from exc

        client = Client(host=args.host, timeout=args.timeout)
        for trial in trials:
            write_result(
                output_handle,
                run_trial(client, args, source, template, trial),
                args.pretty,
            )
    finally:
        if output_handle is not sys.stdout:
            output_handle.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
