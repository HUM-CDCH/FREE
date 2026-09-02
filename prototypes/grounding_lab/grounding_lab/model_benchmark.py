"""Benchmark pinned retriever/reranker pairs without touching production code.

One invocation loads one retriever and, for reranking, one scorer. This keeps
the 24 GB evaluation GPU predictable and makes every report reproducible.

Usage:
  python -m grounding_lab.model_benchmark dataset --stage retrieval --retriever qwen-0.6b
  python -m grounding_lab.model_benchmark dataset --stage rerank --retriever qwen-0.6b --reranker qwen-0.6b
"""

from __future__ import annotations

import argparse
import importlib.util
import math
import statistics
import threading
import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import numpy as np

from .calibrate import DEFAULT_HELDOUT, ci, decide, evaluate
from .harness import load_dataset
from .pipeline import (
    CROSS_ENCODER_BATCH_SIZE,
    CROSS_ENCODER_MODEL,
    CROSS_ENCODER_REVISION,
    RERANK_INSTRUCTION,
    Claim,
    bounded_contains,
    lexical_match,
    lexical_tier,
    render_claim,
)

K_VALUES = (10, 20, 30, 50)
RERANK_K = 30
CONTAINMENT_CAP = 0.25
INCUMBENT_VALIDATION_WRONG = 7
TASK_INSTRUCTION = RERANK_INSTRUCTION


@dataclass(frozen=True)
class ModelSpec:
    repo: str
    revision: str
    batch_size: int
    research_only: bool = False
    instruction_aware: bool = False
    listwise: bool = False
    trust_remote_code: bool = False
    code_revision: str | None = None
    required_modules: tuple[str, ...] = ()


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
        code_revision="bd55a5ec8e6c0fb1d6c26efb4b6a4a74ce8a88d3",
        required_modules=("einops",),
    ),
}

RERANKERS = {
    "bge": ModelSpec(
        "BAAI/bge-reranker-v2-m3",
        "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e",
        16,
    ),
    "qwen-0.6b": ModelSpec(
        CROSS_ENCODER_MODEL,
        CROSS_ENCODER_REVISION,
        CROSS_ENCODER_BATCH_SIZE,
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


def claim_text(claim: Claim, rendering: str, in_hitset: bool = False) -> str:
    """bare: value only. rich: field + siblings always. rich-hitset: field name
    only when disambiguating inside a verbatim hit set (abstention is not at
    stake there; row context is on the anchor side), bare for the dense path
    where rich context eroded abstention."""
    if rendering == "bare" or (rendering == "rich-hitset" and not in_hitset):
        return str(claim.value)
    if rendering == "rich":
        return render_claim(claim)
    if rendering == "rich-hitset":
        return render_claim(claim, siblings=False)
    raise ValueError(f"unknown claim rendering: {rendering!r}")


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


_DEVICE_PEAK_BYTES = 0


def _reset_peak_vram() -> None:
    global _DEVICE_PEAK_BYTES
    _DEVICE_PEAK_BYTES = 0
    torch = _torch()
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()


def _sample_device_vram(stop: threading.Event) -> None:
    global _DEVICE_PEAK_BYTES
    torch = _torch()
    if not torch.cuda.is_available():
        return
    while not stop.is_set():
        free, total = torch.cuda.mem_get_info()
        _DEVICE_PEAK_BYTES = max(_DEVICE_PEAK_BYTES, total - free)
        stop.wait(0.02)


def _vram_monitor() -> tuple[threading.Event, threading.Thread]:
    stop = threading.Event()
    thread = threading.Thread(target=_sample_device_vram, args=(stop,), daemon=True)
    thread.start()
    return stop, thread


def _vram_lines() -> list[str]:
    torch = _torch()
    if not torch.cuda.is_available():
        return ["Peak device VRAM in use: 0.00 GiB"]
    return [
        f"Peak device VRAM in use: {_DEVICE_PEAK_BYTES / 1024**3:.2f} GiB "
        "(whole-device sample)",
        "Peak PyTorch CUDA reservation: "
        f"{torch.cuda.max_memory_reserved() / 1024**3:.2f} GiB",
    ]


def _model_path(spec: ModelSpec) -> str:
    missing = [
        name
        for name in spec.required_modules
        if importlib.util.find_spec(name) is None
    ]
    if missing:
        raise RuntimeError(
            f"{spec.repo} requires {', '.join(missing)}; the benchmark does not add "
            "optional dependencies beyond peft"
        )
    if not spec.trust_remote_code:
        return spec.repo

    from huggingface_hub import snapshot_download

    # Remote model code may load sibling artifacts by name. Passing the local,
    # exact-revision snapshot keeps those secondary loads pinned as well.
    return snapshot_download(spec.repo, revision=spec.revision)


def _load_retriever(spec: ModelSpec):
    from sentence_transformers import MultiVectorEncoder, SentenceTransformer

    torch = _torch()
    model_path = _model_path(spec)
    model_kwargs = (
        {"dtype": torch.bfloat16}
        if spec.repo != RETRIEVERS["mini"].repo
        else None
    )
    if spec.code_revision:
        model_kwargs = {**(model_kwargs or {}), "code_revision": spec.code_revision}
    is_colbert = spec.repo == RETRIEVERS["jina-colbert"].repo
    encoder = MultiVectorEncoder if is_colbert else SentenceTransformer
    return encoder(
        model_path,
        revision=None if model_path != spec.repo else spec.revision,
        trust_remote_code=spec.trust_remote_code,
        model_kwargs=model_kwargs,
        processor_kwargs={"fix_mistral_regex": True} if is_colbert else None,
    )


def _encode(model, spec: ModelSpec, texts: list[str], *, query: bool):
    if spec.repo == RETRIEVERS["jina-colbert"].repo:
        encode = model.encode_query if query else model.encode_document
        return encode(
            texts,
            batch_size=spec.batch_size,
            show_progress_bar=False,
            convert_to_numpy=False,
            normalize_embeddings=True,
        )
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

        model_path = _model_path(spec)
        model = AutoModel.from_pretrained(
            model_path,
            trust_remote_code=True,
            dtype=torch.bfloat16,
        ).to("cuda" if torch.cuda.is_available() else "cpu")
        # The inspected pinned custom code otherwise loads this tokenizer from
        # an unqualified repo id. Supplying it here keeps every artifact pinned.
        model._tokenizer = AutoTokenizer.from_pretrained(
            model_path,
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
    return [bounded_contains(claim.value, anchor.text) for anchor in anchors]


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


def _candidates(hits, index, retriever, retriever_spec, document_embeddings, text, k, source):
    """Rerank candidates: the lexical hit set when the value is verbatim in
    several anchors (gold is one of them), else the dense shortlist."""
    if source == "hitset" and len(hits) > 1:
        return hits
    query_embeddings = _encode(retriever, retriever_spec, [text], query=True)
    retrieval_scores = _similarities(retriever, query_embeddings, document_embeddings)
    order = retrieval_scores.argsort()[::-1][:k]
    return [index.anchors[int(i)] for i in order]


def _score_entries(
    documents, retriever, retriever_spec, reranker, reranker_spec, rendering, k=RERANK_K,
    candidates="hitset", zero_hit="abstain",
):
    entries = []
    latencies: list[tuple[str, str, float]] = []
    dense = not (candidates == "hitset" and zero_hit == "abstain")
    for doc_name, index, claims in documents:
        # Document embeddings only serve the dense path; hitset + abstain never reaches it.
        document_embeddings = _encode(
            retriever,
            retriever_spec,
            [anchor.scoring_text for anchor in index.anchors],
            query=False,
        ) if dense else None
        for claim in claims:
            started = time.perf_counter()
            decided, hits = lexical_tier(claim, index.anchors)
            if decided is not None and (decided.anchor_id or zero_hit == "abstain"):
                # one hit links; zero hits abstain without a neural pass (only
                # 2/177 lab claims are linkable paraphrases; 0/100 on final set 2)
                tier = "lexical" if decided.anchor_id else "abstain"
                entries.append((doc_name, claim, tier, decided.anchor_id))
                latencies.append((doc_name, "lexical", time.perf_counter() - started))
                continue
            in_hitset = candidates == "hitset" and len(hits) > 1
            text = claim_text(claim, rendering, in_hitset)
            shortlist = _candidates(
                hits, index, retriever, retriever_spec, document_embeddings, text, k, candidates
            )
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
            latencies.append((doc_name, "neural", time.perf_counter() - started))
    return entries, latencies


def choose_thresholds(entries) -> tuple[float, float, dict]:
    """Tune score and auto-accept gates on dev without assuming a score scale."""
    best_scores = [
        float(np.max(payload[1]))
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
            picked, confidence, _ = decide(entry, abstain, CONTAINMENT_CAP)
            if picked is not None:
                confidences.add(confidence)
        accept = 1.0
        metrics = evaluate(entries, abstain, CONTAINMENT_CAP, accept)
        for threshold in sorted(confidences):
            if threshold <= CONTAINMENT_CAP:
                continue  # a capped (non-verbatim) link must never auto-accept
            current = evaluate(entries, abstain, CONTAINMENT_CAP, threshold)
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
    metrics = evaluate(selected, abstain, CONTAINMENT_CAP, accept)
    fallback_linkable = [
        entry for entry in selected
        if entry[2] == "neural" and entry[1].gold_anchor_ids
    ]
    metrics["recall_at_k"] = sum(
        any(
            anchor.anchor_id in entry[1].gold_anchor_ids
            for anchor in entry[3][0]
        )
        for entry in fallback_linkable
    )
    metrics["recall_total"] = len(fallback_linkable)
    timings = [
        seconds
        for name, tier, seconds in latencies
        if name in names and tier == "neural"
    ]
    metrics["median_ms"] = 1000 * (statistics.median(timings) if timings else 0)
    return metrics


def cv_folds(names, folds: int) -> list[list[str]]:
    """Deterministic document-level folds: sorted names dealt round-robin."""
    ordered = sorted(names)
    return [ordered[i::folds] for i in range(folds)]


def cv_evaluate(entries, latencies, folds):
    """Per fold: tune thresholds on the other folds, evaluate on the fold.
    Returns (per-fold rows, pooled counts summed over folds)."""
    rows = []
    pooled: dict = {}
    for fold in folds:
        held = set(fold)
        train = [entry for entry in entries if entry[0] not in held]
        abstain, accept, _ = choose_thresholds(train)
        metrics = _evaluation_metrics(entries, held, abstain, accept, latencies)
        rows.append((fold, abstain, accept, metrics))
        for key, value in metrics.items():
            if key != "median_ms":
                pooled[key] = pooled.get(key, 0) + value
    timings = [seconds for _, tier, seconds in latencies if tier == "neural"]
    pooled["median_ms"] = 1000 * (statistics.median(timings) if timings else 0)
    return rows, pooled


def _metrics_cells(metrics) -> str:
    total = metrics["linkable"] + metrics["abstains_due"]
    return (
        f"{metrics['recall_at_k']}/{metrics['recall_total']} | "
        f"{metrics['total_correct']}/{total} | "
        f"{metrics['correct_links']}/{metrics['linkable']} | "
        f"{metrics['correct_abstains']}/{metrics['abstains_due']} | "
        f"{metrics['wrong']} | {metrics['auto_correct']}/{metrics['auto']} | "
        f"{ci(metrics['total_correct'], total)} | "
        f"{ci(metrics['auto_correct'], metrics['auto'])} | "
        f"{metrics['median_ms']:.0f}"
    )


def _candidate_labels(args) -> tuple[str, str]:
    if args.candidates == "retrieval":
        return f"top-{args.k} retrieval", f"recall@{args.k}"
    if args.zero_hit == "abstain":
        return "all lexical hits", "hit-set recall"
    return f"all lexical hits; zero-hit top-{args.k} retrieval", "candidate recall"


def cv_report(args, documents, entries, latencies, retriever_loaded) -> str:
    folds = cv_folds([name for name, _, _ in documents], args.cv)
    rows, pooled = cv_evaluate(entries, latencies, folds)
    candidate_scope, recall_label = _candidate_labels(args)
    lines = [
        f"# Neural model benchmark — {args.cv}-fold cross-validation",
        "",
        f"Generated {date.today().isoformat()} by `grounding_lab.model_benchmark`.",
        "",
        *_model_lines(args.retriever, args.reranker, retriever_loaded),
        f"- claim mode: `{args.claim_mode}`",
        f"- candidates: `{args.candidates}`",
        f"- zero-hit claims: `{args.zero_hit}`",
        f"- candidate scope: {candidate_scope}",
        f"- containment cap: {CONTAINMENT_CAP}",
        f"- documents: {len(documents)} from {', '.join(f'`{root}`' for root in args.root)}",
        "",
        f"| fold | documents | abstain | accept | {recall_label} | correct decisions | correct links | correct abstains | wrong links | auto precision | total 95% CI | auto 95% CI | median neural ms |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for i, (fold, abstain, accept, metrics) in enumerate(rows, 1):
        lines.append(
            f"| {i} | {', '.join(fold)} | {_fmt_threshold(abstain)} | {accept:.4f} | "
            + _metrics_cells(metrics) + " |"
        )
    lines.append(f"| **pooled** | all | — | — | " + _metrics_cells(pooled) + " |")
    lines += ["", "## Document results (thresholds from the document's own fold)", "",
              "| document | fold | correct decisions | wrong links |", "|---|---:|---:|---:|"]
    for i, (fold, abstain, accept, _) in enumerate(rows, 1):
        for name in fold:
            metrics = _evaluation_metrics(entries, {name}, abstain, accept, latencies)
            total = metrics["linkable"] + metrics["abstains_due"]
            lines.append(f"| {name} | {i} | {metrics['total_correct']}/{total} | {metrics['wrong']} |")
    lines += ["", *_vram_lines(),
              "Each fold's thresholds were selected on the other folds only; pooled counts sum the held-out folds."]
    return "\n".join(lines) + "\n"


def _fmt_threshold(value: float) -> str:
    return "-∞" if value == -math.inf else f"{value:.6f}"


def _model_lines(retriever_key: str, reranker_key: str | None = None, retriever_loaded: bool = True) -> list[str]:
    retriever = RETRIEVERS[retriever_key]
    lines = [
        f"- retriever: `{retriever_key}` — `{retriever.repo}@{retriever.revision}`"
        + ("" if retriever_loaded else " (not loaded: hit-set candidates with zero-hit abstain never retrieve)")
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
        *_vram_lines(),
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
        args.k,
        args.candidates,
        args.zero_hit,
    )
    if args.cv is not None:
        return cv_report(args, documents, entries, latencies, retriever is not None)
    if args.abstain_threshold is not None:
        abstain, accept = args.abstain_threshold, args.accept_threshold
        requested = (
            [args.split]
            if args.split != "all"
            else ["dev", "validation", "all"]
        )
        dev_metrics = None
    else:
        dev_names = split_names(documents, "dev")
        dev_entries = [entry for entry in entries if entry[0] in dev_names]
        if not dev_entries:
            raise ValueError("no development documents available for calibration")
        abstain, accept, dev_metrics = choose_thresholds(dev_entries)
        requested = [args.split] if args.split != "all" else ["dev", "validation", "all"]

    candidate_scope, recall_label = _candidate_labels(args)
    lines = [
        "# Neural model benchmark — reranking",
        "",
        f"Generated {date.today().isoformat()} by `grounding_lab.model_benchmark`.",
        "",
        *_model_lines(args.retriever, args.reranker, retriever is not None),
        f"- claim mode: `{args.claim_mode}`",
        f"- candidates: `{args.candidates}`",
        f"- zero-hit claims: `{args.zero_hit}`",
        f"- candidate scope: {candidate_scope}",
        f"- abstain threshold: {_fmt_threshold(abstain)}",
        f"- containment cap: {CONTAINMENT_CAP}",
        f"- auto-accept threshold: {accept:.6f}",
        "",
        f"| split | {recall_label} | correct decisions | correct links | correct abstains | wrong links | auto precision | total 95% CI | auto 95% CI | median neural ms |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    metrics_by_split = {}
    for split in requested:
        names = split_names(documents, split)
        metrics = _evaluation_metrics(entries, names, abstain, accept, latencies)
        metrics_by_split[split] = metrics
        total = metrics["linkable"] + metrics["abstains_due"]
        lines.append(
            f"| {split} | {metrics['recall_at_k']}/{metrics['recall_total']} | "
            f"{metrics['total_correct']}/{total} | "
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
            "Validation wrong-link gate: "
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
    lines += ["", *_vram_lines()]
    if dev_metrics is not None:
        lines.append(
            "Thresholds were selected from development documents only; validation was not used for calibration."
        )
    else:
        lines.append(
            "Thresholds were supplied explicitly; this run performed no calibration."
        )
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="*", default=[Path("dataset")], type=Path)
    parser.add_argument("--stage", choices=("retrieval", "rerank"), required=True)
    parser.add_argument("--retriever", choices=tuple(RETRIEVERS), required=True)
    parser.add_argument("--reranker", choices=tuple(RERANKERS))
    parser.add_argument(
        "--claim-mode", choices=("bare", "rich", "rich-hitset"), default="rich-hitset",
        help="rich-hitset: field-name rendering only inside the lexical hit set (needs --candidates hitset)",
    )
    parser.add_argument(
        "--candidates", choices=("retrieval", "hitset"), default="hitset",
        help="hitset: rerank inside the lexical multi-hit set instead of the dense top-K",
    )
    parser.add_argument(
        "--zero-hit", choices=("neural", "abstain"), default="abstain",
        help="abstain: a value verbatim in no anchor abstains without a neural pass",
    )
    parser.add_argument(
        "--split", choices=("dev", "validation", "all", "final"), default="all"
    )
    parser.add_argument("--abstain-threshold", type=float)
    parser.add_argument("--accept-threshold", type=float)
    parser.add_argument("--k", type=int, default=RERANK_K)
    parser.add_argument(
        "--cv", type=int, metavar="FOLDS",
        help="document-level k-fold cross-validation: thresholds are tuned on the other folds",
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    if args.stage == "rerank" and not args.reranker:
        parser.error("--reranker is required for --stage rerank")
    if args.stage == "retrieval" and args.reranker:
        parser.error("--reranker is only valid for --stage rerank")
    if args.k < 1:
        parser.error("--k must be positive")
    if args.claim_mode == "rich-hitset" and args.candidates != "hitset":
        parser.error("--claim-mode rich-hitset requires --candidates hitset")
    if (args.abstain_threshold is None) != (args.accept_threshold is None):
        parser.error(
            "--abstain-threshold and --accept-threshold must be supplied together"
        )
    if args.split == "final" and args.abstain_threshold is None:
        parser.error("--split final requires frozen abstain and accept thresholds")

    documents = [doc for root in args.root for doc in load_dataset(root)]
    if not documents:
        parser.error(f"no documents with anchors.json + claims.json under {args.root}")
    if len({name for name, _, _ in documents}) != len(documents):
        parser.error("duplicate document names across roots")
    if args.cv is not None and (args.cv < 2 or args.cv > len(documents)):
        parser.error("--cv needs between 2 and the number of documents")
    if args.cv is not None and args.abstain_threshold is not None:
        parser.error("--cv tunes thresholds per fold; do not pass thresholds")
    if args.split in {"dev", "validation"}:
        missing = set(DEFAULT_HELDOUT) - {name for name, _, _ in documents}
        if missing:
            parser.error(f"split requires missing documents: {sorted(missing)}")

    _reset_peak_vram()
    stop, monitor = _vram_monitor()
    try:
        retriever_spec = RETRIEVERS[args.retriever]
        needs_retriever = args.stage == "retrieval" or not (
            args.candidates == "hitset" and args.zero_hit == "abstain"
        )
        retriever = None
        if needs_retriever:
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
    finally:
        stop.set()
        monitor.join()

    if args.output:
        args.output.write_text(report, encoding="utf-8")
    print(report, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
