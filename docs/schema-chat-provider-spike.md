# Gemma Schema-Tool Provider Spike

## Result

On 2026-07-17, the VPN-only Ollama endpoint at
`http://spark.cdch-dgxspark.lan.ku.dk:11434` was exercised through an AI SDK 7
`ToolLoopAgent` and `createAgentUIStreamResponse`. No API key was required.

All candidate models completed the same streamed, validated tool path:

| Model | Tool input | Validated output | UI tool parts | Completion |
| --- | --- | --- | --- | --- |
| `gemma4:12b-it-qat` | passed | passed | passed | passed |
| `gemma4:e4b-it-qat` | passed | passed | passed | passed |
| `gemma4:26b-a4b-it-qat` | passed | passed | passed | passed |

`gemma4:26b-a4b-it-qat` is the selected default. The other two models are
verified alternatives. Explicit operation names are required: when the schema
was underspecified, every candidate emitted `add` instead of the intended
`set`. The probe therefore asks for `set` explicitly and validates the
operation before returning tool output.

Unsupported `AI_CHAT_PROVIDER` values and model names outside the verified set
produce a clear JSON route error instead of reaching Ollama.

## Repeatable manual smoke

1. Connect to the institutional VPN.
2. From the repository root, install dependencies with `pnpm install`.
3. Run all verified candidates:

   ```bash
   pnpm --filter studio probe:schema-chat
   ```

   To probe one candidate only:

   ```bash
   pnpm --filter studio probe:schema-chat -- gemma4:26b-a4b-it-qat
   ```

The command fails unless each response contains tool-input availability,
validated tool output, streamed UI tool parts, the explicit `set` operation,
and a final stream completion event.

Production chat configuration selected by this spike:

```env
AI_CHAT_PROVIDER=ollama
AI_CHAT_MODEL=gemma4:26b-a4b-it-qat
AI_CHAT_BASE_URL=http://spark.cdch-dgxspark.lan.ku.dk:11434
```
