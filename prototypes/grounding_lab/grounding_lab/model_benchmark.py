"""Benchmark pinned retriever/scorer pairs without touching production code.

One invocation loads one retriever and one optional scorer. This keeps
the 24 GB evaluation GPU predictable and makes every report reproducible.

Usage:
  python -m grounding_lab.model_benchmark dataset --stage retrieval --retriever qwen-0.6b
  python -m grounding_lab.model_benchmark dataset --stage rerank --retriever qwen-0.6b --reranker qwen-0.6b
  python -m grounding_lab.model_benchmark dataset --stage verify --retriever lfm-colbert-350m --verifier minicheck-deberta-large
"""

from __future__ import annotations

import argparse
import importlib.util
import json
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
    SIBLING_MIN_CHARS,
    SIBLING_WINDOW,
    CROSS_ENCODER_MODEL,
    CROSS_ENCODER_REVISION,
    RERANK_INSTRUCTION,
    Claim,
    bounded_contains,
    claim_field,
    gated_lexical_tier,
    index_anchors,
    lexical_match,
    lexical_tier,
    render_claim,
)

K_VALUES = (10, 20, 30, 50)
RERANK_K = 30
CONTAINMENT_CAP = 0.25
VERIFIER_SUPPORT_FLOOR = 0.5
INCUMBENT_VALIDATION_WRONG = 7
TASK_INSTRUCTION = RERANK_INSTRUCTION


@dataclass(frozen=True)
class ModelSpec:
    repo: str
    revision: str
    batch_size: int
    eligibility: str | None = None
    instruction_aware: bool = False
    listwise: bool = False
    trust_remote_code: bool = False
    multi_vector: bool = False
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
        eligibility="research-only (non-commercial model license)",
        instruction_aware=True,
    ),
    "jina-colbert": ModelSpec(
        "jinaai/jina-colbert-v2",
        "a9dc5cd7293d4c71dbbba04829923ba4d0e4f6ea",
        8,
        eligibility="research-only (non-commercial model license)",
        trust_remote_code=True,
        multi_vector=True,
        code_revision="bd55a5ec8e6c0fb1d6c26efb4b6a4a74ce8a88d3",
        required_modules=("einops",),
    ),
    "lfm-colbert-350m": ModelSpec(
        "LiquidAI/LFM2.5-ColBERT-350M",
        "9772bdf797255d8693b83e84aa98e9b2d36dd0be",
        8,
        eligibility="license-restricted (LFM Open License v1.0 commercial-use threshold)",
        trust_remote_code=True,
        multi_vector=True,
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
    "nemotron-1b": ModelSpec(
        "nvidia/llama-nemotron-rerank-1b-v2",
        "828765652b05bd439c9789d2a6d093db1caa1443",
        8,
        trust_remote_code=True,
    ),
    "jina-v3.5": ModelSpec(
        "jinaai/jina-reranker-v3.5",
        "e8a93f33f0b22108f8c2364f8484ce3422552fbc",
        1,
        eligibility="research-only (non-commercial model license)",
        instruction_aware=True,
        listwise=True,
        trust_remote_code=True,
    ),
}

VERIFIERS = {
    "minicheck-deberta-large": ModelSpec(
        "lytang/MiniCheck-DeBERTa-v3-Large",
        "2f2d01a54fa022a7ffadb76260e1ea8bc88c82bb",
        8,
    ),
}


def claim_text(claim: Claim, rendering: str, in_hitset: bool = False) -> str:
    """bare: value only. rich: field + siblings always. rich-hitset: field +
    siblings only when disambiguating inside a verbatim hit set (abstention is
    not at stake there, and siblings pick the table row over prose mentions),
    bare for the dense path where rich context eroded abstention."""
    if rendering == "bare" or (rendering == "rich-hitset" and not in_hitset):
        return str(claim.value)
    if rendering in ("rich", "rich-hitset"):
        return render_claim(claim)
    raise ValueError(f"unknown claim rendering: {rendering!r}")


def verifier_claim_text(claim: Claim) -> str:
    field, value = render_claim(claim, siblings=False).split(": ", 1)
    context = f" ({claim.context})" if claim.context else ""
    return f"The {field} is {value}{context}."


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
    return snapshot_download(
        spec.repo,
        revision=spec.revision,
        ignore_patterns=["pytorch_model.bin"]
        if spec.repo == RERANKERS["nemotron-1b"].repo
        else None,
    )


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
    encoder = MultiVectorEncoder if spec.multi_vector else SentenceTransformer
    return encoder(
        model_path,
        revision=None if model_path != spec.repo else spec.revision,
        trust_remote_code=spec.trust_remote_code,
        model_kwargs=model_kwargs,
        processor_kwargs={"fix_mistral_regex": True}
        if spec.repo == RETRIEVERS["jina-colbert"].repo
        else None,
    )


def _encode(model, spec: ModelSpec, texts: list[str], *, query: bool):
    if spec.multi_vector:
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
    if spec.repo == RERANKERS["nemotron-1b"].repo:
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        model_path = _model_path(spec)
        tokenizer = AutoTokenizer.from_pretrained(
            model_path, trust_remote_code=True, padding_side="left"
        )
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token
        model = AutoModelForSequenceClassification.from_pretrained(
            model_path, trust_remote_code=True, dtype=torch.bfloat16
        ).to("cuda" if torch.cuda.is_available() else "cpu")
        if model.config.pad_token_id is None:
            model.config.pad_token_id = tokenizer.eos_token_id
        model.eval()
        return tokenizer, model
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
    if spec.repo == RERANKERS["nemotron-1b"].repo:
        torch = _torch()
        tokenizer, classifier = model
        scores = []
        for start in range(0, len(documents), spec.batch_size):
            texts = [
                f"question:{query} \n \n passage:{document}"
                for document in documents[start:start + spec.batch_size]
            ]
            inputs = tokenizer(
                texts, padding=True, truncation=True, max_length=512,
                return_tensors="pt",
            ).to(classifier.device)
            with torch.inference_mode():
                scores.extend(classifier(**inputs).logits.view(-1).float().cpu().tolist())
        return np.asarray(scores)
    if spec.listwise:
        prompted = f"{TASK_INSTRUCTION}\nExtracted scalar: {query}"
        return scores_from_ranking(model.rerank(prompted, documents), len(documents))
    scores = model.predict(
        [(query, document) for document in documents],
        batch_size=spec.batch_size,
        show_progress_bar=False,
    )
    return np.asarray(scores).reshape(-1)


def _load_verifier(spec: ModelSpec):
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    torch = _torch()
    tokenizer = AutoTokenizer.from_pretrained(spec.repo, revision=spec.revision)
    model = AutoModelForSequenceClassification.from_pretrained(
        spec.repo, revision=spec.revision, dtype=torch.bfloat16
    ).to("cuda" if torch.cuda.is_available() else "cpu")
    model.eval()
    return tokenizer, model


def _verify_scores(model, spec: ModelSpec, claim: str, documents: list[str]) -> np.ndarray:
    """MiniCheck support probabilities, using its documented document-claim order."""
    torch = _torch()
    tokenizer, classifier = model
    scores = []
    for start in range(0, len(documents), spec.batch_size):
        texts = [
            f"{document}{tokenizer.eos_token}{claim}"
            for document in documents[start:start + spec.batch_size]
        ]
        inputs = tokenizer(
            texts, padding=True, truncation=True, max_length=2048,
            return_tensors="pt",
        ).to(classifier.device)
        with torch.inference_mode():
            probabilities = classifier(**inputs).logits.float().softmax(dim=-1)
        scores.extend(probabilities[:, 1].cpu().tolist())
    return np.asarray(scores)


def _verbatim_flags(claim: Claim, anchors) -> list[bool]:
    return [bounded_contains(claim.value, anchor.text) for anchor in anchors]


def _warm_retriever(model, spec: ModelSpec) -> None:
    documents = _encode(model, spec, ["Evidence passage."], query=False)
    query = _encode(model, spec, ["evidence"], query=True)
    _similarities(model, query, documents)


def _warm_reranker(model, spec: ModelSpec) -> None:
    _rerank_scores(model, spec, "evidence", ["Evidence passage.", "Unrelated text."])


def _warm_verifier(model, spec: ModelSpec) -> None:
    _verify_scores(model, spec, "claim: evidence", ["Evidence passage."])


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
    if source == "hitset" and hits:
        return hits
    query_embeddings = _encode(retriever, retriever_spec, [text], query=True)
    retrieval_scores = _similarities(retriever, query_embeddings, document_embeddings)
    order = retrieval_scores.argsort()[::-1][:k]
    return [index.anchors[int(i)] for i in order]


def _colliding_values(claims) -> set:
    """Values an extraction claims under more than one field. A unique
    lexical hit proves the value is in the document, not that it belongs to
    this field ("Poul Kragh" as machine_operator and excavation_leader, one
    occurrence): such hits are scored field-aware and capped for review."""
    fields: dict = {}
    for claim in claims:
        fields.setdefault(claim.value, set()).add(claim_field(claim))
    return {value for value, seen in fields.items() if len(seen) > 1}


def _score_entries(
    documents, retriever, retriever_spec, reranker, reranker_spec, rendering, k=RERANK_K,
    candidates="hitset", zero_hit="abstain", rerank_one_hit=False, sibling_gate=False,
):
    entries = []
    latencies: list[tuple[str, str, float]] = []
    dense = not (candidates == "hitset" and zero_hit == "abstain")
    lexical = gated_lexical_tier if sibling_gate else lexical_tier
    for doc_name, index, claims in documents:
        # One-off per-document cost, reported apart from the per-claim path.
        started = time.perf_counter()
        index_anchors(index.anchors)
        latencies.append((doc_name, "index", time.perf_counter() - started))
        # Document embeddings only serve the dense path; hitset + abstain never reaches it.
        document_embeddings = _encode(
            retriever,
            retriever_spec,
            [anchor.scoring_text for anchor in index.anchors],
            query=False,
        ) if dense else None
        colliding = set() if rerank_one_hit else _colliding_values(claims)
        for claim in claims:
            started = time.perf_counter()
            decided, hits = lexical(claim, index.anchors)
            collision = bool(decided and decided.anchor_id and claim.value in colliding)
            rerank_single = bool(rerank_one_hit and decided and decided.anchor_id)
            if decided is not None and not collision and not rerank_single and (decided.anchor_id or zero_hit == "abstain"):
                # one hit links; zero hits abstain without a neural pass (only
                # 6/182 lab claims are linkable paraphrase/OCR/spacing cases;
                # 0/100 on final set 2)
                tier = "lexical" if decided.anchor_id else "abstain"
                if decided.anchor_id and decided.confidence < 1.0:
                    tier = "review"  # gated: hit shares no sibling value with the claim
                entries.append((doc_name, claim, tier, decided.anchor_id))
                latencies.append((doc_name, "lexical", time.perf_counter() - started))
                continue
            in_hitset = candidates == "hitset" and (len(hits) > 1 or collision or rerank_single)
            text = render_claim(claim) if rerank_single else claim_text(claim, rendering, in_hitset)
            shortlist = _candidates(
                hits, index, retriever, retriever_spec, document_embeddings, text, k, candidates
            )
            scores = _rerank_scores(
                reranker,
                reranker_spec,
                text,
                [anchor.scoring_text for anchor in shortlist],
            )
            # The legacy collision policy caps its special case. The generic
            # path disables that heuristic and keeps real containment.
            verbatim = (
                [False] * len(shortlist)
                if collision
                else _verbatim_flags(claim, shortlist)
            )
            entries.append((doc_name, claim, "neural", (shortlist, scores, verbatim)))
            latencies.append((doc_name, "neural", time.perf_counter() - started))
    return entries, latencies


def _verification_entries(documents, retriever, retriever_spec, verifier, verifier_spec, k):
    """Policy G: retrieve zero hits, then verify every candidate independently."""
    entries = []
    latencies: list[tuple[str, str, float]] = []
    for doc_name, index, claims in documents:
        document_embeddings = _encode(
            retriever,
            retriever_spec,
            [anchor.scoring_text for anchor in index.anchors],
            query=False,
        )
        for claim in claims:
            started = time.perf_counter()
            _, hits = lexical_tier(claim, index.anchors)
            text = verifier_claim_text(claim)
            shortlist = hits or _candidates(
                hits, index, retriever, retriever_spec, document_embeddings,
                text, k, "retrieval",
            )
            scores = _verify_scores(
                verifier,
                verifier_spec,
                text,
                [anchor.scoring_text for anchor in shortlist],
            )
            entries.append(
                (
                    doc_name,
                    claim,
                    "verifier",
                    (shortlist, scores, _verbatim_flags(claim, shortlist)),
                )
            )
            latencies.append((doc_name, "verifier", time.perf_counter() - started))
    return entries, latencies


def choose_thresholds(entries) -> tuple[float, float, dict]:
    """Tune score and auto-accept gates on dev without assuming a score scale."""
    verifier_first = any(entry[2] == "verifier" for entry in entries)
    best_scores = [
        float(np.max(payload[1]))
        for _, _, tier, payload in entries
        if tier in {"neural", "verifier"}
    ]
    abstain_candidates = (
        [VERIFIER_SUPPORT_FLOOR]
        + sorted({math.nextafter(score, math.inf) for score in best_scores if score >= VERIFIER_SUPPORT_FLOOR})
        if verifier_first
        else [-math.inf] + sorted(
            {math.nextafter(score, math.inf) for score in best_scores}
        )
    )
    candidates = []
    for abstain in abstain_candidates:
        confidences = {1.0}
        for entry in entries:
            if entry[2] not in {"neural", "verifier"}:
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
            (-metrics["wrong"], metrics["total_correct"])
            if verifier_first
            else (metrics["total_correct"], -metrics["wrong"])
        ) + (metrics["correct_links"], metrics["auto"])
        candidates.append((rank, abstain, accept, metrics))
    _, abstain, accept, metrics = max(candidates, key=lambda candidate: candidate[0])
    return abstain, accept, metrics


def outcome(entry, abstain, accept) -> str:
    """One label per claim, the reviewer's view: link-correct, link-wrong
    (an anchor outside the gold set, or any anchor for an unsupported value),
    review, abstain."""
    _, claim, tier, payload = entry
    if tier in {"abstain", "review"}:
        return tier
    if tier == "lexical":
        picked, confidence = payload, 1.0
    else:
        picked, confidence, _ = decide(entry, abstain, CONTAINMENT_CAP)
        if picked is None:
            return "abstain"
    if confidence < accept:
        return "review"
    return "link-correct" if picked in claim.gold_anchor_ids else "link-wrong"


def dump_outcomes(path: Path, entries, thresholds) -> None:
    """thresholds: {doc name: (abstain, accept)}; one JSON line per claim."""
    with path.open("w", encoding="utf-8") as out:
        for entry in entries:
            doc_name, claim = entry[0], entry[1]
            abstain, accept = thresholds[doc_name]
            out.write(json.dumps({
                "doc": doc_name,
                "path": list(claim.result_path),
                "value": claim.value,
                "supported": bool(claim.gold_anchor_ids),
                "outcome": outcome(entry, abstain, accept),
            }, ensure_ascii=False) + "\n")


def _evaluation_metrics(entries, names, abstain, accept, latencies):
    selected = [entry for entry in entries if entry[0] in names]
    metrics = evaluate(selected, abstain, CONTAINMENT_CAP, accept)
    fallback_linkable = [
        entry for entry in selected
        if entry[2] in {"neural", "verifier"} and entry[1].gold_anchor_ids
    ]
    metrics["recall_at_k"] = sum(
        any(
            anchor.anchor_id in entry[1].gold_anchor_ids
            for anchor in entry[3][0]
        )
        for entry in fallback_linkable
    )
    metrics["recall_total"] = len(fallback_linkable)
    timings = sorted(
        seconds
        for name, tier, seconds in latencies
        if name in names and tier != "index"
    )
    metrics["median_ms"] = 1000 * (statistics.median(timings) if timings else 0)
    metrics["p95_ms"] = 1000 * (timings[int(0.95 * (len(timings) - 1))] if timings else 0)
    metrics["index_ms"] = 1000 * sum(
        seconds for name, tier, seconds in latencies if name in names and tier == "index"
    )
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
            if key not in {"median_ms", "p95_ms"}:
                pooled[key] = pooled.get(key, 0) + value
    timings = sorted(seconds for _, tier, seconds in latencies if tier != "index")
    pooled["median_ms"] = 1000 * (statistics.median(timings) if timings else 0)
    pooled["p95_ms"] = 1000 * (timings[int(0.95 * (len(timings) - 1))] if timings else 0)
    return rows, pooled


def _metrics_cells(metrics) -> str:
    total = metrics["linkable"] + metrics["abstains_due"]
    return (
        f"{metrics['recall_at_k']}/{metrics['recall_total']} | "
        f"{metrics['total_correct']}/{total} | "
        f"{metrics['correct_links']}/{metrics['linkable']} | "
        f"{metrics['correct_abstains']}/{metrics['abstains_due']} | "
        f"{metrics['review']} | {metrics['wrong']} | "
        f"{metrics['auto_correct']}/{metrics['auto']} | "
        f"{ci(metrics['total_correct'], total)} | "
        f"{ci(metrics['auto_correct'], metrics['auto'])} | "
        f"{metrics['median_ms']:.0f} | {metrics['p95_ms']:.0f}"
    )


def _gate_and_latency_lines(args) -> list[str]:
    gate = getattr(args, "sibling_gate", False)
    return [
        "- sibling gate: " + (
            f"on (window {SIBLING_WINDOW} anchors on the page, siblings of {SIBLING_MIN_CHARS}+ characters; "
            "a single hit sharing no sibling value goes to review, a bare number links only through a sibling-supported hit)"
            if gate else "off"
        ),
        "- latency: whole path per claim (lexical scan and scorer) after a one-off anchor normalization per document (index ms)",
    ]


def _candidate_labels(args) -> tuple[str, str]:
    if getattr(args, "stage", None) == "verify":
        return f"lexical hits; zero-hit top-{args.k} retrieval", "candidate recall"
    if args.candidates == "retrieval":
        return f"top-{args.k} retrieval", f"recall@{args.k}"
    if args.zero_hit == "abstain":
        return "all lexical hits", "hit-set recall"
    return f"all lexical hits; zero-hit top-{args.k} retrieval", "candidate recall"


def cv_report(args, documents, entries, latencies, retriever_loaded) -> str:
    folds = cv_folds([name for name, _, _ in documents], args.cv)
    rows, pooled = cv_evaluate(entries, latencies, folds)
    if getattr(args, "dump", None):
        dump_outcomes(args.dump, entries, {
            name: (abstain, accept) for fold, abstain, accept, _ in rows for name in fold
        })
    candidate_scope, recall_label = _candidate_labels(args)
    lines = [
        f"# Neural model benchmark — {args.cv}-fold cross-validation",
        "",
        f"Generated {date.today().isoformat()} by `grounding_lab.model_benchmark`.",
        "",
        *_model_lines(
            args.retriever, args.reranker, retriever_loaded, args.verifier
        ),
        f"- claim mode: `{args.claim_mode}`",
        f"- candidates: `{args.candidates}`",
        f"- zero-hit claims: `{args.zero_hit}`",
        f"- strict single hits: {'reranked with rich claims' if getattr(args, 'rerank_one_hit', False) else 'linked directly'}",
        *_gate_and_latency_lines(args),
        f"- candidate scope: {candidate_scope}",
        *(
            ["- threshold objective: minimize wrong links, then maximize correct decisions"]
            if args.stage == "verify" else []
        ),
        *(
            [f"- support threshold floor: {VERIFIER_SUPPORT_FLOOR}"]
            if args.stage == "verify" else []
        ),
        f"- containment cap: {CONTAINMENT_CAP}",
        "- links below the auto-accept threshold count as review, not supported or wrong",
        f"- documents: {len(documents)} from {', '.join(f'`{root}`' for root in args.root)}",
        "",
        f"| fold | documents | abstain | accept | {recall_label} | correct decisions | supported links | correct abstains | review | wrong links | auto precision | total 95% CI | auto 95% CI | median ms | p95 ms |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for i, (fold, abstain, accept, metrics) in enumerate(rows, 1):
        lines.append(
            f"| {i} | {', '.join(fold)} | {_fmt_threshold(abstain)} | {accept:.4f} | "
            + _metrics_cells(metrics) + " |"
        )
    lines.append(f"| **pooled** | all | — | — | " + _metrics_cells(pooled) + " |")
    lines += ["", "## Document results (thresholds from the document's own fold)", "",
              "| document | fold | correct decisions | review | wrong links | median ms | p95 ms | index ms |",
              "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for i, (fold, abstain, accept, _) in enumerate(rows, 1):
        for name in fold:
            metrics = _evaluation_metrics(entries, {name}, abstain, accept, latencies)
            total = metrics["linkable"] + metrics["abstains_due"]
            lines.append(
                f"| {name} | {i} | {metrics['total_correct']}/{total} | "
                f"{metrics['review']} | {metrics['wrong']} | "
                f"{metrics['median_ms']:.0f} | {metrics['p95_ms']:.0f} | {metrics['index_ms']:.0f} |"
            )
    lines += ["", *_vram_lines(),
              "Each fold's thresholds were selected on the other folds only; pooled counts sum the held-out folds."]
    return "\n".join(lines) + "\n"


def _fmt_threshold(value: float) -> str:
    return "-∞" if value == -math.inf else f"{value:.6f}"


def _model_lines(
    retriever_key: str,
    reranker_key: str | None = None,
    retriever_loaded: bool = True,
    verifier_key: str | None = None,
) -> list[str]:
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
    if verifier_key:
        verifier = VERIFIERS[verifier_key]
        lines.append(
            f"- verifier: `{verifier_key}` — `{verifier.repo}@{verifier.revision}`"
        )
    restrictions = [retriever.eligibility]
    if reranker_key:
        restrictions.append(RERANKERS[reranker_key].eligibility)
    if verifier_key:
        restrictions.append(VERIFIERS[verifier_key].eligibility)
    restrictions = [restriction for restriction in restrictions if restriction]
    if restrictions:
        lines.append("- eligibility: " + "; ".join(restrictions))
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


def rerank_report(args, documents, retriever, retriever_spec, scorer, scorer_spec):
    if args.stage == "verify":
        entries, latencies = _verification_entries(
            documents, retriever, retriever_spec, scorer, scorer_spec, args.k
        )
    else:
        entries, latencies = _score_entries(
            documents,
            retriever,
            retriever_spec,
            scorer,
            scorer_spec,
            args.claim_mode,
            args.k,
            args.candidates,
            args.zero_hit,
            args.rerank_one_hit,
            getattr(args, "sibling_gate", False),
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

    if getattr(args, "dump", None):
        dump_outcomes(args.dump, entries, {name: (abstain, accept) for name, _, _ in documents})
    candidate_scope, recall_label = _candidate_labels(args)
    lines = [
        f"# Neural model benchmark — {'verification' if args.stage == 'verify' else 'reranking'}",
        "",
        f"Generated {date.today().isoformat()} by `grounding_lab.model_benchmark`.",
        "",
        *_model_lines(
            args.retriever, args.reranker, retriever is not None, args.verifier
        ),
        f"- claim mode: `{args.claim_mode}`",
        f"- candidates: `{args.candidates}`",
        f"- zero-hit claims: `{args.zero_hit}`",
        f"- strict single hits: {'reranked with rich claims' if args.rerank_one_hit else 'linked directly'}",
        *_gate_and_latency_lines(args),
        f"- candidate scope: {candidate_scope}",
        *(
            ["- threshold objective: minimize wrong links, then maximize correct decisions"]
            if args.stage == "verify" else []
        ),
        *(
            [f"- support threshold floor: {VERIFIER_SUPPORT_FLOOR}"]
            if args.stage == "verify" else []
        ),
        f"- abstain threshold: {_fmt_threshold(abstain)}",
        f"- containment cap: {CONTAINMENT_CAP}",
        f"- auto-accept threshold: {accept:.6f}",
        "- links below the auto-accept threshold count as review, not supported or wrong",
        "",
        f"| split | {recall_label} | correct decisions | supported links | correct abstains | review | wrong links | auto precision | total 95% CI | auto 95% CI | median ms | p95 ms |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
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
            f"{metrics['review']} | {metrics['wrong']} | "
            f"{metrics['auto_correct']}/{metrics['auto']} | "
            f"{ci(metrics['total_correct'], total)} | "
            f"{ci(metrics['auto_correct'], metrics['auto'])} | "
            f"{metrics['median_ms']:.0f} | {metrics['p95_ms']:.0f} |"
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
        "| document | correct decisions | review | wrong links | median ms | p95 ms | index ms |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for name in sorted(split_names(documents, args.split)):
        metrics = _evaluation_metrics(entries, {name}, abstain, accept, latencies)
        total = metrics["linkable"] + metrics["abstains_due"]
        lines.append(
            f"| {name} | {metrics['total_correct']}/{total} | "
            f"{metrics['review']} | {metrics['wrong']} | "
            f"{metrics['median_ms']:.0f} | {metrics['p95_ms']:.0f} | {metrics['index_ms']:.0f} |"
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
    parser.add_argument(
        "--stage", choices=("retrieval", "rerank", "verify"), required=True
    )
    parser.add_argument("--retriever", choices=tuple(RETRIEVERS), required=True)
    parser.add_argument("--reranker", choices=tuple(RERANKERS))
    parser.add_argument("--verifier", choices=tuple(VERIFIERS))
    parser.add_argument(
        "--claim-mode", choices=("bare", "rich", "rich-hitset"), default="rich-hitset",
        help="rich-hitset: field + sibling rendering only inside the lexical hit set (needs --candidates hitset)",
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
        "--rerank-one-hit", action="store_true",
        help="rerank strict single lexical hits with rich claim rendering",
    )
    parser.add_argument(
        "--sibling-gate", action="store_true",
        help="a single hit sharing no sibling value with the claim goes to review; "
             "a bare number links only through a sibling-supported hit",
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
    parser.add_argument(
        "--claims", default="claims.json",
        help="comma-separated claim files merged per document (e.g. claims.json,traps.json)",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--dump", type=Path,
        help="write one JSON line per claim with its outcome (link-correct, link-wrong, review, abstain) at the thresholds used",
    )
    args = parser.parse_args()

    if args.stage == "rerank" and not args.reranker:
        parser.error("--reranker is required for --stage rerank")
    if args.stage == "verify" and not args.verifier:
        parser.error("--verifier is required for --stage verify")
    if args.stage != "rerank" and args.reranker:
        parser.error("--reranker is only valid for --stage rerank")
    if args.stage != "verify" and args.verifier:
        parser.error("--verifier is only valid for --stage verify")
    if args.rerank_one_hit and args.stage != "rerank":
        parser.error("--rerank-one-hit is only valid for --stage rerank")
    if args.rerank_one_hit and args.candidates != "hitset":
        parser.error("--rerank-one-hit requires --candidates hitset")
    if args.sibling_gate and args.stage != "rerank":
        parser.error("--sibling-gate is only valid for --stage rerank")
    if args.stage == "verify":
        args.claim_mode = "rich"
        args.candidates = "hitset"
        args.zero_hit = "neural"
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

    claims_files = tuple(n.strip() for n in args.claims.split(",") if n.strip())
    documents = [doc for root in args.root for doc in load_dataset(root, claims_files)]
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
        needs_retriever = args.stage in {"retrieval", "verify"} or not (
            args.candidates == "hitset" and args.zero_hit == "abstain"
        )
        retriever = None
        if needs_retriever:
            retriever = _load_retriever(retriever_spec)
            _warm_retriever(retriever, retriever_spec)
        if args.stage == "retrieval":
            report = retrieval_report(args, documents, retriever, retriever_spec)
        elif args.stage == "verify":
            verifier_spec = VERIFIERS[args.verifier]
            verifier = _load_verifier(verifier_spec)
            _warm_verifier(verifier, verifier_spec)
            report = rerank_report(
                args, documents, retriever, retriever_spec, verifier, verifier_spec
            )
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
