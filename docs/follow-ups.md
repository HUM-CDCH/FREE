# Follow-ups

Tracked items deferred out of scope from completed changes. Each is independent
of the change that surfaced it.

## From `compose-model-features`

### 1. Verify the Ollama provider accepts the base64 `image_url` object shape

`make_image_content` (`shared/pdf.py`) emits OpenAI-style image parts:
`{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,…", "detail": "high"}}`.
`/extract` and `/markdown` now send page images through the default provider, but
the image path on `OllamaProvider` is untested. Confirm Ollama accepts the
`image_url: { url }` object shape; if it instead expects a bare string URL (or an
`images: [...]` field), adapt `OllamaProvider` accordingly. Add an image-content
provider test once the expected shape is known.

### 2. Reconcile the `CLAUDE.md` ↔ `config.py` default-provider drift

`CLAUDE.md` documents the NuExtract3 endpoint defaults (`NUEXTRACT3_BASE_URL`,
`NUEXTRACT3_MODEL`) while `config.py` carries its own default provider/base-url.
The two have drifted; reconcile the documented defaults with the code so a fresh
checkout points at the same model endpoint the docs describe.

### 3. Rename `template` → Schema Suggestion across the surface

Per `CONTEXT.md` terminology, the `template` concept is the **Extraction Schema**
produced by **Schema Suggestion**. The code still uses `template` widely
(`/generate-template`, `TemplateParser`, `requestTemplate`, `TemplateState`,
`decodeTemplateDone`, …). A dedicated rename change should align the vocabulary
end-to-end (endpoint path, backend symbols, frontend state/decoders, tests).
