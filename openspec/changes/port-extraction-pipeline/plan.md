<!-- markdownlint-disable MD013 -->

# Plan: port FREE-technical extraction

**Status:** reviewed and simplified on 2026-07-16.

**Behavioral reference:** `/home/gebbaro/Progetti/FREE-technical` at commit `67ea4dc535a2ab674ed8c4b558068e13e7c2980d`.

## Outcome

A researcher can run the `Burial_Finds` Catalog extraction against a completed canonical `ParsedDocument` and receive the same record shape, embedded Evidence, fallback, retry, conformance, and merge behavior as `FREE-technical`.

This change ports extraction only. It does not port parsing, schema editing, human review, evaluation, export, or production infrastructure.

## Runtime boundary

| Runtime | Responsibility |
|---|---|
| Browser TypeScript | Start/poll ingestion, retain the parsing task ID, request extraction, display returned JSON and warnings. |
| Server TypeScript in `prototypes/studio/api` | Fetch the completed `ParsedDocument`, construct prompts, call the configured model, parse/conform output, run Article or Catalog extraction, and normalize Evidence. |
| Python `parsing_service` | PDF inspection, Docling, OCR, layout reconstruction, canonical Markdown, page mapping, canonical tables, and Evidence Anchors. |

Do not run model extraction in the browser: provider configuration stays server-side. Do not move extraction into Python: once `ParsedDocument` exists, the reference hierarchy, validation, conformance, merge, and Evidence transformations have no Python-only dependency.

This boundary also follows `docs/adr/0002-application-composition-and-use-case-pipelines.md`: Studio API functions execute use cases; `parsing_service` remains a parsing/OCR service.

### Verified model support

- Installed `ai@7.0.15` supports schema-validated structured output through `generateText` and `Output.object`.
- Installed `ai-sdk-ollama@4.0.0` supports Ollama structured output but does not expose the exact raw NuExtract generate control required here.
- Keep the current direct Ollama `POST /api/generate` path in `api/_model.ts`: render NuExtract's prompt and send `raw: true`.
- The current `renderNuExtractPrompt` matches NuExtract 3's upstream `chat_template.jinja`, including structured-only instructions and the non-thinking prompt.

Primary sources checked:

- <https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data>
- <https://docs.ollama.com/api/generate>
- <https://huggingface.co/numind/NuExtract3/blob/main/chat_template.jinja>
- <https://huggingface.co/numind/NuExtract3-GGUF>

## Pi Coding Agent workflow

These models guide implementation of this plan; they are not FREE's extraction models.

Use the GPT-5.6 family by role:

| Role | Model | Thinking | Use |
|---|---|---|---|
| Reconnaissance | `openai-codex/gpt-5.6-luna` | `medium` | Official docs, file discovery, and focused inventory. Read-only. |
| Implementation | `openai-codex/gpt-5.6-terra` | `high` | Detailed comparison and the sole writer for an approved slice. |
| Judgment | `openai-codex/gpt-5.6-sol` | `high` | Final synthesis and fresh-context simplification review. Read-only. |

Recommended planning/review workflow:

```text
parallel: Luna reviews current docs; Terra maps current and reference code
then:     Sol resolves disagreements and removes unnecessary architecture
```

Recommended implementation workflow:

```text
Terra high writes one approved slice
Sol high reviews the resulting diff
Terra high applies accepted fixes
```

Do not run multiple writers in the same worktree. Do not use Sol for routine discovery, and do not default to `xhigh` or `max`; escalate beyond `high` only when a concrete unresolved decision remains. Pi supports model selection through `/model`, thinking selection with Shift+Tab, and CLI IDs such as `--model openai-codex/gpt-5.6-sol --thinking high`. Keep Pi's default 272K context limit for these models unless the task demonstrably requires long context.

## Scope

### Port now

- `Burial_Finds.json` as the first schema fixture.
- Catalog boundary detection, marker resolution, slicing, per-record extraction, one retry, and merge.
- `_conform_to_schema` behavior.
- Embedded local `_evidence`, including nested `fundliste` Evidence.
- Whole-document fallback when Catalog boundaries cannot be resolved.
- Article extraction after Catalog works, verified with `collagen_extraction.json`.
- Sequential batch as a thin browser loop over the same per-document API.

### Leave in Python

- `pdf_io.py`, Docling/DocTags conversion, OCR, rendering, and PDF safety checks.
- Camelot and all table discovery/canonicalization.
- Creation and publication of `ParsedDocument`, `ParsedTable`, pages, spans, and anchors.

Extraction consumes those canonical products and never opens or reparses the PDF.

### Do not build

- Compatibility with the current extraction request/result shape.
- Schema editor or schema-generation UX.
- Human validation/review, gold datasets, evaluation, or export.
- A Python extraction worker.
- Queues, databases, repositories, service interfaces, dependency-injection containers, version registries, or rollout machinery.
- A new provider abstraction; reuse the existing model boundary.

## Corrected decisions

### Strategy is explicit

The request carries `strategy: "catalog" | "article"`.

Do not infer strategy from a top-level object array. Both `Burial_Finds` and `collagen_extraction` contain `record.entries`, so shape inference cannot distinguish their intended extraction behavior. `FREE-technical` also selects the extractor variant explicitly.

The first implementation supports only `strategy: "catalog"`. Article is added after Burial Finds passes.

### Use the published ParsedDocument contract directly

The browser sends `{ taskId, schema, strategy }`, not the complete document and not a PDF. The server fetches the completed document from the parsing service.

Do not invent an `ExtractionDocument` schema. At the HTTP boundary, validate only the final `parsed_document.v2` fields extraction reads. API wiring waits for the v2 contract to land; pure Catalog work can start earlier.

### Preserve the reference Evidence contract first

The copied schemas already contain local `_evidence`. Preserve those slots, including `table_index`, during the parity port. Resolve `table_index` against the deterministic order of canonical `ParsedTable` objects.

Do not rename it to `table_id` inside this port. A later versioned result-contract change may expose stable canonical table IDs.

Keep Evidence traversal in the existing `_evidence_template.ts` area rather than creating a new codec layer. Embedded Evidence is the only public result shape in this change.

### No filesystem cache

Do not add extraction persistence or cache in this port. Vercel functions have a read-only filesystem with only ephemeral `/tmp` scratch space: <https://vercel.com/docs/functions/runtimes#file-system-support>.

Returning the result is sufficient for proving extraction parity. Durable ownership can be selected later; it must not be hidden inside `parsing_service` or a local-only filesystem convention.

## Behavior to preserve

### Catalog

For `strategy: "catalog"`:

1. Infer the primary repeated array using the reference function; Burial Finds resolves to `record.entries`.
2. Ask the model for top-level record boundaries over canonical LLM Markdown.
3. Resolve boundary markers against the Markdown and slice sections in source order.
4. If no boundaries resolve, treat the whole document as one section and return `boundary_fallback`.
5. Extract one item per section using the item schema and matching `_schema_metadata`.
6. Conform every response recursively.
7. Detect failed or suspicious records with the reference heuristics.
8. Retry those sections once.
9. Merge in source order and apply the reference scalar fingerprint deduplication.
10. Return the schema-shaped record with embedded Evidence plus minimal warnings.

Preserve these known limitations rather than redesigning them:

- document-level fields outside the primary Catalog array remain empty;
- boundary failure produces one whole-document section;
- suspicious records retry once;
- fingerprint deduplication may collapse similar records;
- phased nested extraction remains disabled.

### Recursive conformance

Port `core/extract.py::_conform_to_schema` exactly:

- unknown object keys are dropped;
- every schema key is restored;
- a missing scalar becomes `null`, regardless of the exemplar value;
- a missing array becomes `[]`;
- a singleton value is recovered as a one-element array;
- `{}` and `[]` remain free-form containers;
- a non-scalar in a scalar slot becomes `null`.

### Article

For `strategy: "article"`, make one whole-document extraction call, conform the result, and normalize embedded Evidence. Do not create a second provider or document adapter.

### Batch

Batch is a sequential browser loop over the same single-document request. It preserves successful results when another request fails. There is no batch extraction module or batch-specific server endpoint.

## Minimal code shape

Prefer changes to existing modules and at most two new production modules:

```text
prototypes/studio/
  src/api.ts                    # retain taskId; request extraction/batch loop
  api/extract.ts                # validate request, fetch ParsedDocument, map errors
  api/_model.ts                 # expose one existing structured generation function
  api/_model_output.ts          # JSON repair + faithful recursive conformance
  api/_evidence_template.ts     # embedded Evidence traversal/normalization
  api/_catalog.ts               # Catalog prompts, boundaries, slicing, retry, merge
  api/_article.ts               # add only when Article slice begins
```

Do not pre-create `engine`, `types`, `schema`, `cache`, `batch`, repository, adapter, or one-file-per-hierarchy-stage modules. Split a file only after it becomes difficult to test or navigate.

Add an API/server TypeScript configuration referenced by the Studio build. The current `tsc -b` configurations do not include `api/*.ts`; the port is not complete while server code is outside type-checking.

## Implementation slices

### 1. Characterize and port the pure Catalog behavior

- Copy `Burial_Finds.json` with attribution and pin the reference commit.
- Add a tiny two-record Markdown fixture and deterministic fake model responses.
- Add server/API TypeScript type-checking.
- Port recursive conformance and the pure boundary, slice, suspicious-record, retry-selection, merge, and deduplication behavior.
- Test missing scalars as `null`, normal boundaries, missing-marker fallback, one retry, source order, nested `fundliste`, and deduplication.

**Done when:** the TypeScript pure-function tests match the pinned Python behavior without HTTP, provider, UI, persistence, or live-model code.

### 2. Deliver Burial Finds end to end

- Retain the parsing `taskId` in `src/api.ts`.
- Make `/api/extract` accept `{ taskId, schema, strategy: "catalog" }` and fetch the canonical document server-side.
- Select canonical LLM Markdown, pages, and tables from the actual v2 contract.
- Reuse the current raw NuExtract renderer and JSON parser through one callable model function.
- Run Catalog with an injected model callback in tests.
- Update the existing Results view only enough to display the embedded record and warnings.

**Done when:** API tests with fake parsing/model responses pass, and one opt-in local NuExtract smoke test extracts the Burial fixture in source order.

### 3. Complete Evidence and Article parity

- Normalize text Evidence against canonical page spans/anchors.
- Backfill table Evidence from canonical `ParsedTable` cells while preserving `table_index` output.
- Cover nested Evidence and the reference ellipsis-snippet behavior.
- Add explicit Article strategy using `collagen_extraction.json` and the same document/model/conformance path.

**Done when:** both fixture schemas produce their reference-shaped embedded Evidence, and collagen reaches Article despite also containing `record.entries`.

### 4. Add sequential batch

- Loop over completed task IDs in the browser.
- Call the same per-document endpoint sequentially.
- Return/display each success or error independently.

**Done when:** per-document results equal individual extraction results and one failure does not erase prior successes.

## Verification

Required automated checks:

```bash
pnpm --filter studio test
pnpm --filter studio build
```

Focused tests must prove:

- API files are type-checked;
- no extraction path reads PDF bytes or invokes Camelot/Docling;
- Catalog fallback emits one warning;
- suspicious sections retry exactly once;
- recursive conformance matches the pinned Python function;
- merge order and deduplication match the reference;
- embedded Evidence survives nested arrays;
- explicit strategy routes collagen to Article;
- batch reuses the single-document endpoint.

Keep live model tests opt-in. Use deterministic fake responses for normal CI.
