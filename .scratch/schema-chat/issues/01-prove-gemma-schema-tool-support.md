# 01 — Prove Gemma schema-tool support

Status: resolved
Type: task
Blocked by: none

## What to build

A credentialed spike proving a local Gemma model can drive the intended chat
path end to end: a `ToolLoopAgent` streamed through
`createAgentUIStreamResponse` via `ai-sdk-ollama`. Test `gemma4:12b-it-qat`,
`gemma4:e4b-it-qat`, and `gemma4:26b-a4b-it-qat` at the VPN-only Ollama
endpoint `http://spark.cdch-dgxspark.lan.ku.dk:11434` (no API key; requires
the institutional VPN — if unreachable, flip this issue to `needs-info`).
Add `@ai-sdk/react@4.0.16` (compatible with installed `ai@7.0.15`) and update
`pnpm-lock.yaml`.

`ai-sdk-ollama` has no capability discovery, so only a live run counts as
evidence. `gemma4:26b-a4b-it-qat` is the selected default; the other two are
verified alternatives.

## Acceptance criteria

- [x] All three candidate models exercised through the actual agent + streaming route
- [x] Tool input, validated output, streamed UI tool parts, and final completion verified
- [x] Unsupported provider/model behavior maps to a clear route error
- [x] Selected default (`gemma4:26b-a4b-it-qat`) and repeatable manual smoke procedure recorded
- [x] Dependencies and lockfile updated; test, lint, and build green

## Blocked by

None - can start immediately.

## Answer

Delivered an AI SDK 7 `ToolLoopAgent` probe using `createAgentUIStreamResponse`,
explicit schema operations, validated tool output, the selected
`gemma4:26b-a4b-it-qat` default, verified alternatives, and clear unsupported
provider/model route errors. Added a repeatable VPN smoke command and recorded
the existing live evidence in `docs/schema-chat-provider-spike.md`. Added
`@ai-sdk/react@4.0.16`, the probe runner dependency, lockfile updates, and
focused configuration/error regression tests.

Verified with `pnpm --filter studio test`, `pnpm --filter studio lint`, and
`pnpm --filter studio build`. Residual risk: live behavior remains
non-deterministic and the endpoint is available only on the institutional VPN;
the committed smoke command is therefore manual rather than part of routine CI.
