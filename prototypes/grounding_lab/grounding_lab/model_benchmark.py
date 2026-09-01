"""Benchmark pinned retriever/reranker pairs without touching production code.

One invocation loads one retriever and, for reranking, one scorer. This keeps
the 24 GB evaluation GPU predictable and makes every report reproducible.

Usage:
  python -m grounding_lab.model_benchmark dataset --stage retrieval --retriever qwen-0.6b
  python -m grounding_lab.model_benchmark dataset --stage rerank --retriever qwen-0.6b --reranker qwen-0.6b
"""

from __future__ import annotations

import argparse
import math
import re
import statistics
import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import numpy as np

from .calibrate import DEFAULT_HELDOUT, ci, decide, evaluate
from .harness import load_dataset
from .pipeline import Claim, lexical_match, normalize, render_claim

K_VALUES = (10, 20, 30, 50)
RERANK_K = 30
CONTAINMENT_CAP = 0.25
INCUMBENT_VALIDATION_WRONG = 7
TASK_INSTRUCTION = (
    "Judge whether the candidate passage directly supports the extracted scalar. "
    "Near-variant names, identifiers, dates, units, and numbers are not evidence."
)


@dataclass(frozen=True)
class ModelSpec:
    repo: str
    revision: str
    batch_size: int
    research_only: bool = False
    instruction_aware: bool = False
    listwise: bool = False
    trust_remote_code: bool = False


RETRIEVERS = {
    "mini": ModelSpec(
        "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
        "e8f8c211226b894fcb81acc59f3b34ba3efd5f42",
        32,
    ),
    "qwen-0.6b": ModelSpec(
        "Qwen/Qwen3-Embedding-0.6B",
        "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3",
        16,
        instruction_aware=True,
    ),
    "qwen-4b": ModelSpec(
        "Qwen/Qwen3-Embedding-4B",
        "5cf2132abc99cad020ac570b19d031efec650f2b",
        4,
        instruction_aware=True,
    ),
    "qwen-8b": ModelSpec(
        "Qwen/Qwen3-Embedding-8B",
        "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af",
        1,
        instruction_aware=True,
    ),
    "jina-v5": ModelSpec(
        "jinaai/jina-embeddings-v5-text-small-retrieval",
        "6856e76bb72982e58de0620458a4e8b3614da340",
        16,
        research_only=True,
        instruction_aware=True,
    ),
    "jina-colbert": ModelSpec(
        "jinaai/jina-colbert-v2",
        "a9dc5cd7293d4c71dbbba04829923ba4d0e4f6ea",
        8,
        research_only=True,
        trust_remote_code=True,
    ),
}

RERANKERS = {
    "bge": ModelSpec(
        "BAAI/bge-reranker-v2-m3",
        "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e",
        16,
    ),
    "qwen-0.6b": ModelSpec(
        "Qwen/Qwen3-Reranker-0.6B",
        "e61197ed45024b0ed8a2d74b80b4d909f1255473",
        16,
        instruction_aware=True,
    ),
    "qwen-4b": ModelSpec(
        "Qwen/Qwen3-Reranker-4B",
        "22e683669bc0f0bd69640a1354a6d0aebcfeede5",
        4,
        instruction_aware=True,
    ),
    "qwen-8b": ModelSpec(
        "Qwen/Qwen3-Reranker-8B",
        "77d193c791ed757ca307ee72715aa132723da912",
        1,
        instruction_aware=True,
    ),
    "jina-v3.5": ModelSpec(
        "jinaai/jina-reranker-v3.5",
        "e8a93f33f0b22108f8c2364f8484ce3422552fbc",
        1,
        research_only=True,
        instruction_aware=True,
        listwise=True,
        trust_remote_code=True,
    ),
}


def claim_text(claim: Claim, mode: str) -> str:
    if mode == "bare":
        return str(claim.value)
    if mode == "rich":
        return render_claim(claim)
    raise ValueError(f"unknown claim mode: {mode!r}")


def scores_from_ranking(ranking: list[dict], count: int) -> np.ndarray:
    """Restore listwise results to candidate order and reject malformed output."""
    scores = np.full(count, -math.inf)
    seen: set[int] = set()
    for result in ranking:
        index = result.get("index")
        if not isinstance(index, (int, np.integer)) or not 0 <= int(index) < count:
            raise ValueError(f"invalid reranker index: {index!r}")
        index = int(index)
        if index in seen:
            raise ValueError(f"duplicate reranker index: {index}")
        seen.add(index)
        scores[index] = float(result["relevance_score"])
    if len(seen) != count:
        raise ValueError(f"reranker returned {len(seen)} of {count} candidates")
    return scores


def split_names(documents, split: str) -> set[str]:
    names = {name for name, _, _ in documents}
    validation = names & set(DEFAULT_HELDOUT)
    if split == "dev":
        return names - validation
    if split == "validation":
        return validation
    if split in {"all", "final"}:
        return names
    raise ValueError(f"unknown split: {split!r}")


def _torch():
    import torch

    return torch


def _reset_peak_vram() -> None:
    torch = _torch()
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()


def _peak_vram_gib() -> float:
    torch = _torch()
    if not torch.cuda.is_available():
        return 0.0
    return torch.cuda.max_memory_allocated() / 1024**3


def _load_retriever(spec: ModelSpec):
    from sentence_transformers import SentenceTransformer

    torch = _torch()
    model_kwargs = {"dtype": torch.bfloat16} if spec.repo != RETRIEVERS["mini"].repo else None
    return SentenceTransformer(
        spec.repo,
        revision=spec.revision,
        trust_remote_code=spec.trust_remote_code,
        model_kwargs=model_kwargs,
    )


def _encode(model, spec: ModelSpec, texts: list[str], *, query: bool):
    prompt = None
    if spec.instruction_aware:
        prompt = (
            TASK_INSTRUCTION + "\nExtracted scalar: "
            if query
            else ("Document: " if spec.repo.startswith("jinaai/jina-embeddings") else None)
        )
    return model.encode(
        texts,
        prompt=prompt,
        batch_size=spec.batch_size,
        show_progress_bar=False,
        convert_to_tensor=True,
        normalize_embeddings=True,
    )


def _similarities(model, query_embeddings, document_embeddings) -> np.ndarray:
    scores = model.similarity(query_embeddings, document_embeddings)[0]
    if hasattr(scores, "detach"):
        scores = scores.detach().float().cpu().numpy()
    return np.asarray(scores).reshape(-1)


def _load_reranker(spec: ModelSpec):
    torch = _torch()
    if spec.listwise:
        from transformers import AutoModel, AutoTokenizer

        model = AutoModel.from_pretrained(
            spec.repo,
            revision=spec.revision,
            trust_remote_code=True,
            dtype=torch.bfloat16,
        ).to("cuda" if torch.cuda.is_available() else "cpu")
        # The inspected pinned custom code otherwise loads this tokenizer from
        # an unqualified repo id. Supplying it here keeps every artifact pinned.
        model._tokenizer = AutoTokenizer.from_pretrained(
            spec.repo,
            revision=spec.revision,
        )
        model.eval()
        return model

    from sentence_transformers import CrossEncoder

    prompts = {"evidence": TASK_INSTRUCTION} if spec.instruction_aware else None
    return CrossEncoder(
        spec.repo,
        revision=spec.revision,
        prompts=prompts,
        default_prompt_name="evidence" if prompts else None,
        model_kwargs={"dtype": torch.bfloat16} if spec.instruction_aware else None,
    )


def _rerank_scores(model, spec: ModelSpec, query: str, documents: list[str]) -> np.ndarray:
    if spec.listwise:
        prompted = f"{TASK_INSTRUCTION}\nExtracted scalar: {query}"
        return scores_from_ranking(model.rerank(prompted, documents), len(documents))
    scores = model.predict(
        [(query, document) for document in documents],
        batch_size=spec.batch_size,
        show_progress_bar=False,
    )
    return np.asarray(scores).reshape(-1)


def _verbatim_flags(claim: Claim, anchors) -> list[bool]:
    if isinstance(claim.value, bool):
        return [False] * len(anchors)
    needle = normalize(str(claim.value))
    bounded = re.compile(rf"(?<!\w){re.escape(needle)}(?!\w)")
    return [bool(bounded.search(normalize(anchor.text))) for anchor in anchors]


def _warm_retriever(model, spec: ModelSpec) -> None:
    documents = _encode(model, spec, ["Evidence passage."], query=False)
    query = _encode(model, spec, ["evidence"], query=True)
    _similarities(model, query, documents)


def _warm_reranker(model, spec: ModelSpec) -> None:
    _rerank_scores(model, spec, "evidence", ["Evidence passage.", "Unrelated text."])


def _retrieval_rows(documents, model, spec: ModelSpec, mode: str):
    rows = []
    index_seconds: dict[str, float] = {}
    for doc_name, index, claims in documents:
        started = time.perf_counter()
        document_embeddings = _encode(
            model, spec, [anchor.scoring_text for anchor in index.anchors], query=False
        )
        index_seconds[doc_name] = time.perf_counter() - started
        for claim in claims:
            if lexical_match(claim, index.anchors) is not None:
                continue
            started = time.perf_counter()
            query_embeddings = _encode(
                model, spec, [claim_text(claim, mode)], query=True
            )
            scores = _similarities(model, query_embeddings, document_embeddings)
            order = scores.argsort()[::-1]
            elapsed = time.perf_counter() - started
            rank = next(
                (
                    i + 1
                    for i, anchor_index in enumerate(order)
                    if index.anchors[int(anchor_index)].anchor_id in claim.gold_anchor_ids
                ),
                None,
            )
            rows.append((doc_name, claim, rank, elapsed))
    return rows, index_seconds


def _retrieval_metrics(rows, names: set[str]) -> dict:
    selected = [row for row in rows if row[0] in names]
    linkable = [row for row in selected if row[1].gold_anchor_ids]
    return {
        "fallback": len(selected),
        "linkable": len(linkable),
        "recall": {
            k: sum(row[2] is not None and row[2] <= k for row in linkable)
            for k in K_VALUES
        },
        "median_ms": 1000 * (
            statistics.median(row[3] for row in selected) if selected else 0
        ),
    }


def _score_entries(documents, retriever, retriever_spec, reranker, reranker_spec, mode):
    entries = []
    latencies: list[tuple[str, float]] = []
    for doc_name, index, claims in documents:
        document_embeddings = _encode(
            retriever,
            retriever_spec,
            [anchor.scoring_text for anchor in index.anchors],
            query=False,
        )
        for claim in claims:
            started = time.perf_counter()
            lexical = lexical_match(claim, index.anchors)
            if lexical is not None:
                entries.append((doc_name, claim, "lexical", lexical.anchor_id))
                latencies.append((doc_name, time.perf_counter() - started))
                continue
            text = claim_text(claim, mode)
            query_embeddings = _encode(retriever, retriever_spec, [text], query=True)
            retrieval_scores = _similarities(
                retriever, query_embeddings, document_embeddings
            )
            order = retrieval_scores.argsort()[::-1][:RERANK_K]
            shortlist = [index.anchors[int(i)] for i in order]
            scores = _rerank_scores(
                reranker,
                reranker_spec,
                text,
                [anchor.scoring_text for anchor in shortlist],
            )
            entries.append(
                (
                    doc_name,
                    claim,
                    "neural",
                    (shortlist, scores, _verbatim_flags(claim, shortlist)),
                )
            )
            latencies.append((doc_name, time.perf_counter() - started))
    return entries, latencies


def choose_thresholds(entries) -> tuple[float, float, dict]:
    """Tune score and auto-accept gates on dev without assuming a score scale."""
    best_scores = [
        float(np.max(payload[1][:RERANK_K]))
        for _, _, tier, payload in entries
        if tier == "neural"
    ]
    abstain_candidates = [-math.inf] + sorted(
        {math.nextafter(score, math.inf) for score in best_scores}
    )
    candidates = []
    for abstain in abstain_candidates:
        confidences = {1.0}
        for entry in entries:
            if entry[2] != "neural":
                continue
            picked, confidence, _ = decide(
                entry, RERANK_K, abstain, CONTAINMENT_CAP
            )
            if picked is not None:
                confidences.add(confidence)
        accept = 1.0
        metrics = evaluate(
            entries, RERANK_K, abstain, CONTAINMENT_CAP, accept
        )
        for threshold in sorted(confidences):
            current = evaluate(
                entries, RERANK_K, abstain, CONTAINMENT_CAP, threshold
            )
            if current["auto"] == current["auto_correct"]:
                accept, metrics = threshold, current
                break
        rank = (
            metrics["total_correct"],
            -metrics["wrong"],
            metrics["correct_links"],
            metrics["auto"],
        )
        candidates.append((rank, abstain, accept, metrics))
    _, abstain, accept, metrics = max(candidates, key=lambda candidate: candidate[0])
    return abstain, accept, metrics


def _evaluation_metrics(entries, names, abstain, accept, latencies):
    selected = [entry for entry in entries if entry[0] in names]
    metrics = evaluate(
        selected, RERANK_K, abstain, CONTAINMENT_CAP, accept
    )
    timings = [seconds for name, seconds in latencies if name in names]
    metrics["median_ms"] = 1000 * (statistics.median(timings) if timings else 0)
    return metrics


def _fmt_threshold(value: float) -> str:
    return "-∞" if value == -math.inf else f"{value:.6f}"


def _model_lines(retriever_key: str, reranker_key: str | None = None) -> list[str]:
    retriever = RETRIEVERS[retriever_key]
    lines = [
        f"- retriever: `{retriever_key}` — `{retriever.repo}@{retriever.revision}`"
    ]
    if reranker_key:
        reranker = RERANKERS[reranker_key]
        lines.append(
            f"- reranker: `{reranker_key}` — `{reranker.repo}@{reranker.revision}`"
        )
    if retriever.research_only or (
        reranker_key and RERANKERS[reranker_key].research_only
    ):
        lines.append("- eligibility: research-only (non-commercial model license)")
    return lines


def retrieval_report(args, documents, model, spec) -> str:
    rows, index_seconds = _retrieval_rows(documents, model, spec, args.claim_mode)
    requested = [args.split] if args.split != "all" else ["dev", "validation", "all"]
    lines = [
        "# Neural model benchmark — retrieval",
        "",
        f"Generated {date.today().isoformat()} by `grounding_lab.model_benchmark`.",
        "",
        *_model_lines(args.retriever),
        f"- claim mode: `{args.claim_mode}`",
        "",
        "| split | fallback claims | linkable | recall@10 | recall@20 | recall@30 | recall@50 | median query ms |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for split in requested:
        names = split_names(documents, split)
        metrics = _retrieval_metrics(rows, names)
        recalls = [
            f"{metrics['recall'][k]}/{metrics['linkable']}" for k in K_VALUES
        ]
        lines.append(
            f"| {split} | {metrics['fallback']} | {metrics['linkable']} | "
            + " | ".join(recalls)
            + f" | {metrics['median_ms']:.0f} |"
        )
    selected_names = split_names(documents, args.split)
    indexing = sum(
        seconds for name, seconds in index_seconds.items() if name in selected_names
    )
    lines += [
        "",
        f"Indexing seconds for requested split: {indexing:.1f}",
        f"Peak CUDA allocation: {_peak_vram_gib():.2f} GiB",
    ]
    return "\n".join(lines) + "\n"


def rerank_report(args, documents, retriever, retriever_spec, reranker, reranker_spec):
    entries, latencies = _score_entries(
        documents,
        retriever,
        retriever_spec,
        reranker,
        reranker_spec,
        args.claim_mode,
    )
    if args.split == "final":
        if args.abstain_threshold is None or args.accept_threshold is None:
            raise ValueError(
                "final evaluation requires --abstain-threshold and --accept-threshold"
            )
        abstain, accept = args.abstain_threshold, args.accept_threshold
        requested = ["final"]
        dev_metrics = None
    else:
        dev_names = split_names(documents, "dev")
        dev_entries = [entry for entry in entries if entry[0] in dev_names]
        if not dev_entries:
            raise ValueError("no development documents available for calibration")
        abstain, accept, dev_metrics = choose_thresholds(dev_entries)
        requested = [args.split] if args.split != "all" else ["dev", "validation", "all"]

    lines = [
        "# Neural model benchmark — reranking",
        "",
        f"Generated {date.today().isoformat()} by `grounding_lab.model_benchmark`.",
        "",
        *_model_lines(args.retriever, args.reranker),
        f"- claim mode: `{args.claim_mode}`",
        f"- K: {RERANK_K}",
        f"- abstain threshold: {_fmt_threshold(abstain)}",
        f"- containment cap: {CONTAINMENT_CAP}",
        f"- auto-accept threshold: {accept:.6f}",
        "",
        "| split | correct decisions | correct links | correct abstains | wrong links | auto precision | total 95% CI | auto 95% CI | median ms/claim |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    metrics_by_split = {}
    for split in requested:
        names = split_names(documents, split)
        metrics = _evaluation_metrics(entries, names, abstain, accept, latencies)
        metrics_by_split[split] = metrics
        total = metrics["linkable"] + metrics["abstains_due"]
        lines.append(
            f"| {split} | {metrics['total_correct']}/{total} | "
            f"{metrics['correct_links']}/{metrics['linkable']} | "
            f"{metrics['correct_abstains']}/{metrics['abstains_due']} | "
            f"{metrics['wrong']} | {metrics['auto_correct']}/{metrics['auto']} | "
            f"{ci(metrics['total_correct'], total)} | "
            f"{ci(metrics['auto_correct'], metrics['auto'])} | "
            f"{metrics['median_ms']:.0f} |"
        )
    if "validation" in metrics_by_split:
        validation = metrics_by_split["validation"]
        lines += [
            "",
            "Production-candidate gate: "
            + (
                "PASS"
                if validation["wrong"] <= INCUMBENT_VALIDATION_WRONG
                else "FAIL (more than 7 validation wrong links)"
            ),
        ]
    lines += ["", "## Requested-split document results", ""]
    lines += [
        "| document | correct decisions | wrong links |",
        "|---|---:|---:|",
    ]
    for name in sorted(split_names(documents, args.split)):
        metrics = _evaluation_metrics(entries, {name}, abstain, accept, latencies)
        total = metrics["linkable"] + metrics["abstains_due"]
        lines.append(
            f"| {name} | {metrics['total_correct']}/{total} | {metrics['wrong']} |"
        )
    lines += ["", f"Peak CUDA allocation: {_peak_vram_gib():.2f} GiB"]
    if dev_metrics is not None:
        lines.append(
            "Thresholds were selected from development documents only; validation was not used for calibration."
        )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default="dataset", type=Path)
    parser.add_argument("--stage", choices=("retrieval", "rerank"), required=True)
    parser.add_argument("--retriever", choices=tuple(RETRIEVERS), required=True)
    parser.add_argument("--reranker", choices=tuple(RERANKERS))
    parser.add_argument("--claim-mode", choices=("bare", "rich"), default="bare")
    parser.add_argument(
        "--split", choices=("dev", "validation", "all", "final"), default="all"
    )
    parser.add_argument("--abstain-threshold", type=float)
    parser.add_argument("--accept-threshold", type=float)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    if args.stage == "rerank" and not args.reranker:
        parser.error("--reranker is required for --stage rerank")
    if args.stage == "retrieval" and args.reranker:
        parser.error("--reranker is only valid for --stage rerank")

    documents = load_dataset(args.root)
    if not documents:
        parser.error(f"no documents with anchors.json + claims.json under {args.root}")
    if args.split in {"dev", "validation"}:
        missing = set(DEFAULT_HELDOUT) - {name for name, _, _ in documents}
        if missing:
            parser.error(f"split requires missing documents: {sorted(missing)}")

    _reset_peak_vram()
    retriever_spec = RETRIEVERS[args.retriever]
    retriever = _load_retriever(retriever_spec)
    _warm_retriever(retriever, retriever_spec)
    if args.stage == "retrieval":
        report = retrieval_report(args, documents, retriever, retriever_spec)
    else:
        reranker_spec = RERANKERS[args.reranker]
        reranker = _load_reranker(reranker_spec)
        _warm_reranker(reranker, reranker_spec)
        report = rerank_report(
            args, documents, retriever, retriever_spec, reranker, reranker_spec
        )

    if args.output:
        args.output.write_text(report, encoding="utf-8")
    print(report, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
