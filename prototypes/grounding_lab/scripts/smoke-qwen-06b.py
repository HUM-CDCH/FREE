"""Live smoke check for the pinned Qwen3 0.6B reranker."""

from grounding_lab.model_benchmark import RERANKERS, _load_reranker, _rerank_scores


spec = RERANKERS["qwen-0.6b"]
model = _load_reranker(spec)
scores = _rerank_scores(
    model,
    spec,
    "17 June 1790",
    ["The meeting was held on 17 June 1790.", "The meeting was held on 18 June 1790."],
)
assert scores[0] > scores[1], scores
print(f"ok {spec.repo}@{spec.revision}: {scores.tolist()}")
