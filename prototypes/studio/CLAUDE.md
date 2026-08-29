# Studio

## NuExtract raw Ollama prompts

Before changing the raw prompt construction in `api/_model.ts`, preserve the
characterized provider behavior: Ollama's OpenAI-compatible endpoint ignored
`chat_template_kwargs`, so the Ollama path reconstructs the NuExtract control
tokens and posts to `/api/generate` with `raw: true`.

Only `structured` mode has an `【instructions】` slot. Guidance for
`template-generation` and `markdown` must lead the document content in the
message body. Keep non-thinking requests at the characterized `0.2`
temperature unless new provider evidence changes that contract.
