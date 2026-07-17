# 01 — Prove Gemma schema-tool support

Status: ready-for-agent
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

- [ ] All three candidate models exercised through the actual agent + streaming route
- [ ] Tool input, validated output, streamed UI tool parts, and final completion verified
- [ ] Unsupported provider/model behavior maps to a clear route error
- [ ] Selected default (`gemma4:26b-a4b-it-qat`) and repeatable manual smoke procedure recorded
- [ ] Dependencies and lockfile updated; test, lint, and build green

## Blocked by

None - can start immediately.
