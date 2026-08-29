# Studio

Model endpoints are served from same-origin `/api`. The production Node host reads `PARSING_SERVICE_URL`; Vite development may use `VITE_PARSING_SERVICE_URL` (default `http://127.0.0.1:8055`).

## Key architecture points

- The PDF viewer uses `pdfjs-dist`'s `PDFViewer` component with `AnnotationEditorType.HIGHLIGHT`. Only text-selection highlights are allowed; free rectangular highlights are blocked by intercepting `pointerdown` during the capture phase.
- `pdf.js` has no public event for editor add/remove. `App.tsx` monkey-patches `uiManager.addEditor` / `removeEditor` to keep the annotation sidebar in sync.
- Server code hot reloads. `server/developmentHost.ts`, wired by `apiFunctions` in `vite.config.ts`, recomposes the Hono application whenever a changed file belongs to Vite's SSR module graph — `server/`, `api/`, `shared/`, and the workspace packages, which are linked TypeScript sources Vite processes rather than externalizes. Invalidation runs upwards from the edited file through its importers, so the singletons its dependencies own stay loaded: the database pool in `packages/db/src/prisma/db.ts` is only rebuilt when that module itself changes, and the Extraction runtime keeps running unless `api/_extraction_runtime.ts` is re-evaluated, in which case the previous Batch Extraction worker is aborted and closed before the new one starts. The production Node host composes once at boot and has no such path.
- Development sessions survive a dev server restart. `scripts/free.mjs` generates one `FREE_SESSION_SECRET` per machine into the gitignored `.dev/session-secret` and passes it to Compose and the Dev Container, so a Vite restart no longer invalidates every session cookie. Because a code-split route module is fetched with that cookie and `/src/*.tsx` is not in `VITE_DEVELOPMENT_ASSETS`, a lost session answers a lazy import with the sign-in redirect; `src/RouteLoadBoundary.tsx` catches that, asks `/api/auth/session` whether the Researcher is still signed in, and either reports authentication-required (sign-in, drafts captured) or offers a reload — the tree never unmounts into a blank page.
- Every model operation resolves its provider from saved configuration through `resolveCapabilityRoute` in `api/_provider.ts`. There are no `AI_*` environment settings; `api/_environment.test.ts` fails the build if one reappears.
- Configuration routes are reached through `src/providerConfig/providerConfig.data.ts`. The browser never calls the Parsing Service; the server-side ingestion handler uses the configured Parsing Service URL.
- There is no hardcoded Source Document. Fresh migrations create zero Researcher Accounts and Project Contexts; Microsoft Entra-assigned Researchers are created locally on first sign-in, and authenticated Researchers create Project Contexts through Studio.
- Each rail row (`src/projectContexts/ProjectContextRail.tsx`) is a disclosure control: its chevron and name both only expand or collapse that Project Context's Source Documents, never navigate. Opening the Project Context page and adding a Source Document to it are actions in the row's own "•••" menu, reusing the same `addSources` queue the page's dropzone uses. Renaming and deleting still live only on the Project Context page (`src/projectContexts/ProjectContextPage.tsx`), routed at `/projects/:id`. Its dropzone (and the rail row's add action) submit PDFs sequentially through the same-origin Project Context ingestion route; each in-flight PDF renders as the card it will become, and an acknowledged ingestion replaces that card with its Source Document in one step. The queue itself lives in `ProjectContextsProvider`, so navigating away mid-queue never drops the PDFs still waiting. The handler retains each canonical package before its Source Document and revision 1 Source Representation become visible. Reopening reads the PDF, Markdown, and `parsed_document.v2` from `/api/project-contexts/{projectContextId}/source-representations/{sourceRepresentationId}/…`.

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

Docker Model Runner and vLLM *do* honor `chat_template_kwargs`. The archived change
above holds the per-provider probe evidence if NuExtract is ever served that way.
