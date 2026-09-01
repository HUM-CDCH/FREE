"""Codex-CLI variant of the LLM grounding baseline.

Same prompt, batching, and scoring as llm_baseline; the model is invoked
through the repo's pinned `codex` binary (`codex exec`), i.e. the same
transport the studio's codex-cli provider uses. Reasoning effort is passed
as `-c model_reasoning_effort=<effort>`.

Latency caveat: elapsed time includes codex process startup and the OpenAI
round-trip — not comparable to local-GPU ms/claim numbers.

Usage: uv run python -m grounding_lab.llm_codex dataset gpt-5.6-luna low
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import time
from pathlib import Path

from .llm_baseline import PROMPT, main, parse_links

CODEX = (
    Path(__file__).resolve().parents[2]
    / "studio" / "node_modules" / ".bin"
    / ("codex.CMD" if sys.platform == "win32" else "codex")
)


def codex_ground(effort: str):
    workdir = tempfile.mkdtemp(prefix="grounding-codex-")

    def ground(model: str, batch: list, anchors: list, think: bool) -> tuple[dict, float]:
        # label is "codex/<model-id>@<effort>" — send only the bare model id
        model_id = model.split("@")[0].removeprefix("codex/")
        claim_lines = "\n".join(f"C{i + 1}: {c.value}" for i, c in batch)
        anchor_lines = "\n".join(
            f"[E{i + 1}] {a.scoring_text}" for i, a in enumerate(anchors)
        )
        prompt = PROMPT.format(claims=claim_lines, anchors=anchor_lines)
        out = Path(workdir) / "last_message.txt"
        started = time.perf_counter()
        result = subprocess.run(
            [
                str(CODEX), "exec",
                "--skip-git-repo-check",
                "-s", "read-only",
                "-C", workdir,
                "-m", model_id,
                "-c", f"model_reasoning_effort={effort}",
                "-o", str(out),
                "-",
            ],
            input=prompt.encode("utf-8"),
            capture_output=True,
            timeout=1800,
        )
        elapsed = time.perf_counter() - started
        if result.returncode != 0:
            print(result.stderr.decode("utf-8", "replace")[-400:], file=sys.stderr)
            return {}, elapsed
        content = out.read_text(encoding="utf-8") if out.exists() else ""
        return parse_links(content), elapsed

    return ground


if __name__ == "__main__":
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "dataset")
    model = sys.argv[2] if len(sys.argv) > 2 else "gpt-5.6-luna"
    effort = sys.argv[3] if len(sys.argv) > 3 else "low"
    raise SystemExit(
        main(root, f"codex/{model}@{effort}", ground=codex_ground(effort))
    )
