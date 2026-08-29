# NuExtract control-channel evidence

The 2026-06-17 provider probe compared NuExtract task controls supplied through
message text and OpenAI-compatible `chat_template_kwargs`.

- Ollama's OpenAI-compatible endpoint did not apply kwargs-only extraction
  controls; kwargs-only requests returned plain text.
- Docker Model Runner and vLLM accepted kwargs-only controls.
- When message text and kwargs conflicted, Docker Model Runner and vLLM
  followed message text. Duplicating task controls across both channels is
  therefore unsafe.

The durable consequence is one authoritative control channel per provider.
FREE's current Ollama integration uses the raw `/api/generate` protocol and
reconstructs NuExtract's prompt tokens rather than relying on
`chat_template_kwargs`.
