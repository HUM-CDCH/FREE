# Slopo late-fusion ensemble benchmark

Corpus fingerprint: `0fa0403d70246a7f5141d3be97915613c1c589fdf4f5026d03b1232f932f4db7`

Discovery models: `pplx-v1-0.6b-512d`, `jina-v2-code-768d`, `qwen3-0.6b-1024d`

Confirmation-only models: `voyage-4-nano-512d`

The input contains 150 discovery occurrences plus 50 confirmation-only occurrences, 92 unique discovery cluster IDs, and 79 non-transitively deduplicated representatives.

Clusters are produced independently by each model. Fusion matches cluster member sets at Jaccard >= 0.60, keeps one representative, and never unions cross-model similarity edges or members transitively.

Matched variants have 2 manual-label conflicts. Labels are used only to evaluate the final ranking, never to form or rank it; metrics score the retained representative rather than a broader matched variant.

## Results

Single-model baseline: `pplx-v1-0.6b-512d` with 18/20 positives at 20 (90.0%) and 42/50 at 50 (84.0%).

| Strategy | Candidates | Positives@20 | Unknown@20 | Reviewed P@20 | Delta vs baseline | Novel positives@20 | Positives@50 | Unknown@50 | Total positives | Total unknown | Total reviewed P | Novel positives total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| consensus_only | 52 | 20 | 0 | 100.0% | +2 | 0 | 44 | 0 | 45 | 0 | 86.5% | 5 |
| support_first | 79 | 20 | 0 | 100.0% | +2 | 0 | 44 | 0 | 51 | 0 | 64.6% | 8 |
| round_robin_union | 79 | 16 | 0 | 80.0% | -2 | 1 | 37 | 0 | 51 | 0 | 64.6% | 8 |

## Candidate support

- 4-model support: 25 representatives.
- 3-model support: 11 representatives.
- 2-model support: 16 representatives.
- Single-model discoveries: 27 representatives.

`consensus_only` is the precision lane. `support_first` retains all candidates but ranks agreement before single-model findings. `round_robin_union` deliberately interleaves model-specific discoveries to maximize diversity at a fixed review budget.

## Recommendation

Use `consensus_only` by default. It raises P@20 from 18/20 to 20/20, raises the first-50 yield from 42 to 44, and returns 45/52 confirmed clusters (86.5%). Of those, 5 are confirmed positives with no matching cluster in the primary model's top 50.

Use `support_first` as an optional exploration tail when finding more clusters matters more than review efficiency. It increases the confirmed pool from 45 to 51, but the 27 additional candidates contain only 6 positives (22.2% marginal precision); the full lane is 51/79 (64.6%).

`round_robin_union` is retained as a diversity-oriented negative control; it finds the same final set as `support_first` but ranks substantially fewer true clusters into the first 20 and 50 review slots.

Novel means a confirmed positive whose member set has no match in the primary pplx top-50 pool at the selected cutoff. Voyage can add support to a discovery but cannot introduce a candidate by itself.

`ensemble-review-candidates.md` is regenerated with any unreviewed fused representatives; the selected 0.60 run currently has none.


## Match-cutoff sensitivity

The 0.60 cutoff is the strongest fully reviewed precision/yield point on this repository. This sweep uses the same adjudications as the reported ensemble, so it is diagnostic rather than an independent test.

| Member Jaccard | Representatives | Consensus candidates | Positives@20 | Consensus positives | Consensus unknown | Expanded positives |
|---:|---:|---:|---:|---:|---:|---:|
| 0.40 | 72 | 56 | 20 | 45/56 | 1 | 49/72 |
| 0.50 | 75 | 55 | 19 | 45/55 | 0 | 49/75 |
| 0.60 | 79 | 52 | 20 | 45/52 | 0 | 51/79 |
| 0.70 | 85 | 49 | 20 | 42/49 | 1 | 53/85 |
| 0.80 | 90 | 51 | 20 | 42/51 | 2 | 53/90 |
| 1.00 | 92 | 47 | 20 | 41/47 | 2 | 53/92 |