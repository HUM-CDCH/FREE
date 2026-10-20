# 0021: Deployment-owned Codex extraction

Date: 2026-10-20. Status: accepted; extends [0010](0010-serve-extraction-models-from-vllm.md).

## Context

A development laptop can run Studio, PostgreSQL and native PDF parsing, and a small OCR server, without enough
VRAM for the default extraction models. Studio already supports an operator-owned Codex login for schema work.
Using that login for extraction must preserve the existing durable operation, pinned requests, evidence and review.

## Decision

A deployment may select `KEI_EXTRACT_PROVIDER=codex-cli` and an explicit available model for both extraction roles.
The extraction listing discovers the login’s visible Codex models that support the low reasoning effort each call
requests; each role can select its own `codex:<model-id>`
without changing the configured default. Planning resolves these IDs locally and pins the selected provider.
The default remains vLLM. The Parsing Service contains the pinned standalone Codex executable and shares the
operator's login volume with Studio; researcher keys and Model Connections do not enter extraction execution.
Each provider call runs one ephemeral app-server turn in an empty directory. Tools, MCP, apps and delegation are
disabled. Unexpected tool requests or context compaction fail the call. Existing durable captures and checkpoints
own the exact request and reply; there is no second extraction or review path.
The adapter speaks the app-server protocol directly rather than through the `openai-codex` Python SDK (0.163.0),
which has no per-call deadline, does not page the model catalog, accepts approval requests by default, stops only
its direct child process, and adds a ~140 MB runtime wheel to every Parsing Service environment.

Codex exposes token usage after inference rather than an exact preflight tokenizer or a hard per-turn output cap.
The versioned `codex:utf8-budget-v1` policy reserves request UTF-8 bytes plus 12,288 framing tokens under a
65,536-token planning ceiling. Captures explicitly label this reservation as `upper_bound`. A completed reply is
accepted only when actual input usage fits its reservation, the reported model window covers the planning ceiling,
and actual output usage fits its reply reserve. The existing vLLM exact-count equality check remains unchanged.
A forward migration admits this adapter and policy while preserving fenced ownership, immutable captures, and
strict HTTP/native request validation.

## Consequences

Codex extraction uses the deployment's online account and its usage limits. It needs no local extraction model.
OCR remains independent. Small explicit counted budgets can be refused because the framing allowance consumes
them; larger bounded settings or full Article mode are appropriate. Output limits are verified after inference,
so they do not prevent the provider from generating more tokens before the call is rejected. A future policy
change must use another version; it must not reinterpret an existing capture.
