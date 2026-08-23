# Slopo local embedding benchmark

Corpus fingerprint: `0fa0403d70246a7f5141d3be97915613c1c589fdf4f5026d03b1232f932f4db7`

Indexed 1636 code units from 174 production/fixture files; 1614 unique bodies were embedded.

Thresholds were calibrated per configuration on three clone families. The search first looked for at least 80% calibration recall while capping the largest similarity component at 32 units. No configuration met both constraints, so each operating point is the best precision-weighted F0.5 result under the component cap. Reported test metrics use four held-out families.

## Recommendation

**pplx-v1-0.6b-512d** is the model-quality winner: 90.0% reviewed repository P@20, 62.0% P@50 lower bound, and 27.8% held-out gated recall. It requires the documented pplx output transform plus 512d truncation. **qwen3-0.6b-1024d** is the precision-first stock Slopo + llama.cpp choice at 80.0% reviewed P@20. **jina-v2-code-768d** is the efficiency choice at 180.88 bodies/s.

## Deployment compatibility

The installed `version: 0.1.2-dev (build 10545, commit a30273376) built with Clang 20.1.8 for Windows x86_64` build returned 1024 values when its OpenAI endpoint was explicitly sent `dimensions: 512`. Stock Slopo also does not apply model-specific output transforms. Only native-width, identity-output rows are therefore exact drop-ins for this setup.

| Configuration | Exact stock Slopo path | Required adapter work |
|---|---:|---|
| pplx-v1-0.6b-512d | no | tanh/INT8 output transform; truncate to 512d and normalize |
| pplx-v1-0.6b-1024d | no | tanh/INT8 output transform |
| voyage-4-nano-512d | no | 1024-to-2048 learned projection; truncate to 512d and normalize |
| voyage-4-nano-256d | no | 1024-to-2048 learned projection; truncate to 256d and normalize |
| qwen3-0.6b-1024d | yes | none |
| jina-v2-code-768d | yes | none |
| qwen3-0.6b-512d | no | truncate to 512d and normalize |

Stock Slopo settings for the drop-in winner (keep the existing source-only path exclusions):

```yaml
embedding_model: openai/qwen3-embedding-0.6b
embedding_dimensions: 1024
embedding_api_key: local
embedding_params:
  custom_llm_provider: openai
  api_base: http://127.0.0.1:18080/v1
  drop_params: true
similarity_threshold: 0.8762
rerank_threshold: 0.8762
```

Start llama.cpp with `--embedding --pooling last --embd-normalize -1` for this Qwen configuration.

## Held-out labeled quality

| Configuration | P@20 | P@50 | AP | ROC AUC | Gated precision | Gated recall |
|---|---:|---:|---:|---:|---:|---:|
| pplx-v1-0.6b-512d | 80.0% | 36.0% | 88.2% | 98.5% | 100.0% | 27.8% |
| pplx-v1-0.6b-1024d | 80.0% | 36.0% | 88.4% | 98.6% | 100.0% | 22.2% |
| voyage-4-nano-512d | 70.0% | 36.0% | 66.3% | 95.2% | 50.0% | 5.6% |
| voyage-4-nano-256d | 65.0% | 36.0% | 65.6% | 95.2% | 50.0% | 5.6% |
| qwen3-0.6b-1024d | 80.0% | 36.0% | 83.6% | 98.3% | 100.0% | 22.2% |
| jina-v2-code-768d | 75.0% | 36.0% | 79.2% | 97.5% | 83.3% | 27.8% |
| qwen3-0.6b-512d | 80.0% | 36.0% | 88.5% | 98.6% | 100.0% | 22.2% |

The held-out candidate set contains 18 positives, so P@50 has a 36.0% ceiling and does not separate these configurations.

## Thresholds and planted-clone recall

| Configuration | Cosine | Rerank | Calibration recall | Largest component | Type-2 recall | Type-3 recall | Repo-semantic recall |
|---|---:|---:|---:|---:|---:|---:|---:|
| pplx-v1-0.6b-512d | 0.8168 | 0.8168 | 50.0% | 22 | 14.3% | 42.9% | 100.0% |
| pplx-v1-0.6b-1024d | 0.8198 | 0.8198 | 50.0% | 15 | 14.3% | 28.6% | 100.0% |
| voyage-4-nano-512d | 0.9225 | 0.9225 | 54.2% | 26 | 14.3% | 14.3% | 0.0% |
| voyage-4-nano-256d | 0.9207 | 0.9207 | 54.2% | 26 | 14.3% | 14.3% | 0.0% |
| qwen3-0.6b-1024d | 0.8762 | 0.8762 | 50.0% | 17 | 0.0% | 28.6% | 100.0% |
| jina-v2-code-768d | 0.7926 | 0.9539 | 62.5% | 28 | 28.6% | 14.3% | 100.0% |
| qwen3-0.6b-512d | 0.8910 | 0.8910 | 50.0% | 10 | 0.0% | 28.6% | 100.0% |

## Full-repository review ranking

Every cluster appearing in any configuration's top 20 was manually adjudicated. P@50 remains a conservative lower bound where the final 30 contain unreviewed clusters.

| Configuration | Clusters | Reviewed P@20 | Unknown@20 | P@50 lower bound | Unknown@50 |
|---|---:|---:|---:|---:|---:|
| pplx-v1-0.6b-512d | 137 | 90.0% | 0 | 62.0% | 17 |
| pplx-v1-0.6b-1024d | 126 | 90.0% | 0 | 62.0% | 17 |
| voyage-4-nano-512d | 129 | 85.0% | 0 | 60.0% | 16 |
| voyage-4-nano-256d | 131 | 85.0% | 0 | 54.0% | 19 |
| qwen3-0.6b-1024d | 146 | 80.0% | 0 | 52.0% | 20 |
| jina-v2-code-768d | 70 | 80.0% | 0 | 46.0% | 23 |
| qwen3-0.6b-512d | 138 | 75.0% | 0 | 54.0% | 18 |

## Local cost

Inference is measured once per model family at native dimensions. Lower-dimensional runs reuse the model's Matryoshka prefix, matching local indexing behavior.

| Configuration | Bodies/s | Embed seconds | GPU MiB | Model MiB | Vector MiB | DB MiB |
|---|---:|---:|---:|---:|---:|---:|
| pplx-v1-0.6b-512d | 53.23 | 30.3 | 9940 | 609.8 | 3.2 | 7.9 |
| pplx-v1-0.6b-1024d | 53.23 | 30.3 | 9940 | 609.8 | 6.3 | 8.7 |
| voyage-4-nano-512d | 68.23 | 23.7 | 7620 | 354.7 | 3.2 | 7.9 |
| voyage-4-nano-256d | 68.23 | 23.7 | 7620 | 354.7 | 1.6 | 3.7 |
| qwen3-0.6b-1024d | 46.78 | 34.5 | 9916 | 609.5 | 6.3 | 8.7 |
| jina-v2-code-768d | 180.88 | 8.9 | 650 | 164.9 | 4.7 | 7.9 |
| qwen3-0.6b-512d | 46.78 | 34.5 | 9916 | 609.5 | 3.2 | 7.9 |

## Reproducibility notes

- All weights are Q8_0 GGUF and served by the installed llama.cpp build.
- Qwen uses last-token pooling; Jina, pplx, and Voyage use mean pooling.
- pplx output is converted to its documented native int8 representation before cosine comparison.
- Voyage uses the conversion repository's required 1024-to-2048 projection before truncation.
- Thresholds are independently calibrated; the old 0.92/0.94 defaults are not reused.

Precision-first ranking: **pplx-v1-0.6b-512d** first. Top-20 repository results are fully adjudicated; P@50 lower bounds remain conservative.
