# Throughput measurement boundaries and primary sources

Research date: 2026-09-30. Existing deployment reports vLLM `0.29.1rc1.dev17+gd2d649e67.d20260913`. This note supplies measurement interpretation; it contains no benchmark results or optimization conclusions.

## Definitions used by this experiment

The captured deployed [vllm-stats-source.py](vllm-stats-source.py) is the authority for server timing. Its matching upstream revision resolves to [`d2d649e674c75425d2d6975c87eb89fd4d55fff8`](https://github.com/vllm-project/vllm/blob/d2d649e674c75425d2d6975c87eb89fd4d55fff8/vllm/v1/metrics/stats.py).

- Server TTFT is `iteration_timestamp - arrival_time` at the first output update (`update_from_output`, captured lines 471–473). Both timestamps are engine frontend wall-clock values; it includes processing until that frontend observes the initial engine output.
- Server decode duration is `last_token_ts - first_token_ts` (lines 549–551), using engine core monotonic timestamps. The first token belongs to prefill, so mean time per subsequent token is `decode_time / (num_generation_tokens - 1)` (lines 557–561). Report decode throughput as `(N - 1) / decode_seconds`; it is undefined for fewer than two tokens or zero decode duration.
- Generated-token count accumulates `len(output.new_token_ids)` (lines 464–475). Server end-to-end latency uses frontend iteration time minus arrival time when request completion is recorded (line 540).

Each serialized benchmark request uses before/after Prometheus sums to recover server TTFT and decode duration. A histogram sum difference is attributable to one request only when the matching count difference is exactly one and unrelated requests are absent. Verify completion/count deltas and actual token usage; do not divide the lifetime histogram sum by its lifetime count and label that a request measurement. This attribution rule is a consequence of cumulative counters, rather than a new vLLM timing boundary.

The benchmark preserves the existing nonstreaming `ResearchChat` request. A nonstreaming HTTP response delivers its completed JSON after generation: time to the first response byte is **not** TTFT. Client end-to-end latency spans the benchmark's caller boundary through complete response processing. It includes client, transport, and harness work; server TTFT and decode duration have the boundaries above. Do not reconstruct server decode duration by subtracting server TTFT from client latency.

## Supporting references and limits

Current [vLLM benchmark documentation](https://docs.vllm.ai/en/latest/benchmarking/cli/) describes a different, streaming-client measurement: TTFT starts at request send and ends at the first streamed output; its TPOT is `(client E2E - client TTFT) / (N - 1)`. That formula documents a client benchmark, and does not replace the deployed engine metric definitions. Streaming SSE may also bundle tokens, so chunk count is not output-token count.

The current [chat completion implementation](https://docs.vllm.ai/en/latest/api/vllm/entrypoints/openai/chat_completion/serving/) counts generated token IDs for completion usage and supports a final streaming usage chunk when `stream_options.include_usage=true`. For this nonstreaming experiment, record response `usage.completion_tokens` and crosscheck server generation-token metrics. Re-tokenizing visible JSON can miss reasoning or control tokens. The current docs are supplementary; deployed implementation and captured metrics govern observed counts.

The [serve CLI documentation](https://docs.vllm.ai/en/stable/cli/serve/) explicitly permits `--served-model-name` aliases. The current [model registry implementation](https://docs.vllm.ai/en/latest/api/vllm/entrypoints/openai/models/serving/) returns the API name in `id`, the underlying model path in `root`, and the configured context limit in `max_model_len`. Compare these with actual container arguments and cached checkpoint configuration/revision; a request's `model` string alone does not prove checkpoint identity.

The versioned [structured-output documentation](https://docs.vllm.ai/en/v0.11.0/features/structured_outputs.html) covers `response_format` JSON schema and `structured_outputs`, and warns about deprecated `guided_*` fields. Preserve the existing effective request body and configured backend across conditions; use the deployed version to resolve compatibility rather than converting request formats during the comparison.

[Automatic prefix caching documentation](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/) distinguishes prefill reuse from generation: it accelerates shared-prefix processing, not decoding new tokens. Disable harness **response** caching while retaining identical server prefix-cache settings and warmup/prompt treatment. A harness cache hit can avoid inference entirely; require one completed server request for every measured harness call to establish that inference occurred.
