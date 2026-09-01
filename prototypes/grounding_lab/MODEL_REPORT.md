# Neural model benchmark — retrieval

Generated 2026-09-01 by `grounding_lab.model_benchmark`.

- retriever: `qwen-0.6b` — `Qwen/Qwen3-Embedding-0.6B@97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3`
- claim mode: `bare`

| split | fallback claims | linkable | recall@10 | recall@20 | recall@30 | recall@50 | median query ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| validation | 50 | 25 | 13/25 | 14/25 | 17/25 | 21/25 | 87 |

Indexing seconds for requested split: 6.1
Peak CUDA allocation: 3.37 GiB
