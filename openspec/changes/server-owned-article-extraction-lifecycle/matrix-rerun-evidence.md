# Article/Catalog 80-call matrix rerun

Rerun on 2026-08-11 against FREE revision `f46f42f`, using Ollama 0.32.7 with `hf.co/numind/NuExtract3-GGUF:Q4_K_M` and Codex CLI 0.147.0 with `gpt-5.6-luna` at low reasoning effort. The corpus and experiment manifests match the retained 32-call and 48-call probes.

The redacted per-call record is [`matrix-rerun-evidence.json`](matrix-rerun-evidence.json). It excludes prompts, source text, parsed values, and raw model output while retaining hashes, timings, token counts, finish reasons, contract validity, and aggregate scoring.

## Execution

| Matrix | Experiment | Calls | Contract-valid | Retries | Raw evidence SHA-256 |
|---|---|---:|---:|---:|---|
| Retained metadata comparison | `cbc6f1fc71a08ed713b63c1ae30c28fae8864272202802b50278f86054a5bced` | 32/32 | 31/32 | 0 | `e6e9dbda9431dbe3756dc42b88f4030d0617c6fe1fec95677a0bfc1c6868d270` |
| Retained strategy comparison | `b6c3be62fa464284440ec101f7a6028357d672eece04a5b6fc9b625d52da62a3` | 48/48 | 46/48 | 0 | `b6d86bed35a03f110e1f514fe908f84e624e71962d263e053b1a4df12d542001` |
| **Cumulative** | | **80/80** | **77/80** | **0** | |

All 80 provider invocations returned. The three rejected component contracts were usable transport responses terminated with `finishReason: "length"`:

- 32-call matrix: Zhang Ollama Article.
- 48-call matrix: Beretning Ollama normal Article and Article metadata-envelope alternative.

## Selected 48-call paths

| Path | Provider | Valid calls | Supported metadata | Grounded content metadata | Record/boundary result | Input / output tokens | Latency |
|---|---|---:|---:|---:|---|---:|---:|
| Article, one whole-source call | Ollama | 1/2 | 0/10 | 0/6 | 0/11 starts | 27,686 / 8,268 | 62.1 s |
| Article, one whole-source call | Codex | 2/2 | 10/10 | 6/6 | 11/11 starts, exact labels | 63,724 / 1,136 | 27.6 s |
| Catalog, metadata + discovery + record calls | Ollama | 8/8 | 8/10 | 4/6 | 10/11 exact starts; 7/10 exact labels and ends | 69,104 / 616 | 14.3 s |
| Catalog, metadata + discovery + record calls | Codex | 8/8 | 10/10 | 6/6 | 11/11 exact starts, labels, and ends | 217,006 / 1,308 | 64.5 s |

## Gate result

**Provider matrix release gate: blocked.** Codex passed the selected Article and Catalog path checks. The Ollama rerun did not: Article truncated and Catalog missed one exact start while grounding only 4/6 supported content metadata values. This confirms that `done_reason: length` must remain an incomplete outcome and that FREE must not silently fall back to another strategy or provider.

Follow-up minimization showed that the Article failure used an obsolete model-authored Evidence shape rather than the implemented values-only operation, while Catalog exposed unreliable heading hierarchy in the retained canonical source. See [`provider-gate-solution-space.md`](provider-gate-solution-space.md) for the 78-call follow-up and revised rollout recommendation.
