# Studio

## NuExtract raw Ollama prompts

Before changing the raw prompt construction in `api/_model.ts`, read the
provider evidence in
`../../openspec/changes/archive/2026-06-17-select-nuextract-control-channel/`.
Ollama's OpenAI-compatible endpoint ignored `chat_template_kwargs` in those
probes, so the Ollama path reconstructs the NuExtract control tokens and posts
to `/api/generate` with `raw: true`.

Only `structured` mode has an `【instructions】` slot. Guidance for
`template-generation` and `markdown` must lead the document content in the
message body. Keep non-thinking requests at the characterized `0.2`
temperature unless new provider evidence changes that contract.
