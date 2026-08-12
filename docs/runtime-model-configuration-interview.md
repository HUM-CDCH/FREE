# Runtime Model Configuration Interview Record

- **OpenCode session ID:** `ses_076220ee8ffethrL8xNXvEsXrm`
- **OpenCode session title:** Config backend and runtime routing plan
- **Scope:** Persisted OpenCode `question` tool parts in chronological order through the stated cutoff, with each `questions` array flattened and aligned by index to its persisted answer.
- **Extraction source:** `/home/gebbaro/.local/share/opencode/opencode.db`, table `part`, JSON column `data`
- **Cutoff:** `1784746486766` (2026-07-22 20:54:46 CEST, Architecture Check)
- **Manual compaction:** `1784736237809` (2026-07-22 18:03:57 CEST)
- **Exact question count:** 99 questions flattened from 97 qualifying tool parts

This is a historical Q&A ledger, not a normative specification. Later answers supersede earlier answers where they conflict. `CONTEXT.md` and accepted ADRs are the current normative sources for terminology and decisions; future OpenSpec artifacts will become the implementation specification when created.

## Direct Chat Exchanges

### D001 - 2026-07-22 14:47:31 CEST (`1784724451627`) - Initial Exploration Request

**User prompt (verbatim):**

```text
explore codebase, I need to implement the backend of config page

Runtime configuration API and credential handling
Define configuration types, persistence lifetime, connection probing, available-model discovery, and secret handling. APIs should return something like hasCredential, never the stored key.
Capability-specific runtime routing
Wire extraction/schema suggestion to one route and chat/schema editing to another. Connect the UI to the API and test local-only and mixed local/remote setups end to end.
```

**Outcome:** The read-only exploration found a disconnected configuration UI, environment-driven runtime selection, divergent provider behavior, and no durable configuration, credential, discovery, or browser-E2E infrastructure. It established the initial deployment, provider-scope, and persistence decisions recorded in [Q001-Q003](#q001---2026-07-22-145642-cest-1784725002240---deployment-boundary); later interview answers supersede the preliminary implementation sketch where they conflict.

### D002 - 2026-07-22 15:10:15 CEST (`1784725815939`) - Ask Matt Request

**User prompt (verbatim):**

```text
# Ask Matt

You don't remember every skill, so ask.

A **flow** is a path through the skills. Most paths run along one **main flow**, and two **on-ramps** merge onto it. Everything else is standalone, or a vocabulary layer that runs underneath.

## The main flow: idea → ship

The route most work travels. You have an idea and want it built.

1. **`/grill-with-docs`** — sharpen the idea by interview. Start here when you **have a codebase**: it's stateful, retaining what it learns in `CONTEXT.md` and ADRs. (No codebase? Use `/grill-me` — see Standalone. Both run the same `/grilling` primitive; `grill-with-docs` is the one that leaves a paper trail.)
2. **Branch — can you settle every question in conversation?** If a question needs a runnable answer (state, business logic, a UI you have to see), detour through a prototype, bridged by **`/handoff`** in both directions (see Crossing sessions):
   - **`/handoff`** out, then open a fresh session against that file,
   - **`/prototype`** to answer the question with throwaway code,
   - **`/handoff`** back what you learned, and reference it from the original idea thread.
3. **Branch — is this a multi-session build?**
   - **Yes** → **`/to-spec`** (turn the thread into a spec), then **`/to-tickets`** to split it into tracer-bullet tickets, each declaring its **blocking edges**. On a local tracker that's one file per ticket under `.scratch/<feature>/issues/`, worked blockers-first by hand; on a real tracker the edges become native blocking links, so any ticket whose blockers are done can be grabbed — kick off **`/implement`** per ticket, **clearing context between each one**.
   - **No** → **`/implement`** right here, in the same context window.

   Either way, **`/implement`** builds each issue by driving **`/tdd`** internally — one red-green slice at a time — then closes out by running **`/code-review`**, a two-axis review (Standards + Spec) of the diff, before committing. Reach for **`/tdd`** on its own when you just want to build a concrete behaviour test-first without a full spec, and **`/code-review`** on its own whenever you want to review a branch or PR against a fixed point.

### Context hygiene

Keep steps 1–3 in **one unbroken context window** — don't compact or clear until after `/to-tickets` — so the grilling, spec, and tickets all build on the same thinking. Each `/implement` then starts fresh, working from the ticket.

The limit on this is the **[smart zone](https://www.aihero.dev/ai-coding-dictionary/smart-zone)**: the window (~120k tokens on state-of-the-art models) within which the model still reasons sharply. If a session approaches it before `/to-tickets`, don't push on degraded — `/handoff` and continue in a fresh thread.

## On-ramps

A starting situation that generates work, then merges onto the main flow.

- **Bugs and requests piling up** → **`/triage`**. It moves issues through triage roles and produces agent-ready issues, which **`/implement`** later picks up.

  Triage is only for issues **you didn't create** — bug reports, incoming feature requests, anything that arrives raw. Tickets that `/to-tickets` produced are already agent-ready, so **don't triage them**.

- **Something's broken** → **`/diagnosing-bugs`**. For the hard ones: the bug that resists a first glance, the intermittent flake, the regression that crept in between two known-good states. It refuses to theorise until it has a **tight feedback loop** — one command that already goes red on *this* bug — then fixes with a regression test. Its post-mortem hands off to **`/improve-codebase-architecture`** when the real finding is that there's no good seam to lock the bug down.

- **A huge, foggy effort — a greenfield project or a huge feature build, too big for one session** → **`/wayfinder`**, the most cognitively demanding flow here. When the way from here to the destination isn't visible yet, it charts a **shared map** of **decision tickets** on the issue tracker and resolves them one at a time — producing **decisions, not deliverables** — until the fog is pushed back and the way is clear. Where **`/grill-with-docs`** sharpens an idea you can hold in one session, wayfinder is for the idea you can't — and it's slower and denser, so save it for exactly that, never a well-scoped feature.

  When the map clears, **it hands off, it doesn't build**: merge onto the main flow at **`/to-spec`**, which collapses the map's linked decisions into a buildable plan, then `/to-tickets` and `/implement` as usual. Looping the map straight into `/implement` skips that collapse and throws the linked detail away — go straight to `/implement` only when the effort turned out genuinely small.

## Codebase health

Not feature work — upkeep.

- **`/improve-codebase-architecture`** — run whenever you have a spare moment to keep the codebase good for agents to operate in. It surfaces **deepening opportunities**; picking one _generates an idea_ you can take into the main flow at `/grill-with-docs`. It's the survey that finds the candidates; **`/codebase-design`** (below) is the bench you design the chosen one on.

## Vocabulary underneath

Two model-invoked references that run *beneath* the other skills — each the single source of truth for its vocabulary. Reach for them directly when the **words**, not the process, are the problem; or let the skills above pull them in.

- **`/domain-modeling`** — sharpen the project's *domain* language: challenge a fuzzy term, resolve an overloaded word ("account" doing three jobs), record a hard-to-reverse decision as an ADR. It's the active discipline `/grill-with-docs` drives to keep `CONTEXT.md` a clean glossary.
- **`/codebase-design`** — the deep-module vocabulary (module, interface, depth, seam, adapter, leverage, locality) for designing a module's *shape*: a lot of behaviour behind a small interface at a clean seam. `/tdd` and `/improve-codebase-architecture` both speak it.

## Crossing sessions

- **`/handoff`** — when a thread is full or you need to branch off (e.g. into a `/prototype` session), this compacts the conversation into a markdown file. You don't continue in place — you **open a new session and reference that file** to carry the context across. It's the bridge between context windows, in either direction. Use it when you want a **fresh session** but need the **current conversation preserved**.
- **`/compact`** (built-in) — stay in the **same conversation**, letting the earlier turns be summarized. Use it at **intentional breaks between phases**, when you don't mind losing the verbatim history. Don't compact mid-phase — the agent can lose its way. `/handoff` forks; `/compact` continues.

## Standalone

Off the main flow entirely.

- **`/grill-me`** — the same relentless interview as `/grill-with-docs`, but for when you have **no codebase**. Stateless: it saves nothing locally, builds no `CONTEXT.md`. Reach for it to sharpen any plan or design that doesn't live in a repo.
- **`/prototype`** — a small, throwaway program that answers one design question: does this state model feel right, or what should this UI look like. Throwaway from day one — keep the answer, delete the code. It's the detour in step 2 of the main flow, but reach for it any time a design question is hard to settle on paper.
- **`/research`** — delegate reading legwork to a **background agent**: it investigates a question against **primary sources**, then leaves a cited Markdown file in the repo. Keep working while it reads. The file it produces is something to take *into* the main flow at `/grill-with-docs` — research feeds the thinking, it doesn't replace it.
- **`/teach`** — learn a concept over multiple sessions, using the current directory as a stateful workspace.
- **`/writing-great-skills`** — reference for writing and editing skills well.

## Precondition

**`/setup-matt-pocock-skills`** — run before your first engineering flow to configure the issue tracker, triage labels, and doc layout the other skills assume. Custom issue trackers also work.


Base directory for this skill: /home/gebbaro/.agents/skills/ask-matt
Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.

I'd like to challenge the plan with an interview and write decisions somewhere before creating docs openspec
```

**Outcome:** The request selected the stateful interview-and-decision-record flow. The interview recorded terminology in `CONTEXT.md` and decisions in ADRs 0006-0008 while leaving OpenSpec untouched. See [Q004-Q044](#q004---2026-07-22-151048-cest-1784725848078---configuration-scope).

### D003 - 2026-07-22 17:59:12 CEST (`1784735952708`) - Last-Options Question

**User prompt (verbatim):**

```text
what were the options you give me in the last question?
```

**Assistant answer (verbatim):**

```markdown
The last question offered:

1. **Shared understanding (Recommended)**: End grilling; decisions are ready for an OpenSpec change.
2. **Challenge scope**: Revisit what is included or deferred.
3. **Challenge UX**: Further stress-test page states and researcher workflows.
4. **Challenge architecture**: Revisit module seams, persistence, routing, or provider adapters.
```

### D004 - 2026-07-22 18:10:50 CEST (`1784736650951`) - Architecture And CQ Report

**User prompt (verbatim):**

```text
Challenge architecture

In code-quality assessment I could see that provider configuration is implemented twice and has already diverged. Also request, internal, and provider errors are collapsed into an inconsistent HTTP contract.

The main source of accidental complexity is the 411-line _model.ts, which combines chat, extraction orchestration, schema generation, provider construction, raw Ollama transport, prompt rendering, output post-processing, and schema editing. The main harmful duplication is provider configuration and schema-type vocabulary.

3. Prioritized findings

Effort uses relative sizing: XS, S, M, and L. “Refactor risk” estimates the chance of unintentionally changing existing behavior.

ID	Severity	Principle or smell	Evidence	Problem	Maintenance impact	Recommendation	Effort	Confidence
CQ-01	High	OCP, DIP, shotgun surgery, harmful duplication	_model.ts, chatModel: chat uses AI_CHAT_MODEL || DEFAULT_MODEL, where the default is llama3.2, and only explicitly branches for claude-code. _provider.ts separately validates providers and has provider-specific defaults, including a Claude default.	Chat/schema editing and extraction have independent provider-selection rules. With AI_PROVIDER=claude-code and no AI_CHAT_MODEL, chat passes the Ollama default model ID to the Claude provider. An unknown provider is rejected by extraction but falls through to Ollama in chatModel; codex-cli also implicitly falls through to Ollama for chat.	Provider changes require edits in several places and configuration errors produce endpoint-specific behavior. The Claude default is a likely runtime defect.	Create one readAiConfig(env) function that validates the provider and computes explicit extractionModelId and chatModelId. Keep two small factories if chat and extraction intentionally use different providers. Add a provider/purpose configuration matrix test. Benefit: one source of truth and elimination of the current default mismatch.	M; refactor risk medium-low	Verified; high
CQ-02	High	Inconsistent error model and incorrect boundary classification	_http.ts, modelError, maps every ordinary Error to HTTP 502 and returns detail as either a string or an object. Chat request Zod errors flow into it. Invalid extraction-template JSON also flows into it through bare JSON.parse. edit_schema.ts separately returns { error: ... } for some 400 responses.	Invalid client input, internal programming failures, PDF failures, and upstream model failures can all appear as 502 responses. Response bodies use multiple incompatible shapes.	Clients cannot reliably distinguish a request problem from a provider outage and may retry non-retryable requests. Internal defects are mislabeled as model failures, slowing diagnosis.	Use a small taxonomy: RequestError for 4xx, UpstreamModelError for 502, and default unexpected errors to 500. Return one stable body such as { error: { code, message, details? } }. Map Zod and request JSON failures to 400. Benefit: predictable UI behavior and materially easier debugging.	M; refactor risk medium because the response contract changes	Verified; high
CQ-03	Medium	SRP violation, god module, excessive centrality	_model.ts imports SDKs, PDF preparation, schema prompts, HTTP errors, evidence handling, output parsing, and provider selection. It implements chat, extraction, and schema generation. It also implements raw Ollama transport and prompt serialization. Finally, it defines schema-editing operations and calls the editing model.	The file has many unrelated reasons to change: chat behavior, provider SDK changes, NuExtract formatting, extraction response shape, environment configuration, and schema editing.	Safe changes require understanding a large central module. Tests mock global environment, fetch, and SDK imports because useful boundaries are private and colocated.	Split into focused modules such as chat_service.ts, extraction_service.ts, nuextract_transport.ts, and schema_edit_service.ts. Keep orchestration functions small and do not introduce a registry or DI framework. Remove unrelated re-exports from _model.ts. Benefit: smaller change surfaces and narrower tests.	M; refactor risk medium	Verified; high
CQ-04	Medium	Hidden degradation, inconsistent return contract, hidden side effect	parseExtractionResult warns to console and returns the raw object when the model violates the extraction schema. Tests explicitly preserve extra fields and incorrect primitive types while only asserting that a warning occurred.	A schema-invalid result is returned through the success path with no machine-readable indication that validation failed. The declared result is already only Record<string, unknown>, so callers receive no useful guarantee.	UI or downstream logic can treat a malformed result as valid. Validation information exists briefly but is lost, and logging is embedded in a parser.	Preserve partial output, but return { value, issues } from the parser and include validationIssues or schemaMatched in the API result. Move logging to the route/service boundary. Benefit: retains the MVP’s tolerant behavior without making degradation invisible.	S–M; refactor risk low	Verified; high
CQ-05	Medium	Swallowed errors, partial-success ambiguity	In editSchemaWithModel, a non-array model response becomes [], and individual invalid operations are silently discarded.	“The model produced invalid output” is indistinguishable from “no schema changes are needed.” A response containing several dependent operations can be partially accepted.	Users can see a silent no-op or an incomplete schema modification, while provider regressions remain hidden.	Validate the complete result using z.array(editSchemaOpSchema). On failure, throw a typed upstream-output error with concise validation issues. Derive EditSchemaOp from the schema with z.infer. Benefit: atomic, observable schema-edit results.	S; refactor risk low	Verified; high
CQ-06	Medium	Missing cancellation contract, hidden temporal coupling	Model input types have no AbortSignal. Generic generation and raw Ollama fetch do not receive a signal. Routes do not pass request.signal into extraction or schema generation.	There is no explicit application-level way to cancel non-streaming extraction or schema generation when the client disconnects or starts a replacement request.	Expensive LLM and PDF work may continue after its result is no longer wanted. Cancellation behavior will be difficult to add consistently after more providers are introduced.	Add signal?: AbortSignal to service inputs, pass request.signal from routes, and forward it to raw fetch and SDK calls where supported. Normalize aborts separately from failures. Benefit: predictable resource use and provider parity.	M; refactor risk medium, dependent on installed SDK capabilities	Verified absence; high
CQ-07	Medium	Responsibility confusion at JSON boundaries	parseUnknownJson performs model-output repair through cascadeRepairText and reports unrepaired syntax as a 502. edit_schema.ts uses that same function to parse client-supplied current_template. Other request fields use ordinary JSON.parse, creating different semantics.	Malformed client JSON may be silently repaired rather than rejected, while other malformed client JSON is not repaired. A model-output utility therefore controls request validation behavior.	The same malformed request can be accepted or rejected depending on the endpoint. Future changes to model repair can unintentionally change the public API.	Separate parseRequestJson from parseModelJson. Request parsing should be strict and yield 400; only generated model output should use repair. Benefit: explicit and testable boundary semantics.	S; refactor risk low	Verified; high
CQ-08	Medium	Invalid states representable, nullable data clump	DocumentInput independently permits nullable file, markdown, and pages. parseDocument can return both a valid file and Markdown after validating and wrapping the file. Later, documentContentParts silently gives Markdown priority and ignores the file.	Source selection is implicit. A valid Markdown body plus an unsupported file is rejected even though the file would never be used; a supported file can be copied and then ignored.	Adding fallback behavior, page metadata, or new source types will require more null checks and precedence rules. Tests must construct impossible states manually.	Replace the type with a discriminated union such as { kind: 'markdown'; markdown; pages } or { kind: 'file'; file }. At the request boundary, either reject both inputs or choose one through an explicit documented rule. Benefit: eliminates invalid states and hidden precedence.	S–M; refactor risk low	Verified; high
CQ-09	Medium	Harmful duplication, inconsistent domain vocabulary	Schema generation advertises verbatim-string, string, date, number, integer, and boolean. Schema editing advertises only string, number, boolean, object, and array. EditSchemaOp and its Zod schema accept any string for type. Output validation has another independent type-token switch.	The generator, editor, runtime validator, and TypeScript types do not share one schema vocabulary. The editing prompt can guide the model to lose date, integer, or verbatim-string semantics, while typos are accepted.	Adding or renaming a token requires shotgun edits and can produce schemas that different stages interpret differently.	Define one small SCHEMA_TYPE_TOKENS constant and Zod enum. Use it in prompt construction, edit-operation validation, and template validation. Keep object/array handling explicit. Benefit: one domain contract with compile-time and runtime consistency.	S–M; refactor risk low	Verified; high
CQ-10	Medium	Vague types and insufficient request validation	ExtractModelInput.template is unknown. The extraction route accepts any JSON value. Non-record templates are not evidence-wrapped, and output validation falls back to accepting any record.	Top-level arrays, strings, numbers, or malformed schema nodes can enter a pipeline that conceptually requires an object schema. Invalid input silently weakens validation rather than producing a clear 400 response.	Every consumer must handle a broader state space, and malformed templates can appear to work while losing schema guarantees.	Introduce a recursive ExtractionTemplate runtime schema with a required top-level record. Use the same structural validator for generated templates, but classify generated invalidity as an upstream error rather than 400. Benefit: clearer contracts and fewer defensive branches.	S–M; refactor risk low	Verified; high
CQ-11	Medium	Primitive obsession and shape-based misclassification	splitNode checks for an inline evidence wrapper before processing an ordinary object. The guard treats any record with value, string-or-null snippet, and number-or-null page as evidence. Schema-mismatched model output is deliberately returned raw and then passed into this splitter.	A legitimate domain object shaped like { value, snippet, page } can be collapsed into a scalar when it arrives through the permissive schema-mismatch path. The object’s meaning is inferred solely from field names and primitive types.	This can cause silent data loss precisely when model output is already degraded and hardest to reason about.	Drive evidence unwrapping from the wrapped template or a set of known evidence paths rather than duck-typing arbitrary output objects. Benefit: domain fields can safely use common names without colliding with transport metadata.	M; refactor risk medium	Inferred from verified control flow; high
CQ-12	Medium	Lost error causes, incomplete resource cleanup, under-tested core path	PDF conversion catches any Error and returns null; pdfFileParts then throws a new generic error without the cause. A page is cleaned up only after successful rendering. The only PDF-module test covers the non-PDF image branch.	PDF parsing and rendering failures lose their actionable cause. If rendering throws before page.cleanup(), only document cleanup is guaranteed. The actual PDF fallback is unprotected by tests.	Library upgrades or malformed PDFs can fail with little diagnostic evidence. Cleanup regressions and page-order/output regressions can go unnoticed.	Let conversion throw a typed error with cause, use a per-page try/finally for cleanup, and test one successful small PDF plus one render failure. Benefit: diagnosable and safer fallback behavior.	M; refactor risk medium-low	Verified; high
CQ-13	Medium	Inconsistent evidence invariant	Evidence wrappers declare page as number, and the splitter accepts any positive number before silently applying Math.trunc. The instruction describes a 1-based page index, while the validator already supports an integer token.	A value such as 2.9 is considered evidence and converted to page 2 without reporting that the model violated the page contract.	Incorrect page citations undermine the feature’s source-grounding value and make model regressions harder to detect.	Model evidence pages as positive integers, reject or flag fractional pages, and remove implicit truncation. Benefit: evidence remains traceable to an exact page.	XS–S; refactor risk low	Verified; high
CQ-14	Low	LSP/capability mismatch	Public extraction and schema inputs accept temperature. Generic Codex and Claude calls omit it even when supplied, while generic Ollama defaults to 0 and raw NuExtract defaults to 0.2.	The same API option has different semantics by provider, and some implementations silently ignore an explicitly supplied value.	Users cannot tell whether tuning is active. Provider substitution changes behavior beyond the selected model.	Add a simple provider capability such as supportsTemperature. Reject an explicitly unsupported value or return a warning; document intentional provider-specific defaults. Benefit: honest and predictable option handling.	S; refactor risk low	Verified; high
CQ-15	Low	Misleading test, false confidence	The test named “repairs malformed Ollama JSON” supplies {"grave":[{"name":"verbatim-string"}]}, which is valid JSON.	The repair branch is not exercised despite the test name claiming that it is.	A change that breaks cascadeRepairText integration could pass the suite. Reviewers may assume malformed and unrecoverable cases are covered.	Replace the fixture with genuinely malformed but repairable JSON and add an unrecoverable case asserting the typed error. Benefit: the test verifies its stated risk.	XS; refactor risk very low	Verified; high
4. Duplication report
Exact duplication
Locations	Classification	Assessment
Provider defaults, environment access, and Ollama construction in _model.ts and _provider.ts	Harmful	This duplication has already diverged and caused CQ-01. Consolidation is strongly recommended.
Schema type labels in _schema.ts, the edit-schema prompt, EditSchemaOp, and primitiveSchemaFromLabel	Harmful	These represent the same domain concept and should change together. Consolidate into one token definition.
EditSchemaOp TypeScript union and editSchemaOpSchema	Harmful but localized	Derive the TypeScript type with z.infer; this is a small change that prevents drift.
isRecord in _evidence_template.ts and _model_output.ts	Acceptable	It is a three-line local type guard. A shared utils.ts would add navigation cost without meaningful benefit.
Structural duplication

The route handlers repeat try/catch → modelError. At the current route count, this is clearer than adding a generic route framework. Correct the error mapper first; consider a tiny wrapper only if more endpoints appear.

Generic-provider and NuExtract generation follow similar high-level flows, but their request protocols are materially different. The current separation is appropriate. Consolidate shared result and capability contracts, not the actual prompt renderers.

Behavioral duplication

JSON handling exists in three forms:

strict JSON.parse,
Zod parsing,
repair-oriented parseUnknownJson.

The problem is not that all three exist; it is that their boundary semantics are mixed. Request data should use strict parsing and 400 responses. Provider output may use repair and 502 responses.

Provider capabilities are also encoded behaviorally in several places: provider selection, renderer selection, model defaults, and direct string checks on model.provider. This should become one small validated configuration object.

Acceptable duplication

The following should remain local unless their behavior grows:

route-level form extraction,
short isRecord helpers,
raw NuExtract and generic-provider prompt paths,
provider-specific tests that assert externally relevant behavior.
5. SOLID assessment
Principle	Status	Evidence and most important point	Recommended improvement	Justified for MVP?
Single Responsibility	Mixed	Route handlers and evidence transformation are focused. _model.ts combines at least five independently changing concerns.	Split by chat, extraction orchestration, raw NuExtract transport, and schema editing.	Yes. This is a moderate module split, not enterprise layering.
Open/Closed	Weak	Adding a provider requires changes to _provider.ts, chatModel, renderer rules, capability checks, and tests.	Centralize provider configuration and explicit capabilities. Do not create a plugin system.	Yes. Current duplication has already diverged.
Liskov Substitution	Mixed	Providers share the same extraction entry point, but temperature behavior and default selection differ, and unsupported options are silently ignored.	Make supported capabilities and defaults explicit at the provider boundary.	Yes, for temperature and model selection; broader provider polymorphism can wait.
Interface Segregation	Mixed	Service input types are small, but DocumentInput uses several nullable fields to model incompatible source variants.	Use a discriminated document-source union.	Yes. It simplifies both runtime code and tests.
Dependency Inversion	Mixed	Important behavior directly reads process.env, constructs SDK clients, uses global fetch, and relies on module-level Codex state. Tests therefore stub globals and inspect provider internals.	Pass a resolved configuration and narrow generation functions into orchestration modules. Plain factory functions are sufficient.	Yes, but only at the configuration and transport seams. A DI framework is not justified.
```

**Outcome:** The report was reconciled against the runtime-configuration design rather than adopted wholesale. The immediate architectural seam became a request-scoped immutable execution target, while later scope review separated runtime configuration from broader CQ follow-ups. See [Q045](#q045---2026-07-22-182003-cest-1784737203341---resolver-result); the later CQ disposition is recorded in Q057-Q068.

### D005 - 2026-07-22 18:39:38 CEST (`1784738378314`) - Minimum-LOC Question

**User prompt (verbatim):**

```text
explain more, what do you suggest to reduce at minimum the lines of code?
```

**Assistant answer (verbatim):**

````markdown
To minimize **maintainable code surface**, I recommend a smaller architecture than the assessment’s four-service split.

**Minimal Shape**
1. Keep `_model.ts` as one orchestration module for the four model operations.
2. Remove all configuration, provider construction, credential lookup, and raw HTTP setup from `_model.ts`.
3. Add only `_model_config.ts` for validated JSON persistence and keyring access.
4. Evolve `_provider.ts` into the single provider module containing one provider table, discovery/probing, factories, capabilities, and route resolution.
5. Keep `_http.ts` as the single error-to-HTTP mapper.

The central interface would be only:

```ts
resolveCapabilityRoute(
  capability: "extraction" | "interaction",
): Promise<ExecutionTarget>
```

```ts
type ExecutionTarget =
  | {
      profile: "general";
      model: LanguageModel;
      jsonOutput: "native" | "prompt";
      supportsTemperature: boolean;
      attribution: ModelAttribution;
    }
  | {
      profile: "nuextract-raw";
      generate(request: RawGenerationRequest): Promise<string>;
      attribution: ModelAttribution;
    };
```

Each operation resolves this once. Credentials, connection records, provider defaults, SDK construction, and raw Ollama URLs never escape the provider module.

**Why This Is Smaller**
- No `ModelGateway` class.
- No provider classes or one-file-per-provider structure.
- No dependency-injection framework or composition-root module.
- No separate `chat_service.ts`, `extraction_service.ts`, and `schema_edit_service.ts`.
- No duplicated frontend provider metadata.
- No `readAiConfig(env)` compatibility layer because the environment variables are being removed.
- No generic transport abstraction shared between materially different AI SDK and raw NuExtract protocols.

Use one literal provider table:

```ts
const PROVIDERS = {
  ollama: { metadata, discover, createModel, createRawGenerator },
  openai: { metadata, discover, createModel },
  anthropic: { metadata, discover, createModel },
  google: { metadata, discover, createModel },
  "codex-cli": { metadata, discover, createModel },
  "claude-code": { metadata, discover, createModel },
  "openai-compatible": { metadata, discover, createModel },
} satisfies ProviderRegistry;
```

That table becomes the single source for:

- Backend provider metadata
- Model discovery
- Provider construction
- Credential requirements
- JSON-output and temperature capabilities

**Small Additional Reductions**
- Define schema types once as a Zod enum and derive TypeScript types with `z.infer`.
- Use one `ApiError` carrying `status`, `code`, and optional details instead of several error classes.
- Strictly parse request JSON; reserve repair parsing for model output.
- Keep route-level `try/catch` blocks rather than adding a route framework.
- Delete `_provider.ts` environment defaults and `chatModel()` rather than wrapping them.
- Do not split `_model.ts` merely to reduce its line count. Once provider/configuration code is removed, its remaining orchestration is substantially more cohesive.

This absorbs CQ-01, CQ-02, CQ-03, CQ-07, CQ-09, and CQ-14 without turning all fifteen findings into a prerequisite refactor. CQ-04 through CQ-06 and CQ-08 through CQ-13 can remain targeted follow-ups unless required by the runtime-configuration contract.
````

### D006 - 2026-07-22 19:03:26 CEST (`1784739806707`) - AI SDK v7 Question

**User prompt (verbatim):**

```text
does it leverage ai sdk v7?
```

**Assistant answer (verbatim):**

````markdown
Yes, for the general-model path. I would refine the target so FREE does not reimplement AI SDK v7’s model abstraction:

```ts
type ExecutionTarget =
  | {
      profile: "general";
      model: LanguageModel;
      jsonOutput: "native" | "prompt";
      supportsTemperature: boolean;
      attribution: ModelAttribution;
    }
  | {
      profile: "nuextract-raw";
      generate(request: RawGenerationRequest): Promise<string>;
      attribution: ModelAttribution;
    };
```

AI SDK v7 then supplies:

- `LanguageModel` as the common interface across official and CLI providers.
- `generateText` for extraction, schema suggestion, and schema editing.
- `streamText` and `convertToModelMessages` for chat.
- `Output.json()` for providers that support native schema-less JSON.
- `Output.object()` or `Output.array()` for fixed Zod-validated outputs such as schema edits.
- `abortSignal` and `timeout` on both `generateText` and `streamText`.
- Standalone `toUIMessageStream` plus `createUIMessageStreamResponse` for current v7 chat streaming and attribution metadata.

The current `result.toUIMessageStreamResponse()` works in v7 but is deprecated and should be replaced.

FREE should add only concerns AI SDK does not provide: persisted Model Connections, Capability Routes, keyring references, model discovery catalogs, product-level capabilities, and sanitized Model Attribution. I would not wrap `generateText`/`streamText` in a universal provider adapter because AI SDK already is that adapter.

The sole exception is NuExtract raw Ollama execution. Its hand-built control tokens, `raw: true`, image handling, and `/api/generate` protocol intentionally bypass AI SDK. That remains the second member of the discriminated union.

I also would **not** add AI SDK’s `createProviderRegistry`. It maps provider-qualified IDs to models, but does not represent FREE’s multiple saved connections, discovery, keyring credentials, execution profiles, or attribution. Using it alongside FREE’s required provider table would add rather than remove code.
````

**Interview continuation:** The answer was refined into direct `LanguageModel` exposure, one orchestrator, one `ApiError`, one typed provider table, per-operation configuration reads, and concrete capability fields. See [Q046-Q054](#q046---2026-07-22-190508-cest-1784739908745---sdk-seam).

### D007 - 2026-07-22 19:13:56 CEST (`1784740436588`) - Capability-Probing Question

**User prompt (verbatim):**

```text
could we probe for capabilities and cache them?
```

**Assistant answer (verbatim):**

```markdown
We could, but it would increase code and produce weaker guarantees for the capabilities under discussion.

AI SDK v7’s `LanguageModel` exposes provider ID, model ID, supported URL patterns, and generate/stream operations. It does **not** expose “supports temperature” or “supports native JSON response format.” FREE would need to discover those behaviorally by making a generation request.

That creates several problems:

- It contradicts the settled rule that discovery does not perform paid test generation.
- A successful JSON response proves one prompt worked, not that native JSON mode is reliably supported.
- Providers may silently ignore temperature rather than reject it, so a probe cannot detect support reliably.
- Results become stale when model versions, endpoint implementations, credentials, or provider packages change.
- The cache needs provenance, timestamps, invalidation rules, and an `unknown` state.
- OpenAI-compatible endpoints vary too widely for one successful probe to establish a durable contract.

I recommend caching only inexpensive observations: connectivity, authentication, model catalogs, and any explicit capability metadata returned by a provider. Protocol behavior should remain a small adapter declaration. The generic OpenAI-compatible adapter should be conservative, using prompt-only JSON unless its guaranteed contract says otherwise.
```

**Interview continuation:** Metadata-only advisory discovery and concrete adapter-declared capabilities were retained; the remaining architecture and scope challenge continued through final confirmation. See [Q055-Q099](#q055---2026-07-22-191428-cest-1784740468673---capability-probing).

## Interactive Interview Questions

### Q001 - 2026-07-22 14:56:42 CEST (`1784725002240`) - Deployment Boundary

**Question:** What deployment boundary should this runtime configuration target? Local Ollama and local CLI providers only make sense when Studio's API runs on the researcher's machine.

- **Trusted local process (Recommended):** Single researcher, localhost API; custom local/remote provider URLs are allowed.
- **Shared remote deployment:** Multi-researcher/serverless; requires auth, per-researcher storage, encrypted secrets, and SSRF controls.
- **Support both:** Design storage, auth, networking, and provider availability for local and hosted modes now.

**Answer:** Trusted local process (Recommended)

### Q002 - 2026-07-22 14:56:42 CEST (`1784725002240`) - Provider Scope

**Question:** Which provider set must the first implementation actually support? The page advertises more than the backend can execute today.

- **Ollama + OpenAI (Recommended):** Covers local-only and local-Ollama/remote-OpenAI mixed routing with manageable scope.
- **All page providers:** Add Ollama, OpenAI, Anthropic, Google, Codex CLI, and Claude Code together.
- **Current backend only:** Support Ollama, Codex CLI, and Claude Code; remove or disable unsupported page choices.

**Answer:** All page providers

### Q003 - 2026-07-22 14:56:42 CEST (`1784725002240`) - Persistence Lifetime

**Question:** How long should configuration and entered credentials survive?

- **Process lifetime (Recommended):** Survives page reloads, resets on Studio restart; credentials remain memory-only and env config seeds startup.
- **Durable local machine:** Persist routes/connections across restarts and store credentials in the OS keyring.
- **Durable shared storage:** Persist per researcher in a database with server-side encryption and authenticated access.

**Answer:** Durable local machine

### Q004 - 2026-07-22 15:10:48 CEST (`1784725848078`) - Configuration Scope

**Question:** Should Model Connections and Capability Routes be machine-wide for the researcher, or vary by Project Context? My recommendation is machine-wide for both: they describe the local FREE runtime, avoid exposing infrastructure choices as project data, and match the current single-researcher prototype. The cost is that changing a route affects every Project Context on that machine.

- **Machine-wide (Recommended):** One durable connection catalog and route map for all Project Contexts.
- **Per Project Context:** Every Project Context owns separate connections, credentials, and routes.
- **Global connections, local routes:** Credentials are machine-wide, but each Project Context chooses its models.

**Answer:** Machine-wide (Recommended)

### Q005 - 2026-07-22 15:11:35 CEST (`1784725895105`) - Trust Boundary

**Question:** May the Studio configuration API ever be reached from another machine, for example by binding Vite to a LAN address? My recommendation is no: configuration and credential mutation remain loopback-only, with Host/Origin checks, and any future shared deployment must introduce authentication and a different secret store rather than inheriting this API unchanged.

- **Loopback only (Recommended):** Local browser and process only; reject LAN/remote configuration access.
- **Trusted LAN:** Allow other machines on a private network without researcher authentication.
- **Remote-ready now:** Add authentication and remote-safe storage/network controls in this change.

**Answer:** Loopback only (Recommended)

### Q006 - 2026-07-22 15:12:33 CEST (`1784725953755`) - Connection URLs

**Question:** What URL policy should Model Connections enforce? My recommendation is HTTP only for loopback addresses and HTTPS everywhere else. This supports local Ollama and remote providers without silently sending Source Document content or credentials unencrypted across a LAN; custom proxy/gateway URLs remain allowed.

- **Loopback HTTP, remote HTTPS (Recommended):** Allow custom URLs; reject unencrypted non-loopback destinations.
- **Allow any HTTP or HTTPS:** Trust the researcher to assess LAN and remote transport security.
- **Provider defaults only:** Disallow custom endpoints except the default local Ollama address.

**Answer:** Allow any HTTP or HTTPS

### Q007 - 2026-07-22 15:14:25 CEST (`1784726065653`) - Keyring Failure

**Question:** What should happen when the OS credential store is unavailable, common on headless Linux? My recommendation is fail closed for credentials entered in the page: do not persist plaintext or invent machine-local encryption, but continue allowing credential-free connections and legacy environment credentials. The UI should explain how to enable a keyring or use environment configuration.

- **Fail closed (Recommended):** Never persist entered keys outside the OS keyring; environment credentials remain usable.
- **Memory-only fallback:** Use entered credentials until Studio restarts, clearly marking them non-durable.
- **Protected config file:** Write credentials to a permission-restricted local file when keyring access fails.

**Answer:** considering windows and mac the most common os

### Q008 - 2026-07-22 15:15:44 CEST (`1784726144925`) - Fallback Decision

**Question:** Given Windows and macOS are the primary targets, should FREE fail credential saves when no secure keyring is available, while still allowing credential-free and environment-configured connections?

- **Yes, fail closed (Recommended):** Optimize for native Windows/macOS stores and expose a clear unsupported-state error elsewhere.
- **Use memory fallback:** Accept keys temporarily on machines without secure storage.
- **Use local file fallback:** Persist keys with filesystem permissions when no keyring exists.

**Answer:** Yes, fail closed (Recommended)

### Q009 - 2026-07-22 15:16:21 CEST (`1784726181273`) - Provider Contracts

**Question:** Does “all page providers” include arbitrary OpenAI-compatible servers such as vLLM or LM Studio, or exactly Ollama, OpenAI, Anthropic, Google, Codex CLI, and Claude Code? My recommendation is exactly those six. A custom base URL still works only when it preserves the selected provider’s API contract; remove the current “any OpenAI-compatible server works” claim rather than create an underspecified seventh adapter.

- **Exactly six (Recommended):** Six explicit contracts; custom URLs may proxy the selected native provider.
- **Add OpenAI-compatible:** Create a seventh generic provider with explicit Chat Completions semantics.
- **Replace native APIs:** Treat all remote APIs through one OpenAI-compatible adapter where possible.

**Answer:** Add OpenAI-compatible

### Q010 - 2026-07-22 15:17:21 CEST (`1784726241661`) - Compatible API

**Question:** Which contract should the generic OpenAI-compatible connection guarantee? My recommendation is `/v1/models` plus `/v1/chat/completions`, including streaming and JSON response formatting where the server supports it. Native OpenAI remains a separate provider using its native SDK/Responses behavior.

- **Chat Completions (Recommended):** Broad vLLM, LM Studio, and gateway compatibility with a clear minimum contract.
- **Responses API:** Require newer `/v1/responses` compatibility instead.
- **Selectable protocol:** Add a per-connection Chat Completions versus Responses setting now.

**Answer:** Chat Completions (Recommended)

### Q011 - 2026-07-22 15:17:48 CEST (`1784726268657`) - Route Failure

**Question:** If a Capability Route is unset, its Model Connection is deleted, or its model becomes unavailable, should FREE ever fall back to another connection or the legacy environment configuration? My recommendation is no: fail that capability with an actionable configuration error. Silent fallback can send a Source Document to an unintended remote provider and make evaluation results irreproducible.

- **Never fall back (Recommended):** Configured routes are authoritative; invalid routes fail explicitly.
- **Fallback to environment:** Use legacy environment settings when a runtime route cannot execute.
- **Fallback to other route:** Try the connection assigned to the other capability family.

**Answer:** Never fall back (Recommended)

### Q012 - 2026-07-22 15:18:23 CEST (`1784726303696`) - Route Granularity

**Question:** Should FREE expose exactly two Capability Routes, or independent routes for all four operations? My recommendation is exactly two: Extraction covers extraction and Schema Suggestion; Interaction covers document chat and conversational Extraction Schema editing. This matches their model requirements and keeps the page understandable.

- **Exactly two (Recommended):** Extraction and Interaction are the complete runtime routing surface.
- **Four operation routes:** Configure extraction, schema suggestion, chat, and schema editing separately.
- **One plus overrides:** Use one default route with optional per-operation overrides.

**Answer:** for now exatly two, but make it easy to extend and compose them in the future

### Q013 - 2026-07-22 15:19:55 CEST (`1784726395024`) - Probe Requirement

**Question:** Must a Model Connection pass its probe before it can be saved or assigned to a Capability Route? My recommendation is no: probes report `untested`, `connected`, `authentication_failed`, or `unreachable`, but durable configuration remains editable while a local server is stopped. Routes may be saved in a non-ready state and then fail explicitly at execution time.

- **Probe is advisory (Recommended):** Allow offline setup; status controls readiness messaging, not persistence.
- **Probe required to save:** Reject new or changed connections unless discovery succeeds.
- **Probe required to route:** Connections may be saved offline, but cannot be assigned until connected.

**Answer:** Probe is advisory (Recommended)

### Q014 - 2026-07-22 15:20:51 CEST (`1784726451446`) - Model Selection

**Question:** When discovery is unavailable or omits a valid model, may the researcher enter a model identifier manually? My recommendation is yes: discovery supplies suggestions, not an allowlist. Preserve the selected identifier across failed probes and label whether it was discovered or entered manually.

- **Allow manual IDs (Recommended):** Discovery is advisory and offline/custom models remain configurable.
- **Discovered models only:** Routes can select only identifiers returned by the latest successful probe.
- **Manual only when offline:** Hide manual entry after any successful discovery.

**Answer:** Discovered models only

### Q015 - 2026-07-22 15:23:31 CEST (`1784726611943`) - Discovery Lifetime

**Question:** After a successful probe, should FREE persist that model catalog and preserve a route if a later probe no longer lists its selected model? My recommendation is yes: retain the selected route but mark it `model_unavailable`; prevent new selection of absent models and never silently replace it.

- **Preserve and mark unavailable (Recommended):** Avoid silent route mutation while enforcing discovered-only selection.
- **Clear the route:** Automatically remove routes whose model disappears.
- **Keep catalog indefinitely:** Continue treating every previously discovered model as selectable.

**Answer:** Preserve and mark unavailable (Recommended)

### Q016 - 2026-07-22 15:24:32 CEST (`1784726672231`) - Ollama Extraction

**Question:** How should the Extraction Route treat Ollama models? NuExtract requires its raw control-token protocol, while general Ollama models require the generic JSON prompt. My recommendation is to support both and persist an explicit `NuExtract` versus `General model` execution profile with the route; provider name or model-name guessing must not decide it invisibly.

- **Explicit profile (Recommended):** Support both protocols and make the Extraction Route’s model profile explicit.
- **NuExtract only:** Only recognized NuExtract models may serve the Extraction Route through Ollama.
- **Infer from model name:** Automatically use raw mode when the identifier contains `nuextract`.

**Answer:** Explicit profile (Recommended)

### Q017 - 2026-07-22 15:26:03 CEST (`1784726763754`) - Chat Context

**Question:** Should document chat continue sending the original PDF to the Interaction Route, or use FREE’s parsed Source Document Markdown for every provider? My recommendation is Markdown: it works with local and remote text models, avoids repeatedly embedding the PDF in chat history, and makes route changes provider-neutral. The trade-off is losing visual/layout information in chat.

- **Parsed Markdown (Recommended):** One provider-neutral document representation for document chat.
- **Original PDF:** Require Interaction models to accept PDF input.
- **Provider-dependent:** Send PDF where supported and Markdown elsewhere.

**Answer:** parsed markdown or I was thinking about docling output (see parsing_service)

### Q018 - 2026-07-22 15:27:28 CEST (`1784726848107`) - Document Representation

**Question:** Should this change standardize Interaction calls on current canonical Markdown, while leaving a future provider-neutral Source Context projection from `ParsedDocument.v2` as a separate decision after v2 ships? My recommendation is yes; never send raw Docling JSON directly to model providers.

- **Markdown now, v2 later (Recommended):** Unblocks routing and preserves the canonical parsing boundary.
- **Wait for ParsedDocument v2:** Block runtime configuration until the structured semantic stream ships.
- **Use raw Docling JSON:** Send parser-native structure directly to model providers.

**Answer:** Markdown now, v2 later (Recommended)

### Q019 - 2026-07-22 15:28:00 CEST (`1784726880031`) - Environment Precedence

**Question:** How should legacy `AI_*` environment variables interact with saved runtime configuration? My recommendation is bootstrap-only: when no saved configuration exists, expose an environment-derived starting configuration; after the researcher saves, the durable configuration is authoritative until explicitly reset. Continuous environment overrides would make the page lie about effective routes.

- **Bootstrap only (Recommended):** Saved configuration wins completely; reset returns to environment-derived defaults.
- **Environment always wins:** Environment variables override fields edited in the page.
- **Merge per field:** Use saved values where present and environment values for missing fields.

**Answer:** remove duplication, I want to use as few lines of code as possible

### Q020 - 2026-07-22 15:29:08 CEST (`1784726948741`) - Single Source

**Question:** Should the runtime configuration page completely replace `AI_PROVIDER`, `AI_MODEL`, `AI_CHAT_MODEL`, `AI_BASE_URL`, and `AI_API_KEY`, leaving a fresh install unconfigured until the researcher saves routes? My recommendation now is yes, based on your priority to remove duplication and minimize code.

- **Replace AI variables (Recommended):** One durable source of truth; update README and delete environment routing.
- **Keep bootstrap import:** Preserve current environment setup only until first save.
- **Keep environment overrides:** Maintain two ongoing configuration sources.

**Answer:** Replace AI variables (Recommended)

### Q021 - 2026-07-22 15:29:40 CEST (`1784726980729`) - Configuration Writes

**Question:** Should the backend expose connection CRUD endpoints, or replace the complete small configuration document atomically? My recommendation is `GET/PUT /api/runtime_config` plus `POST /api/probe_connection`: fewer handlers and client states, atomic connection/route edits, and no temporary dangling references. `PUT` carries a revision and write-only credential actions.

- **Whole-document PUT (Recommended):** Small interface, atomic updates, optimistic revision check.
- **CRUD endpoints:** Separate create/update/delete connection and route operations.
- **Command endpoint:** One endpoint with many named mutation commands.

**Answer:** explain in more detail

### Q022 - 2026-07-22 15:30:44 CEST (`1784727044593`) - Configuration Writes

**Question:** With those atomicity and interface trade-offs, which write model should FREE use?

- **Whole-document PUT (Recommended):** One small versioned configuration resource plus a separate probe operation.
- **CRUD endpoints:** Independently mutate connections and routes through multiple endpoints.
- **Command endpoint:** Send named operations such as addConnection and assignRoute.

**Answer:** Whole-document PUT (Recommended)

### Q023 - 2026-07-22 15:31:26 CEST (`1784727086082`) - Probe Timing

**Question:** Should opening the configuration page automatically contact every Model Connection? My recommendation is no: `GET` stays local and deterministic, showing the last persisted catalog and check time; the researcher explicitly refreshes a connection, while saving a new connection may trigger a probe as a convenience. Automatic probing can delay the page, wake local models, and leak presence to remote providers.

- **Explicit refresh (Recommended):** No network on GET; probe only through deliberate test/refresh actions.
- **Probe on page open:** Refresh every connection whenever configuration loads.
- **Probe stale entries:** Automatically probe only when the saved check exceeds a time limit.

**Answer:** Explicit refresh (Recommended)

### Q024 - 2026-07-22 15:31:56 CEST (`1784727116757`) - Save Behavior

**Question:** Should saving or applying configuration automatically run a probe? My recommendation is no: Save only validates and persists; Test/Refresh explicitly probes a saved or unsaved connection. This keeps advisory network state out of the write transaction and minimizes combined failure paths.

- **Save without probing (Recommended):** Persistence and network observation are separate deliberate actions.
- **Probe after save:** Persist first, then automatically refresh status and models.
- **Probe before save:** Automatically test every changed connection before persistence.

**Answer:** I want to Use as few lines of code as possible but make the best ux possible

### Q025 - 2026-07-22 15:33:10 CEST (`1784727190153`) - Save And Test UX

**Question:** Should FREE keep Save and Test as separate explicit actions to minimize behavior and keep offline saving possible?

- **Separate Save and Test (Recommended):** Smallest predictable interface; route selection unlocks after successful discovery.
- **Save then auto-test:** One click, but adds hidden network work and partial-failure handling.
- **Test then auto-save:** One click when online, with a separate offline-save escape hatch.

**Answer:** Save then auto-test

### Q026 - 2026-07-22 15:33:46 CEST (`1784727226045`) - Single Model Mode

**Question:** How should the page’s “Single model” mode relate to advanced routing? My recommendation is that it is only a simpler view of the same configuration: choose one saved Model Connection and discovered model, then Apply assigns both Capability Routes atomically. Do not maintain a second provider/key workflow or separate state.

- **One config, simpler view (Recommended):** Single mode assigns both routes through the shared connection catalog.
- **Keep inline API setup:** Single mode separately creates/reuses API connections and credentials.
- **Remove single mode:** Expose only connections and the two Capability Routes.

**Answer:** One config, simpler view (Recommended)

### Q027 - 2026-07-22 15:34:40 CEST (`1784727280149`) - CLI Authentication

**Question:** Should Codex CLI and Claude Code sign-in appear as `hasCredential: true` even though FREE neither stores nor controls those credentials? My recommendation is no: provider metadata declares `credentialMode: managed | optional | external`; `hasCredential` refers only to a key stored by FREE, while CLI probe status separately reports installed/authenticated.

- **Separate external auth (Recommended):** Avoid implying FREE owns CLI tokens or can clear them.
- **Treat as credential present:** Use one boolean for stored keys and external CLI login.
- **Hide authentication state:** Only report whether the CLI executable is detected.

**Answer:** Separate external auth (Recommended)

### Q028 - 2026-07-22 15:36:28 CEST (`1784727388980`) - Data Egress UX

**Question:** Because arbitrary HTTP/HTTPS destinations are allowed, when should FREE warn that Source Document content will leave the machine? My recommendation is a one-time confirmation when a Capability Route is assigned to a non-loopback connection, plus a persistent `Remote` label showing the destination host. Never interrupt each model call.

- **Confirm on route assignment (Recommended):** Explicit informed choice with persistent destination visibility.
- **Persistent label only:** Show Local/Remote and host, with no confirmation dialog.
- **Confirm every call:** Require approval before each remote model request.

**Answer:** not important

### Q029 - 2026-07-22 15:38:24 CEST (`1784727504557`) - Egress Decision

**Question:** Should I record that FREE provides no special remote-egress warning beyond displaying the configured Model Connection URL?

- **No special warning (Recommended):** Connection URL is visible; no label or confirmation behavior is required.
- **Keep persistent label:** Show Local/Remote without a confirmation step.
- **Keep confirmation:** Require confirmation when assigning a remote route.

**Answer:** No special warning (Recommended)

### Q030 - 2026-07-22 15:38:42 CEST (`1784727522945`) - Configuration Store

**Question:** Where should non-secret runtime configuration persist? My recommendation is one versioned JSON file in the platform configuration directory, written atomically. The data is tiny, machine-wide, and single-writer; SQLite would add schema/migration/dependency surface without useful concurrency or query capability.

- **Versioned JSON (Recommended):** Minimal local store with atomic replacement and schema version.
- **SQLite:** Use a local database shared with future FREE persistence.
- **Browser storage:** Keep non-secret configuration in localStorage while keys remain server-side.

**Answer:** Versioned JSON (Recommended)

### Q031 - 2026-07-22 15:39:13 CEST (`1784727553592`) - Concurrent Edits

**Question:** Does the local configuration need optimistic revision checks for two Studio tabs editing at once? Given the single-researcher, loopback-only scope and your code-surface priority, my recommendation is to drop revisions and use atomic last-write-wins. A revision conflict flow adds server and UI states for a rare case.

- **Last write wins (Recommended):** Atomic file replacement, no conflict protocol.
- **Revision conflicts:** Reject stale whole-document writes with HTTP 409.
- **File locking only:** Serialize writes but do not detect stale browser state.

**Answer:** Last write wins (Recommended)

### Q032 - 2026-07-22 15:41:07 CEST (`1784727667609`) - Model Capability

**Question:** Should discovery guarantee that every listed model can perform the selected FREE capability? Provider model-list endpoints often include embeddings/audio and do not consistently expose streaming or structured-output support. My recommendation is no: discovery means “reported by this provider”; use reliable metadata where available, but do not make paid test generations or brittle model-name allowlists. Incompatible selections fail explicitly when used.

- **Availability only (Recommended):** No paid probes or guessed capability catalog.
- **Run capability probes:** Test each model with real generation before offering it.
- **Maintain allowlists:** FREE ships and updates provider/model capability tables.

**Answer:** Availability only (Recommended)

### Q033 - 2026-07-22 15:42:38 CEST (`1784727758334`) - Claude Models

**Question:** Claude Code exposes authentication status but no model-list command. Under the discovered-only rule, what should FREE offer? My recommendation is to expose the CLI’s documented aliases (`fable`, `opus`, `sonnet`, `haiku`) after a successful auth probe and label their source as built-in, while Codex continues using true dynamic discovery.

- **Built-in aliases (Recommended):** Claude Code remains usable without pretending the aliases were dynamically listed.
- **No Claude models:** Do not support Claude Code until it exposes model discovery.
- **Allow manual Claude IDs:** Create a provider-specific exception to discovered-only selection.

**Answer:** Built-in aliases (Recommended)

### Q034 - 2026-07-22 15:43:16 CEST (`1784727796774`) - Structured Output

**Question:** For the generic Extraction profile, should FREE use each provider’s native structured-output feature or one JSON-only prompt plus the existing parser/repair path? My recommendation is one generic prompt/parser for all providers. Claude Code does not support schema-less `Output.json()`, OpenAI-compatible servers vary, and provider-specific output modes would multiply branches. NuExtract raw remains the sole specialized path.

- **One generic JSON path (Recommended):** Maximum provider portability and smallest execution surface.
- **Native per provider:** Use each provider’s structured-output mechanism where available.
- **Native with fallback:** Try provider-native output and retry through generic prompting.

**Answer:** I want to leverage AI sdk v7, it should be easy to use native when avaiable?

### Q035 - 2026-07-22 15:46:38 CEST (`1784727998103`) - Output Strategy

**Question:** Should provider adapters declare `nativeJsonOutput`, letting the shared generic generator use AI SDK `Output.json()` when supported and JSON-only prompting otherwise? My recommendation is yes: it keeps one execution module, uses native output for official providers, and handles Claude Code/OpenAI-compatible limitations without retry complexity.

- **Adapter capability (Recommended):** Native output where verified; one prompt-based alternative where unavailable.
- **Always native AI SDK:** Require every provider and compatible server to honor `Output.json()`.
- **Always prompt JSON:** Avoid all native response-format features.

**Answer:** Adapter capability (Recommended)

### Q036 - 2026-07-22 15:47:33 CEST (`1784728053708`) - Runtime Host

**Question:** Is this change responsible for adding a distributable local Node host for Studio’s `/api` handlers, or only for making the existing local development prototype work? My recommendation is prototype only: retain `api/*.ts` and Vite’s local middleware, declare hosted Vercel unsupported for runtime configuration, and defer packaging a local production host.

- **Local prototype only (Recommended):** No new server or desktop packaging in this change.
- **Add local Node host:** Create a production local server for Studio assets and model APIs.
- **Move to FastAPI:** Put runtime configuration and model routes into the parsing service.

**Answer:** Local prototype only (Recommended)

### Q037 - 2026-07-22 15:48:15 CEST (`1784728095360`) - End-to-End Scope

**Question:** What should “end to end” mean for local-only and mixed routing? My recommendation is two Playwright browser tests using fake provider servers: configure through the real modal, reload durable state, then trigger representative Extraction and Interaction calls and assert which fake server received them. All four endpoint-to-capability mappings remain covered by faster Vitest route tests.

- **Playwright plus route tests (Recommended):** Real UI-to-backend proof without exercising every document workflow twice.
- **HTTP integration only:** Test handlers, store, keyring adapter, and fake providers without a browser.
- **Full four-flow browser tests:** Drive schema suggestion, extraction, chat, and schema editing in both setups.

**Answer:** Playwright plus route tests (Recommended)

### Q038 - 2026-07-22 15:49:22 CEST (`1784728162366`) - CLI Connections

**Question:** Can the researcher create multiple Codex CLI or Claude Code Model Connections? They would all use the same executable and external login because the page exposes no profile/path settings. My recommendation is no: each CLI kind is a singleton connection that can be added once, probed, routed, and deleted; HTTP providers may have multiple connections.

- **One per CLI kind (Recommended):** Avoid duplicate records that behave identically.
- **Allow duplicates:** Treat CLI connections like arbitrary named HTTP connections.
- **Auto-create CLI entries:** Always show both built-in CLI connections, even before they are probed.

**Answer:** One per CLI kind (Recommended)

### Q039 - 2026-07-22 15:50:54 CEST (`1784728254573`) - Model Provenance

**Question:** Should each model operation return a sanitized snapshot of the Capability Route it actually used? My recommendation is yes: include provider, connection ID, model ID, and Extraction profile where relevant, but never credentials. The frontend can retain it with the result now and a future persistence layer can store it for reproducibility.

- **Return route snapshot (Recommended):** Results remain attributable after runtime configuration changes.
- **No provenance yet:** Keep existing response shapes and infer effective configuration only at call time.
- **Extraction only:** Record model provenance for extraction/schema suggestion but not interaction calls.

**Answer:** Return route snapshot (Recommended)

### Q040 - 2026-07-22 15:52:06 CEST (`1784728326311`) - Advanced Save

**Question:** When should advanced connection/route edits persist? My recommendation is one explicit `Save changes` action for the complete configuration. The page already edits local state, and this maps directly to atomic whole-document PUT; closing discards unsaved changes. Auto-saving each control would recreate partial-order and error states.

- **Explicit Save changes (Recommended):** One atomic commit for all advanced edits.
- **Auto-save every edit:** Persist each connection and route control immediately.
- **Save per section:** Connections and routes have separate save actions.

**Answer:** Explicit Save changes (Recommended)

### Q041 - 2026-07-22 15:53:45 CEST (`1784728425223`) - Provider Catalog

**Question:** Where should provider names, default URLs, credential mode, and supported probe behavior be defined? My recommendation is once in the backend provider registry and returned with `GET /api/runtime_config`; the frontend renders that catalog instead of maintaining `API_PROVIDERS` and `CONNECTION_KINDS` duplicates.

- **Backend catalog (Recommended):** One source of provider truth shared through the configuration response.
- **Shared static module:** Frontend and backend import one common TypeScript provider catalog.
- **Duplicate metadata:** Keep presentation metadata in the frontend and execution metadata in the backend.

**Answer:** Backend catalog (Recommended)

### Q042 - 2026-07-22 15:54:23 CEST (`1784728463648`) - Future Composition

**Question:** What future extensibility should this design preserve? My recommendation is only that new named Capability Routes and operation-to-capability mappings can be added without changing provider adapters. Each current route still selects exactly one connection/model; chains, ensembles, and fallback routes are explicitly deferred.

- **Add capability families (Recommended):** Extensible keyed route map, but one target per route.
- **Prepare route chains:** Model routes as ordered multi-provider pipelines now.
- **Prepare operation composition:** Allow one operation to invoke several named capability routes now.

**Answer:** what do you mean by operation composition?

### Q043 - 2026-07-22 15:56:34 CEST (`1784728594706`) - Future Composition

**Question:** Which extension should the current design prepare for?

- **Add capability families (Recommended):** New named routes can be added later; one route per current operation.
- **Multi-route operations:** Design pipeline composition and multi-model attribution now.
- **Fallback chains:** Design ordered alternative providers now.

**Answer:** Add capability families (Recommended)

### Q044 - 2026-07-22 15:58:41 CEST (`1784728721381`) - Shared Understanding

**Question:** Have we reached a shared understanding strong enough to end the interview, or should we challenge another area before creating OpenSpec artifacts?

- **Shared understanding (Recommended):** End grilling; the decisions are ready to become an OpenSpec change.
- **Challenge scope:** Revisit what is included or explicitly deferred.
- **Challenge UX:** Stress-test page states and researcher workflows further.
- **Challenge architecture:** Revisit module seams, persistence, routing, or provider adapters.

**Answer:** Shared understanding (Recommended)

## Manual Compaction Boundary

Manual compaction occurred here at `1784736237809` (2026-07-22 18:03:57 CEST). Q001 through Q044 precede that boundary and were recovered from persisted OpenCode database history rather than from the compacted context.

### Q045 - 2026-07-22 18:20:03 CEST (`1784737203341`) - Resolver Result

**Question:** What should resolving an Extraction Route or Interaction Route return to model orchestration?

- **Execution target (Recommended):** Return an immutable general-model or NuExtract-raw target with capabilities and sanitized attribution; hide configuration, credentials, and provider construction.
- **Configuration snapshot:** Return validated route, connection, model, and credential data; orchestration or factories construct providers. Smaller initial change, but leaks complexity and invites duplication.
- **Operation gateway:** Return a gateway that performs extraction, schema suggestion, chat, and schema editing itself. Hides the most, but forces a broad subsystem rewrite now.

**Answer:** Execution target (Recommended)

### Q046 - 2026-07-22 19:05:08 CEST (`1784739908745`) - SDK Seam

**Question:** Should the general Execution Target expose AI SDK v7's `LanguageModel` directly, leaving FREE to wrap only the raw NuExtract exception?

- **Expose LanguageModel (Recommended):** Lowest code surface; use AI SDK directly for generation, streaming, structured output, cancellation, and provider interoperability.
- **Wrap AI SDK:** Expose FREE-owned generate/stream methods. More isolation, but duplicates SDK concepts and adds adapter code.
- **Use SDK registry:** Resolve provider-qualified IDs through createProviderRegistry. Does not cover FREE connection/discovery/credential semantics and adds a second registry.

**Answer:** Expose LanguageModel (Recommended)

### Q047 - 2026-07-22 19:06:08 CEST (`1784739968755`) - Model Module

**Question:** After provider resolution, credentials, and raw transport leave `_model.ts`, should its four operation workflows remain together?

- **Keep one orchestrator (Recommended):** Minimum code surface. Retain four exported workflows and existing focused helpers; reassess size after deleting duplicated provider/configuration logic.
- **Split by capability:** Create extraction and interaction orchestration modules. Clearer route ownership, but adds files/imports and some repeated setup.
- **Split by operation:** Create four modules for extraction, schema suggestion, chat, and schema editing. Best locality per workflow, but highest code and navigation surface.

**Answer:** Keep one orchestrator (Recommended)

### Q048 - 2026-07-22 19:07:02 CEST (`1784740022820`) - Error Contract

**Question:** How much error architecture should this change introduce while correcting the inconsistent HTTP contract?

- **One ApiError (Recommended):** One class with status, stable code, message, and optional details/cause; one `{ error: { code, message, details? } }` body. Unknown errors become 500.
- **Error subclasses:** Separate RequestError, ConfigurationError, and UpstreamModelError classes. More semantic types, but more declarations and mapping code.
- **Mapper only:** Keep current errors and improve modelError heuristics. Fewest edits, but classification remains dependent on where errors originated.

**Answer:** One ApiError (Recommended)

### Q049 - 2026-07-22 19:07:49 CEST (`1784740069473`) - Provider Shape

**Question:** How should the seven provider kinds share metadata, construction, discovery, and capabilities?

- **One typed table (Recommended):** A backend literal keyed by provider kind; each entry supplies metadata, discovery, model creation, and capabilities. UI metadata is derived from it.
- **Several switch functions:** Keep metadata, discovery, and construction as separate switches. Straightforward locally, but provider additions require synchronized edits.
- **Provider modules:** One module or class per provider implementing a common interface. More extensible, but substantially more files and boilerplate.

**Answer:** One typed table (Recommended)

### Q050 - 2026-07-22 19:08:17 CEST (`1784740097570`) - Config Loading

**Question:** Should model execution cache the saved configuration in process memory, or read a fresh immutable snapshot for each operation?

- **Read per operation (Recommended):** One small local JSON read per model call; simplest consistency model, no invalidation or mutable singleton, and attribution comes from the same snapshot.
- **Process cache:** Cache after first read and replace on PUT. Avoids trivial disk reads, but adds synchronization and stale-state paths.
- **Watch file:** Maintain a cache updated by filesystem events. Supports external editing, but conflicts with the API-owned configuration model and adds complexity.

**Answer:** Read per operation (Recommended)

### Q051 - 2026-07-22 19:09:32 CEST (`1784740172425`) - Credential Save

**Question:** Should the whole-document configuration PUT also carry transient credential changes, or should credentials have a separate endpoint?

- **One PUT (Recommended):** Send `{ config, credentials? }` on explicit Save; secrets are written to keyring but omitted from JSON. Smallest UI and HTTP surface.
- **Separate endpoint:** Save credentials independently from non-secret configuration. Cleaner resource separation, but adds requests, UI state, and partial-save behavior.
- **Transactional facade:** One PUT with rollback across file and keyring operations. Strongest illusion of atomicity, but substantial complexity over two non-transactional stores.

**Answer:** One PUT (Recommended)

### Q052 - 2026-07-22 19:09:58 CEST (`1784740198707`) - Save Atomicity

**Question:** What atomicity should the single PUT promise across the JSON file and the OS keyring, which cannot share a real transaction?

- **JSON atomic only (Recommended):** Validate first, write requested credentials idempotently, then atomically replace JSON. A rare JSON failure may leave an orphaned keyring entry, but never plaintext or an active partial config.
- **Compensating rollback:** Read old secrets and restore them if JSON replacement fails. Stronger behavior, but more secret handling and failure branches.
- **Config first:** Atomically replace JSON, then update keyring. Simplest write ordering, but a credential failure leaves active configuration without its requested credential.

**Answer:** JSON atomic only (Recommended)

### Q053 - 2026-07-22 19:10:33 CEST (`1784740233294`) - Save Probes

**Question:** How should Save perform the agreed automatic probes of changed Model Connections?

- **Probe within PUT (Recommended):** After commit, probe changed connections concurrently with timeouts, persist advisory results, and return the final document. One request and no job state.
- **Frontend probes:** PUT first, then the page calls a probe endpoint for each changed connection. Faster save response, but more client orchestration and races.
- **Background probes:** Return immediately and probe in process. Requires polling or push updates and risks losing work when the process exits.

**Answer:** Probe within PUT (Recommended)

### Q054 - 2026-07-22 19:11:14 CEST (`1784740274213`) - Capabilities

**Question:** How extensible should provider/model capabilities be in the first implementation?

- **Only concrete fields (Recommended):** Type only behavior currently needed, such as JSON mode, temperature support, discovery mode, and allowed execution profiles.
- **Generic capability map:** Store arbitrary named capability flags for future features. More extensible, but adds validation and unused states.
- **Infer dynamically:** Inspect provider/model IDs at execution time. Lowest metadata, but repeats the current hidden string-check problem.

**Answer:** what do you mean by hidden string-check problem?

### Q055 - 2026-07-22 19:14:28 CEST (`1784740468673`) - Capability Probing

**Question:** Should FREE preserve metadata-only discovery, or perform generation calls to infer model capabilities?

- **Metadata only (Recommended):** Cache connectivity, authentication, catalogs, and explicit provider metadata; keep protocol capabilities as typed adapter declarations.
- **Active generation probes:** Run small model calls and cache observed behavior. Potentially paid and slow, with uncertain/stale results.
- **Learn on use:** Infer capability failures from real operations and cache them. Avoids probe calls but makes first-use behavior unpredictable and needs error heuristics.

**Answer:** Metadata only (Recommended)

### Q056 - 2026-07-22 19:15:02 CEST (`1784740502323`) - Capability Fields

**Question:** For those adapter declarations, should we model only capabilities used by current code or introduce an extensible capability map?

- **Concrete fields (Recommended):** Use typed `jsonOutput` and `temperature` fields plus the existing execution-profile discriminator. Add fields only when behavior needs them.
- **Capability map:** Use arbitrary capability names and values for future expansion. More flexible, but weaker typing and more unused states.
- **Per-provider logic:** Let each adapter decide options internally without exposing capabilities. Smaller target type, but orchestration cannot explain or validate option behavior.

**Answer:** Concrete fields (Recommended)

### Q057 - 2026-07-22 19:15:53 CEST (`1784740553073`) - Cancellation

**Question:** Should this architecture absorb CQ-06 by threading `request.signal` through all four operations now?

- **Add now (Recommended):** AI SDK v7 already accepts `abortSignal`; the raw target forwards it to fetch. Establishes one cancellation contract with little code.
- **Defer entirely:** Keep this change focused on configuration. Fewer touched signatures now, but every new provider path starts without cancellation.
- **AI SDK only:** Pass signals to generateText/streamText but not raw NuExtract. Smallest edit, but preserves provider inconsistency.

**Answer:** Add now (Recommended)

### Q058 - 2026-07-22 19:19:37 CEST (`1784740777407`) - Schema Vocabulary

**Question:** Should this change also eliminate the duplicated schema-type vocabulary identified in CQ-09?

- **Centralize now (Recommended):** One Zod enum and inferred TypeScript type used by schema prompts, edit operations, and validation. Small change with immediate deletion and drift prevention.
- **Defer:** Keep runtime-model configuration isolated. Smaller immediate diff, but known incompatible vocabularies remain in touched orchestration.
- **Redesign schemas:** Replace the current token vocabulary with a richer recursive schema model. Stronger contract, but significantly expands scope.

**Answer:** Centralize now (Recommended)

### Q059 - 2026-07-22 19:20:33 CEST (`1784740833730`) - Invalid Extraction

**Question:** When model JSON is parseable but does not match the Extraction Schema, what contract should extraction use?

- **Partial plus issues (Recommended):** Return the partial value with machine-readable validation issues; unwrap evidence from known schema paths rather than object shape.
- **Reject as upstream error:** Return a typed 502 and no partial result. Smallest and strongest contract, but loses usable model output.
- **Keep silent tolerance:** Return the raw object as success and only log a warning. Fewest changes, but preserves invisible degradation and evidence collision risk.

**Answer:** Partial plus issues (Recommended)

### Q060 - 2026-07-22 19:21:02 CEST (`1784740862954`) - Invalid Schema Edits

**Question:** When conversational schema editing returns any invalid operation, should valid-looking operations from the same model response still be applied?

- **Reject all (Recommended):** Validate the complete operation array and return one typed upstream-output error. Atomic and distinguishes invalid output from a real no-op.
- **Return issues:** Return valid operations plus validation issues and let the UI decide. Flexible, but introduces partial-application state and more contract code.
- **Discard invalid ops:** Keep silently filtering individual operations. Fewest edits, but preserves incomplete and unobservable schema changes.

**Answer:** how does it work now?

### Q061 - 2026-07-22 19:22:06 CEST (`1784740926391`) - Invalid Schema Edits

**Question:** Given the current silent filtering, what should happen when any returned schema-edit operation is invalid?

- **Reject all (Recommended):** Validate the complete array and return a typed upstream-output error; a genuine empty array remains the only no-op.
- **Return issues:** Return valid operations plus validation issues for UI review. Preserves partial work but adds partial-application state.
- **Keep filtering:** Apply only valid operations and hide invalid ones. Minimum code change, but invalid output remains indistinguishable from model intent.

**Answer:** Keep filtering

### Q062 - 2026-07-22 19:23:43 CEST (`1784741023273`) - Wrong Edit Shape

**Question:** If schema-edit output is not an array at all, should it still be treated as “no changes needed”?

- **Return upstream error (Recommended):** Reserve `[]` for an intentional no-op; wrong top-level shape becomes a typed 502 while individual invalid operations are still filtered.
- **Treat as no-op:** Preserve current behavior exactly. Smallest implementation, but malformed output can produce a false “No changes needed” message.

**Answer:** Treat as no-op

### Q063 - 2026-07-22 19:24:13 CEST (`1784741053156`) - JSON Boundaries

**Question:** Should client-supplied JSON remain repairable, or should repair apply only to model output?

- **Strict requests (Recommended):** Use strict JSON parsing and 400 errors for request data; reserve cascade repair for generated model output.
- **Repair both:** Preserve forgiving parsing for current_template and model output. More permissive, but request semantics depend on a model-output utility.
- **Strict everywhere:** Remove repair entirely. Lowest parser complexity, but model formatting defects become hard failures.

**Answer:** what do you mean by client-supplied JSON?

### Q064 - 2026-07-22 19:25:42 CEST (`1784741142168`) - JSON Boundaries

**Question:** Should request data use strict JSON parsing while generated model output retains repair?

- **Strict requests (Recommended):** Malformed browser/API JSON is a 400; only generated text may use cascade repair.
- **Repair both:** Continue attempting to repair malformed current_template requests as well as generated output.
- **Strict everywhere:** Reject malformed model output too and remove cascade repair.

**Answer:** Strict requests (Recommended)

### Q065 - 2026-07-22 19:28:58 CEST (`1784741338768`) - Document Source

**Question:** Should the backend make document source an explicit union and reject requests containing both Markdown and a file?

- **Use union, reject both (Recommended):** Model `{ kind: 'markdown' } | { kind: 'file' }`; eliminates nullable combinations and hidden precedence with no current UI behavior change.
- **Use union, prefer Markdown:** Model one source internally but keep accepting both by explicitly selecting Markdown. Preserves external permissiveness, including ignored uploads.
- **Keep nullable object:** Avoid touching document parsing. Fewest edits, but retains invalid states and implicit source precedence.

**Answer:** Keep nullable object

### Q066 - 2026-07-22 19:36:42 CEST (`1784741802852`) - Evidence Pages

**Question:** Should fractional evidence pages continue being truncated, or become extraction validation issues?

- **Require integers (Recommended):** Accept only positive integer pages; fractional values are reported in validation issues and are not silently changed.
- **Keep truncation:** Preserve `Math.trunc` behavior. Fewer edits, but a model citation such as 2.9 silently becomes page 2.
- **Round values:** Convert to the nearest page. Convenient, but invents citation precision not supplied by the model.

**Answer:** Require integers (Recommended)

### Q067 - 2026-07-22 19:37:36 CEST (`1784741856918`) - Attribution Shape

**Question:** What should the sanitized Model Attribution snapshot contain?

- **Identity fields (Recommended):** Route, connection ID/name, provider kind, model ID, and execution profile. No URL, credential state, or provider response metadata.
- **Include endpoint:** Also snapshot a sanitized base URL. Better endpoint traceability, but requires reliable redaction and may expose machine/network details.
- **Reference only:** Return connection ID and model ID only. Smallest payload, but later connection edits erase provider/profile context.

**Answer:** what is the scope of this? let's remain on config runtime

### Q068 - 2026-07-22 19:38:39 CEST (`1784741919381`) - Attribution Scope

**Question:** For the runtime-configuration change, should public Model Attribution remain included or be deferred with the other operation-output changes?

- **Defer public attribution (Recommended):** Resolver still knows its target, but operation response and chat-stream attribution become a separate follow-up; amend ADR 0007 accordingly.
- **Keep attribution:** Preserve the prior requirement that all four operations return route/connection/model/profile identity in this change.

**Answer:** Defer public attribution (Recommended)

### Q069 - 2026-07-22 19:40:12 CEST (`1784742012398`) - Config Location

**Question:** Where should the machine-wide non-secret JSON document live?

- **OS user config dir (Recommended):** Use the platform convention under XDG config, Application Support, or APPDATA. Correct lifecycle for one local researcher across projects.
- **Home .free directory:** Use `~/.free/model-config.json` everywhere. Less path code, but ignores platform conventions.
- **Repository local:** Store beneath the Studio prototype. Simplest path, but configuration becomes checkout-specific rather than machine-wide.

**Answer:** repo local and add to gitignore

### Q070 - 2026-07-22 19:41:22 CEST (`1784742082030`) - Configuration Scope

**Question:** Should we rename the scope to reflect repository-local persistence?

- **Studio-instance-wide (Recommended):** Configuration belongs to this local Studio checkout/process and applies across its Project Contexts; update glossary and ADR terminology.
- **Keep machine-wide:** Use the existing term despite separate checkouts having independent ignored files.
- **Use OS config dir:** Reconsider the storage choice so the existing machine-wide term remains accurate.

**Answer:** Use OS config dir

### Q071 - 2026-07-22 19:42:05 CEST (`1784742125848`) - Keyring Failure

**Question:** If the OS keyring is unavailable, should credentialless and externally authenticated connections still work?

- **Degrade safely (Recommended):** Configuration remains readable; Ollama and externally authenticated CLIs can work. Saving or resolving a FREE-managed credential fails explicitly.
- **Fail entire runtime:** All configuration and model execution fail until keyring access returns, including connections that need no stored secret.
- **Memory fallback:** Allow temporary credentials for the process lifetime. More convenient, but violates the accepted fail-closed rule.

**Answer:** How do we ship this app?

### Q072 - 2026-07-22 19:43:37 CEST (`1784742217267`) - Shipping Scope

**Question:** Should runtime model configuration remain source-prototype-only, or should this change also establish a distributable local host?

- **Prototype only (Recommended):** Keep `pnpm start` as the supported runtime; native keyring runs in local Vite middleware. Shipping remains a separate architectural change.
- **Local distribution:** Add a packaged local host/installer now. Makes deployment real, but substantially expands runtime, lifecycle, update, and native-module scope.
- **Hosted deployment:** Target a remote server. Conflicts with local providers, external CLI authentication, and per-researcher OS keyring access.

**Answer:** Prototype only (Recommended)

### Q073 - 2026-07-22 19:44:15 CEST (`1784742255870`) - Keyring Failure

**Question:** Within that local prototype, if the OS keyring is unavailable, should credentialless and externally authenticated connections still work?

- **Degrade safely (Recommended):** Configuration remains readable; Ollama and externally authenticated CLIs can work. FREE-managed credential saves/resolution fail explicitly.
- **Fail entire runtime:** Block all configuration and model execution, even when the selected connection needs no FREE-managed credential.
- **Memory fallback:** Temporarily retain credentials in Node memory. Convenient, but violates the accepted fail-closed storage rule.

**Answer:** Degrade safely (Recommended)

### Q074 - 2026-07-22 19:44:51 CEST (`1784742291110`) - HTTP Surface

**Question:** What is the smallest clear HTTP surface for configuration and manual model discovery?

- **Config plus probe (Recommended):** GET/PUT `/api/model_config` includes provider metadata and keyring state; POST `/api/model_probe` checks one saved or submitted connection.
- **One endpoint:** GET, PUT, and action-oriented POST all use `/api/model_config`. One fewer file, but mixes resource replacement and probing semantics.
- **Separate resources:** Dedicated endpoints for configuration, providers, credentials, and probes. Clearest separation, but substantially more client and route code.

**Answer:** Config plus probe (Recommended)

### Q075 - 2026-07-22 19:46:44 CEST (`1784742404044`) - Probe Target

**Question:** Should manual probing operate only on saved Model Connections, or also accept unsaved draft connection details?

- **Saved only (Recommended):** POST takes a connection ID and resolves the saved snapshot/keyring entry. New or changed drafts are probed by Save's PUT.
- **Allow drafts:** POST accepts a complete connection and transient credential. Enables pre-save testing, but duplicates validation and secret-handling paths.

**Answer:** Saved only (Recommended)

### Q076 - 2026-07-22 19:47:37 CEST (`1784742457611`) - Connection IDs

**Question:** How should new Model Connections receive stable IDs when configuration is replaced as one document?

- **Client UUIDs (Recommended):** The configuration page creates `crypto.randomUUID()` values; PUT validates them and routes reference them directly.
- **Backend assignment:** The backend replaces temporary IDs during PUT. More authoritative, but requires ID remapping in connections and routes.
- **Names as IDs:** Use the connection name as the key. Fewer fields, but renaming breaks route references and keyring lookup.

**Answer:** Client UUIDs (Recommended)

### Q077 - 2026-07-22 20:19:38 CEST (`1784744378186`) - Dangling Routes

**Question:** May a saved Capability Route reference a Model Connection that the same configuration has deleted?

- **Reject configuration (Recommended):** PUT requires every non-null route to reference an existing connection. The UI must clear or reassign routes before deletion.
- **Allow dangling route:** Preserve the route reference and fail model operations explicitly until repaired. More states and error handling, but retains deleted identity.
- **Clear automatically:** Backend silently sets affected routes to null. Convenient, but violates whole-document replacement semantics and hides a configuration change.

**Answer:** Reject configuration (Recommended)

### Q078 - 2026-07-22 20:31:56 CEST (`1784745116773`) - Probe State

**Question:** How should persisted model catalogs and check results interact with whole-document PUT?

- **Server-owned fields (Recommended):** Keep them in the same JSON document, but PUT accepts only editable configuration; backend carries forward or replaces observations from real probes.
- **Client-owned document:** PUT accepts catalogs and statuses exactly as sent. Least transformation code, but stale or fabricated observations become authoritative.
- **Separate cache file:** Store editable configuration and probe observations independently. Clear ownership, but adds another store and consistency logic.

**Answer:** Server-owned fields (Recommended)

### Q079 - 2026-07-22 20:35:07 CEST (`1784745307705`) - Loopback Enforcement

**Question:** Where should the local-only trust boundary be enforced now that model APIs can resolve keyring-backed credentials?

- **All Vite API traffic (Recommended):** Bind Vite to loopback and reject non-loopback sockets in the custom `/api/*` middleware. Protects configuration and paid model operations together.
- **Configuration only:** Reject remote access only for model_config and model_probe. Existing model operations remain callable if Vite is exposed.
- **Binding only:** Set Vite host to loopback and trust it. Least code, but command-line host overrides can expose the APIs.

**Answer:** explain better, prefer KISS

### Q080 - 2026-07-22 20:37:09 CEST (`1784745429269`) - Loopback Enforcement

**Question:** Which local-only enforcement should the prototype use?

- **Explicit loopback bind (Recommended):** Set Vite host to 127.0.0.1 and rely on the OS listener boundary. Smallest coherent solution.
- **Bind plus socket guard:** Also reject non-loopback remote addresses in middleware. Defense in depth, but more address-handling code.
- **Keep implicit default:** Rely on Vite's current localhost default without recording the trust boundary in configuration.

**Answer:** Keep implicit default

### Q081 - 2026-07-22 20:38:02 CEST (`1784745482412`) - Credential Adapter

**Question:** How should the local Node process access the OS credential store?

- **@napi-rs/keyring (Recommended):** Add one direct cross-platform dependency and wrap its Entry API in a few functions.
- **Platform commands:** Invoke macOS security, Linux secret-tool, and Windows credential commands. Avoids native dependency but adds substantial branching and parsing.
- **No managed credentials:** Support only credentialless or externally authenticated providers. Smallest code, but removes OpenAI, Anthropic, Google, and authenticated compatible connections.

**Answer:** @napi-rs/keyring (Recommended)

### Q082 - 2026-07-22 20:38:26 CEST (`1784745506190`) - Config Path

**Question:** Should FREE use a small dependency for platform-standard config paths or implement OS path selection itself?

- **Use env-paths (Recommended):** One direct ESM dependency yields the correct config directory on Linux, macOS, and Windows with minimal source code.
- **Implement paths:** Use Node os/platform helpers and encode XDG, Application Support, and APPDATA rules in FREE.

**Answer:** Use env-paths (Recommended)

### Q083 - 2026-07-22 20:39:01 CEST (`1784745541527`) - Provider Lifetime

**Question:** Should resolved AI SDK providers/models be cached across operations?

- **Construct per operation (Recommended):** Provider factories are lightweight; avoid cache invalidation when configuration changes. Retain only required process-owning CLI lifecycle such as Codex app-server reuse.
- **Cache by connection:** Reuse provider/model objects until configuration changes. May save tiny setup cost, but adds invalidation and disposal logic.
- **Single global provider:** Keep one active provider instance. Small state surface, but cannot correctly support two routes using different connections.

**Answer:** Construct per operation (Recommended)

### Q084 - 2026-07-22 20:40:41 CEST (`1784745641338`) - Unavailable Model

**Question:** If the latest successful catalog no longer lists a route’s selected model, should the resolver block execution or still call the provider?

- **Still call provider (Recommended):** Discovery remains advisory; UI marks the selection unavailable, but the provider call is authoritative and may still succeed.
- **Block execution:** Fail before generation until discovery lists the model again. Strong consistency with the catalog, but transient/incomplete listings disable work.
- **Clear selection:** Automatically unconfigure the route. Contradicts the accepted rule that disappeared selections are preserved.

**Answer:** kiss but best ux

### Q085 - 2026-07-22 20:42:08 CEST (`1784745728587`) - Unavailable Model

**Question:** Use the catalog as an advisory UI warning while still attempting the selected model?

- **Still attempt (Recommended):** Simplest behavior and best continuity; provider execution remains authoritative.
- **Block locally:** Treat the cached catalog as authoritative and refuse generation before contacting the provider.

**Answer:** Still attempt (Recommended)

### Q086 - 2026-07-22 20:42:26 CEST (`1784745746986`) - HTTP Statuses

**Question:** Should runtime configuration use a small semantic status mapping or collapse configuration failures into generic 400/500 responses?

- **Small mapping (Recommended):** 400 invalid request, 409 incomplete/invalid saved state, 502 provider failure, 503 unavailable keyring, 500 unexpected failure.
- **Only 400 and 500:** Simpler status set, but UI cannot distinguish repairable configuration from local dependency or provider failures.
- **Detailed status mapping:** Map provider authentication, rate limits, timeouts, and each configuration condition separately. Richer, but substantially more contract and tests.

**Answer:** trasparent errors

### Q087 - 2026-07-22 20:43:22 CEST (`1784745802933`) - Transparent Errors

**Question:** Which meaning of transparent errors do you want?

- **Stable codes, sanitized detail (Recommended):** Use the small status mapping plus precise error codes/messages and safe provider details.
- **Raw provider passthrough:** Return upstream status and body directly. Maximum visibility, but inconsistent contracts and potential secret/internal leakage.
- **Generic safe messages:** Hide provider details behind broad messages. Safest output, but harder for researchers to diagnose configuration.

**Answer:** Raw provider passthrough

### Q088 - 2026-07-22 20:43:53 CEST (`1784745833852`) - Provider Errors

**Question:** Which decision should win when provider passthrough conflicts with the stable error contract?

- **Stable envelope, raw detail (Recommended):** Return FREE 502 with upstream status and size-bounded verbatim body in details. One frontend contract with transparent diagnostics.
- **Exact passthrough:** Return each provider's status, content type, and body unchanged. Overturns the one-ApiError decision for provider failures.
- **Stable sanitized envelope:** Keep one contract and redact provider details. Safest, but less transparent.

**Answer:** Stable envelope, raw detail (Recommended)

### Q089 - 2026-07-22 20:44:27 CEST (`1784745867439`) - Probe Error Storage

**Question:** Should raw provider error bodies from probes be persisted in the non-secret JSON document?

- **Persist summary only (Recommended):** Store timestamp, status, upstream status, and concise message; return bounded raw detail only in the immediate PUT/POST response.
- **Persist raw body:** Offline configuration view retains full diagnostics, but arbitrary endpoints may place sensitive or large content in local JSON.
- **Never expose raw probes:** Use summarized probe errors both immediately and offline, while execution errors remain transparent.

**Answer:** Persist summary only (Recommended)

### Q090 - 2026-07-22 20:45:00 CEST (`1784745900824`) - Credential Cleanup

**Question:** When deleting a connection with a FREE-managed credential, must keyring deletion succeed before the configuration is committed?

- **Require deletion (Recommended):** Fail PUT if the keyring entry cannot be removed; prevents abandoned credentials. Credentialless and external-auth connections are unaffected.
- **Best effort:** Delete configuration even if keyring cleanup fails. Better availability, but can leave inaccessible secrets behind.
- **Keep credential:** Retain the keyring entry so recreating the same UUID can reuse it. Convenient, but surprising and conflicts with deletion expectations.

**Answer:** Require deletion (Recommended)

### Q091 - 2026-07-22 20:45:27 CEST (`1784745927380`) - Credential Mutation

**Question:** How should PUT distinguish preserving, replacing, and deleting a stored credential?

- **Explicit tri-state (Recommended):** Omitted connection ID preserves; string replaces; null deletes. The API never sends masked placeholders back.
- **Blank means preserve:** Empty string preserves and non-empty replaces; requires another mechanism for explicit credential deletion.
- **Always resend:** The UI must submit every credential on every Save. Impossible without returning or retaining secrets in browser state.

**Answer:** Explicit tri-state (Recommended)

### Q092 - 2026-07-22 20:47:44 CEST (`1784746064356`) - Corrupt Config

**Question:** If the versioned JSON document is malformed or has an unsupported version, how should the prototype recover?

- **Fail closed (Recommended):** Return a transparent configuration error with the file path; never overwrite it automatically. Researcher repairs or removes it manually.
- **UI reset flow:** Return provider metadata alongside the load failure and add an explicit reset action. Better recovery, but expands endpoint and UI states.
- **Auto-reset:** Rename the bad file and create a fresh configuration automatically. Simple UX, but silently changes configuration after corruption.

**Answer:** explain more, which json?

### Q093 - 2026-07-22 20:48:30 CEST (`1784746110172`) - Corrupt Config

**Question:** If `model-config.json` exists but is malformed or uses an unsupported version, how should the prototype recover?

- **Fail closed (Recommended):** Show the path and validation problem; preserve the file unchanged until the researcher repairs or removes it.
- **UI reset flow:** Add an explicit reset action that backs up and replaces the file after researcher confirmation.
- **Auto-reset:** Automatically replace it with an empty configuration, risking loss of recoverable settings.

**Answer:** Fail closed (Recommended)

### Q094 - 2026-07-22 20:49:53 CEST (`1784746193872`) - Concurrent Saves

**Question:** Because one Save updates both keyring entries and JSON, how should two overlapping PUT requests be handled?

- **Serialize PUTs (Recommended):** Use one small in-process save queue; each credential/probe/file sequence finishes before the next begins, preserving last-completed-write behavior.
- **Revision conflicts:** Require a revision and reject stale saves with 409. Safer multi-tab UX, but contradicts the accepted last-write-wins policy.
- **Allow overlap:** Fewest lines, but one request can win the JSON write while another wins the keyring mutation.

**Answer:** what do you mean by overlapping? the app is single user, i would use last-win

### Q095 - 2026-07-22 20:50:53 CEST (`1784746253801`) - Concurrent Saves

**Question:** Use a small in-process queue so last-arriving Save wins coherently across keyring and JSON?

- **Serialize for last-win (Recommended):** A few backend lines; no revision or conflict UX, and the last queued PUT owns both stores.
- **Rely on UI:** Disable Save while pending and accept cross-tab races. Less backend code, but last-win is not guaranteed across keyring and JSON.

**Answer:** Serialize for last-win (Recommended)

### Q096 - 2026-07-22 20:51:21 CEST (`1784746281036`) - Resolution During Save

**Question:** If model execution begins while a Save is already changing keyring and JSON state, should route resolution wait for that Save?

- **Wait for Save (Recommended):** Resolver awaits the current configuration mutation, then reads JSON and keyring. Prevents mixed old-config/new-credential targets.
- **Resolve immediately:** Lower latency during Save, but an operation can combine the old document with credentials already changed by the pending PUT.

**Answer:** it is a strange case, we are over complicate things

### Q097 - 2026-07-22 20:52:39 CEST (`1784746359580`) - Test Surface

**Question:** For this source-only runtime-configuration change, should we add Playwright or stay within the existing Vitest stack?

- **Vitest only (Recommended):** Test config storage with temp files/keyring fakes, provider matrix, route resolution, endpoints, and the React page with mocked fetch. No new browser harness.
- **Add Playwright:** Cover Save/probe/configuration workflows through a real browser and local server. Stronger integration coverage, but adds configuration, fixtures, and native-store isolation.
- **Minimal backend tests:** Test only storage and route resolution. Lowest test code, but configuration UI and HTTP contracts remain weakly protected.

**Answer:** Add Playwright

### Q098 - 2026-07-22 20:53:13 CEST (`1784746393062`) - Playwright Backend

**Question:** Should Playwright exercise the real configuration backend or mock the two HTTP endpoints?

- **Mock HTTP in browser (Recommended):** Use Playwright route interception for UI workflows; Vitest covers real handlers/store with temp files and fake keyring. Deterministic and no OS credential side effects.
- **Real backend, fake store:** Launch Vite with test-only config/keyring adapters. Stronger integration, but adds runtime switches and server-fixture complexity.
- **Real OS keyring:** Exercise actual native credentials. Environment-dependent and unsafe for repeatable local/CI tests.

**Answer:** Mock HTTP in browser (Recommended)

### Q099 - 2026-07-22 20:54:46 CEST (`1784746486766`) - Architecture Check

**Question:** Does this now represent the runtime-configuration architecture you want captured in OpenSpec?

- **Shared understanding (Recommended):** End the architecture challenge; update the settled docs and proceed to OpenSpec when requested.
- **Challenge storage:** Revisit JSON, keyring, save ordering, or concurrency.
- **Challenge providers:** Revisit AI SDK targets, discovery, capabilities, or route resolution.
- **Challenge HTTP/UI:** Revisit endpoints, errors, configuration workflow, or tests.
- **Challenge scope:** Reconsider which CQ findings belong in this change.

**Answer:** Shared understanding (Recommended)

## Authoritative Outcome

Q099 confirmed shared understanding of the runtime-configuration architecture recorded in `CONTEXT.md` and ADRs 0006-0008. Those current sources, rather than this ledger, are authoritative.

No OpenSpec artifacts currently exist for this change. They will become the implementation specification when created.

- Model Connections and Capability Routes are machine-wide for one humanities researcher and do not belong to or vary by Project Context.
- The local prototype exposes exactly two Capability Routes: the Extraction Route serves Extraction and Schema Suggestion; the Interaction Route serves document chat and conversational Extraction Schema editing. A central resolver resolves one immutable configuration snapshot per operation, with no route or configuration-source fallback.
- Non-secret configuration is one versioned JSON document in the operating system's user application-config directory. Credentials exist only in the operating system credential store; no plaintext or memory-only fallback exists. Credential-store failure blocks only FREE-managed credential operations, while credentialless Model Connections and externally authenticated model harnesses remain usable.
- Saved configuration is the sole runtime model-configuration source. It replaces `AI_PROVIDER`, `AI_MODEL`, `AI_CHAT_MODEL`, `AI_BASE_URL`, and `AI_API_KEY` rather than importing, overlaying, or falling back to them.
- Seven explicit Model Connection kinds are supported: Ollama, OpenAI, Anthropic, Google, Codex CLI, Claude Code, and generic OpenAI-compatible. Provider metadata, defaults, credential modes, discovery, model construction, and concrete capabilities live in one backend registry. The generic adapter guarantees `/v1/models` and `/v1/chat/completions`; custom native-provider URLs must retain that provider's native contract.
- Discovery is advisory network observation: it certifies availability, not suitability, never performs paid test generation, and persists the latest catalog and check result for offline display. Researchers select discovered models, with Claude Code's documented static aliases as the sole exception. A selected model that disappears remains selected, is marked unavailable, and is still attempted without silent substitution.
- General model execution uses AI SDK v7 and resolves to its `LanguageModel` directly. NuExtract's raw Ollama protocol remains the explicit specialized execution profile. Provider adapters declare concrete capabilities such as native schema-less JSON support; generic generation uses native output when available and JSON-only prompting otherwise.
- Interaction uses canonical Source Document Markdown as provider-neutral context. Raw Docling output remains internal; a future `ParsedDocument.v2` Source Context projection is a separate decision.
- Configuration uses whole-document GET/PUT plus a probe endpoint, explicit Save, automatic probing of changed Model Connections after commit, server-owned persisted observations, client-created UUIDs, dangling-route rejection, atomic JSON replacement, and serialized last-write-wins saves. Managed credential mutation is explicit tri-state, and credential deletion must succeed before deleting its Model Connection.
- Provider failures use one stable FREE error envelope with bounded raw upstream detail in the immediate response. Persisted probe failures retain summaries only. Malformed or unsupported `model-config.json` fails closed without automatic replacement.
- Request JSON uses strict parsing and request-validation failures use the stable request/error contract; repair is confined to generated model output.
- The configuration API remains part of the local TypeScript/Vite source prototype. Hosted Vercel runtime configuration and a distributable production host are unsupported or deferred. Playwright covers UI workflows with mocked HTTP, while Vitest covers real handlers, storage, provider behavior, and route resolution with isolated adapters.
- Public Model Attribution is deferred. Route resolution still uses an immutable snapshot, but current extraction, schema, and chat response contracts do not expose or retain that snapshot. Model Attribution remains the term for a future sanitized snapshot and does not replace source-backed Evidence.

## Superseded Or Deferred Decisions

- **Environment compatibility removed:** Q007-Q008 still contemplated environment-configured connections, and Q019 considered bootstrap import. Q020 superseded both: saved configuration is the sole source, with no `AI_*` import, overlay, or fallback.
- **Unavailable catalog entries are attempted:** Q014-Q015 established discovered-only selection and preservation of disappeared selections. Q084-Q085 clarified that the catalog is advisory at execution time: an unavailable selected model is marked but still attempted, and provider failure is returned without substitution.
- **Public Model Attribution deferred:** Q039 initially selected returning a route snapshot. Q067 returned the interview to runtime-configuration scope, and Q068 deferred public Model Attribution. The resolver still reads one immutable snapshot per operation, but response contracts remain unchanged.
- **Repository-local configuration reversed:** Q069 selected repository-local ignored storage. Q070 immediately reversed that answer to the operating system's user application-config directory, preserving the machine-wide Model Connection and Capability Route terminology.
- **Raw provider passthrough bounded by a stable contract:** Q087 selected raw passthrough. Q088 refined it to a stable FREE error envelope containing size-bounded raw upstream detail, and Q089 limited persisted probe errors to summaries.
- **Broader CQ work deferred:** Q057-Q059 and Q066 selected cancellation, centralized schema vocabulary, partial Extraction results with validation issues, and integer Evidence pages. When Q067-Q068 returned scope to runtime configuration, those extraction and orchestration contract changes were deferred rather than included in this architecture.
- **Read coordination during Save rejected:** Q095 retained a small queue to serialize overlapping PUT operations for coherent last-write-wins behavior. Q096 rejected making route resolution wait for an in-progress Save as overcomplication; per-operation reads remain independent.
- **Schema-edit tolerance deliberately retained:** Q061 kept filtering invalid conversational Extraction Schema edit operations, and Q062 kept treating a wrong top-level output shape as a no-op. The stricter reject-all and typed upstream-error alternatives were not adopted.
- **Request/error boundary retained:** Q064 remains included as the strict request-JSON boundary, with repair limited to generated model output. Q065 retained the nullable document-source object; other broader document and PDF changes remain outside runtime configuration.
