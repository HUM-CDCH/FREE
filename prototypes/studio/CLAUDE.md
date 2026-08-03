# Studio

Model endpoints are served from same-origin `/api`. Set `VITE_PARSING_SERVICE_URL` to override the parsing service URL (default `http://127.0.0.1:8000`).

## Key architecture points

- The PDF viewer uses `pdfjs-dist`'s `PDFViewer` component with `AnnotationEditorType.HIGHLIGHT`. Only text-selection highlights are allowed; free rectangular highlights are blocked by intercepting `pointerdown` during the capture phase.
- `pdf.js` has no public event for editor add/remove. `App.tsx` monkey-patches `uiManager.addEditor` / `removeEditor` to keep the annotation sidebar in sync.
- Every model operation resolves its provider from saved configuration through `resolveCapabilityRoute` in `api/_provider.ts`. There are no `AI_*` environment settings; `api/_environment.test.ts` fails the build if one reappears.
- Configuration routes are reached through `src/providerConfig/providerConfig.data.ts`; parsing routes stay under `VITE_PARSING_SERVICE_URL`.
- The hardcoded source document is `examples/Beretning_Ellekilde_8_13.pdf` (a Danish archaeological site report).

## Annotation modes

Sent to `/api/generate_schema`:

- `hints` — model designs the schema from the whole document, but every highlighted passage must be covered.
- `fields` — model derives the schema primarily from the highlighted passages.

## NuExtract prompting (raw prompts to Ollama)

NuExtract3 is driven with a **hand-built raw prompt**, not OpenAI-style
`chat_template_kwargs`. Historical control-channel evidence archived under
`openspec/changes/archive/2026-06-17-select-nuextract-control-channel/`
found the **Ollama** OpenAI-compatible endpoint silently ignores
`chat_template_kwargs` (`mode`, `template`, `enable_thinking`) — kwargs-only
requests come back as plain text. So `api/_model.ts` posts to Ollama's
`/api/generate` with `raw: true` and reconstructs the NuExtract control tokens
itself (`【task】`, `【template_start】`, `【document_start】…【document_end】`, trailing
`<think>` block), mirroring `nuextract.template.jinja`. Consequences when editing
schema/extraction prompts:

- **No `【instructions】` slot outside `structured` mode** (jinja only emits it for
  extraction). `template-generation` and `markdown` carry all guidance inline in
  the message body, so schema-suggestion guidance must *lead* the document parts —
  it's just message text, not a privileged slot.
- **Thinking is `structured`/`content` only.** The jinja forbids `enable_thinking`
  for `template-generation`/`markdown`; those always render the empty
  `<think></think>` (non-thinking) prompt.
- **Temperature:** NuExtract recommends `0.2` non-thinking / `0.6` thinking. We send
  `0.2` by default (`NON_THINKING_TEMPERATURE`); leaving it unset lets Ollama apply
  ~0.8, which produced noisy, instance-enumerated templates.

Docker Model Runner and vLLM *do* honor `chat_template_kwargs` — see the probe doc
for the per-provider channel if NuExtract is ever served that way.
