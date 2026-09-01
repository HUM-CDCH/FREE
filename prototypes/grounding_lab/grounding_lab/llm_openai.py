"""OpenAI-compatible-endpoint variant of the LLM grounding baseline.

Same prompt, batching, and scoring as llm_baseline; the model is served by
any OpenAI-compatible /chat/completions endpoint (Docker Model Runner,
vLLM, llama.cpp server, ...).

Usage: uv run python -m grounding_lab.llm_openai dataset <model> [base-url]
       (default base-url: Docker Model Runner, http://localhost:12434/engines/v1)
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

from .llm_baseline import PROMPT, main, parse_links

DEFAULT_BASE = "http://localhost:12434/engines/v1"


def openai_ground(base_url: str):
    endpoint = base_url.rstrip("/") + "/chat/completions"

    def ground(model: str, batch: list, anchors: list, think: bool) -> tuple[dict, float]:
        claim_lines = "\n".join(f"C{i + 1}: {c.value}" for i, c in batch)
        anchor_lines = "\n".join(
            f"[E{i + 1}] {a.scoring_text}" for i, a in enumerate(anchors)
        )
        body = json.dumps({
            "model": model,
            "messages": [{
                "role": "user",
                "content": PROMPT.format(claims=claim_lines, anchors=anchor_lines),
            }],
            "temperature": 0,
            "response_format": {"type": "json_object"},
        }).encode()
        started = time.perf_counter()
        request = urllib.request.Request(
            endpoint, body, {"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(request, timeout=3600) as response:
            content = json.load(response)["choices"][0]["message"]["content"]
        elapsed = time.perf_counter() - started
        return parse_links(content), elapsed

    return ground


if __name__ == "__main__":
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "dataset")
    model = sys.argv[2] if len(sys.argv) > 2 else "hf.co/ai9stars/G9v3-39A5B"
    base = sys.argv[3] if len(sys.argv) > 3 else DEFAULT_BASE
    raise SystemExit(main(root, model, ground=openai_ground(base)))
