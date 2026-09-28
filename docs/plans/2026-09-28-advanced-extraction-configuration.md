# Advanced Extraction Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Researcher Account save Article and Catalog extraction-method settings on a new Advanced tab, freeze the active method at single/batch admission (with stale-preview conflicts, replay and batch identity), execute only the admitted method, and show requested versus effective methods honestly.

**Architecture:** One method contract (`packages/extraction/src/extraction-method.ts`) owns the settings schema, cross-field rules and exact error copy, canonicalization, the active-method descriptor and the Parsing Service wire translation; Studio's account document embeds it and the browser imports the same functions. Admission reads the account document under its row lock inside the existing admission transaction, compares the submitted descriptor, checks identity fields against the pinned schema and writes an immutable snapshot on the Extraction and Batch Extraction rows; `runExtraction` reads only that snapshot. The Advanced tab lives in the existing Model Configuration draft; start views submit the descriptor they display; Extraction details show "Method used".

**Tech Stack:** TypeScript, zod 4, React 19 + Testing Library (vitest/jsdom), node:test via tsx, Prisma Next 0.16 authored migrations on PostgreSQL, DBOS TypeScript SDK 5.1, Playwright, Python 3.13 + pydantic + pytest (Parsing Service, tests only).

**Spec:** `openspec/changes/advanced-extraction-configuration/` — `proposal.md`, `design.md` (UI and ownership, binding), `verification.md` (acceptance matrix U1–U9, P1–P7, E1–E5, F1–F2, M1, A1), `tasks.md`, `contract-cases.json`, `specs/advanced-extraction-configuration/spec.md`, `specs/model-connection-configuration/spec.md`. Executors read the spec beside this plan.

Worktree: `/home/gennaro/projects/FREE-worktrees/advanced-extraction-spec`, branch `feat/advanced-extraction-configuration`, based on `e2a82549` (spec commit over `4e2a5820`). Every path below is relative to that root.

## Global Constraints

- Never run `pnpm install` or `uv sync` or create a venv. Python tests run via `prototypes/parsing_service/.venv/bin/python -m pytest` (a shim venv already importing this worktree's `src`), or `pnpm test`. The focused Python command is, from `prototypes/parsing_service`: `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src:. .venv/bin/python -m pytest -q <files> -m 'not postgres and not live_model'` (`PYTHONPATH` needs `.` because tests import `tests.*`).
- Disposable PostgreSQL targets only per README guard: loopback port 5432 and `free_test_*` databases (`PROJECT_STORE_POSTGRES_URL`, `EXTRACTION_TEST_DATABASE_URL` = `DATABASE_URL`, `PARSING_TEST_DATABASE_URL`; see `docs/operations/local-development.md`). Never point a check at `free`.
- No strategy registry, generic form generator/settings framework, plugin registry, DI container, new state machine, capability-discovery service, persisted preset name/ID, duplicated saved/draft state, second workflow/queue, hidden retry, schema-policy editor in account configuration, or flags for old span protocol versions.
- Serving code never imports `experiments/extraction` or validation/report code. UI and HTTP code implement no extraction policy, token partitioning, evidence eligibility or span matching. Execution never reads account defaults for an admitted method.
- Optional disabled factors serialize by omission; never invent wire values like `plain`/`all`; never clamp, coerce or silently repair; server rejects invalid combos without partial save.
- Parsing Service remains the authority for extraction policy/final request validation; do not change extraction defaults or algorithms. Python changes in this plan are tests, fixtures and a fixture-regeneration helper only.
- Keys/credentials never enter the method object or workflow inputs. `runExtraction`'s input stays `[extractionId]`.
- Match surrounding code style, comment density, naming, and CONTEXT.md domain language (Researcher Account, Extraction, Batch Extraction, Extraction Strategy, Extraction Model Choice, Schema Revision, Source Document, Evidence).
- DBOS (verbatim, `prototypes/studio/CLAUDE.md`): "A change to a workflow's step sequence goes behind `DBOS.patch()`; `studio@1` changes only after draining. Workflow inputs carry IDs, never keys or document text." Parsing Service equivalent: "A change to a workflow's steps goes behind `DBOS.patch()` (`enable_patching` is on); `kei@1` changes only after draining." This plan changes no step sequence (Task 6 records the review).
- Wire names are the Parsing Service's own (`kie/extract/method.py`, `run.py`, `grounded.py`): Article `context`, `context_tokens`, `overlap_passages`, `identity`, `identity_fields`, `prompt`, `grounding`, `grounding_schedule`, `evidence_policy`, `grounding_routing`, `selection`, `rendering`, `grouping`; generic Catalog `discovery_chars`, `record_chars`; recipe Catalog `catalog.input_tokens`, `catalog.output_tokens`, `catalog.factors.{glossary,headings,overlap,verification}`. The account document keeps these snake_case names inside `extractionSettings` so the shared fixtures validate verbatim on both sides.
- Exact error copy (design §3), one constant each in `METHOD_MESSAGES`: "This choice requires bounded source units." · "Schema policies require generated quotes or source spans." · "Choose a verification method to use this schedule." · "Use generated quotes or source spans, and stop after support." · "Add the scalar record fields that identify one record."
- Commits: one per task, conventional prefix, message ending with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never `git stash`, `reset` or `commit --amend` another task's work. `git rm` may need user authorization; ask the controller.
- After each task run the task's focused commands, then `pnpm typecheck` and `pnpm lint`; run `pnpm test` at least after Tasks 1, 3, 5, 7, 10 and 14.

## Review Focus

1. Only the other strategy's settings change between the start preview and the start (e.g. Catalog limits saved while an Article start is open) → the Article Extraction is admitted, not refused as stale. Test added to Task 4.
2. An identity field that differs from a schema field only by case (`Species` vs `species`) → refused at start naming `Species`, never case-folded or matched. Test added to Task 4.
3. A factor switched off and on again (or a numeric field edited back to its saved value) → the footer reads "Everything saved"; key order never makes an equal draft dirty. Test added to Task 8.
4. A `runExtraction` recovered after the release whose `loadAdmitted` checkpoint was written before it (no `requestedSettings` in the checkpointed output) → the kei request is today's reference shape with no `article`/`catalog` settings. Test added to Task 6.
5. A direct `PUT /api/model_config` with explicit `null` optional factors and empty Catalog members (`{"catalog": {"generic": {}}}`) → stored and returned canonically without nulls or empty members, and a reload reads exactly the returned document. Test added to Task 3.

## Architecture invariants (design §8)

1. Account draft state has one owner; UI and HTTP code do not implement extraction, token partitioning, evidence eligibility or source-span matching.
2. Execution depends on an admitted method value and pinned schema/source; it does not query account defaults on recovery or for individual batch members.
3. Serving code never imports `experiments/extraction` or validation/report code; canonical evidence logic remains independent of Studio transport and storage.

**A1's structural/import check is added by Task 6** (`packages/extraction/src/architecture.test.ts`, `prototypes/studio/api/extraction_boundaries.test.ts`, `prototypes/parsing_service/tests/test_serving_imports.py`); Task 14 cites it in the docs.

## Spec discrepancies found during planning

Each is written into the tasks with the recommended ruling; the controller can overturn a ruling before its task starts.

1. **Third admission path.** Design §8 lists `api/extractions.ts` and `api/batch_extractions.ts`, but `api/batch_schema_suggestions.ts` → `persistSuggestedBatch` → `admitBatchMember` also admits a Batch Extraction and reads `configuredExtractionModels`. Ruling: treat it as batch admission (descriptor in its Run request, stale check and identity check on the fresh path, snapshot on batch and members); a replayed handoff returns its existing batch unchanged. Otherwise invariant 2 has a hole.
2. **Batch has no recipe.** `admitBatchMember` hard-codes `catalogRecipe: null` and the batch request has no recipe field. Ruling: batch Catalog uses the generic Catalog member only; recipe Catalog settings apply to single Extractions. No batch recipe selector is added.
3. **`record_chars` reaches Article.** `article.py` passes `options.record_chars` as a budget although the service README says it is generic-Catalog only. Ruling: Article requests never emit `discovery_chars`/`record_chars` (the service default stays in force); generic limits enter only generic Catalog requests; the Article inventory does not vary them. No service change.
4. **Request contracts carry no intent.** `extractionRequestSchema` has `models: z.never().optional()` and the batch/suggestion Run requests have no models, while design §7 requires the submitted descriptor (models included) to be compared. Ruling: a required `method` intent on `POST /api/extractions`, `POST /api/batch-extractions` and `POST /api/batch-schema-suggestions/{id}/run`; every direct poster in tests is updated (Tasks 4–5).
5. **U7 before enqueue vs Python-only check.** The only schema-dependent identity check (`ExtractRequest._identity_fields_exist`) runs in the worker after enqueue, and the Parsing Service API has no validation route. Ruling: a shape-only pre-check (`identityFieldIssues`) in `packages/extraction` admission, pinned to Python by a shared fixture; the Parsing Service stays authoritative and re-validates at execution. HTTP handlers hold no such logic.
6. **"Optional" `extractionSettings` vs the migration.** Design §7 calls it optional but the migration adds an empty object. Ruling: a required member whose empty value `{}` means service defaults, like `extractionModels`/`ingestionModels`; the migration backfills `{}`. This keeps the migration meaningful and the draft's dirty comparison exact.
7. **Empty members vs explicit Article.** "Empty normalized strategy members collapse to omission" would turn `article: {}` into omission, but the service treats any `article` object as explicit (method fields and `options.article` in the artifact, a different fingerprint). Ruling: the Article member never collapses — it canonicalizes to the full seven-field explicit form; empty Catalog members (`generic: {}`, `recipe: {}`, `catalog: {}`) collapse, because the service dumps Catalog defaults identically either way.
8. **Canonicalization vs errors.** Silent canonicalization is limited to: `context_tokens` under `context: "full"` returns to 12,288 (design §2); explicit `null` optional factors are dropped; a partial explicit Article fills the service defaults; partial recipe `factors` fill `true`; empty Catalog members are dropped. Everything else is an error: overlap/selection/grouping without bounded context, every other §3 rule, non-integers, values below minima, `overlap_passages > 2`, unknown keys, duplicate or empty identity fields. Validation precedes canonicalization (so `context_tokens: 7000` under full is still refused).
9. **Python accepts what the design rejects.** `ArticleOptions` accepts `identity_fields: [""]` and lax numeric strings; the design requires rejecting empty names. Ruling: TS rejects empty names and non-number JSON (strictly narrower; an empty name can never pass the service's schema check). Parity tests compare verdicts on the fixture partitions only, and TS supplies the field paths §3 demands (Python's cross-field errors have `loc: ()`).
10. **Heading vs CONTEXT.md.** The design's panel heading "Advanced extraction" collides with CONTEXT.md, which lists "advanced extraction" as a term to avoid (for Schema-Guided Extraction). Ruling: keep the design copy (binding); add the domain term **Extraction Method Settings** to CONTEXT.md (Task 14). The controller may rename the heading to "Extraction method settings".
11. **Batch equal-selection across the release.** Historical batches have no snapshot. Ruling: the selection ID always hashes the canonical descriptor, so a post-release request never replays a pre-release batch (their method is "Not recorded", not provably equal).
12. **Row lock for a never-applied account.** `ModelConfigurationStore.apply` locks by upsert and would create a bare row. Ruling: admission locks the configuration row only when it exists (no-op UPDATE, the `lockSourceDocumentRow` pattern) and never creates configuration rows; a concurrent first apply linearizes after an admission that read no row. Lock order everywhere: Source Document rows (sorted) → configuration row; `apply` takes only the configuration row, so no cycle.
13. **Effective method for historical runs.** Stored diagnostics never kept artifact options. Ruling: effective method is "Not recorded" for historical successes; kei artifacts are not re-read (design §7 permits, does not require, using retained artifacts).
14. **Exact Article span ranges have no home on the evidence link.** Ruling (E3): keep `evidenceLinkSchema` unchanged (assert `precision` pass-through); carry the artifact's `quoted_support` proofs, including code-point `start`/`end`, verbatim into diagnostics.
15. **360 px.** The repo's `REQUIRED_VIEWPORTS` stop at 390 px; U8 requires 360 px. Ruling: the Advanced browser test adds a 360×800 case.
16. **"Local persistence contract documentation"** (tasks.md 1.2) has no dedicated file. Ruling: column comments in `packages/db/src/prisma/contract.prisma` (Task 2) and README product-contract items 5 and 7 (Task 14).

## Traceability

| Plan task | tasks.md | Acceptance IDs |
| --- | --- | --- |
| 1 Method contract, fixtures, TS/Python parity | 1.1 | U5, U6, U7 (function), P1 (translation), P7 |
| 2 Authored migration and configuration row lock | 1.2 | M1, F2 (null snapshots), P6 (lock) |
| 3 Account document contract and API | 1.1 | U2, U3, U6, Review Focus 5 |
| 4 Single admission end to end | 1.3 | P5, P6, P7, U7, Review Focus 1–2 |
| 5 Batch and suggested-batch admission end to end | 1.3 | P3 (admission), P4, P5 (batch), P6, U7 |
| 6 Durable execution reads only the admitted method; A1 | 1.4 | P1, P2, P3, M1, A1, Review Focus 4 |
| 7 Result adapters and the attempt read model | 3.2, 3.1 (data) | E1, E2, E3, E5, F1, F2 |
| 8 Advanced draft state and helpers | 2.1 | U4, U5 (UI reachability), U9, Review Focus 3 |
| 9 Advanced tab UI | 2.1 | U1, U2, U3, U4, U6, U9 |
| 10 Explain guide and starting points | 2.2 | U1, U8, U9, E4 |
| 11 Start views show and refresh the saved method | 3.1 | P5, P6, P7 |
| 12 Method used on Extraction details | 3.1 | F1, F2, E1 (display) |
| 13 Browser and real-service coverage | 2.3 | U1, U3, U4, U8, P1, F1 |
| 14 README, CONTEXT and contract docs | 3.3 (+1.2, 1.4 docs) | A1 (documented), all |
| Acceptance phase (controller) | 4.1–4.3 | all |

## File structure

| File | Responsibility |
| --- | --- |
| `packages/extraction/src/extraction-method.ts` | The one method contract: model-choice schema (moved from Studio), Article/Catalog settings schemas and cross-field rules, `METHOD_MESSAGES`, canonicalization, active-method descriptor, account-document reader, stored-snapshot reader, `keiMethodOptions`, identity-field pre-check. Browser-safe (imports zod, `allowed-values`, `errors`, types only). |
| `packages/extraction/src/extraction-method.test.ts` | Contract, fixture parity, categorical inventory, canonicalization, wire translation. |
| `prototypes/parsing_service/tests/fixtures/contracts/article-options.json` | The 19 contract cases (verbatim) with each accepted case's `ArticleOptions` dump, and the categorical inventory's verdict vector. |
| `prototypes/parsing_service/tests/fixtures/contracts/identity-fields.json` | Schema + identity-field cases shared by TS pre-check and Python `ExtractRequest`. |
| `prototypes/parsing_service/tests/helpers/article_options.py` | Enumerates the inventory and regenerates `article-options.json` (`--write`). |
| `packages/db/migrations/app/*_extraction_settings/` | Authored forward migration: three nullable jsonb columns + account-document backfill. |
| `packages/db/src/row-lock.ts` | `lockModelConfiguration` beside `lockSourceDocumentRow`. |
| `prototypes/studio/shared/modelConfig.contract.ts` | Embeds `extractionSettings` in the account document. |
| `prototypes/studio/api/_model_config.ts` | Validates, canonicalizes and persists the whole document. |
| `packages/extraction/src/postgres-admission.ts`, `postgres-suggested-batch.ts` | Pin, compare and snapshot the active method. |
| `packages/extraction/src/workflows.ts`, `postgres-workflow-store.ts` | Read only the admitted snapshot. |
| `packages/extraction/src/kei-artifact.ts` | Checks the artifact honors every requested option; records effective method, eligibility and support proofs. |
| `prototypes/studio/src/savedMethod.ts` | Loads the account document for start views and derives the descriptor with the contract's function. |
| `prototypes/studio/src/providerConfig/advancedSettings.ts` | Local labels, summaries, availability (disabled reasons), change detection, starting points and deltas. |
| `prototypes/studio/src/providerConfig/AdvancedTab.tsx` | The Advanced tab. |
| `prototypes/studio/src/providerConfig/AdvancedGuide.tsx`, `advancedGuide.data.ts` | Explain dialog, How this works, starting points, study evidence. |
| `prototypes/studio/src/SavedMethodSummary.tsx` | "Saved advanced settings" disclosure and conflict refresh for start views. |
| `prototypes/studio/src/MethodUsed.tsx` | "Method used" in Run details. |

---

### Task 1: Method contract, shared fixtures and TS/Python parity

**Files:**
- Modify: `packages/extraction/src/extraction-method.ts` (whole file; today 42 lines)
- Modify: `packages/extraction/src/errors.ts` (add four codes)
- Modify: `packages/extraction/package.json` (subpath export, test list)
- Create: `packages/extraction/src/extraction-method.test.ts`
- Modify: `packages/extraction/src/workflows.test.ts` (one existing expectation gains `requestedSettings: null`)
- Create: `prototypes/parsing_service/tests/fixtures/contracts/article-options.json`
- Create: `prototypes/parsing_service/tests/fixtures/contracts/identity-fields.json`
- Create: `prototypes/parsing_service/tests/helpers/article_options.py`
- Modify: `prototypes/parsing_service/tests/test_extraction_methods.py` (append three tests)
- Modify: `prototypes/studio/shared/modelConfig.contract.ts:39-48` (re-export the moved model-choice schemas)

**Interfaces:**
- Consumes: `isScalarFieldType` (`packages/extraction/src/allowed-values.ts`), `SchemaNode` (`schema.ts`), `ExtractionModelChoice`, `ExtractionStrategy` (`types.ts`), `ExtractionError` (`errors.ts`).
- Produces (all exported from `extraction-method.ts` and from subpath `extraction/extraction-method`):
  - `extractionModelKeySchema`, `extractionModelChoiceSchema` (moved verbatim from Studio)
  - `ARTICLE_MIN_CONTEXT_TOKENS = 8_192`, `ARTICLE_REFERENCE_CONTEXT_TOKENS = 12_288`, `CATALOG_DEFAULTS`
  - `METHOD_MESSAGES` (keys `bounded`, `schemaPolicy`, `schedule`, `routing`, `identity`, `identityNames`, `contextTokens`, `overlap`, `characters`, `budgetTokens`)
  - `articleSettingsSchema`, `type ArticleSettings`, `ARTICLE_KEYS`, `REFERENCE_ARTICLE`
  - `genericCatalogSettingsSchema`, `recipeCatalogSettingsSchema`, `catalogFactorsSchema`, `catalogSettingsSchema`, `type GenericCatalogSettings`, `type RecipeCatalogSettings`, `type CatalogSettings`, `REFERENCE_CATALOG`
  - `extractionSettingsSchema`, `type ExtractionSettings`
  - `type MethodIssue = Readonly<{ path: string; message: string }>`; `articleSettingsIssues(article: ArticleSettings): MethodIssue[]` (paths relative to the Article member); `extractionSettingsIssues(settings: ExtractionSettings): MethodIssue[]` (paths `article.<field>`); `settingsShapeIssues(error: z.ZodError, prefix?: string): MethodIssue[]`; `validateArticleOptions(input: unknown): { ok: true; value: ArticleSettings } | { ok: false; issues: MethodIssue[] }`
  - `canonicalArticle(article: ArticleSettings): ArticleSettings`; `canonicalExtractionSettings(settings: ExtractionSettings): ExtractionSettings`
  - `activeSettingsSchema`, `type ActiveSettings` (`{ article: ArticleSettings | null } | { generic: GenericCatalogSettings | null } | { recipe: RecipeCatalogSettings | null }`), `type SettingsSlot = 'article' | 'generic' | 'recipe'`, `settingsSlot(strategy, catalogRecipe: string | null): SettingsSlot`, `activeSettings(settings, strategy, catalogRecipe): ActiveSettings`
  - `extractionMethodIntentSchema`, `type ExtractionMethodIntent = Readonly<{ models: ExtractionModelChoice | null; settings: ActiveSettings }>`, `activeMethod(models: unknown, settings: ExtractionSettings, strategy, catalogRecipe): ExtractionMethodIntent`, `accountMethod(document: unknown, strategy, catalogRecipe): ExtractionMethodIntent` (throws `ExtractionError('invalid_model_config')`), `canonicalIntent(value: unknown, strategy, catalogRecipe): ExtractionMethodIntent | null`
  - `storedSettings(value: unknown, strategy, catalogRecipe): ActiveSettings | null` (throws `ExtractionError('invalid_extraction_method')`)
  - `type ExtractionMethod` gains `requestedSettings: ActiveSettings | null`; `extractionMethod(strategy, catalogRecipe, requestedModels, requestedSettings?: unknown)`; `keiMethodOptions(method)` extended; `modelChoice` unchanged
  - `type IdentityFieldIssue = Readonly<{ name: string; reason: 'missing' | 'nested' | 'not-scalar' | 'document' | 'filename' }>`, `identityFieldIssues(nodes: readonly SchemaNode[], fields: readonly string[]): IdentityFieldIssue[]`, `identityFieldsMessage(issues: readonly IdentityFieldIssue[]): string`
  - `ExtractionErrorCode` gains `'method_changed' | 'invalid_identity_fields' | 'invalid_model_config' | 'invalid_extraction_method'`

- [ ] **Step 1: Create the shared fixtures**

  `prototypes/parsing_service/tests/fixtures/contracts/article-options.json` — copy the 19 `cases` from `openspec/changes/advanced-extraction-configuration/contract-cases.json` verbatim (same `id`, `input`, `accepted`, same order); `canonical` fields and the inventory `verdicts` are filled by Step 3's `--write`:

  ```json
  {
    "source": "openspec/changes/advanced-extraction-configuration/contract-cases.json (4e2a5820): the nineteen Article method examples, copied verbatim; `canonical` is ArticleOptions.model_dump(mode='json') for accepted cases",
    "cases": [
      {"id": "reference", "input": {}, "accepted": true},
      {"id": "full-quoted-policy", "input": {"grounding": "quoted", "evidence_policy": "schema"}, "accepted": true},
      {"id": "bounded-combined", "input": {"context": "bounded", "context_tokens": 12288, "prompt": "schema", "grounding": "spans", "grounding_schedule": "unresolved", "evidence_policy": "schema"}, "accepted": true},
      {"id": "all-optional-factors", "input": {"context": "bounded", "context_tokens": 16384, "overlap_passages": 2, "identity": "conservative", "identity_fields": ["species", "preparation"], "prompt": "schema", "grounding": "spans", "grounding_schedule": "unresolved", "evidence_policy": "schema", "grounding_routing": "origin_lexical", "selection": "supported", "rendering": "structured", "grouping": "structural"}, "accepted": true},
      {"id": "reference-with-fields", "input": {"identity_fields": ["species"]}, "accepted": true},
      {"id": "semantic-unresolved", "input": {"grounding": "semantic", "grounding_schedule": "unresolved"}, "accepted": true},
      {"id": "off", "input": {"grounding": "off"}, "accepted": true},
      {"id": "full-overlap", "input": {"overlap_passages": 1}, "accepted": false},
      {"id": "full-selection", "input": {"selection": "supported"}, "accepted": false},
      {"id": "full-structural", "input": {"grouping": "structural"}, "accepted": false},
      {"id": "semantic-schema-policy", "input": {"grounding": "semantic", "evidence_policy": "schema"}, "accepted": false},
      {"id": "off-schedule", "input": {"grounding": "off", "grounding_schedule": "unresolved"}, "accepted": false},
      {"id": "routing-without-schedule", "input": {"grounding": "spans", "grounding_routing": "origin_lexical"}, "accepted": false},
      {"id": "routing-semantic", "input": {"grounding": "semantic", "grounding_schedule": "unresolved", "grounding_routing": "origin_lexical"}, "accepted": false},
      {"id": "conservative-no-fields", "input": {"identity": "conservative"}, "accepted": false},
      {"id": "duplicate-fields", "input": {"identity_fields": ["species", "species"]}, "accepted": false},
      {"id": "too-small-context", "input": {"context": "bounded", "context_tokens": 8191}, "accepted": false},
      {"id": "too-much-overlap", "input": {"context": "bounded", "overlap_passages": 3}, "accepted": false},
      {"id": "invented-span-version-option", "input": {"span_grounding_version": 1}, "accepted": false}
    ],
    "inventory": {
      "context_tokens": 12288,
      "identity_fields": ["species", "preparation"],
      "factors": {
        "context": ["full", "bounded"],
        "overlap_passages": [0, 1, 2],
        "identity": ["reference", "conservative"],
        "prompt": ["reference", "schema"],
        "grounding": ["semantic", "quoted", "spans", "off"],
        "grounding_schedule": [null, "unresolved"],
        "evidence_policy": [null, "schema"],
        "grounding_routing": [null, "origin_lexical"],
        "selection": [null, "supported"],
        "rendering": [null, "structured"],
        "grouping": [null, "structural"]
      },
      "accepted": 0,
      "rejected": 0,
      "verdicts": ""
    }
  }
  ```

  Enumeration order is `itertools.product` over `factors` in key order (last factor varies fastest). An input takes each non-null factor value, `context_tokens` from the inventory, and `identity_fields` = the inventory's fields when `identity` is `conservative`, else `[]`. `verdicts` is one `1`/`0` per input in that order.

  `prototypes/parsing_service/tests/fixtures/contracts/identity-fields.json`:

  ```json
  {
    "schema": {"recordDescription": "One specimen.", "schemaNodes": [
      {"id": "species", "name": "species", "type": "string"},
      {"id": "preparation", "name": "preparation", "type": "verbatim-string"},
      {"id": "count", "name": "count", "type": "integer"},
      {"id": "measurements", "name": "measurements", "type": "object", "children": [
        {"id": "temperature", "name": "temperature", "type": "number"}
      ]},
      {"id": "tags", "name": "tags", "type": "array", "itemType": "string"},
      {"id": "journal", "name": "journal", "type": "string", "valueSource": "document"},
      {"id": "file", "name": "file", "type": "string", "valueSource": "source-filename"}
    ]},
    "cases": [
      {"fields": ["species", "preparation"], "issues": []},
      {"fields": ["count"], "issues": []},
      {"fields": ["Species"], "issues": [{"name": "Species", "reason": "missing"}]},
      {"fields": ["temperature"], "issues": [{"name": "temperature", "reason": "nested"}]},
      {"fields": ["measurements"], "issues": [{"name": "measurements", "reason": "not-scalar"}]},
      {"fields": ["tags"], "issues": [{"name": "tags", "reason": "not-scalar"}]},
      {"fields": ["journal"], "issues": [{"name": "journal", "reason": "document"}]},
      {"fields": ["file"], "issues": [{"name": "file", "reason": "filename"}]},
      {"fields": ["species", "absent"], "issues": [{"name": "absent", "reason": "missing"}]}
    ]
  }
  ```

- [ ] **Step 2: Write the Python helper and failing Python tests**

  `prototypes/parsing_service/tests/helpers/article_options.py`:

  ```python
  """The shared Article-method fixture (`tests/fixtures/contracts/article-options.json`) as this service decides it.

  Studio's `packages/extraction/src/extraction-method.test.ts` enumerates the same categorical inventory from the
  fixture's own factor lists and must reach the same verdicts, so TS/Python parity is a test on both sides. After an
  intended `ArticleOptions` change, regenerate from `prototypes/parsing_service`:
  `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src:. .venv/bin/python -m tests.helpers.article_options --write`
  """
  from __future__ import annotations

  import itertools
  import json
  import sys
  from collections.abc import Iterator

  from pydantic import ValidationError

  from kei_exp.kie.extract.method import ArticleOptions
  from tests.helpers.contracts import FIXTURES

  PATH = FIXTURES / "article-options.json"


  def inputs(inventory: dict) -> Iterator[dict]:
      factors = inventory["factors"]
      names = list(factors)
      for values in itertools.product(*(factors[name] for name in names)):
          chosen = dict(zip(names, values))
          yield {**{name: value for name, value in chosen.items() if value is not None},
                 "context_tokens": inventory["context_tokens"],
                 "identity_fields": inventory["identity_fields"] if chosen["identity"] == "conservative" else []}


  def accepted(value: dict) -> bool:
      try:
          ArticleOptions.model_validate(value)
      except ValidationError:
          return False
      return True


  def verdicts(inventory: dict) -> str:
      return "".join("1" if accepted(value) else "0" for value in inputs(inventory))


  def regenerated(fixture: dict) -> dict:
      cases = []
      for case in fixture["cases"]:
          kept = {key: case[key] for key in ("id", "input", "accepted")}
          if accepted(case["input"]):
              kept["canonical"] = ArticleOptions.model_validate(case["input"]).model_dump(mode="json")
          cases.append(kept)
      vector = verdicts(fixture["inventory"])
      inventory = {**fixture["inventory"], "accepted": vector.count("1"), "rejected": vector.count("0"),
                   "verdicts": vector}
      return {**fixture, "cases": cases, "inventory": inventory}


  if __name__ == "__main__":
      current = json.loads(PATH.read_text(encoding="utf-8"))
      if sys.argv[1:] != ["--write"]:
          sys.exit("usage: python -m tests.helpers.article_options --write")
      PATH.write_text(json.dumps(regenerated(current), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
  ```

  Append to `prototypes/parsing_service/tests/test_extraction_methods.py` (imports at the top: `from tests.helpers import article_options` and `from tests.helpers.contracts import fixture`):

  ```python
  def test_contract_cases_and_their_dumps_match_the_shared_fixture():
      shared = fixture("article-options")
      for case in shared["cases"]:
          assert article_options.accepted(case["input"]) is case["accepted"], case["id"]
          if case["accepted"]:
              assert ArticleOptions.model_validate(case["input"]).model_dump(mode="json") == case["canonical"], case["id"]
      assert len(shared["cases"]) == 19


  def test_categorical_inventory_verdicts_match_the_shared_fixture():
      inventory = fixture("article-options")["inventory"]
      assert article_options.verdicts(inventory) == inventory["verdicts"]
      # The specification's receipt (contract-check.json) pins these counts at one ceiling and key set.
      assert (inventory["accepted"], inventory["rejected"]) == (1560, 4584)


  def test_identity_fields_are_checked_against_the_schema_as_the_shared_fixture_says():
      shared = fixture("identity-fields")
      for case in shared["cases"]:
          options = {"strategy": "article", "article": {"identity_fields": case["fields"]}}
          if not case["issues"]:
              run.ExtractRequest(schema=shared["schema"], options=options)
              continue
          with pytest.raises(ValueError) as refused:
              run.ExtractRequest(schema=shared["schema"], options=options)
          assert str(sorted(issue["name"] for issue in case["issues"])) in str(refused.value)
  ```

- [ ] **Step 3: Generate the fixture and run the Python tests**

  ```bash
  cd prototypes/parsing_service
  PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src:. .venv/bin/python -m tests.helpers.article_options --write
  PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src:. .venv/bin/python -m pytest -q tests/test_extraction_methods.py -m 'not postgres and not live_model'
  ```
  Expected: the write fills seven `canonical` objects and a 6,144-character `verdicts` with `"accepted": 1560, "rejected": 4584`; all tests PASS. If counts differ from 1560/4584, stop and report: the Python validator differs from the specification's receipt.

- [ ] **Step 4: Write the failing TS contract tests**

  Create `packages/extraction/src/extraction-method.test.ts`:

  ```ts
  import assert from 'node:assert/strict'
  import { readFileSync } from 'node:fs'
  import test from 'node:test'
  import {
    activeMethod, activeSettings, accountMethod, ARTICLE_REFERENCE_CONTEXT_TOKENS, canonicalArticle,
    canonicalExtractionSettings, canonicalIntent, extractionMethod, extractionSettingsIssues, extractionSettingsSchema,
    identityFieldIssues, identityFieldsMessage, keiMethodOptions, METHOD_MESSAGES, REFERENCE_ARTICLE, REFERENCE_CATALOG,
    storedSettings, validateArticleOptions, type ArticleSettings,
  } from './extraction-method.js'
  import { ExtractionError } from './errors.js'
  import { parseSchemaDefinition } from './schema.js'

  const FIXTURES = new URL('../../../prototypes/parsing_service/tests/fixtures/contracts/', import.meta.url)
  const fixture = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'))

  type Inventory = { context_tokens: number; identity_fields: string[]; factors: Record<string, unknown[]>; accepted: number; rejected: number; verdicts: string }

  /** itertools.product over the fixture's factors in key order: the last factor varies fastest. */
  function* inventoryInputs(inventory: Inventory): Generator<Record<string, unknown>> {
    const names = Object.keys(inventory.factors)
    const walk = function* (index: number, chosen: Record<string, unknown>): Generator<Record<string, unknown>> {
      if (index === names.length) {
        const input = Object.fromEntries(Object.entries(chosen).filter(([, value]) => value !== null))
        yield { ...input, context_tokens: inventory.context_tokens,
          identity_fields: chosen.identity === 'conservative' ? inventory.identity_fields : [] }
        return
      }
      for (const value of inventory.factors[names[index]!]!) yield* walk(index + 1, { ...chosen, [names[index]!]: value })
    }
    yield* walk(0, {})
  }

  test('the nineteen contract cases get the service verdicts and, when accepted, its exact dump', () => {
    const { cases } = fixture('article-options') as { cases: Array<{ id: string; input: unknown; accepted: boolean; canonical?: unknown }> }
    assert.equal(cases.length, 19)
    for (const item of cases) {
      const result = validateArticleOptions(item.input)
      assert.equal(result.ok, item.accepted, item.id)
      if (result.ok) assert.deepEqual(canonicalArticle(result.value), item.canonical, item.id)
    }
  })

  test('every categorical combination gets the verdict the service gives it', () => {
    const inventory = fixture('article-options').inventory as Inventory
    const mismatches: string[] = []
    let index = 0
    for (const input of inventoryInputs(inventory)) {
      const expected = inventory.verdicts[index] === '1'
      if (validateArticleOptions(input).ok !== expected && mismatches.length < 10)
        mismatches.push(`#${index} ${JSON.stringify(input)} service=${expected}`)
      index += 1
    }
    assert.equal(index, 6144)
    assert.deepEqual(mismatches, [])
    assert.deepEqual([inventory.accepted, inventory.rejected], [1560, 4584])
  })

  test('cross-field refusals name their field with the design copy', () => {
    const issues = (input: Record<string, unknown>) => {
      const result = validateArticleOptions(input)
      return result.ok ? [] : result.issues
    }
    assert.deepEqual(issues({ overlap_passages: 1 }), [{ path: 'overlap_passages', message: METHOD_MESSAGES.bounded }])
    assert.deepEqual(issues({ selection: 'supported' }), [{ path: 'selection', message: METHOD_MESSAGES.bounded }])
    assert.deepEqual(issues({ grouping: 'structural' }), [{ path: 'grouping', message: METHOD_MESSAGES.bounded }])
    assert.deepEqual(issues({ evidence_policy: 'schema' }), [{ path: 'evidence_policy', message: METHOD_MESSAGES.schemaPolicy }])
    assert.deepEqual(issues({ grounding: 'off', grounding_schedule: 'unresolved' }), [{ path: 'grounding_schedule', message: METHOD_MESSAGES.schedule }])
    assert.deepEqual(issues({ grounding: 'spans', grounding_routing: 'origin_lexical' }), [{ path: 'grounding_routing', message: METHOD_MESSAGES.routing }])
    assert.deepEqual(issues({ identity: 'conservative' }), [{ path: 'identity_fields', message: METHOD_MESSAGES.identity }])
    assert.equal(METHOD_MESSAGES.bounded, 'This choice requires bounded source units.')
    assert.equal(METHOD_MESSAGES.routing, 'Use generated quotes or source spans, and stop after support.')
  })

  test('numeric and key boundaries: minima, integers, overlap ceiling, duplicate and empty names, unknown factors', () => {
    const refused = (input: Record<string, unknown>, path: string, message: string) => {
      const result = validateArticleOptions(input)
      assert.equal(result.ok, false, JSON.stringify(input))
      assert.ok(!result.ok && result.issues.some((issue) => issue.path === path && issue.message === message), JSON.stringify(result))
    }
    assert.equal(validateArticleOptions({ context: 'bounded', context_tokens: 8192 }).ok, true)
    refused({ context: 'bounded', context_tokens: 8191 }, 'context_tokens', METHOD_MESSAGES.contextTokens)
    refused({ context: 'bounded', context_tokens: 8192.5 }, 'context_tokens', METHOD_MESSAGES.contextTokens)
    refused({ context: 'bounded', context_tokens: '12288' }, 'context_tokens', METHOD_MESSAGES.contextTokens)
    refused({ context: 'bounded', overlap_passages: 3 }, 'overlap_passages', METHOD_MESSAGES.overlap)
    refused({ identity_fields: ['species', 'species'] }, 'identity_fields', METHOD_MESSAGES.identityNames)
    refused({ identity_fields: [''] }, 'identity_fields.0', METHOD_MESSAGES.identityNames)
    assert.equal(validateArticleOptions({ span_grounding_version: 1 }).ok, false)
    const catalog = (value: unknown) => extractionSettingsSchema.safeParse({ catalog: value })
    assert.equal(catalog({ generic: { discovery_chars: 1000, record_chars: 1000 } }).success, true)
    assert.equal(catalog({ generic: { discovery_chars: 999 } }).success, false)
    assert.equal(catalog({ recipe: { input_tokens: 64, output_tokens: 64 } }).success, true)
    assert.equal(catalog({ recipe: { output_tokens: 63 } }).success, false)
    assert.equal(catalog({ recipe: { factors: { glossary: false, vocabulary: false } } }).success, false)
  })

  test('canonical settings: full Article, no nulls, the unused ceiling restored, empty Catalog members dropped', () => {
    const parsed = extractionSettingsSchema.parse({
      article: { context: 'full', context_tokens: 16384, grounding_schedule: null, selection: null },
      catalog: { generic: {}, recipe: { factors: { verification: false } } },
    })
    assert.deepEqual(extractionSettingsIssues(parsed), [])
    const canonical = canonicalExtractionSettings(parsed)
    assert.deepEqual(canonical, {
      article: { ...REFERENCE_ARTICLE, context_tokens: ARTICLE_REFERENCE_CONTEXT_TOKENS },
      catalog: { recipe: { factors: { glossary: true, headings: true, overlap: true, verification: false } } },
    })
    assert.deepEqual(Object.keys(canonical.article!), ['context', 'context_tokens', 'overlap_passages', 'identity', 'identity_fields', 'prompt', 'grounding'])
    assert.deepEqual(canonicalExtractionSettings(extractionSettingsSchema.parse({ catalog: {} })), {})
    // An explicit Article is never an omission: it changes the service's artifact.
    assert.deepEqual(canonicalExtractionSettings(extractionSettingsSchema.parse({ article: {} })), { article: REFERENCE_ARTICLE })
  })

  const EXPLORE: ArticleSettings = {
    context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
    prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema',
  }

  test('the exact wire example: strategy, models and every active option, nothing invented', () => {
    const method = extractionMethod('ARTICLE', null, { fields: 'instruct', reasoning: 'instruct' }, { article: EXPLORE })
    assert.deepEqual(keiMethodOptions(method), {
      strategy: 'article',
      models: { fields: 'instruct', reasoning: 'instruct' },
      article: {
        context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
        prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema',
      },
    })
  })

  test('service defaults omit the strategy member; generic Catalog emits no catalog object; inactive settings never leak', () => {
    assert.deepEqual(keiMethodOptions(extractionMethod('ARTICLE', null, null, { article: null })), { strategy: 'article' })
    assert.deepEqual(keiMethodOptions(extractionMethod('ARTICLE', null, null, null)), { strategy: 'article' })
    assert.deepEqual(keiMethodOptions(extractionMethod('CATALOG', null, null, { generic: { record_chars: 30000 } })),
      { strategy: 'catalog', record_chars: 30000 })
    assert.deepEqual(keiMethodOptions(extractionMethod('CATALOG', 'numbered-catalogue-de@1', null, { recipe: REFERENCE_CATALOG.recipe! })),
      { strategy: 'catalog', catalog: { recipe: 'numbered-catalogue-de@1', ...REFERENCE_CATALOG.recipe } })
    assert.deepEqual(keiMethodOptions(extractionMethod('CATALOG', 'numbered-catalogue-de@1', null, { recipe: null })),
      { strategy: 'catalog', catalog: { recipe: 'numbered-catalogue-de@1' } })
    const saved = extractionSettingsSchema.parse({ article: EXPLORE, catalog: REFERENCE_CATALOG })
    assert.deepEqual(activeSettings(saved, 'CATALOG', null), { generic: REFERENCE_CATALOG.generic })
    assert.deepEqual(activeSettings(saved, 'ARTICLE', null), { article: EXPLORE })
    for (const strategy of ['ARTICLE', 'CATALOG'] as const) {
      const wire = JSON.stringify(keiMethodOptions(extractionMethod(strategy, null, null, activeSettings(saved, strategy, null))))
      for (const invented of ['"plain"', '"all"', '"token"', '"source_order"', 'null']) assert.ok(!wire.includes(invented), wire)
    }
  })

  test('explicit reference and omission are different descriptors', () => {
    const omitted = activeMethod(null, {}, 'ARTICLE', null)
    const explicit = activeMethod(null, { article: REFERENCE_ARTICLE }, 'ARTICLE', null)
    assert.deepEqual(omitted, { models: null, settings: { article: null } })
    assert.notDeepEqual(omitted, explicit)
    assert.deepEqual(keiMethodOptions(extractionMethod('ARTICLE', null, null, explicit.settings)).article, REFERENCE_ARTICLE)
  })

  test('an account document yields the active descriptor; only the chosen strategy counts', () => {
    const document = {
      connections: [], routes: {}, ingestionModels: {},
      extractionModels: { fields: 'nuextract' },
      extractionSettings: { article: EXPLORE, catalog: { generic: { record_chars: 30000 } } },
    }
    assert.deepEqual(accountMethod(document, 'ARTICLE', null), { models: { fields: 'nuextract' }, settings: { article: EXPLORE } })
    assert.deepEqual(accountMethod(document, 'CATALOG', 'numbered-catalogue-de@1'), { models: { fields: 'nuextract' }, settings: { recipe: null } })
    assert.deepEqual(accountMethod(null, 'CATALOG', null), { models: null, settings: { generic: null } })
    assert.throws(() => accountMethod({ extractionModels: {}, extractionSettings: { article: { overlap_passages: 1 } } }, 'ARTICLE', null),
      (error: unknown) => error instanceof ExtractionError && error.code === 'invalid_model_config')
  })

  test('a submitted intent is canonicalized, and one for another strategy is refused', () => {
    assert.deepEqual(canonicalIntent({ models: {}, settings: { article: { ...EXPLORE, grouping: null } } }, 'ARTICLE', null),
      { models: null, settings: { article: EXPLORE } })
    assert.deepEqual(canonicalIntent({ models: null, settings: { generic: {} } }, 'CATALOG', null), { models: null, settings: { generic: null } })
    assert.equal(canonicalIntent({ models: null, settings: { article: null } }, 'CATALOG', null), null)
    assert.equal(canonicalIntent({ models: null, settings: { article: { overlap_passages: 1 } } }, 'ARTICLE', null), null)
    assert.equal(canonicalIntent({ models: null, settings: { generic: null }, preset: 'best' }, 'CATALOG', null), null)
  })

  test('a stored snapshot is read back, and one for another strategy is an invalid method', () => {
    assert.equal(storedSettings(null, 'ARTICLE', null), null)
    assert.deepEqual(storedSettings({ article: EXPLORE }, 'ARTICLE', null), { article: EXPLORE })
    assert.throws(() => storedSettings({ generic: null }, 'ARTICLE', null),
      (error: unknown) => error instanceof ExtractionError && error.code === 'invalid_extraction_method')
  })

  test('identity fields are checked against the pinned schema exactly as the shared fixture says', () => {
    const shared = fixture('identity-fields') as { schema: unknown; cases: Array<{ fields: string[]; issues: unknown[] }> }
    const nodes = parseSchemaDefinition(shared.schema).schemaNodes
    for (const item of shared.cases) assert.deepEqual(identityFieldIssues(nodes, item.fields), item.issues, item.fields.join())
    assert.equal(
      identityFieldsMessage(identityFieldIssues(nodes, ['Species', 'tags'])),
      'These identity fields are not scalar record fields of the selected Schema Revision: Species (not in this schema), tags (not a single value).',
    )
  })
  ```

- [ ] **Step 5: Run to verify the TS tests fail**

  Run: `cd packages/extraction && npx tsx --test src/extraction-method.test.ts`
  Expected: FAIL — `validateArticleOptions` (and the other new exports) are not exported.

- [ ] **Step 6: Implement the contract**

  Add to `packages/extraction/src/errors.ts` `ExtractionErrorCode` union: `| 'method_changed' | 'invalid_identity_fields' | 'invalid_model_config' | 'invalid_extraction_method'`.

  Replace `packages/extraction/src/extraction-method.ts` with:

  ```ts
  import { z } from 'zod'
  import { isScalarFieldType } from './allowed-values.js'
  import { ExtractionError } from './errors.js'
  import type { SchemaNode } from './schema.js'
  import type { ExtractionModelChoice, ExtractionStrategy } from './types.js'

  const ROLES = ['fields', 'reasoning'] as const

  /** A kei-exp extraction model key (`instruct`, `nuextract`, ...): a registry key of the kei-exp deployment, never a
   *  repo id and never a FREE Model Connection's model. */
  export const extractionModelKeySchema = z.string().min(1).max(128)

  /** An Extraction Model Choice: per role, the kei-exp model key extractions are requested on. An omitted role keeps
   *  kei-exp's deployment default; kei-exp refuses a key it does not serve, or one that cannot take the role. */
  export const extractionModelChoiceSchema = z
    .object({ fields: extractionModelKeySchema.optional(), reasoning: extractionModelKeySchema.optional() })
    .strict()

  export const ARTICLE_MIN_CONTEXT_TOKENS = 8_192
  /** The Parsing Service's reference bounded ceiling; full source uses the served context instead. */
  export const ARTICLE_REFERENCE_CONTEXT_TOKENS = 12_288
  /** The Parsing Service's Catalog defaults (`run.py` `Options`, `grounded.py` `CatalogOptions`). */
  export const CATALOG_DEFAULTS = { discovery_chars: 48_000, record_chars: 24_000, input_tokens: 4_096, output_tokens: 1_024 } as const

  /** The copy a refused setting shows: beside its field on the Advanced tab and in a refused request's details. */
  export const METHOD_MESSAGES = {
    bounded: 'This choice requires bounded source units.',
    schemaPolicy: 'Schema policies require generated quotes or source spans.',
    schedule: 'Choose a verification method to use this schedule.',
    routing: 'Use generated quotes or source spans, and stop after support.',
    identity: 'Add the scalar record fields that identify one record.',
    identityNames: 'Each identity field needs its own non-empty name.',
    contextTokens: 'Enter a whole number of tokens, at least 8,192.',
    overlap: 'Choose 0, 1 or 2 previous passages.',
    characters: 'Enter a whole number of characters, at least 1,000.',
    budgetTokens: 'Enter a whole number of tokens, at least 64.',
  } as const

  const wholeNumber = (message: string, minimum: number) => z.number({ error: message }).int(message).min(minimum, message)
  const optionalFactor = <T extends string>(value: T) => z.literal(value).nullable().optional()

  /** Article's method: the Parsing Service's `ArticleOptions` (`kie/extract/method.py`) field for field, with its
   *  defaults. Its cross-field rules are `articleSettingsIssues`, so every refusal names the field it concerns. */
  export const articleSettingsSchema = z.object({
    context: z.enum(['full', 'bounded']).default('full'),
    context_tokens: wholeNumber(METHOD_MESSAGES.contextTokens, ARTICLE_MIN_CONTEXT_TOKENS).default(ARTICLE_REFERENCE_CONTEXT_TOKENS),
    overlap_passages: wholeNumber(METHOD_MESSAGES.overlap, 0).max(2, METHOD_MESSAGES.overlap).default(0),
    identity: z.enum(['reference', 'conservative']).default('reference'),
    identity_fields: z.array(z.string().min(1, METHOD_MESSAGES.identityNames)).default([]),
    prompt: z.enum(['reference', 'schema']).default('reference'),
    grounding: z.enum(['semantic', 'quoted', 'spans', 'off']).default('semantic'),
    grounding_schedule: optionalFactor('unresolved'),
    evidence_policy: optionalFactor('schema'),
    grounding_routing: optionalFactor('origin_lexical'),
    selection: optionalFactor('supported'),
    rendering: optionalFactor('structured'),
    grouping: optionalFactor('structural'),
  }).strict()
  export type ArticleSettings = z.output<typeof articleSettingsSchema>

  /** `ArticleOptions` field order: saved, compared and sent Article settings keep it, so equal drafts serialize alike. */
  export const ARTICLE_KEYS = [
    'context', 'context_tokens', 'overlap_passages', 'identity', 'identity_fields', 'prompt', 'grounding',
    'grounding_schedule', 'evidence_policy', 'grounding_routing', 'selection', 'rendering', 'grouping',
  ] as const satisfies readonly (keyof ArticleSettings)[]

  /** The explicit reference Customize starts from: every required field, no optional factor. */
  export const REFERENCE_ARTICLE: ArticleSettings = Object.freeze(articleSettingsSchema.parse({}))

  export const genericCatalogSettingsSchema = z.object({
    discovery_chars: wholeNumber(METHOD_MESSAGES.characters, 1_000).optional(),
    record_chars: wholeNumber(METHOD_MESSAGES.characters, 1_000).optional(),
  }).strict()
  export type GenericCatalogSettings = z.output<typeof genericCatalogSettingsSchema>

  /** Recipe factors: `CatalogFactors`. Present factors are complete; each unset switch is on, as the service reads it. */
  export const catalogFactorsSchema = z.object({
    glossary: z.boolean().default(true),
    headings: z.boolean().default(true),
    overlap: z.boolean().default(true),
    verification: z.boolean().default(true),
  }).strict()
  export const recipeCatalogSettingsSchema = z.object({
    input_tokens: wholeNumber(METHOD_MESSAGES.budgetTokens, 64).optional(),
    output_tokens: wholeNumber(METHOD_MESSAGES.budgetTokens, 64).optional(),
    factors: catalogFactorsSchema.optional(),
  }).strict()
  export type RecipeCatalogSettings = z.output<typeof recipeCatalogSettingsSchema>

  /** Generic and recipe Catalog are saved apart: the recipe is chosen per Extraction. */
  export const catalogSettingsSchema = z.object({
    generic: genericCatalogSettingsSchema.optional(),
    recipe: recipeCatalogSettingsSchema.optional(),
  }).strict()
  export type CatalogSettings = z.output<typeof catalogSettingsSchema>

  export const REFERENCE_CATALOG: CatalogSettings = Object.freeze({
    generic: { discovery_chars: CATALOG_DEFAULTS.discovery_chars, record_chars: CATALOG_DEFAULTS.record_chars },
    recipe: {
      input_tokens: CATALOG_DEFAULTS.input_tokens, output_tokens: CATALOG_DEFAULTS.output_tokens,
      factors: { glossary: true, headings: true, overlap: true, verification: true },
    },
  })

  /** A Researcher Account's saved method settings per strategy. An absent member means service defaults. */
  export const extractionSettingsSchema = z.object({
    article: articleSettingsSchema.optional(),
    catalog: catalogSettingsSchema.optional(),
  }).strict()
  export type ExtractionSettings = z.output<typeof extractionSettingsSchema>

  export type MethodIssue = Readonly<{ path: string; message: string }>

  /** The service's cross-field rules (`ArticleOptions.coherent`), each addressed to the choice that breaks it. */
  export function articleSettingsIssues(article: ArticleSettings): MethodIssue[] {
    const issues: MethodIssue[] = []
    const bounded = article.context === 'bounded'
    const verifiesQuotes = article.grounding === 'quoted' || article.grounding === 'spans'
    if (article.overlap_passages > 0 && !bounded) issues.push({ path: 'overlap_passages', message: METHOD_MESSAGES.bounded })
    if (article.selection && !bounded) issues.push({ path: 'selection', message: METHOD_MESSAGES.bounded })
    if (article.grouping && !bounded) issues.push({ path: 'grouping', message: METHOD_MESSAGES.bounded })
    if (article.evidence_policy && !verifiesQuotes) issues.push({ path: 'evidence_policy', message: METHOD_MESSAGES.schemaPolicy })
    if (article.grounding_schedule && article.grounding === 'off')
      issues.push({ path: 'grounding_schedule', message: METHOD_MESSAGES.schedule })
    if (article.grounding_routing && (!verifiesQuotes || article.grounding_schedule !== 'unresolved'))
      issues.push({ path: 'grounding_routing', message: METHOD_MESSAGES.routing })
    if (article.identity === 'conservative' && article.identity_fields.length === 0)
      issues.push({ path: 'identity_fields', message: METHOD_MESSAGES.identity })
    if (new Set(article.identity_fields).size !== article.identity_fields.length)
      issues.push({ path: 'identity_fields', message: METHOD_MESSAGES.identityNames })
    return issues
  }

  export function extractionSettingsIssues(settings: ExtractionSettings): MethodIssue[] {
    return settings.article
      ? articleSettingsIssues(settings.article).map((issue) => ({ ...issue, path: `article.${issue.path}` }))
      : []
  }

  export function settingsShapeIssues(error: z.ZodError, prefix = ''): MethodIssue[] {
    return error.issues.map((issue) => ({ path: [prefix, ...issue.path.map(String)].filter(Boolean).join('.'), message: issue.message }))
  }

  /** What the Parsing Service's `ArticleOptions` accepts, with field-addressed issues: the parity entry point. */
  export function validateArticleOptions(input: unknown):
    | { ok: true; value: ArticleSettings }
    | { ok: false; issues: MethodIssue[] } {
    const parsed = articleSettingsSchema.safeParse(input)
    if (!parsed.success) return { ok: false, issues: settingsShapeIssues(parsed.error) }
    const issues = articleSettingsIssues(parsed.data)
    return issues.length === 0 ? { ok: true, value: parsed.data } : { ok: false, issues }
  }

  /** The explicit Article method as saved, compared and sent: every required field, optional factors only when chosen
   *  (never null), keys in `ArticleOptions` order. Full source uses the served context size, so its unused ceiling
   *  returns to the reference value (design §2). Only for settings without issues. */
  export function canonicalArticle(article: ArticleSettings): ArticleSettings {
    const canonical: Record<string, unknown> = {}
    for (const key of ARTICLE_KEYS) {
      const value = key === 'context_tokens' && article.context === 'full' ? ARTICLE_REFERENCE_CONTEXT_TOKENS : article[key]
      if (value !== null && value !== undefined) canonical[key] = Array.isArray(value) ? [...value] : value
    }
    return canonical as ArticleSettings
  }

  /** A Catalog member without any value is service defaults, i.e. absent: the service dumps its defaults alike. */
  function present<T extends object>(value: T | null | undefined): T | undefined {
    if (value === null || value === undefined) return undefined
    const kept = Object.entries(value).filter(([, item]) => item !== null && item !== undefined)
    return kept.length === 0 ? undefined : (Object.fromEntries(kept) as T)
  }

  /** Saved settings as stored: an explicit Article in full, Catalog members only when they carry a value. */
  export function canonicalExtractionSettings(settings: ExtractionSettings): ExtractionSettings {
    const generic = present(settings.catalog?.generic)
    const recipe = present(settings.catalog?.recipe)
    return {
      ...(settings.article ? { article: canonicalArticle(settings.article) } : {}),
      ...(generic || recipe ? { catalog: { ...(generic ? { generic } : {}), ...(recipe ? { recipe } : {}) } } : {}),
    }
  }

  /** The settings one Extraction uses, as it is compared, pinned and recorded. `null` records service defaults. */
  export const activeSettingsSchema = z.union([
    z.object({ article: articleSettingsSchema.nullable() }).strict(),
    z.object({ generic: genericCatalogSettingsSchema.nullable() }).strict(),
    z.object({ recipe: recipeCatalogSettingsSchema.nullable() }).strict(),
  ])
  export type ActiveSettings = z.output<typeof activeSettingsSchema>
  export type SettingsSlot = 'article' | 'generic' | 'recipe'

  /** Article uses the Article member; Catalog its recipe member when a recipe is chosen, else its generic member. */
  export function settingsSlot(strategy: ExtractionStrategy, catalogRecipe: string | null): SettingsSlot {
    return strategy === 'ARTICLE' ? 'article' : catalogRecipe ? 'recipe' : 'generic'
  }

  export function activeSettings(settings: ExtractionSettings, strategy: ExtractionStrategy, catalogRecipe: string | null): ActiveSettings {
    const canonical = canonicalExtractionSettings(settings)
    switch (settingsSlot(strategy, catalogRecipe)) {
      case 'article': return { article: canonical.article ?? null }
      case 'recipe': return { recipe: canonical.catalog?.recipe ?? null }
      case 'generic': return { generic: canonical.catalog?.generic ?? null }
    }
  }

  /** What a start view shows and submits, and what admission compares and pins: the Extraction Model Choice and the
   *  applicable saved settings. Never a key, a connection or a preset name. */
  export const extractionMethodIntentSchema = z.object({
    models: extractionModelChoiceSchema.nullable(),
    settings: activeSettingsSchema,
  }).strict()
  export type ExtractionMethodIntent = Readonly<{ models: ExtractionModelChoice | null; settings: ActiveSettings }>

  export function activeMethod(
    models: unknown, settings: ExtractionSettings, strategy: ExtractionStrategy, catalogRecipe: string | null,
  ): ExtractionMethodIntent {
    return { models: modelChoice(models), settings: activeSettings(settings, strategy, catalogRecipe) }
  }

  const accountMembersSchema = z.object({ extractionModels: extractionModelChoiceSchema, extractionSettings: extractionSettingsSchema })

  /** The active method a stored account document (Studio's whole Model Configuration document, or null before its
   *  first Apply) gives one Extraction. Studio validates the document on every write, so one that fails here is refused,
   *  never read as defaults. */
  export function accountMethod(document: unknown, strategy: ExtractionStrategy, catalogRecipe: string | null): ExtractionMethodIntent {
    if (document === null) return activeMethod(null, {}, strategy, catalogRecipe)
    const members = accountMembersSchema.safeParse(document)
    if (!members.success || extractionSettingsIssues(members.data.extractionSettings).length > 0)
      throw new ExtractionError('invalid_model_config', 'The saved model configuration is invalid.')
    return activeMethod(members.data.extractionModels, members.data.extractionSettings, strategy, catalogRecipe)
  }

  /** A submitted intent in the form admission compares, or null when it is malformed, breaks a rule, or names another
   *  strategy's settings. */
  export function canonicalIntent(value: unknown, strategy: ExtractionStrategy, catalogRecipe: string | null): ExtractionMethodIntent | null {
    const parsed = extractionMethodIntentSchema.safeParse(value)
    if (!parsed.success) return null
    const slot = settingsSlot(strategy, catalogRecipe)
    const settings = parsed.data.settings as Partial<Record<SettingsSlot, unknown>>
    if (!(slot in settings)) return null
    const models = modelChoice(parsed.data.models)
    if (slot === 'article') {
      const article = settings.article as ArticleSettings | null
      if (article === null) return { models, settings: { article: null } }
      return articleSettingsIssues(article).length > 0 ? null : { models, settings: { article: canonicalArticle(article) } }
    }
    const member = present(settings[slot] as object | null) ?? null
    return { models, settings: slot === 'recipe' ? { recipe: member as RecipeCatalogSettings | null } : { generic: member as GenericCatalogSettings | null } }
  }

  /** An Extraction's recorded settings: null for one admitted before they were recorded (it ran on service defaults). */
  export function storedSettings(value: unknown, strategy: ExtractionStrategy, catalogRecipe: string | null): ActiveSettings | null {
    if (value === null || value === undefined) return null
    const parsed = activeSettingsSchema.safeParse(value)
    if (!parsed.success || !(settingsSlot(strategy, catalogRecipe) in parsed.data))
      throw new ExtractionError('invalid_extraction_method', 'The admitted extraction method is invalid.')
    return parsed.data
  }

  /** A choice from a request or stored jsonb value: absent, null and empty roles all mean service defaults. */
  export function modelChoice(value: unknown): ExtractionModelChoice | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const chosen: { fields?: string; reasoning?: string } = {}
    for (const role of ROLES) {
      const key = (value as Record<string, unknown>)[role]
      if (typeof key === 'string' && key !== '') chosen[role] = key
    }
    return Object.keys(chosen).length === 0 ? null : chosen
  }

  export type ExtractionMethod = Readonly<{
    strategy: ExtractionStrategy
    catalogRecipe: string | null
    requestedModels: ExtractionModelChoice | null
    /** The admitted settings; null for an Extraction admitted before they were recorded. */
    requestedSettings: ActiveSettings | null
  }>

  /** The method persisted on an Extraction: a recipe applies only to Catalog, and unchosen roles use service defaults. */
  export function extractionMethod(
    strategy: ExtractionStrategy,
    catalogRecipe: string | null | undefined,
    requestedModels: unknown,
    requestedSettings?: unknown,
  ): ExtractionMethod {
    const recipe = strategy === 'CATALOG' ? catalogRecipe ?? null : null
    return {
      strategy,
      catalogRecipe: recipe,
      requestedModels: modelChoice(requestedModels),
      requestedSettings: storedSettings(requestedSettings, strategy, recipe),
    }
  }

  /** The Parsing Service's options for the same pinned method. Service defaults add nothing; an explicit Article is
   *  sent whole; generic Catalog limits are top-level options; recipe factors and budgets join the recipe. */
  export function keiMethodOptions(method: ExtractionMethod): Record<string, unknown> {
    const settings = method.requestedSettings
    const article = settings && 'article' in settings ? settings.article : null
    const generic = settings && 'generic' in settings ? settings.generic : null
    const recipe = settings && 'recipe' in settings ? settings.recipe : null
    return {
      strategy: method.strategy === 'CATALOG' ? 'catalog' : 'article',
      ...(method.requestedModels === null ? {} : { models: method.requestedModels }),
      ...(method.strategy === 'ARTICLE' && article ? { article: canonicalArticle(article) } : {}),
      ...(method.strategy === 'CATALOG' && method.catalogRecipe === null && generic ? present(generic) : {}),
      ...(method.catalogRecipe === null ? {} : { catalog: { recipe: method.catalogRecipe, ...(present(recipe) ?? {}) } }),
    }
  }

  export type IdentityFieldIssue = Readonly<{ name: string; reason: 'missing' | 'nested' | 'not-scalar' | 'document' | 'filename' }>

  /** Identity fields the pinned schema cannot key records by: absent, only nested, not a single value, or not read from
   *  the record (`valueSource`: the whole document, or the source's filename). Exact names, exact case. The Parsing
   *  Service checks the same at execution (`ExtractRequest._identity_fields_exist`); this refuses before anything is
   *  enqueued. */
  export function identityFieldIssues(nodes: readonly SchemaNode[], fields: readonly string[]): IdentityFieldIssue[] {
    const topLevel = new Map(nodes.map((node) => [node.name, node]))
    const nested = new Set<string>()
    const visit = (node: SchemaNode): void => node.children?.forEach((child) => { nested.add(child.name); visit(child) })
    nodes.forEach(visit)
    return fields.flatMap((name): IdentityFieldIssue[] => {
      const node = topLevel.get(name)
      if (!node) return [{ name, reason: nested.has(name) ? 'nested' : 'missing' }]
      if (node.valueSource !== undefined) return [{ name, reason: node.valueSource === 'document' ? 'document' : 'filename' }]
      return isScalarFieldType(node.type) ? [] : [{ name, reason: 'not-scalar' }]
    })
  }

  const IDENTITY_REASONS: Readonly<Record<IdentityFieldIssue['reason'], string>> = {
    missing: 'not in this schema',
    nested: 'not a top-level field',
    'not-scalar': 'not a single value',
    document: 'read once for the whole document',
    filename: 'taken from the source’s filename',
  }

  export function identityFieldsMessage(issues: readonly IdentityFieldIssue[]): string {
    const named = issues.map(({ name, reason }) => `${name} (${IDENTITY_REASONS[reason]})`).join(', ')
    return `These identity fields are not scalar record fields of the selected Schema Revision: ${named}.`
  }
  ```

  In `packages/extraction/package.json` add `"./extraction-method": "./src/extraction-method.ts"` to `exports` and append `src/extraction-method.test.ts` to the `test` script's file list. In `packages/extraction/src/workflows.test.ts`, the existing `pins absent, null and empty model choices…` test's expected objects each gain `requestedSettings: null` (the method value now carries its settings).

  In `prototypes/studio/shared/modelConfig.contract.ts` replace lines 39–48 (the two schema definitions and their comments) with a re-export, keeping the `ExtractionModelChoice` type:

  ```ts
  import { extractionModelChoiceSchema } from 'extraction/extraction-method'
  export { extractionModelChoiceSchema, extractionModelKeySchema } from 'extraction/extraction-method'
  export type ExtractionModelChoice = z.infer<typeof extractionModelChoiceSchema>
  ```

  (Keep the imports at the top of the file with the existing ones; `modelConfigSchema` still references `extractionModelChoiceSchema`.)

- [ ] **Step 7: Run the tests to verify they pass**

  ```bash
  cd packages/extraction && npx tsx --test src/extraction-method.test.ts && pnpm test && pnpm typecheck
  cd ../../prototypes/studio && npx vitest run shared/ && cd ../..
  pnpm typecheck
  ```
  Expected: PASS. The categorical test reports `[]` mismatches.

- [ ] **Step 8: Commit**

  ```bash
  git add packages/extraction/src/extraction-method.ts packages/extraction/src/extraction-method.test.ts packages/extraction/src/errors.ts \
    packages/extraction/src/workflows.test.ts packages/extraction/package.json prototypes/studio/shared/modelConfig.contract.ts \
    prototypes/parsing_service/tests/fixtures/contracts/article-options.json prototypes/parsing_service/tests/fixtures/contracts/identity-fields.json \
    prototypes/parsing_service/tests/helpers/article_options.py prototypes/parsing_service/tests/test_extraction_methods.py
  git commit -m "feat(extraction): one Article/Catalog method contract with shared TS/Python parity fixtures"
  ```

### Task 2: Authored forward migration and the configuration row lock

**Files:**
- Modify: `packages/db/src/prisma/contract.prisma` (`Extraction`, `BatchExtraction` models)
- Create: `packages/db/migrations/app/<generated timestamp>_extraction_settings/` (by `migration plan`, then edited)
- Modify: `packages/db/migrations/app/refs/db.json` (by `ref set`)
- Modify: `packages/db/src/row-lock.ts`, `packages/db/src/index.ts`
- Modify: `packages/db/src/model-configuration-store.ts` (comment only)
- Create: `packages/db/src/extraction-settings-migration.test.ts`
- Create: `packages/db/src/extraction-settings-migration.postgres.check.ts`
- Modify: `packages/db/src/model-configuration.postgres.check.ts` (lock ordering subtests)
- Modify: `packages/db/package.json` (`test:postgres` list)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - Columns: `extraction."requestedSettings" jsonb NULL`, `batchExtraction."requestedModels" jsonb NULL`, `batchExtraction."requestedSettings" jsonb NULL`. ORM fields `Extraction.requestedSettings`, `BatchExtraction.requestedModels`, `BatchExtraction.requestedSettings` (`Json?`). NULL means *not recorded* (admitted before this release); a new admission always writes an `ActiveSettings` object (Tasks 4–5).
  - Every stored account document that is a JSON object gains `"extractionSettings": {}` when absent; nothing else changes; a malformed (non-object) document is left as it is.
  - `lockModelConfiguration(client: Pick<PoolClient, 'query'>, researcherAccountId: string): Promise<unknown | null>` exported from `db`.

- [ ] **Step 1: Write the failing static migration test**

  `packages/db/src/extraction-settings-migration.test.ts`:

  ```ts
  import assert from 'node:assert/strict'
  import { readdirSync, readFileSync } from 'node:fs'
  import { resolve } from 'node:path'
  import { it } from 'node:test'

  type Step = { sql: string; params: unknown[] }
  type Operation = { id: string; operationClass: string; execute?: Step[]; postcheck?: Step[] }

  const migrations = resolve(import.meta.dirname, '../migrations/app')
  const named = (suffix: string) => resolve(migrations, readdirSync(migrations).find((name) => name.endsWith(suffix))!)
  const directory = named('_extraction_settings')
  const operations = JSON.parse(readFileSync(resolve(directory, 'ops.json'), 'utf8')) as Operation[]

  it('adds three nullable jsonb method snapshots with no default: no historical row is given guessed settings', () => {
    const columns = operations.filter((operation) => operation.operationClass === 'additive')
    assert.deepEqual(columns.map((operation) => operation.id).sort(), [
      'column.public.batchExtraction.requestedModels',
      'column.public.batchExtraction.requestedSettings',
      'column.public.extraction.requestedSettings',
    ])
    for (const operation of columns)
      assert.match(operation.execute?.[0]?.sql ?? '',
        /^ALTER TABLE "public"\."(?:extraction|batchExtraction)" ADD COLUMN "requested(?:Settings|Models)" jsonb$/)
  })

  it('gives each stored object document an empty extractionSettings and writes nothing else', () => {
    const data = operations.filter((operation) => operation.operationClass === 'data')
    assert.deepEqual(data.map((operation) => operation.id), ['data_migration.empty-extraction-settings'])
    const run = data[0]!.execute!.map((step) => step.sql).join('\n')
    assert.match(run, /^UPDATE "public"\."modelConfiguration" SET "document" = /)
    assert.ok(run.includes(`'{"extractionSettings": {}}'::jsonb`), run)
    assert.ok(run.includes('jsonb_typeof('), run)
    assert.ok(run.includes(`'extractionSettings'`), run)
    assert.doesNotMatch(run, /"extraction"|"batchExtraction"|"connections"|"extractionModels"|"ingestionModels"/)
  })

  it('follows the baseline directly', () => {
    const migration = JSON.parse(readFileSync(resolve(directory, 'migration.json'), 'utf8')) as { from: string }
    const baseline = JSON.parse(readFileSync(resolve(named('_baseline'), 'migration.json'), 'utf8')) as { to: string }
    assert.equal(migration.from, baseline.to)
  })
  ```

  Run: `cd packages/db && npx tsx --test src/extraction-settings-migration.test.ts`
  Expected: FAIL (no `_extraction_settings` directory).

- [ ] **Step 2: Add the columns to the contract**

  In `packages/db/src/prisma/contract.prisma`, `model Extraction`, directly after `requestedModels Json?` and its comment:

  ```prisma
    // The Extraction's admitted method settings (`ActiveSettings`: `{article}`, `{generic}` or `{recipe}`, each null for
    // service defaults), frozen at admission with `requestedModels`; execution reads only these. Null: admitted before
    // settings were recorded ("Not recorded"), never inferred from today's account configuration.
    requestedSettings              Json?
  ```

  In `model BatchExtraction`, after `strategy String`:

  ```prisma
    // The one method every member was admitted with (members carry the same values). Null before this was recorded.
    requestedModels  Json?
    requestedSettings Json?
  ```

  Align the new fields with the surrounding column alignment.

- [ ] **Step 3: Plan the migration, add the backfill, emit, pin the ref**

  ```bash
  cd packages/db
  export CONTRACT_URL=postgresql://contract:emit@127.0.0.1:5432/free   # never dialled
  DATABASE_URL=$CONTRACT_URL pnpm contract:emit
  DATABASE_URL=$CONTRACT_URL npx prisma-next migration plan --name extraction_settings --no-interactive
  ls migrations/app                                   # a new *_extraction_settings directory beside the baseline
  ```

  Edit the generated `migrations/app/*_extraction_settings/migration.ts`: keep its three `addColumn` operations and append the data transform (pattern: the historical `20260826T1742_entra_researcher_identity` migration):

  ```ts
  import postgresStatic from '@prisma-next/postgres/static';

  const { contract, sql } = postgresStatic<End>({ contractJson: endContract });
  ```
  and, as the last element of `operations`:

  ```ts
      // Every valid stored account document gains the empty advanced settings (service defaults); its connections, routes
      // and model choices are untouched. A malformed document is not an object and keeps its visible server fault on
      // read. A document that already has the member is left alone, so the transform's postcheck holds after a rerun.
      this.dataTransform(contract, 'empty-extraction-settings', {
        check: () =>
          sql.public.modelConfiguration
            .select((fields) => ({ researcherAccountId: fields.researcherAccountId }))
            .where((fields, fns) =>
              fns.raw`jsonb_typeof(${fields.document}) = 'object' AND (${fields.document} -> 'extractionSettings') IS NULL`
                .returns('pg/bool@1'))
            .limit(1),
        run: () =>
          sql.public.modelConfiguration
            .update((fields, fns) => ({
              document: fns.raw`${fields.document} || '{"extractionSettings": {}}'::jsonb`.returns('pg/jsonb@1'),
            }))
            .where((fields, fns) =>
              fns.raw`jsonb_typeof(${fields.document}) = 'object' AND (${fields.document} -> 'extractionSettings') IS NULL`
                .returns('pg/bool@1')),
      }),
  ```

  Then self-emit and pin:

  ```bash
  DATABASE_URL=$CONTRACT_URL node migrations/app/*_extraction_settings/migration.ts --dry-run   # the data op prints with the UPDATE
  DATABASE_URL=$CONTRACT_URL node migrations/app/*_extraction_settings/migration.ts             # rewrites ops.json + migration.json
  cat migrations/app/*_extraction_settings/migration.json                                        # note "to"; "from" = baseline's "to"
  DATABASE_URL=$CONTRACT_URL npx prisma-next ref set db <the "to" hash> --no-interactive
  DATABASE_URL=$CONTRACT_URL npx prisma-next migration check --no-interactive                     # "All checks passed"
  ```

  If the builder refuses a `where` callback of this shape, keep the SQL meaning with an unconditional update, which the historical `require-empty-auth-cutover` transform proves the builder accepts: `run` sets `document` to `fns.raw\`CASE WHEN jsonb_typeof(${fields.document}) = 'object' AND (${fields.document} -> 'extractionSettings') IS NULL THEN ${fields.document} || '{"extractionSettings": {}}'::jsonb ELSE ${fields.document} END\`.returns('pg/jsonb@1')`, and `check` selects `researcherAccountId` with a raw boolean column (`… AS needsSettings`) filtered the same way, or omit `check` (the transform is idempotent). Step 1's test then matches `UPDATE "public"."modelConfiguration" SET "document" = CASE` instead of the `SET "document" = ` prefix; adjust that one regex and nothing else. Do not edit `ops.json` by hand. `src/prisma/contract.{d.ts,json}` and `refs/*.contract.*` are generated and gitignored.

- [ ] **Step 4: Run the static test**

  Run: `cd packages/db && npx tsx --test src/extraction-settings-migration.test.ts`
  Expected: PASS.

- [ ] **Step 5: Add the configuration lock**

  Append to `packages/db/src/row-lock.ts` (add `import type { PoolClient } from 'pg'` at the top):

  ```ts
  /**
   * Orders an admission against its Researcher Account's configuration applies for the rest of the admission's
   * transaction, and returns the committed document (null before the account's first apply). `client` is the pooled
   * client withPoolClientTransaction hands its work, so the lock belongs to that transaction.
   *
   * FOR SHARE conflicts with the lock `ModelConfigurationStore.apply` holds (its upsert's ON CONFLICT DO UPDATE): an
   * apply in flight commits first and this reads what it committed, and an apply that starts later waits for this
   * transaction. Admissions do not block one another. An account that never applied has no row: nothing is locked or
   * created, and a first apply racing this transaction is ordered after it, since nothing it writes was read here.
   * Callers lock Source Document rows first; `apply` takes no other lock, so the order has no cycle.
   */
  export async function lockModelConfiguration(
    client: Pick<PoolClient, 'query'>,
    researcherAccountId: string,
  ): Promise<unknown | null> {
    const { rows } = await client.query<{ document: unknown }>(
      'SELECT "document" FROM "public"."modelConfiguration" WHERE "researcherAccountId" = $1 FOR SHARE',
      [researcherAccountId],
    )
    return rows[0]?.document ?? null
  }
  ```

  Export it from `packages/db/src/index.ts`: `export { lockModelConfiguration, lockSourceDocumentRow } from './row-lock.js'` (replacing the existing single export).

  In `model-configuration-store.ts`, extend the `ModelConfigurationStore` doc comment with one sentence: "Admission reads the committed document under the same row lock (`lockModelConfiguration`), so an Extraction is admitted either before an apply or with what it committed."

- [ ] **Step 6: Write the PostgreSQL checks (populated data, lock ordering)**

  `packages/db/src/extraction-settings-migration.postgres.check.ts`:

  ```ts
  import assert from 'node:assert/strict'
  import { randomUUID } from 'node:crypto'
  import { readdirSync, readFileSync } from 'node:fs'
  import { resolve } from 'node:path'
  import { after, test } from 'node:test'
  import { Client } from 'pg'
  import { validateDisposableTestDatabaseTarget } from './database-url.js'

  /** The backfill on populated data: the migration's own data SQL, run against documents shaped as they were stored
   *  before this release, a document that already has the member, and a malformed one. */
  const databaseUrl = process.env.PROJECT_STORE_POSTGRES_URL

  test('the extraction-settings backfill adds only the empty member to valid stored documents', async () => {
    if (!databaseUrl) throw new Error('Set PROJECT_STORE_POSTGRES_URL to a migrated disposable free_test_* database.')
    validateDisposableTestDatabaseTarget(databaseUrl)
    process.env.DATABASE_URL = databaseUrl
    const [{ db, pool }, { createModelConfigurationStore }] = await Promise.all([
      import('./prisma/db.js'), import('./model-configuration-store.js'),
    ])
    const ids: string[] = []
    after(async () => {
      try { for (const id of ids) await db.orm.public.ResearcherAccount.where({ id }).delete() }
      finally { await db.close(); await pool.end() }
    })
    const account = async () => {
      const created = await db.orm.public.ResearcherAccount.create({ tenantId: randomUUID(), objectId: randomUUID(), displayName: 'Migrated' })
      ids.push(created.id)
      return created.id
    }
    const store = createModelConfigurationStore(db)
    const before = {
      connections: [{ id: randomUUID(), name: 'Lab', provider: 'vllm', baseUrl: 'http://lab.example/v1', hasKey: true }],
      routes: { schemaSuggestion: null, interaction: null },
      extractionModels: { fields: 'nuextract', reasoning: 'instruct' },
      ingestionModels: { ocr: 'surya' },
    }
    const saved = { ...before, extractionSettings: { article: { context: 'bounded' } } }
    const [old, current, malformed] = [await account(), await account(), await account()]
    await store.apply(old, () => before)
    await store.apply(current, () => saved)
    await store.apply(malformed, () => ['not', 'an', 'object'])

    const migrations = resolve(import.meta.dirname, '../migrations/app')
    const directory = readdirSync(migrations).find((name) => name.endsWith('_extraction_settings'))!
    const operations = JSON.parse(readFileSync(resolve(migrations, directory, 'ops.json'), 'utf8')) as
      Array<{ operationClass: string; execute: Array<{ sql: string; params: unknown[] }>; postcheck: Array<{ sql: string; params: unknown[] }> }>
    const data = operations.find((operation) => operation.operationClass === 'data')!
    const client = new Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      for (const step of data.execute) await client.query(step.sql, step.params)
      for (const step of data.postcheck) assert.equal((await client.query(step.sql, step.params)).rows[0]?.ok, true)
      // Running it again changes nothing: a replay of the transform is harmless.
      for (const step of data.execute) await client.query(step.sql, step.params)
    } finally {
      await client.end()
    }
    assert.deepEqual(await store.read(old), { ...before, extractionSettings: {} })
    assert.deepEqual(await store.read(current), saved)
    assert.deepEqual(await store.read(malformed), ['not', 'an', 'object'])
  })
  ```

  Append to `packages/db/src/model-configuration.postgres.check.ts`, inside the existing top-level test after its last subtest (it already imports `Client`, `setTimeout`, `randomUUID`; add `lockModelConfiguration` to the dynamic imports from `./row-lock.js`):

  ```ts
  await t.test('an admission lock waits for an apply in flight and then reads what it committed', async () => {
    const account = await createAccount('Locked read')
    await store.apply(account.id, () => ({ version: 1 }))
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const applying = store.apply(account.id, async () => { await held; return { version: 2 } })
    await setTimeout(100)
    const client = new Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      await client.query('BEGIN')
      const reading = lockModelConfiguration(client, account.id)
      await setTimeout(100)
      release()
      await applying
      assert.deepEqual(await reading, { version: 2 })
      await client.query('COMMIT')
    } finally {
      await client.end()
    }
  })

  await t.test('an apply waits for a transaction holding the admission lock', async () => {
    const account = await createAccount('Locked apply')
    await store.apply(account.id, () => ({ version: 1 }))
    const client = new Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      await client.query('BEGIN')
      assert.deepEqual(await lockModelConfiguration(client, account.id), { version: 1 })
      let applied = false
      const applying = store.apply(account.id, () => ({ version: 2 })).then(() => { applied = true })
      await setTimeout(200)
      assert.equal(applied, false)
      await client.query('COMMIT')
      await applying
      assert.equal(applied, true)
    } finally {
      await client.end()
    }
  })

  await t.test('an account that never applied is read as null and gets no row', async () => {
    const account = await createAccount('Never locked')
    const client = new Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      await client.query('BEGIN')
      assert.equal(await lockModelConfiguration(client, account.id), null)
      await client.query('COMMIT')
    } finally {
      await client.end()
    }
    assert.equal(await db.orm.public.ModelConfiguration.select('researcherAccountId').first({ researcherAccountId: account.id }), null)
  })
  ```

  Add `src/extraction-settings-migration.postgres.check.ts` to the `test:postgres` list in `packages/db/package.json` (after `src/model-configuration.postgres.check.ts`).

- [ ] **Step 7: Run the checks**

  ```bash
  cd packages/db && pnpm test && pnpm typecheck
  # Disposable target only (README guard): create and migrate it, then run the tier.
  createdb -h 127.0.0.1 -p 5432 -U postgres free_test_extraction_settings
  DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/free_test_extraction_settings npx prisma-next migrate --yes
  PROJECT_STORE_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/free_test_extraction_settings \
    npx tsx --test --test-concurrency=1 src/model-configuration.postgres.check.ts src/extraction-settings-migration.postgres.check.ts
  ```
  Expected: PASS. (Use the password of the running loopback PostgreSQL; `pnpm --filter db db:start` starts one. Drop the database afterwards: `dropdb -h 127.0.0.1 -U postgres free_test_extraction_settings`.)

- [ ] **Step 8: Commit**

  ```bash
  git add packages/db/src/prisma/contract.prisma packages/db/migrations/app packages/db/src/row-lock.ts packages/db/src/index.ts \
    packages/db/src/model-configuration-store.ts packages/db/src/extraction-settings-migration.test.ts \
    packages/db/src/extraction-settings-migration.postgres.check.ts packages/db/src/model-configuration.postgres.check.ts packages/db/package.json
  git commit -m "feat(db): nullable method snapshots, empty account extraction settings, and the admission config lock"
  ```

  Note for the reviewer: between this commit and Task 3 the backfilled key is not yet accepted by Studio's strict document schema; both ship in one release (design, Migration Plan), and no test reads a migrated document in between.

---

### Task 3: Account document contract and API

**Files:**
- Modify: `prototypes/studio/shared/modelConfig.contract.ts` (`modelConfigSchema`, exports)
- Modify: `prototypes/studio/api/_model_config.ts` (`emptyModelConfig`, `semanticIssues`, `applyAccountModelConfig`)
- Modify: every `ModelConfig` document literal (list below)
- Test: `prototypes/studio/api/_model_config.test.ts`, `prototypes/studio/shared/modelConfig.contract.test.ts`
- Create: `prototypes/studio/api/model_config.postgres.test.ts`

**Interfaces:**
- Consumes: `extractionSettingsSchema`, `extractionSettingsIssues`, `canonicalExtractionSettings`, `type ExtractionSettings` (Task 1).
- Produces: `ModelConfig.extractionSettings: ExtractionSettings` (required; `{}` = service defaults); `EMPTY_MODEL_CONFIG.extractionSettings = {}`; `PUT /api/model_config` stores and returns the canonical document; structural failures are 400 `invalid_request` with `details.issues[].path` like `config.extractionSettings.article.context_tokens`; cross-field failures are 409 `invalid_model_config` with paths like `config.extractionSettings.article.overlap_passages` and the `METHOD_MESSAGES` copy. `configuredExtractionModels` stays until Task 5.

- [ ] **Step 1: Write the failing tests**

  In `prototypes/studio/api/_model_config.test.ts`, add `extractionSettings: {}` to `configured()` (after `ingestionModels: {}`) and add:

  ```ts
  import { METHOD_MESSAGES, REFERENCE_ARTICLE } from 'extraction/extraction-method'

  describe('advanced extraction settings', () => {
    it('an account that never applied reads no advanced overrides', async () => {
      await expect(readAccountModelConfig(ACCOUNT, inMemoryModelConfigurations())).resolves.toMatchObject({ extractionSettings: {} })
    })

    it('a stored document without the member is a server fault that echoes nothing', async () => {
      const { extractionSettings: _omitted, ...legacy } = configured()
      await expect(readAccountModelConfig(ACCOUNT, inMemoryModelConfigurations({ [ACCOUNT]: legacy })))
        .rejects.toMatchObject({ status: 500, code: 'invalid_model_config', message: 'The saved model configuration is invalid.' })
    })

    it('refuses an incompatible combination field by field, with the design copy, and stores nothing', async () => {
      const configurations = inMemoryModelConfigurations()
      const config = configured({ extractionSettings: { article: { ...REFERENCE_ARTICLE, overlap_passages: 1, evidence_policy: 'schema' } } })
      const response = await handlers({ configurations }).PUT(putRequest({ config }))
      expect(response.status).toBe(409)
      const body = await response.json() as { error: { code: string; details: { issues: { path: string; message: string }[] } } }
      expect(body.error.code).toBe('invalid_model_config')
      expect(body.error.details.issues).toEqual(expect.arrayContaining([
        { path: 'config.extractionSettings.article.overlap_passages', message: METHOD_MESSAGES.bounded },
        { path: 'config.extractionSettings.article.evidence_policy', message: METHOD_MESSAGES.schemaPolicy },
      ]))
      expect(configurations.documents.size).toBe(0)
    })

    it.each([
      ['a non-integer ceiling', { article: { ...REFERENCE_ARTICLE, context: 'bounded', context_tokens: 12288.5 } }, 'config.extractionSettings.article.context_tokens'],
      ['a ceiling below the minimum', { article: { ...REFERENCE_ARTICLE, context: 'bounded', context_tokens: 8191 } }, 'config.extractionSettings.article.context_tokens'],
      ['an empty identity field', { article: { ...REFERENCE_ARTICLE, identity_fields: [''] } }, 'config.extractionSettings.article.identity_fields.0'],
      ['an unknown recipe factor', { catalog: { recipe: { factors: { vocabulary: false } } } }, 'config.extractionSettings.catalog.recipe.factors'],
      ['a record limit below the minimum', { catalog: { generic: { record_chars: 999 } } }, 'config.extractionSettings.catalog.generic.record_chars'],
      ['a made-up version switch', { article: { ...REFERENCE_ARTICLE, span_grounding_version: 1 } }, 'config.extractionSettings.article'],
    ])('refuses %s as a structural 400 and stores nothing', async (_label, extractionSettings, path) => {
      const configurations = inMemoryModelConfigurations()
      const response = await handlers({ configurations }).PUT(putRequest({ config: configured({ extractionSettings } as never) }))
      expect(response.status).toBe(400)
      const body = await response.json() as { error: { code: string; details: { issues: { path: string }[] } } }
      expect(body.error.code).toBe('invalid_request')
      expect(body.error.details.issues.map((issue) => issue.path)).toContain(path)
      expect(configurations.documents.size).toBe(0)
    })

    it('stores and returns the canonical document: no nulls, no empty members, the unused ceiling restored', async () => {
      const configurations = inMemoryModelConfigurations()
      const submitted = configured({ extractionSettings: {
        article: { ...REFERENCE_ARTICLE, context_tokens: 16384, grounding_schedule: null, grouping: null },
        catalog: { generic: {}, recipe: { factors: { verification: false } } },
      } as never })
      const response = await handlers({ configurations }).PUT(putRequest({ config: submitted }))
      expect(response.status).toBe(200)
      const expected = configured({ extractionSettings: {
        article: REFERENCE_ARTICLE,
        catalog: { recipe: { factors: { glossary: true, headings: true, overlap: true, verification: false } } },
      } })
      await expect(response.json()).resolves.toEqual({ config: expected })
      await expect(readAccountModelConfig(ACCOUNT, configurations)).resolves.toEqual(expected)
    })

    it("one account's advanced settings are never another's", async () => {
      const configurations = inMemoryModelConfigurations({ [ACCOUNT]: configured({ extractionSettings: { article: REFERENCE_ARTICLE } }) })
      await expect(readAccountModelConfig(OTHER_ACCOUNT, configurations)).resolves.toMatchObject({ extractionSettings: {} })
    })
  })
  ```

  `prototypes/studio/api/model_config.postgres.test.ts` (runs in the Studio PostgreSQL tier; the account is created and deleted by the test):

  ```ts
  import { randomUUID } from 'node:crypto'
  import { afterAll, describe, expect, it } from 'vitest'
  import { createModelConfigurationStore, db, pool } from 'db'
  import { REFERENCE_ARTICLE } from 'extraction/extraction-method'
  import { applyAccountModelConfig, readAccountModelConfig, EMPTY_MODEL_CONFIG } from './_model_config.js'
  import { createModelKeyCache } from './_model_keys.js'
  import { disposableDatabaseUrl } from '../test/support/postgres.js'

  disposableDatabaseUrl()
  const accounts: string[] = []
  afterAll(async () => {
    try { for (const id of accounts) await db.orm.public.ResearcherAccount.where({ id }).delete() }
    finally { await db.close(); await pool.end() }
  })

  describe('advanced settings in PostgreSQL', () => {
    it('an Apply survives a reload, and a refused Apply leaves the saved document as it was', async () => {
      const account = await db.orm.public.ResearcherAccount.create({ tenantId: randomUUID(), objectId: randomUUID(), displayName: 'Advanced' })
      accounts.push(account.id)
      const store = createModelConfigurationStore(db)
      const keys = createModelKeyCache()
      const saved = { ...EMPTY_MODEL_CONFIG, extractionSettings: { article: { ...REFERENCE_ARTICLE, grounding: 'spans' as const } } }
      await applyAccountModelConfig({ config: saved }, { researcherAccountId: account.id, store, keys })
      await expect(readAccountModelConfig(account.id, store)).resolves.toEqual(saved)
      const refused = { ...saved, extractionSettings: { article: { ...REFERENCE_ARTICLE, overlap_passages: 1 } } }
      await expect(applyAccountModelConfig({ config: refused }, { researcherAccountId: account.id, store, keys }))
        .rejects.toMatchObject({ status: 409, code: 'invalid_model_config' })
      await expect(readAccountModelConfig(account.id, store)).resolves.toEqual(saved)
    })
  })
  ```

  Run: `cd prototypes/studio && npx vitest run api/_model_config.test.ts`
  Expected: FAIL (`extractionSettings` unknown to the strict schema).

- [ ] **Step 2: Embed the settings in the account document**

  In `prototypes/studio/shared/modelConfig.contract.ts`, extend the import from `extraction/extraction-method` added in Task 1 with `extractionSettingsSchema`, re-export `extractionSettingsSchema` and `type ExtractionSettings`, and add the member to `modelConfigSchema` after `ingestionModels`:

  ```ts
      ingestionModels: ingestionModelChoiceSchema,
      /** Saved method settings for future Extractions, per strategy (the Advanced tab). `{}` keeps every service default;
       *  an Extraction pins the member its strategy uses when it is admitted. */
      extractionSettings: extractionSettingsSchema,
  ```

- [ ] **Step 3: Validate, canonicalize and persist**

  In `prototypes/studio/api/_model_config.ts`:

  ```ts
  import { canonicalExtractionSettings, extractionSettingsIssues } from 'extraction/extraction-method'
  ```

  `emptyModelConfig()` gains `extractionSettings: {},` after `ingestionModels: {},`.

  At the end of `semanticIssues`, before `return issues`:

  ```ts
    // The method rules the Parsing Service applies, addressed to the field that breaks them (design §3).
    for (const issue of extractionSettingsIssues(config.extractionSettings))
      issues.push({ path: `extractionSettings.${issue.path}`, message: issue.message })
  ```

  In `applyAccountModelConfig`, store and return the canonical document:

  ```ts
    const { config: submitted } = parseModelConfigUpdate(value)
    // Stored as the page and admission compare it: no nulls, no empty Catalog members, an explicit Article in full.
    const config: ModelConfig = { ...submitted, extractionSettings: canonicalExtractionSettings(submitted.extractionSettings) }
    await (options.store ?? modelConfigurations()).apply(options.researcherAccountId, (stored) => {
  ```
  (the rest unchanged; it already returns `config`).

- [ ] **Step 4: Add the member to every document literal**

  ```bash
  grep -rln "ingestionModels: {" prototypes/studio tests --include=*.ts --include=*.tsx --include=*.mjs | grep -v node_modules
  ```
  In each document literal found (today: `tests/contract.test.mjs`, `prototypes/studio/shared/modelConfig.contract.test.ts`, `test/support/interactive.ts`, `test/support/ingestion.ts`, `api/source_reprocess.test.ts`, `api/source_documents.test.ts`, `api/_model.test.ts`, `api/model_auth.test.ts`, `api/model_keys.test.ts`, `api/_provider.test.ts`, `api/_model_config.test.ts`, `e2e/interactiveStack.ts`, `e2e/model-configuration.spec.ts`, `e2e/canonical-evidence-lifecycle.spec.ts`, `e2e/authentication-accessibility.spec.ts`, `src/providerConfig/ProviderConfigPage.test.tsx`), add `extractionSettings: {}` directly after `ingestionModels: …`. Literals that are not whole documents (e.g. `ModelsTab.tsx` reading `draft.ingestionModels`) are unchanged.

- [ ] **Step 5: Run the tests**

  ```bash
  cd prototypes/studio && npx vitest run api/_model_config.test.ts shared/ api/model_keys.test.ts api/model_auth.test.ts src/providerConfig
  cd ../.. && pnpm typecheck && pnpm lint && pnpm test
  # Studio PostgreSQL tier (disposable, migrated; DATABASE_URL must equal EXTRACTION_TEST_DATABASE_URL):
  cd prototypes/studio && EXTRACTION_TEST_DATABASE_URL=$URL DATABASE_URL=$URL npx vitest run --config vitest.postgres.config.ts api/model_config.postgres.test.ts
  ```
  with `URL=postgresql://postgres:postgres@127.0.0.1:5432/free_test_extraction` (created and migrated as in Task 2 Step 7). Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add prototypes/studio/shared/modelConfig.contract.ts prototypes/studio/api/_model_config.ts prototypes/studio/api/model_config.postgres.test.ts \
    prototypes/studio/api prototypes/studio/test prototypes/studio/e2e prototypes/studio/shared prototypes/studio/src/providerConfig/ProviderConfigPage.test.tsx tests/contract.test.mjs
  git commit -m "feat(studio): persist advanced extraction settings in the account's model configuration"
  ```

---

### Task 4: Single-Extraction admission pins the saved method, end to end

**Files:**
- Modify: `packages/extraction/src/types.ts` (`FreshExtractionInput`, `ExtractionSnapshot`, `ExtractionAttemptSnapshot`)
- Modify: `packages/extraction/src/postgres-admission.ts` (single path; shared helpers for Task 5)
- Modify: `packages/extraction/src/postgres-persistence.ts` (`scheduleExtraction` dispositions)
- Modify: `packages/extraction/src/postgres-attempts.ts` (`readAttemptRows`, `pinsOf`)
- Modify: `packages/extraction/src/testing/extraction-fixture.ts` (`configureAccount`, `freshInput`)
- Modify: `packages/extraction/src/postgres-admission.integration.test.ts` and every other `runSingle` caller in `packages/extraction/src/*.test.ts`
- Modify: `prototypes/studio/shared/extraction.contract.ts` (`extractionRequestSchema`)
- Modify: `prototypes/studio/api/extractions.ts`, `prototypes/studio/api/extractions.test.ts`, `prototypes/studio/shared/extraction.contract.test.ts`
- Create: `prototypes/studio/src/savedMethod.ts`, `prototypes/studio/src/savedMethod.test.tsx`
- Modify: `prototypes/studio/src/useExtraction.ts`, `src/useExtraction.test.tsx`, `src/App.tsx`, `src/App.test.tsx`
- Modify (direct single starters): `prototypes/studio/test/support/scenarios/{extraction-publish,gc-missed-cancel,gc-late-handoff,gc-deleted-project}.ts`, `e2e/canonical-evidence-lifecycle.spec.ts`, `e2e/real-service.spec.ts`, `e2e/real-service-gc.spec.ts`, `tests/contract.test.mjs`, and any other hit of the grep in Step 8

**Interfaces:**
- Consumes: `canonicalIntent`, `accountMethod`, `identityFieldIssues`, `identityFieldsMessage`, `settingsSlot`, `extractionMethodIntentSchema`, `activeMethod`, `type ExtractionMethodIntent`, `type ActiveSettings` (Task 1); `lockModelConfiguration` and the `requestedSettings` column (Task 2); `ModelConfig.extractionSettings` (Task 3).
- Produces:
  - `FreshExtractionInput.method: ExtractionMethodIntent` (replaces `models`); `ExtractionSnapshot.requestedSettings?: ActiveSettings | null` and `ExtractionAttemptSnapshot.requestedSettings?: ActiveSettings | null` (null = not recorded).
  - `postgres-admission.ts` exports `METHOD_CHANGED_MESSAGE`, `savedMethodStillCurrent(client, owner, strategy, catalogRecipe, method): Promise<boolean>`, `refuseUnusableIdentityFields(settings: ActiveSettings, schemaTree: unknown): void` (Task 5 reuses both).
  - Errors: `ExtractionError('method_changed', METHOD_CHANGED_MESSAGE)`, `ExtractionError('invalid_identity_fields', <identityFieldsMessage>)`, `ExtractionError('invalid_model_config', …)`, `ExtractionError('invalid_request', 'The saved method does not fit this Extraction Strategy.')`.
  - HTTP: `POST /api/extractions` body `{ id, sourceRepresentationRevisionId, schemaRevisionId, strategy, catalogRecipe?, method: { models, settings } }` (required `method`); 409 `method_changed`, 422 `invalid_identity_fields`, 500 `invalid_model_config`.
  - Client: `useSavedMethod(): { state: SavedMethodState; refresh(): Promise<ModelConfig | null> }`, `savedMethodFor(config, strategy, catalogRecipe): ExtractionMethodIntent`; `useExtraction().runExtraction(method, target?, strategy?, catalogRecipe?)`.
  - Test fixture: `fixture.configureAccount(researcherAccountId, { extractionModels?, extractionSettings? })`; `fixture.freshInput(project, extractionId?, method?)` defaulting to `{ models: null, settings: { article: null } }`.

- [ ] **Step 1: Give the test fixture an account configuration**

  In `packages/extraction/src/testing/extraction-fixture.ts`, add `createModelConfigurationStore` to the dynamic `import('db')` destructuring, then inside `setup`:

  ```ts
  /** The accounts' Model Configuration documents, through the store Studio's Apply uses. */
  const modelConfigurations = createModelConfigurationStore(db)

  /** Saves a Researcher Account's whole Model Configuration document as Studio's Apply would, under its row lock. */
  async function configureAccount(
    researcherAccountId: string,
    members: Readonly<{ extractionModels?: Record<string, string>; extractionSettings?: unknown }> = {},
  ): Promise<void> {
    await modelConfigurations.apply(researcherAccountId, () => ({
      connections: [],
      routes: { schemaSuggestion: null, interaction: null },
      extractionModels: members.extractionModels ?? {},
      ingestionModels: {},
      extractionSettings: members.extractionSettings ?? {},
    }))
  }
  ```

  Change `freshInput` to take the intent the start view would submit:

  ```ts
  const freshInput = (
    project: SeededProject,
    extractionId: string = randomUUID(),
    method: ExtractionMethodIntent = { models: null, settings: { article: null } },
  ): RunSingleInput => ({
    kind: 'fresh' as const,
    extractionId,
    sourceRepresentationRevisionId: project.documents[0]!.sourceRepresentationRevisionId,
    schemaRevisionId: project.schemaRevisionId,
    strategy: 'ARTICLE' as const,
    method,
  })
  ```
  (import `type ExtractionMethodIntent` from `../extraction-method.js`) and add `configureAccount` and `modelConfigurations` to the returned object.

- [ ] **Step 2: Write the failing admission tests**

  Append to `packages/extraction/src/postgres-admission.integration.test.ts` (also destructure `configureAccount`, `modelConfigurations` and `rejectsWithCode` from `fixture`; import `REFERENCE_ARTICLE` from `./extraction-method.js` and `setTimeout as delay` from `node:timers/promises`):

  ```ts
  const SPANS = {
    context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
    prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema',
  } as const
  const QUOTES = { ...SPANS, grounding: 'quoted' } as const
  const intent = (article: unknown, models: Record<string, string> | null = null) => ({ models, settings: { article } }) as never

  it('pins the saved method on the row it admits, with the models', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    kei.holding = true
    await configureAccount(project.researcherAccountId, { extractionModels: { fields: 'instruct' }, extractionSettings: { article: SPANS } })
    const input = freshInput(project, randomUUID(), intent(SPANS, { fields: 'instruct' }))
    assert.equal((await scheduler(project.researcherAccountId).runSingle(input)).disposition, 'created')
    const row = await extractionRow(input.extractionId)
    assert.deepEqual(row?.requestedSettings, { article: SPANS })
    assert.deepEqual(row?.requestedModels, { fields: 'instruct' })
    await heldByKei(input.extractionId)
  })

  it('a start preview that no longer matches the saved method admits nothing', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: QUOTES } })
    const input = freshInput(project, randomUUID(), intent(SPANS))
    await assert.rejects(scheduler(project.researcherAccountId).runSingle(input), rejectsWithCode('method_changed'))
    assert.equal(await extractionRow(input.extractionId), null)
    assert.deepEqual(await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`] }), [])
  })

  it('a lost response replays with its stored method after the account changes; another descriptor under the ID conflicts', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    kei.holding = true
    const module = scheduler(project.researcherAccountId)
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS } })
    const input = freshInput(project, randomUUID(), intent(SPANS))
    assert.equal((await module.runSingle(input)).disposition, 'created')
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: QUOTES } })
    // The retry resolves the admitted Extraction before today's defaults are consulted.
    assert.equal((await module.runSingle(input)).disposition, 'replayed')
    for (const other of [intent(QUOTES), intent(null), intent(REFERENCE_ARTICLE)])
      await assert.rejects(module.runSingle({ ...input, method: other }), rejectsWithCode('extraction_id_conflict'))
    assert.equal((await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`] })).length, 1)
    assert.deepEqual((await extractionRow(input.extractionId))?.requestedSettings, { article: SPANS })
    await heldByKei(input.extractionId)
  })

  it('explicit reference and service defaults are different requests under one ID', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    kei.holding = true
    const module = scheduler(project.researcherAccountId)
    const input = freshInput(project)
    assert.equal((await module.runSingle(input)).disposition, 'created')
    await assert.rejects(module.runSingle({ ...input, method: intent(REFERENCE_ARTICLE) }), rejectsWithCode('extraction_id_conflict'))
    assert.deepEqual((await extractionRow(input.extractionId))?.requestedSettings, { article: null })
    await heldByKei(input.extractionId)
  })

  it('an Extraction admitted before settings were recorded is never the same request', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    kei.holding = true
    const module = scheduler(project.researcherAccountId)
    const input = freshInput(project)
    await module.runSingle(input)
    await db.orm.public.Extraction.where({ id: input.extractionId }).update({ requestedSettings: null })
    await assert.rejects(module.runSingle(input), rejectsWithCode('extraction_id_conflict'))
    await heldByKei(input.extractionId)
  })

  it('changing only Catalog settings does not make an Article preview stale', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    kei.holding = true
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS } })
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS, catalog: { generic: { record_chars: 30000 } } } })
    const input = freshInput(project, randomUUID(), intent(SPANS))
    assert.equal((await scheduler(project.researcherAccountId).runSingle(input)).disposition, 'created')
    await heldByKei(input.extractionId)
  })

  it('identity fields the pinned schema lacks refuse the start before anything is enqueued, by exact name', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    const declared = { ...REFERENCE_ARTICLE, identity: 'conservative', identity_fields: ['Title', 'filename'] }
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: declared } })
    const input = freshInput(project, randomUUID(), intent(declared))
    await assert.rejects(scheduler(project.researcherAccountId).runSingle(input), (error: unknown) =>
      error instanceof ExtractionError && error.code === 'invalid_identity_fields' &&
      error.message === 'These identity fields are not scalar record fields of the selected Schema Revision: Title (not in this schema), filename (taken from the source’s filename).')
    assert.equal(await extractionRow(input.extractionId), null)
    assert.equal(kei.submissions.length, 0)
  })

  it('an Apply in flight commits before the admission compares; the admission then refuses the stale preview', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS } })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const applying = modelConfigurations.apply(project.researcherAccountId, async (previous) => {
      await held
      return { ...(previous as object), extractionSettings: { article: QUOTES } }
    })
    await delay(100)
    const input = freshInput(project, randomUUID(), intent(SPANS))
    const admitting = scheduler(project.researcherAccountId).runSingle(input)
    await delay(200)
    assert.equal(await extractionRow(input.extractionId), null)
    release()
    await applying
    await assert.rejects(admitting, rejectsWithCode('method_changed'))
    assert.equal(await extractionRow(input.extractionId), null)
  })

  it('an Apply waits for an admission that holds the configuration lock, and the run keeps what it saw', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    kei.holding = true
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS } })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const barrier: ExtractionExecution = { ...execution, async enqueue(client, workflow, input) { await held; await execution.enqueue(client, workflow, input) } }
    const module = createExtractionModule(
      createResearcherExtractionPersistence(project.researcherAccountId, barrier, { database: db as Database, packages }))
    const input = freshInput(project, randomUUID(), intent(SPANS))
    const admitting = module.runSingle(input)
    await delay(200)
    let applied = false
    const applying = configureAccount(project.researcherAccountId, { extractionSettings: { article: QUOTES } }).then(() => { applied = true })
    await delay(200)
    assert.equal(applied, false)
    release()
    assert.equal((await admitting).disposition, 'created')
    await applying
    assert.deepEqual((await extractionRow(input.extractionId))?.requestedSettings, { article: SPANS })
    await heldByKei(input.extractionId)
  })
  ```

  Update the existing tests in this file that pass `models`: `admits an Extraction row…` configures `{ extractionModels: { fields: 'nuextract' } }` and passes `method: { models, settings: { recipe: null } }`; `keeps the Extraction Model Choice…` configures `{ extractionModels: models }` and its conflict loop uses `method: { models: other, settings: { article: null } }` for `other` in `[null, { fields: 'nuextract' }, { fields: 'instruct', reasoning: 'instruct' }]` (drop `{}`, which is canonically `null` and therefore now a conflict-free replay only when the account has no choice), and its replay uses `{ reasoning: 'instruct', fields: 'nuextract' }`; `stores no Extraction Model Choice…` iterates `models` over `[null, {}]`. `stores the Catalog recipe…` passes `method: { models: null, settings: { recipe: null } }` and its null-recipe conflict uses `{ generic: null }`. In every other `packages/extraction/src/*.test.ts` that calls `runSingle` with `models`, apply the same rule (configure the account, pass the matching `method`).

  Run: `cd packages/extraction && EXTRACTION_TEST_DATABASE_URL=$URL DATABASE_URL=$URL npx tsx --test --test-concurrency=1 src/postgres-admission.integration.test.ts`
  Expected: FAIL (`method` unknown; no `requestedSettings`).

- [ ] **Step 3: Carry the intent in the extraction types**

  In `packages/extraction/src/types.ts` (import `type { ActiveSettings, ExtractionMethodIntent } from './extraction-method.js'`):

  ```ts
  export type FreshExtractionInput = Readonly<{
    kind: 'fresh'
    extractionId: string
    sourceRepresentationRevisionId: string
    schemaRevisionId: string
    strategy: ExtractionStrategy
    /** The numbered-catalogue recipe chosen for this Catalog Extraction; null or absent for generic Catalog. */
    catalogRecipe?: string | null
    /** The saved method the researcher saw at start: admission refuses it unless it is still the account's, then pins it. */
    method: ExtractionMethodIntent
  }>
  ```
  and in both `ExtractionSnapshot` and `ExtractionAttemptSnapshot`, after `requestedModels`:

  ```ts
    /** The settings admitted with the run (`{article}`, `{generic}` or `{recipe}`, each null for service defaults);
     *  null or absent when the run predates recorded settings ("Not recorded"). */
    requestedSettings?: ActiveSettings | null
  ```

- [ ] **Step 4: Compare and pin in the admission transaction**

  In `packages/extraction/src/postgres-admission.ts`:

  - import `lockModelConfiguration` from `db`; `accountMethod`, `canonicalIntent`, `identityFieldIssues`, `identityFieldsMessage`, `type ActiveSettings`, `type ExtractionMethodIntent` from `./extraction-method.js` (keep `modelChoice`; drop `extractionMethod`); `parseExtractionSchema` from `./schema.js`.
  - Add near the top:

  ```ts
  export const METHOD_CHANGED_MESSAGE =
    'Your saved advanced settings changed after this summary was shown. Nothing was started; review the updated summary and start again.'

  /** Whether the account's saved method, read under its configuration row's lock, is still the one the researcher saw.
   *  The comparison and the snapshot write share one transaction, so an Apply commits wholly before or after it. */
  export async function savedMethodStillCurrent(
    client: Parameters<typeof lockModelConfiguration>[0],
    owner: string,
    strategy: ExtractionStrategy,
    catalogRecipe: string | null,
    method: ExtractionMethodIntent,
  ): Promise<boolean> {
    return isDeepStrictEqual(accountMethod(await lockModelConfiguration(client, owner), strategy, catalogRecipe), method)
  }

  /** Identity fields the pinned schema cannot key records by refuse the Extraction before anything is enqueued; the
   *  Parsing Service checks the same again when it runs (`ExtractRequest._identity_fields_exist`). */
  export function refuseUnusableIdentityFields(settings: ActiveSettings, schemaTree: unknown): void {
    const article = 'article' in settings ? settings.article : null
    if (!article || article.identity_fields.length === 0) return
    let nodes
    try {
      nodes = parseExtractionSchema(schemaTree).schemaNodes
    } catch {
      throw new ExtractionError('invalid_extraction_pins', 'The selected Schema Revision is invalid.')
    }
    const issues = identityFieldIssues(nodes, article.identity_fields)
    if (issues.length > 0) throw new ExtractionError('invalid_identity_fields', identityFieldsMessage(issues))
  }
  ```

  - `AdmissionPins` gains `requestedSettings: ActiveSettings` and `schemaTree: unknown`. In `resolveAdmission`, select `'extractionSchemaId', 'schemaTree'` from `SchemaRevision`, and replace the `...extractionMethod(...)` spread with:

  ```ts
    const catalogRecipe = input.strategy === 'CATALOG' ? input.catalogRecipe ?? null : null
    const method = canonicalIntent(input.method, input.strategy, catalogRecipe)
    if (method === null) throw new ExtractionError('invalid_request', 'The saved method does not fit this Extraction Strategy.')
    return {
      owner: researcherAccountId,
      projectContextId: document.projectContextId,
      sourceDocumentId: representation.sourceDocumentId,
      sourceRepresentationRevisionId: input.sourceRepresentationRevisionId,
      schemaRevisionId: input.schemaRevisionId,
      extractionSchemaId: schema.extractionSchemaId,
      strategy: input.strategy,
      catalogRecipe,
      requestedModels: method.models,
      requestedSettings: method.settings,
      schemaTree: schema.schemaTree,
      preprocessId: representation.preprocessId,
    }
  ```

  - `AdmittedIdentity` gains `requestedSettings: unknown`; the `identity()` select adds `'requestedSettings'`; `sameAdmission` adds `&& isDeepStrictEqual(row.requestedSettings ?? null, pins.requestedSettings)` (a NULL, historical row never equals a recorded method).
  - The return type of `admitInteractiveExtraction` adds `'method-changed'`. After `if (current.id !== pins.sourceRepresentationRevisionId) return 'superseded'`:

  ```ts
      // After the replay checks: an identical repeat replays even when the account's settings changed since (design §7).
      if (!(await savedMethodStillCurrent(client, pins.owner, pins.strategy, pins.catalogRecipe,
        { models: pins.requestedModels, settings: pins.requestedSettings })))
        return 'method-changed'
      refuseUnusableIdentityFields(pins.requestedSettings, pins.schemaTree)
  ```
  and the `Extraction.create` adds `requestedSettings: pins.requestedSettings`. `extractionAttributes({ ...pins, batchExtractionId: null })` is unchanged (attributes never carry settings).

  In `packages/extraction/src/postgres-persistence.ts` `scheduleExtraction`, after the `superseded` mapping:

  ```ts
      if (disposition === 'method-changed') throw new ExtractionError('method_changed', METHOD_CHANGED_MESSAGE)
  ```
  (import `METHOD_CHANGED_MESSAGE`).

  In `packages/extraction/src/postgres-attempts.ts`, add `'requestedSettings'` to the `readAttemptRows` select and, in `pinsOf`, `requestedSettings: storedSettings(row.requestedSettings, row.strategy as ExtractionStrategy, row.catalogRecipe),` after `requestedModels` (import `storedSettings`).

- [ ] **Step 5: Run the admission tests**

  Run: `cd packages/extraction && pnpm test && EXTRACTION_TEST_DATABASE_URL=$URL DATABASE_URL=$URL pnpm test:postgres`
  Expected: PASS (`URL` = a migrated disposable `free_test_extraction`, Task 2 Step 7).

- [ ] **Step 6: Require the intent on the HTTP request**

  In `prototypes/studio/shared/extraction.contract.ts` import `extractionMethodIntentSchema`, `settingsSlot` from `extraction/extraction-method`, and replace the `models: z.never().optional()` line and its comment:

  ```ts
      /** The saved method the start view showed: the Extraction Model Choice and this strategy's settings. Admission
       *  refuses it when the account's saved method changed since, and pins it otherwise. */
      method: extractionMethodIntentSchema,
    })
    .strict()
    .refine((request) => request.catalogRecipe === undefined || request.strategy === 'CATALOG', {
      path: ['catalogRecipe'],
      message: 'A recipe applies to a Catalog Extraction only.',
    })
    .refine((request) => settingsSlot(request.strategy, request.catalogRecipe ?? null) in request.method.settings, {
      path: ['method', 'settings'],
      message: 'The saved settings do not match this Extraction Strategy.',
    })
    .superRefine(methodRuleIssues)
  ```
  where, in the same file (also import `articleSettingsIssues` and `type ArticleSettings` from `extraction/extraction-method`):

  ```ts
  /** A direct request gets the same field-addressed refusals as the Advanced tab (design §3): the contract's own rules. */
  export function methodRuleIssues(request: { method: z.output<typeof extractionMethodIntentSchema> }, context: z.RefinementCtx): void {
    const settings = request.method.settings
    const article: ArticleSettings | null = 'article' in settings ? settings.article : null
    if (!article) return
    for (const issue of articleSettingsIssues(article))
      context.addIssue({ code: 'custom', path: ['method', 'settings', 'article', issue.path], message: issue.message })
  }
  ```

  In `prototypes/studio/api/extractions.ts`, the malformed-request branch keeps its code and message and adds the issues: `throw new ApiError(422, 'invalid_request', 'The Extraction request is invalid.', { details: boundedValidationDetails('request', parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }))) })` (import `boundedValidationDetails` from `./_http.js`). Also drop the `configuredExtractionModels` import and the `extractionModels` constant; `createResearcherApiHandlers(store)` loses its `dependencies` parameter (keep exporting `ExtractionHandlerDependencies` — the batch handlers import it until Task 5); build the input with `method: parsed.data.method` instead of `...(models ? { models } : {})`; extend `asTransportError`:

  ```ts
      case 'method_changed':
        return new ApiError(409, 'method_changed', error.message, { cause: error })
      case 'invalid_identity_fields':
        return new ApiError(422, 'invalid_identity_fields', error.message, { cause: error })
      case 'invalid_model_config':
        return new ApiError(500, 'invalid_model_config', 'The saved model configuration is invalid.', { cause: error })
  ```

  Tests in `prototypes/studio/api/extractions.test.ts`: remove the `modelConfig` / `configuredExtractionModels` mock; `handlerFor(module)` loses its `configured` parameter and calls `createResearcherApiHandlers({ researcherAccountId: ACCOUNT } as ResearcherProjectStore).POST`; `fresh` gains `method: { models: null, settings: { article: null } }`; the tests that asserted the configured models reached `runSingle` now assert the submitted `method` does. Add:

  ```ts
  it('hands the submitted method to admission unchanged; the handler never reads the account', async () => {
    const module = extractionModule()
    const method = { models: { fields: 'instruct' }, settings: { article: null } }
    expect((await handlerFor(module)(request({ ...fresh, method }))).status).toBe(201)
    expect(module.runSingle).toHaveBeenCalledWith(expect.objectContaining({ method }))
  })

  it.each([
    ['method_changed', 409],
    ['invalid_identity_fields', 422],
    ['invalid_model_config', 500],
  ] as const)('answers %s with %i', async (code, status) => {
    const module = extractionModule({
      runSingle: vi.fn<ExtractionModule['runSingle']>().mockRejectedValue(new ExtractionError(code, 'Refused for a reason the researcher can read.')),
    })
    const response = await handlerFor(module)(request(fresh))
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { code } })
  })

  it('refuses an incompatible method field by field, before admission', async () => {
    const module = extractionModule()
    const article = { context: 'full', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
      prompt: 'reference', grounding: 'semantic', grounding_schedule: 'unresolved', grounding_routing: 'origin_lexical' }
    const response = await handlerFor(module)(request({ ...fresh, method: { models: null, settings: { article } } }))
    expect(response.status).toBe(422)
    expect((await response.json()).error.details.issues).toContainEqual({
      path: 'method.settings.article.grounding_routing', message: 'Use generated quotes or source spans, and stop after support.',
    })
    expect(module.runSingle).not.toHaveBeenCalled()
  })

  it("refuses a request without the method, or with another strategy's settings, before admission", async () => {
    const module = extractionModule()
    const { method: _dropped, ...missing } = fresh
    expect((await handlerFor(module)(request(missing))).status).toBe(422)
    expect((await handlerFor(module)(request({ ...fresh, method: { models: null, settings: { generic: null } } }))).status).toBe(422)
    expect(module.runSingle).not.toHaveBeenCalled()
  })
  ```
  In `shared/extraction.contract.test.ts`, extend the request tests with the same three request shapes (accepted with `method`; refused without it; refused with `{ generic: null }` for `ARTICLE` and with `{ article: null }` for `CATALOG` + recipe).

- [ ] **Step 7: Start requests carry the saved method from the browser**

  `prototypes/studio/src/savedMethod.ts`:

  ```ts
  import { useCallback, useEffect, useRef, useState } from 'react'
  import { activeMethod, type ExtractionMethodIntent } from 'extraction/extraction-method'
  import type { ExtractionStrategy } from '../shared/extraction.contract'
  import type { ModelConfig } from '../shared/modelConfig.contract'
  import { apiErrorText, getModelConfig } from './providerConfig/providerConfig.data'

  /** The saved method a start view shows and submits: the same function admission compares it with. */
  export function savedMethodFor(config: ModelConfig, strategy: ExtractionStrategy, catalogRecipe: string | null): ExtractionMethodIntent {
    return activeMethod(config.extractionModels, config.extractionSettings, strategy, catalogRecipe)
  }

  export type SavedMethodState =
    | { status: 'loading' }
    | { status: 'ready'; config: ModelConfig }
    | { status: 'error'; message: string }

  /** The signed-in account's saved configuration for a start view, read on mount and on `refresh()`. Keys are never
   *  part of it. */
  export function useSavedMethod(): { state: SavedMethodState; refresh: () => Promise<ModelConfig | null> } {
    const [state, setState] = useState<SavedMethodState>({ status: 'loading' })
    const current = useRef<AbortController | null>(null)
    const refresh = useCallback(async () => {
      current.current?.abort()
      const controller = new AbortController()
      current.current = controller
      setState({ status: 'loading' })
      try {
        const { config } = await getModelConfig(controller.signal)
        if (controller.signal.aborted) return null
        setState({ status: 'ready', config })
        return config
      } catch (cause) {
        if (!controller.signal.aborted) setState({ status: 'error', message: apiErrorText(cause) })
        return null
      }
    }, [])
    useEffect(() => {
      void refresh()
      return () => current.current?.abort()
    }, [refresh])
    return { state, refresh }
  }
  ```

  `prototypes/studio/src/savedMethod.test.tsx` (jsdom; stub `fetch` for `/api/model_config` as `ProviderConfigPage.test.tsx` does):

  ```tsx
  // @vitest-environment jsdom
  import { renderHook, waitFor } from '@testing-library/react'
  import { afterEach, expect, it, vi } from 'vitest'
  import { REFERENCE_ARTICLE } from 'extraction/extraction-method'
  import { savedMethodFor, useSavedMethod } from './savedMethod'

  const config = {
    connections: [], routes: { schemaSuggestion: null, interaction: null },
    extractionModels: { reasoning: 'instruct' }, ingestionModels: {},
    extractionSettings: { article: REFERENCE_ARTICLE, catalog: { generic: { record_chars: 30000 } } },
  }
  afterEach(() => vi.unstubAllGlobals())

  it('derives each strategy\'s method from the saved document', () => {
    expect(savedMethodFor(config, 'ARTICLE', null)).toEqual({ models: { reasoning: 'instruct' }, settings: { article: REFERENCE_ARTICLE } })
    expect(savedMethodFor(config, 'CATALOG', null)).toEqual({ models: { reasoning: 'instruct' }, settings: { generic: { record_chars: 30000 } } })
    expect(savedMethodFor(config, 'CATALOG', 'numbered-catalogue-de@1')).toEqual({ models: { reasoning: 'instruct' }, settings: { recipe: null } })
  })

  it('reads the account configuration on mount and again on refresh', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ config, providers: [], deployment: { connections: [], defaultRoute: null } }),
      { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const { result } = renderHook(() => useSavedMethod())
    await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', config }))
    await result.current.refresh()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  ```

  `prototypes/studio/src/useExtraction.ts`: `ExtractionRunRequest` gains `method: ExtractionMethodIntent`; the signature becomes

  ```ts
    async function runExtraction(
      method: ExtractionMethodIntent,
      target: ReviewTarget | null = reviewTarget,
      strategy: ExtractionStrategy = 'ARTICLE',
      catalogRecipe: string | null = null,
    ) {
      if (!target?.schemaRevisionId) return null
      return runRequest(attempt !== null, {
        sourceRepresentationRevisionId: target.sourceRepresentationId,
        schemaRevisionId: target.schemaRevisionId,
        strategy,
        ...(strategy === 'CATALOG' && catalogRecipe ? { catalogRecipe } : {}),
        method,
      })
    }
  ```
  An uncertain outcome is still reconciled by reading the same identity (the request keeps its original descriptor for the retry, design §7). In `useExtraction.test.tsx`, pass `const SERVICE_DEFAULTS = { models: null, settings: { article: null } } as const` as the first argument of every `runExtraction(` call and assert once that `requestExtraction` received `method: SERVICE_DEFAULTS`.

  `prototypes/studio/src/App.tsx`: call `const saved = useSavedMethod()` beside the other hooks; add `saved.state.status !== 'ready' ||` to `runExtractionUnavailable`; in `runExtraction()` return early unless `saved.state.status === 'ready'`, compute `const method = savedMethodFor(saved.state.config, strategy, catalogRecipe)` after `catalogRecipe`, and call `extraction.runExtraction(method, { sourceRepresentationId: targetSourceRepresentationId, schemaRevisionId: revision.schemaRevisionId }, strategy, catalogRecipe)`. In `App.test.tsx`, `vi.mock('./savedMethod', async (importOriginal) => ({ ...(await importOriginal<typeof import('./savedMethod')>()), useSavedMethod: () => saved }))` so `useSavedMethod` returns `{ state: { status: 'ready', config: <the empty document with extractionSettings: {}> }, refresh: vi.fn() }` while keeping the real `savedMethodFor`.

- [ ] **Step 8: Update every other single-Extraction starter**

  ```bash
  grep -rn "runSingle(\|/api/extractions'\|'/extractions'\|e2eStudioPath('/api/extractions')" prototypes/studio tests packages --include=*.ts --include=*.tsx --include=*.mjs | grep -v node_modules | grep -v "api/extractions.ts"
  ```
  Each `runSingle({…})` in `test/support/scenarios/*.ts` adds `method: accountMethod(await createModelConfigurationStore().read(<account>), 'ARTICLE', null)` (imports from `extraction/extraction-method` and `db`), so the scenario submits what the account has saved. Each direct `POST /api/extractions` body in `e2e/*.spec.ts` and `tests/contract.test.mjs` adds `method: { models: <the extractionModels that spec saved for the account, or null>, settings: { article: null } }` for Article (`{ recipe: null }` for a recipe Catalog, `{ generic: null }` for generic Catalog); `canonical-evidence-lifecycle.spec.ts` saves `extractionModels: { fields: 'instruct' }` near line 205, so its posts send `models: { fields: 'instruct' }`.

- [ ] **Step 9: Run everything touched**

  ```bash
  cd prototypes/studio && npx vitest run api/extractions.test.ts shared/extraction.contract.test.ts src/savedMethod.test.tsx src/useExtraction.test.tsx src/App.test.tsx
  cd ../.. && pnpm typecheck && pnpm lint && pnpm test
  cd packages/extraction && EXTRACTION_TEST_DATABASE_URL=$URL DATABASE_URL=$URL pnpm test:postgres
  ```
  Expected: PASS.

- [ ] **Step 10: Commit**

  ```bash
  git add -u packages prototypes tests
  git add prototypes/studio/src/savedMethod.ts prototypes/studio/src/savedMethod.test.tsx
  git commit -m "feat(extraction): single admission compares and pins the saved method under the account's row lock"
  ```

---

### Task 5: Batch and suggested-batch admission pin one method, end to end

**Files:**
- Modify: `packages/extraction/src/types.ts` (`ScheduleBatchInput`, `ScheduleSuggestedBatchInput`)
- Modify: `packages/extraction/src/postgres-admission.ts` (`selectionId`, `admitBatchExtraction`, `BatchMemberAdmission`, `admitBatchMember`)
- Modify: `packages/extraction/src/postgres-suggested-batch.ts` (`persistSuggestedBatch`)
- Modify: `packages/extraction/src/postgres-batches.ts` (`DurableBatchExtraction`, `loadBatches`)
- Test: `packages/extraction/src/postgres-batches.integration.test.ts`, `postgres-suggested-batches.integration.test.ts`
- Modify: `prototypes/studio/shared/batchExtraction.contract.ts`, `shared/batchSchemaSuggestion.contract.ts`
- Modify: `prototypes/studio/api/batch_extractions.ts`, `api/batch_schema_suggestions.ts`, `api/extractions.ts` (delete `ExtractionHandlerDependencies`), `api/_model_config.ts` (delete `configuredExtractionModels`)
- Test: `prototypes/studio/api/batch_extractions.test.ts`, `api/batch_schema_suggestions.test.ts`, `api/_model_config.test.ts`
- Modify: `prototypes/studio/src/projectContexts/batchExtractions.ts`, `BatchExtractionsPanel.tsx`, `batchSchemaSuggestionMachine.ts`, `useBatchSchemaSuggestion.ts` and their tests
- Modify: `e2e/batch-extraction-export.spec.ts`, `e2e/canonical-evidence-lifecycle.spec.ts`, `e2e/real-service.spec.ts` (batch posts)

**Interfaces:**
- Consumes: Task 4's `savedMethodStillCurrent`, `refuseUnusableIdentityFields`, `METHOD_CHANGED_MESSAGE`, `canonicalIntent`, `useSavedMethod`, `savedMethodFor`; Task 2's batch columns.
- Produces:
  - `ScheduleBatchInput.method: ExtractionMethodIntent` and `ScheduleSuggestedBatchInput.method: ExtractionMethodIntent` (replace `models`); only `{ article }` (ARTICLE) or `{ generic }` (CATALOG) settings are valid for a batch (discrepancy 2).
  - `BatchMemberAdmission.requestedSettings: ActiveSettings`; batch rows carry `requestedModels`/`requestedSettings`; `DurableBatchExtraction.requestedModels: ExtractionModelChoice | null`, `requestedSettings: ActiveSettings | null`.
  - Selection identity: `selectionId(input, method)` hashes `[projectContextId, schemaRevisionId, strategy, canonicalIds, method]` (the canonical descriptor always, so inactive-strategy settings never enter it and pre-release batches are never replayed).
  - HTTP: `POST /api/batch-extractions` and `POST /api/batch-schema-suggestions/{id}/run` require `method`; 409 `method_changed`, 422 `invalid_identity_fields`, 500 `invalid_model_config`.
  - `openBatchExtraction(request & { method })`, `runBatchSchemaSuggestion(projectContextId, id, strategy, method)`, machine event `{ type: 'run.requested'; strategy; method }`.

- [ ] **Step 1: Write the failing batch admission tests**

  Append to `packages/extraction/src/postgres-batches.integration.test.ts` (reuse the file's batch input helper; `SPANS`/`QUOTES` as in Task 4; the project needs two documents — `seedProject(ARTICLE_SCHEMA, ['a.pdf', 'b.pdf'])`):

  ```ts
  const batchInput = (project: SeededProject, method: unknown, repetition: BatchRepetition = 'reuse-equal-selection') => ({
    projectContextId: project.projectContextId, schemaRevisionId: project.schemaRevisionId, strategy: 'ARTICLE' as const,
    sourceDocumentIds: project.documents.map((document) => document.sourceDocumentId), repetition, method: method as never,
  })

  it('one batch-level method is pinned on the batch and every member', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['a.pdf', 'b.pdf'])
    kei.holding = true
    await configureAccount(project.researcherAccountId, { extractionModels: { fields: 'instruct' }, extractionSettings: { article: SPANS } })
    const method = { models: { fields: 'instruct' }, settings: { article: SPANS } }
    const opened = await scheduler(project.researcherAccountId).scheduleBatch(batchInput(project, method))
    const batch = await db.orm.public.BatchExtraction.select('requestedModels', 'requestedSettings').first({ id: opened.batch.batchExtractionId })
    assert.deepEqual(batch, { requestedModels: { fields: 'instruct' }, requestedSettings: { article: SPANS } })
    const members = await db.orm.public.Extraction.where({ batchExtractionId: opened.batch.batchExtractionId }).select('requestedModels', 'requestedSettings').all()
    assert.equal(members.length, 2)
    for (const member of members) assert.deepEqual(member, { requestedModels: { fields: 'instruct' }, requestedSettings: { article: SPANS } })
  })

  it('equal selection reuses only an equal active method; an inactive strategy change still reuses', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['a.pdf', 'b.pdf'])
    kei.holding = true
    const module = scheduler(project.researcherAccountId)
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS } })
    const first = await module.scheduleBatch(batchInput(project, { models: null, settings: { article: SPANS } }))
    assert.equal((await module.scheduleBatch(batchInput(project, { models: null, settings: { article: SPANS } }))).batch.batchExtractionId,
      first.batch.batchExtractionId)
    // Only the schedule changes: a different selection.
    const unscheduled = { ...SPANS, grounding_schedule: undefined }
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: unscheduled } })
    const changed = await module.scheduleBatch(batchInput(project, { models: null, settings: { article: unscheduled } }))
    assert.notEqual(changed.batch.batchExtractionId, first.batch.batchExtractionId)
    assert.equal(changed.disposition, 'created')
    // Only the inactive (Catalog) settings change: the same selection.
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: unscheduled, catalog: { generic: { record_chars: 30000 } } } })
    const reused = await module.scheduleBatch(batchInput(project, { models: null, settings: { article: unscheduled } }))
    assert.equal(reused.batch.batchExtractionId, changed.batch.batchExtractionId)
    assert.equal(reused.disposition, 'replayed')
  })

  it('a retried batch request replays its batch after the account changes; a stale fresh request admits nothing', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['a.pdf', 'b.pdf'])
    kei.holding = true
    const module = scheduler(project.researcherAccountId)
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS } })
    const input = batchInput(project, { models: null, settings: { article: SPANS } })
    const opened = await module.scheduleBatch(input)
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: QUOTES } })
    assert.equal((await module.scheduleBatch(input)).disposition, 'replayed')
    await assert.rejects(module.scheduleBatch({ ...input, repetition: 'create-new' }), rejectsWithCode('method_changed'))
    assert.equal((await db.orm.public.BatchExtraction.where({ projectContextId: project.projectContextId }).select('id').all()).length, 1)
    assert.equal(opened.batch.members.length, 2)
  })

  it('a batch whose identity fields the schema lacks is refused whole before enqueue', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['a.pdf', 'b.pdf'])
    const declared = { ...REFERENCE_ARTICLE, identity: 'conservative', identity_fields: ['species'] }
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: declared } })
    await assert.rejects(scheduler(project.researcherAccountId).scheduleBatch(batchInput(project, { models: null, settings: { article: declared } })),
      rejectsWithCode('invalid_identity_fields'))
    assert.equal((await db.orm.public.BatchExtraction.where({ projectContextId: project.projectContextId }).select('id').all()).length, 0)
    assert.equal(kei.submissions.length, 0)
  })

  it('recipe settings are refused for a batch, which has no recipe', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    await assert.rejects(scheduler(project.researcherAccountId).scheduleBatch({
      ...batchInput(project, { models: null, settings: { recipe: null } }), strategy: 'CATALOG',
    }), rejectsWithCode('invalid_request'))
  })
  ```

  In `postgres-suggested-batches.integration.test.ts`, add the equivalents on the handoff: a fresh handoff pins `{ article: SPANS }` on batch and members; a stale intent is refused with `method_changed` and confirms nothing (`confirmedSchemaRevisionId` stays null); a draft whose top-level fields lack a declared identity field is refused with `invalid_identity_fields`; a replayed handoff (second call after success, account changed) returns `disposition: 'replayed'` with the original batch. Update existing calls in both files: `models: X` becomes `method: { models: X, settings: { article: null } }` with `configureAccount(…, { extractionModels: X })` when `X` is a choice.

  Run: `cd packages/extraction && EXTRACTION_TEST_DATABASE_URL=$URL DATABASE_URL=$URL npx tsx --test --test-concurrency=1 src/postgres-batches.integration.test.ts src/postgres-suggested-batches.integration.test.ts`
  Expected: FAIL.

- [ ] **Step 2: Pin and compare on batch admission**

  `packages/extraction/src/types.ts`: in `ScheduleBatchInput` and `ScheduleSuggestedBatchInput`, replace `models?: ExtractionModelChoice | null` with

  ```ts
    /** The saved method the researcher saw at start; one snapshot for the batch and every member. */
    method: ExtractionMethodIntent
  ```

  `packages/extraction/src/postgres-admission.ts`:

  ```ts
  function batchMethod(input: Pick<ScheduleBatchInput, 'strategy' | 'method'>): ExtractionMethodIntent {
    // A batch has no recipe (admitBatchMember pins none), so Catalog batches use the generic Catalog settings.
    const method = canonicalIntent(input.method, input.strategy, null)
    if (method === null) throw new ExtractionError('invalid_request', 'The saved method does not fit this Extraction Strategy.')
    return method
  }

  function selectionId(input: ScheduleBatchInput, method: ExtractionMethodIntent): string {
    const hash = createHash('sha256')
      .update(JSON.stringify([
        input.projectContextId,
        input.schemaRevisionId,
        input.strategy,
        canonicalIds(input.sourceDocumentIds),
        // The active method in its canonical form: an equal selection with another method is another batch, and
        // settings for the other strategy never enter it.
        method,
      ]))
      .digest('hex')
    const variant = (['8', '9', 'a', 'b'] as const)[parseInt(hash[16]!, 16) & 3]
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  }
  ```

  In `admitBatchExtraction`: compute `const method = batchMethod(input)` first; the existing `SchemaRevision` read selects `'extractionSchemaId', 'schemaTree'`; `batchExtractionId = input.repetition === 'create-new' ? randomUUID() : selectionId(input, method)`; inside the transaction, right after the project check, replay before consulting today's settings:

  ```ts
        // An equal selection already admitted replays before today's settings are consulted (design §7).
        if (await orm.public.BatchExtraction.select('id').first({ id: batchExtractionId })) return 'existing' as const
  ```
  After the member loop (every Source Document row locked in sorted order):

  ```ts
        if (!(await savedMethodStillCurrent(client, researcherAccountId, input.strategy, null, method))) return 'method-changed' as const
        refuseUnusableIdentityFields(method.settings, schema.schemaTree)
        await orm.public.BatchExtraction.create({
          id: batchExtractionId,
          projectContextId: input.projectContextId,
          schemaRevisionId: input.schemaRevisionId,
          strategy: input.strategy,
          requestedModels: method.models,
          requestedSettings: method.settings,
        })
  ```
  and each `admitBatchMember(…)` receives `requestedModels: method.models, requestedSettings: method.settings`. After the transaction: `'method-changed'` throws `new ExtractionError('method_changed', METHOD_CHANGED_MESSAGE)`; `'existing'` takes the same path as the unique-violation branch. Factor that branch into `replayedBatch(error?: unknown)` and compare:

  ```ts
      if (
        !batch ||
        batch.schemaRevisionId !== input.schemaRevisionId ||
        batch.strategy !== input.strategy ||
        !isDeepStrictEqual(batch.requestedModels, method.models) ||
        !isDeepStrictEqual(batch.requestedSettings, method.settings) ||
        batch.members.length !== selected.length ||
        !batch.members.every((member, index) => member.sourceDocumentId === selected[index])
      )
        throw new ExtractionError('batch_conflict', 'The Batch Extraction identity belongs to another selection.', { cause: error })
  ```

  `BatchMemberAdmission` gains `requestedSettings: ActiveSettings`; `admitBatchMember` writes `requestedSettings: member.requestedSettings` on the member row.

  `packages/extraction/src/postgres-batches.ts`: `DurableBatchExtraction` gains `requestedModels: ExtractionModelChoice | null` and `requestedSettings: ActiveSettings | null`; `loadBatches` selects `'requestedModels', 'requestedSettings'` and maps them with `modelChoice(batch.requestedModels)` and `storedSettings(batch.requestedSettings, batch.strategy as ExtractionStrategy, null)`. `snapshot()` is unchanged (the wire batch DTO does not change).

  `packages/extraction/src/postgres-suggested-batch.ts` (fresh path only; a confirmed suggestion still returns `'replayed'` before any of this):

  Before `withPoolClientTransaction` (a malformed intent is refused before any lock):

  ```ts
    const method = canonicalIntent(input.method, input.strategy, null)
    if (method === null) throw new ExtractionError('invalid_request', 'The saved method does not fit this Extraction Strategy.')
  ```
  and inside the transaction, directly after the `pinned` loop and before `const extractionSchemaId = stableUuid(…)` (the first write):

  ```ts
        if (!(await helpers.savedMethodStillCurrent(client, researcherAccountId, input.strategy, null, method)))
          return 'method-changed' as const
        helpers.refuseUnusableIdentityFields(method.settings, draft)
  ```
  (the transaction callback's parameters become `({ orm }, client)` — they already are; the status union gains `'method-changed'`).
  pass `requestedModels: method.models, requestedSettings: method.settings` to `BatchExtraction.create` and each `admitBatchMember`, and map `'method-changed'` to `ExtractionError('method_changed', METHOD_CHANGED_MESSAGE)`. Add `savedMethodStillCurrent` and `refuseUnusableIdentityFields` to the `helpers` type and to the call in `postgres-persistence.ts` `scheduleSuggestedBatch`.

- [ ] **Step 3: Run the batch admission tests**

  Run: `cd packages/extraction && pnpm test && EXTRACTION_TEST_DATABASE_URL=$URL DATABASE_URL=$URL pnpm test:postgres`
  Expected: PASS.

- [ ] **Step 4: Require the intent on both batch requests; retire the handler-side account read**

  `prototypes/studio/shared/batchExtraction.contract.ts` (import `extractionMethodIntentSchema` from `extraction/extraction-method`):

  ```ts
      /** The saved method the start view showed. A batch has no recipe: Article or generic Catalog settings. */
      method: extractionMethodIntentSchema,
    })
    .strict()
    .refine((request) => (request.strategy === 'ARTICLE' ? 'article' : 'generic') in request.method.settings, {
      path: ['method', 'settings'],
      message: 'The saved settings do not match this Extraction Strategy.',
    })
  ```
  followed by `.superRefine(methodRuleIssues)` (imported from `./extraction.contract.js`). `batchSchemaSuggestionRunRequestSchema` becomes `z.object({ strategy: extractionStrategySchema, method: extractionMethodIntentSchema }).strict()` with the same refine and `.superRefine(methodRuleIssues)`. Both handlers' malformed-request 422s keep their code and message and add the issues (import `boundedValidationDetails` from `./_http.js`):

  ```ts
      if (!parsed.success)
        throw new ApiError(422, 'invalid_request', 'The Batch Extraction request is invalid.', {
          details: boundedValidationDetails('request', parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }))),
        })
  ```
  (`api/batch_schema_suggestions.ts` keeps its message 'The Batch Extraction strategy is invalid.' with the same `details`.)

  `api/batch_extractions.ts`: drop `configuredExtractionModels`, `extractionModels` and the `dependencies` parameter; call `scheduleBatch({ ...selection, method: parsed.data.method, repetition: … })` (`selection` no longer contains `method`; destructure `const { force, method, ...selection } = parsed.data`); map `method_changed` → 409 `method_changed` (message from the error), `invalid_identity_fields` → 422, `invalid_model_config` → 500 `invalid_model_config` 'The saved model configuration is invalid.', before the existing `invalid_extraction_pins`/`batch_conflict` mapping. `invalid_request` from admission → 422 `invalid_request`.

  `api/batch_schema_suggestions.ts`: same removal; pass `method: parsed.data.method` to `scheduleSuggestedBatch`; the same three mappings. Add `'method_changed'`, `'invalid_identity_fields'` and `'invalid_model_config'` to the `code` enum of `batchSchemaSuggestionErrorSchema` in `shared/batchSchemaSuggestion.contract.ts`, so the browser parses these refusals instead of reporting an unexpected failure.

  Delete `ExtractionHandlerDependencies` from `api/extractions.ts` and `configuredExtractionModels` (and its test) from `api/_model_config.ts` / `api/_model_config.test.ts`; `grep -rn "configuredExtractionModels\|ExtractionHandlerDependencies" prototypes packages` must print nothing.

  In `api/batch_extractions.test.ts` and `api/batch_schema_suggestions.test.ts`, drop the injected `extractionModels`, send `method` in every request, and add: the submitted `method` reaches `scheduleBatch`/`scheduleSuggestedBatch` unchanged; `method_changed` → 409; a recipe slot is a 422; a request without `method` is a 422.

- [ ] **Step 5: Thread the saved method through the batch start views**

  `src/projectContexts/batchExtractions.ts`: `openBatchExtraction`'s request type gains `method: ExtractionMethodIntent`; `runBatchSchemaSuggestion(projectContextId, batchSchemaSuggestionId, strategy, method, signal?)` sends `{ strategy, method }`.

  `src/projectContexts/batchSchemaSuggestionMachine.ts`: the `run.requested` event becomes `{ type: 'run.requested'; strategy: ExtractionStrategy; method: ExtractionMethodIntent }` and the invoked run input carries `method` beside `strategy` (the line reading `event.type === 'run.requested' ? event.strategy : 'ARTICLE'` gains the same for `method`); `useBatchSchemaSuggestion.ts`'s `run` passes it to `runBatchSchemaSuggestion`. This is an existing machine; only its event payload grows.

  `src/projectContexts/BatchExtractionsPanel.tsx`: `const saved = useSavedMethod()`; the batch Run, "Run again" and the suggestion Run are disabled unless `saved.state.status === 'ready'`, and each computes `savedMethodFor(saved.state.config, strategy, null)` at click time (Run again uses the stored batch's `strategy`, as today, with today's saved method — existing fresh-run semantics). Update the panel's and machine's tests to pass `method` (mock `../savedMethod` as in Task 4's `App.test.tsx`).

  Direct batch posts in `e2e/*.spec.ts` (grep `batch-extractions'` and `/run?`) send `method` exactly as Task 4 Step 8 describes.

- [ ] **Step 6: Run everything touched**

  ```bash
  cd prototypes/studio && npx vitest run api/batch_extractions.test.ts api/batch_schema_suggestions.test.ts api/_model_config.test.ts src/projectContexts
  cd ../.. && pnpm typecheck && pnpm lint && pnpm test
  cd packages/extraction && EXTRACTION_TEST_DATABASE_URL=$URL DATABASE_URL=$URL pnpm test:postgres
  ```
  Expected: PASS.

- [ ] **Step 7: Commit**

  ```bash
  git add -u packages prototypes
  git commit -m "feat(extraction): batch and suggested-batch admission pin one method and include it in equal-selection identity"
  ```

---

### Task 6: Durable execution reads only the admitted method; architecture checks (A1)

**DBOS ruling (read before editing).** The repository rule, verbatim: "A change to a workflow's step sequence goes behind `DBOS.patch()`; `studio@1` changes only after draining. Workflow inputs carry IDs, never keys or document text." `runExtractionWorkflow`'s steps stay exactly `loadAdmitted` → (`publishFailure` | `submitToKei` → `pollKei`* → `publishFailure` | `publishResult`), with `cancelKeiChild` on error; no step is added, removed, renamed or reordered, and `runExtraction`'s input stays `[extractionId]`. Only the *output* of `loadAdmitted` gains a field, and `keiExtractRequest` (plain code between steps) reads it. So no `DBOS.patch()` and no `studio@1` change. Compatibility: a workflow admitted before this release replays `loadAdmitted` from a checkpoint without `requestedSettings`; that must build today's reference request (no `article`/`catalog` settings), which is exactly what it was admitted with. Kei's `extract` workflow is untouched (the Parsing Service's own `DBOS.patch()` rule does not arise).

**Files:**
- Modify: `packages/extraction/src/workflows.ts` (`AdmittedExtraction`, `keiExtractRequest`)
- Modify: `packages/extraction/src/postgres-workflow-store.ts` (`loadAdmitted`)
- Modify: `packages/extraction/src/kei-artifact.ts` (requested-options check)
- Modify: `packages/extraction/src/testing/extraction-fixture.ts` (`deterministicArtifact` echoes the request's options)
- Test: `packages/extraction/src/workflows.test.ts`, `kei-artifact.test.ts`, `postgres-admission.integration.test.ts`, `postgres-batches.integration.test.ts`
- Modify: `prototypes/studio/test/support/scenarios/extraction-publish.ts` (mode `kill-before-submit`)
- Test: `prototypes/studio/api/extraction_workflow.postgres.test.ts`
- Create: `packages/extraction/src/architecture.test.ts`, `prototypes/studio/api/extraction_boundaries.test.ts`, `prototypes/parsing_service/tests/test_serving_imports.py`
- Modify: `packages/extraction/package.json` (test list)

**Interfaces:**
- Consumes: `extractionMethod(strategy, recipe, models, settings)`, `keiMethodOptions` (Task 1); `Extraction.requestedSettings` written by Tasks 4–5.
- Produces: `AdmittedExtraction.requestedSettings?: unknown` (optional: older checkpoints lack it; validated when the request is built); failure `{ code: 'invalid_extraction_method', message: 'The admitted extraction method is invalid.', phase: 'loading' }`; `acceptKeiArtifact` refuses (`invalid_model_output`, 'kei-exp returned an artifact for different extraction inputs.') an artifact whose recorded options do not honor every requested method option, including an `article` present on one side only.

- [ ] **Step 1: Write the failing workflow unit tests**

  In `packages/extraction/src/workflows.test.ts`, make `artifactFor` echo the method options (import `keiMethodOptions`):

  ```ts
  const artifactFor = (admitted: AdmittedExtraction, overrides: Parameters<typeof keiExpArtifact>[0] = {}) =>
    keiExpArtifact({
      run_id: RUN, generation: 'g1', strategy: strategyOf(admitted.strategy), model: 'fields-model', schema,
      options: { model: null, ...keiMethodOptions(extractionMethod(admitted.strategy, admitted.catalogRecipe,
        admitted.requestedModels, admitted.requestedSettings)), models: admitted.requestedModels },
      records: [{ title: 'Alpha' }], evidence: [keiExpEvidence()], ...overrides,
    })
  ```
  and add:

  ```ts
  const SPANS = {
    context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
    prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema',
  } as const

  describe('the admitted method', () => {
    it('is the only method kei is asked to run: the exact wire example', async () => {
      const admitted = admittedExtraction({ requestedModels: { fields: 'instruct', reasoning: 'instruct' }, requestedSettings: { article: SPANS } })
      const run = harness({ admitted })
      await run.run()
      assert.deepEqual((run.submissions[0]!.request as KeiExtractInput).request.options, {
        strategy: 'article', models: { fields: 'instruct', reasoning: 'instruct' }, article: SPANS,
      })
      assert.deepEqual(run.submissions[0]!.attributes, extractionAttributes(admitted))
    })

    it('a checkpoint written before settings were recorded builds the reference request', async () => {
      const { requestedSettings: _absent, ...older } = admittedExtraction()
      const run = harness({ admitted: older as AdmittedExtraction })
      await run.run()
      assert.deepEqual((run.submissions[0]!.request as KeiExtractInput).request.options, { strategy: 'article' })
    })

    it('an unreadable admitted method fails the Extraction, not the workflow, and asks kei for nothing', async () => {
      const run = harness({ admitted: admittedExtraction({ requestedSettings: { generic: null } }) })
      await run.run()
      assert.equal(run.submissions.length, 0)
      assert.deepEqual(run.settles, [{ outcome: 'FAILED', failure: {
        code: 'invalid_extraction_method', message: 'The admitted extraction method is invalid.', phase: 'loading' } }])
    })

    it('an artifact that ran another method is refused', async () => {
      const admitted = admittedExtraction({ requestedSettings: { article: SPANS } })
      const other = artifactFor(admittedExtraction({ requestedSettings: { article: { ...SPANS, grounding: 'quoted' } } }))
      const run = harness({ admitted, artifact: other })
      await run.run()
      assert.equal(run.settles[0]!.outcome, 'FAILED')
      assert.equal((run.settles[0] as { failure: { code: string } }).failure.code, 'invalid_model_output')
    })
  })
  ```
  (Use the harness's existing names for its returned `submissions`, `settles` and runner; `admittedExtraction()` gains `requestedSettings: { article: null }` in its defaults.)

  In `kei-artifact.test.ts`, extend `Run` with `settings?: Record<string, unknown>` merged into `request()`'s options, and add:

  ```ts
  it('refuses an artifact that does not record every requested method option', () => {
    const article = { context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
      prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema' }
    const withArticle = (recorded: unknown) => artifact({ options: { strategy: 'article', model: 'selected-model', discovery_chars: 48_000, record_chars: 24_000, ...(recorded ? { article: recorded } : {}) } })
    assert.doesNotThrow(() => accept(withArticle(article), { settings: { article } }))
    refused(() => accept(withArticle({ ...article, grounding: 'quoted' }), { settings: { article } }))
    refused(() => accept(withArticle(null), { settings: { article } }))
    // An explicit Article the request never asked for is another request's artifact.
    refused(() => accept(withArticle(article)))
    refused(() => accept(artifact({ options: { strategy: 'catalog', model: null, discovery_chars: 48_000, record_chars: 24_000 }, strategy: 'catalog' }),
      { strategy: 'CATALOG', settings: { record_chars: 30_000 } }))
  })
  ```

  Run: `cd packages/extraction && npx tsx --test src/workflows.test.ts src/kei-artifact.test.ts`
  Expected: FAIL.

- [ ] **Step 2: Build the request from the admitted snapshot only**

  `packages/extraction/src/workflows.ts`: `AdmittedExtraction` gains, after `requestedModels`:

  ```ts
    /** The settings admission pinned (`Extraction.requestedSettings`); never today's account configuration. Absent in a
     *  `loadAdmitted` checkpoint written before settings were recorded, which ran on service defaults. */
    requestedSettings?: unknown
  ```
  and `keiExtractRequest`:

  ```ts
    let method: ExtractionMethod
    // Admission validated the method; one that no longer reads fails this Extraction rather than its workflow.
    try { method = extractionMethod(admitted.strategy, admitted.catalogRecipe, admitted.requestedModels, admitted.requestedSettings) }
    catch { return { code: 'invalid_extraction_method', message: 'The admitted extraction method is invalid.', phase: 'loading' } }
    return {
      run_id: run.runId,
      generation: run.generation,
      request: { schema, options: keiMethodOptions(method) },
    }
  ```
  (import `type ExtractionMethod`). Extend the doc comment of `runExtractionWorkflow` with: "It runs the method admission pinned on the row; it never reads the account's saved settings, on recovery or for batch members."

  `packages/extraction/src/postgres-workflow-store.ts` `loadAdmitted`: select `'requestedSettings'` and return `requestedSettings: row.requestedSettings` (raw; `keiExtractRequest` validates it).

  `packages/extraction/src/kei-artifact.ts`: add

  ```ts
  /** kei-exp records the options it ran under (`Options.dumped()`): every method option Studio sent must be there with
   *  the same value, and an explicit Article method on one side only is another Extraction's artifact. Options Studio
   *  left to the service may be recorded with their defaults. */
  function honorsRequestedOptions(recorded: Readonly<Record<string, unknown>>, requested: Readonly<Record<string, unknown>>): boolean {
    if (!isDeepStrictEqual(recorded.article ?? null, requested.article ?? null)) return false
    const { strategy: _strategy, models: _models, article: _article, catalog, ...limits } = requested
    if (!Object.entries(limits).every(([key, value]) => isDeepStrictEqual(recorded[key], value))) return false
    if (catalog === null || typeof catalog !== 'object') return true
    const recordedCatalog = (recorded.catalog ?? {}) as Record<string, unknown>
    return Object.entries(catalog).every(([key, value]) => key === 'recipe' || isDeepStrictEqual(recordedCatalog[key], value))
  }
  ```
  and add `|| !honorsRequestedOptions(artifact.options, options)` to the existing "different extraction inputs" condition.

  `packages/extraction/src/testing/extraction-fixture.ts` `deterministicArtifact`: `options: { model: 'deterministic', ...options, strategy, models: (options.models as Record<string, string> | undefined) ?? null }` so the scripted kei records what it was asked for, as kei-exp does. The spawned stand-in's auto answer (`testing/kei-stand-in-cli.ts`, `options: { model: null, models: null, ...options }`) already echoes the request's options; check with `grep -rn "keiExpArtifact(" packages prototypes/studio/e2e prototypes/studio/test` that no other scripted artifact is answered to a request carrying method settings without echoing them.

- [ ] **Step 3: Run the unit tests**

  Run: `cd packages/extraction && pnpm test`
  Expected: PASS.

- [ ] **Step 4: Prove it on PostgreSQL: capture (P1), batch members after a change (P3)**

  Append to `postgres-admission.integration.test.ts`:

  ```ts
  it('kei receives the admitted method byte for value: strategy, models and every active option', async (t) => {
    t.after(cleanup)
    const project = await seedProject()
    kei.holding = true
    const models = { fields: 'instruct', reasoning: 'instruct' }
    await configureAccount(project.researcherAccountId, { extractionModels: models, extractionSettings: { article: SPANS } })
    const input = freshInput(project, randomUUID(), intent(SPANS, models))
    await scheduler(project.researcherAccountId).runSingle(input)
    await heldByKei(input.extractionId)
    const submitted = kei.submissions.find((submission) => submission.workflowId === keiExtractWorkflowId(input.extractionId))!
    assert.deepEqual((submitted.request as KeiExtractInput).request.options, { strategy: 'article', models, article: SPANS })
  })
  ```

  Append to `postgres-batches.integration.test.ts`:

  ```ts
  it('queued batch members keep the batch method after the account saves another one', async (t) => {
    t.after(cleanup)
    const project = await seedProject(ARTICLE_SCHEMA, ['a.pdf', 'b.pdf'])
    kei.holding = true
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: SPANS } })
    const opened = await scheduler(project.researcherAccountId).scheduleBatch(batchInput(project, { models: null, settings: { article: SPANS } }))
    await configureAccount(project.researcherAccountId, { extractionSettings: { article: QUOTES } })
    const members = await db.orm.public.Extraction.where({ batchExtractionId: opened.batch.batchExtractionId }).select('id').all()
    for (const member of members) await heldByKei(member.id)
    for (const member of members) {
      const submitted = kei.submissions.find((submission) => submission.workflowId === keiExtractWorkflowId(member.id))!
      assert.deepEqual(((submitted.request as KeiExtractInput).request.options as { article: unknown }).article, SPANS)
    }
  })
  ```

  Run: `cd packages/extraction && EXTRACTION_TEST_DATABASE_URL=$URL DATABASE_URL=$URL pnpm test:postgres`
  Expected: PASS.

- [ ] **Step 5: Prove recovery across a Studio restart (P2, M1)**

  In `prototypes/studio/test/support/scenarios/extraction-publish.ts`, add a third mode:

  ```ts
  /** Dies (SIGKILL) as the first run is about to hand its Extraction to kei: loadAdmitted is checkpointed, submitToKei is not. */
  function killBeforeSubmit(kei: KeiHandoff, firstRun: boolean): KeiHandoff {
    return {
      ...kei,
      async submit(submission) {
        if (firstRun) process.kill(process.pid, 'SIGKILL')
        return kei.submit(submission)
      },
    }
  }
  ```
  and register the ports lazily as today (they need the launched DBOS):

  ```ts
      register: () =>
        registerExtractionWorkflow(() => {
          const ports = extractionWorkflowPorts()
          return {
            ...ports,
            kei: killBeforeSubmit(ports.kei, firstRun && mode === 'kill-before-submit'),
            store: killAfterSettle(createExtractionStore({ packages }), firstRun && mode === 'kill-after-settle'),
          }
        }),
  ```
  (import `type KeiHandoff` from `extraction/kei-handoff`). Update the scenario's doc comment to name the mode.

  In `prototypes/studio/api/extraction_workflow.postgres.test.ts` (import `createModelConfigurationStore` from `db`; `studioWithKei` accepts the new mode):

  ```ts
  it('an admitted Extraction recovered after the account saves another method runs the one it was admitted with', async () => {
    const { research, extractionId, env } = await studioWithKei('kill-before-submit')
    const store = createModelConfigurationStore(db)
    const document = (article: unknown) => ({
      connections: [], routes: { schemaSuggestion: null, interaction: null }, extractionModels: {}, ingestionModels: {},
      extractionSettings: { article },
    })
    const spans = { context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
      prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema' }
    await store.apply(research.researcherAccountId, () => document(spans))
    await standIn!.policy({ extract: 'hold' })

    const killed = await runWorkflowChild('extraction-publish', env)
    expect(killed.signal, killed.output).toBe('SIGKILL')
    await store.apply(research.researcherAccountId, () => document({ ...spans, grounding: 'quoted' }))

    const recovering = runWorkflowChild('extraction-publish', env)
    const [held] = await standIn!.held()
    const request = held!.request as KeiExtractInput
    expect(request.request.options).toEqual({ strategy: 'article', article: spans })
    await standIn!.answer(held!.workflowId, {
      artifact: keiExpArtifact({
        run_id: request.run_id, generation: request.generation, strategy: 'article',
        schema: request.request.schema as { recordDescription: string; schemaNodes: unknown[] },
        options: { model: null, models: null, ...request.request.options } as never,
        model: 'fixture/instruct', models: { fields: 'fixture/instruct', reasoning: 'fixture/instruct' },
        complete: true, records: [{ title: 'Recovered' }], evidence: [], ungrounded: [['records', 0, 'title']],
      }),
    })
    expect((await recovering).code).toBe(0)
    expect((await extractionRow(extractionId))?.outcome).toBe('SUCCEEDED')
  })
  ```

  Run (disposable, migrated target; `DATABASE_URL` = `EXTRACTION_TEST_DATABASE_URL`):
  `cd prototypes/studio && EXTRACTION_TEST_DATABASE_URL=$URL DATABASE_URL=$URL npx vitest run --config vitest.postgres.config.ts api/extraction_workflow.postgres.test.ts`
  Expected: PASS (all three restart cases).

- [ ] **Step 6: Add the structural checks (A1)**

  `packages/extraction/src/architecture.test.ts`:

  ```ts
  import assert from 'node:assert/strict'
  import { readdirSync, readFileSync } from 'node:fs'
  import { fileURLToPath } from 'node:url'
  import test from 'node:test'

  /** Design §8's invariants, checked at this package's source boundary; an independent review covers the rest. */
  const SOURCE = fileURLToPath(new URL('.', import.meta.url))
  const read = (name: string) => readFileSync(`${SOURCE}${name}`, 'utf8')
  const serving = readdirSync(SOURCE).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  /** Every module specifier: `… from '…'` (single- or multi-line), `import('…')` and bare `import '…'`. */
  const importsOf = (name: string) =>
    [...read(name).matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm)]
      .map((match) => match[1] ?? match[2] ?? match[3]!)

  test('serving code imports no experiment, validation report or Studio code', () => {
    for (const name of serving)
      for (const specifier of importsOf(name))
        assert.doesNotMatch(specifier, /experiments|docs\/validation|prototypes\//, `${name} imports ${specifier}`)
  })

  test('execution reads the admitted method only: nothing on the workflow path touches the account configuration', () => {
    for (const name of ['workflows.ts', 'workflow-steps.ts', 'postgres-workflow-store.ts', 'kei-artifact.ts', 'kei-handoff.ts'])
      for (const account of ['lockModelConfiguration', 'ModelConfiguration', 'accountMethod', 'createModelConfigurationStore'])
        assert.ok(!read(name).includes(account), `${name} mentions ${account}`)
  })

  test('the method contract stays browser-safe and holds no extraction algorithm', () => {
    assert.deepEqual(importsOf('extraction-method.ts').sort(), ['./allowed-values.js', './errors.js', './schema.js', './types.js', 'zod'])
  })
  ```
  Add `src/architecture.test.ts` to the package's `test` list.

  `prototypes/studio/api/extraction_boundaries.test.ts`:

  ```ts
  import { readdirSync, readFileSync } from 'node:fs'
  import { join } from 'node:path'
  import { describe, expect, it } from 'vitest'

  const root = join(import.meta.dirname, '..')
  const read = (path: string) => readFileSync(join(root, path), 'utf8')
  const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [])
  const importing = /(?:from\s*|import\(\s*)['"][^'"]*(?:experiments\/extraction|docs\/validation)[^'"]*['"]/

  describe('extraction method boundaries (design §8)', () => {
    it('start handlers hold no method policy and never read the account configuration themselves', () => {
      for (const handler of ['api/extractions.ts', 'api/batch_extractions.ts', 'api/batch_schema_suggestions.ts']) {
        const source = read(handler)
        for (const forbidden of ['readAccountModelConfig', 'modelConfigurations', 'lockModelConfiguration', 'accountMethod',
          'articleSettingsIssues', 'identityFieldIssues', 'keiMethodOptions'])
          expect(source.includes(forbidden), `${handler} uses ${forbidden}`).toBe(false)
      }
    })

    it('browser code never imports the extraction runtime, experiments or validation reports', () => {
      for (const file of walk('src')) {
        const source = read(file)
        expect(source, file).not.toMatch(/from\s*['"]extraction['"]/)
        expect(source, file).not.toMatch(importing)
      }
    })

    it('server code never imports experiments or validation reports', () => {
      for (const file of [...walk('api'), ...walk('server'), ...walk('shared')]) expect(read(file), file).not.toMatch(importing)
    })
  })
  ```

  `prototypes/parsing_service/tests/test_serving_imports.py`:

  ```python
  """Serving code never imports the experiment or validation/report code (design §8, invariant 3)."""
  import ast
  from pathlib import Path

  SOURCE = Path(__file__).parent.parent / "src"


  def test_serving_modules_never_import_experiments():
      offenders = []
      for path in SOURCE.rglob("*.py"):
          for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
              if isinstance(node, ast.Import):
                  names = [alias.name for alias in node.names]
              elif isinstance(node, ast.ImportFrom) and node.level == 0:
                  names = [node.module or ""]
              else:
                  continue
              offenders += [f"{path.relative_to(SOURCE)}: {name}" for name in names if name.split(".")[0] == "experiments"]
      assert offenders == []
  ```

  Run:
  ```bash
  cd packages/extraction && pnpm test
  cd ../../prototypes/studio && npx vitest run api/extraction_boundaries.test.ts
  cd ../parsing_service && PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src:. .venv/bin/python -m pytest -q tests/test_serving_imports.py
  ```
  Expected: PASS. Mutation check (do not commit): add `import { readAccountModelConfig } from './_model_config.js'` to `api/extractions.ts` and confirm the Studio check fails; revert.

- [ ] **Step 7: Full fast gate and commit**

  ```bash
  pnpm typecheck && pnpm lint && pnpm test
  git add -u packages prototypes
  git add packages/extraction/src/architecture.test.ts prototypes/studio/api/extraction_boundaries.test.ts prototypes/parsing_service/tests/test_serving_imports.py
  git commit -m "feat(extraction): runExtraction runs only the admitted method; boundary checks for design §8"
  ```

---

### Task 7: Result adapters keep the effective method, policy accounting and support proofs

**Files:**
- Modify: `packages/extraction/src/kei-artifact.ts` (`artifactSchema`, `acceptKeiArtifact` diagnostics)
- Modify: `packages/extraction/src/types.ts` (`ExtractionDiagnostics`, new `EffectiveMethod`, `GroundingEligibility`, `SupportProof`), `index.ts` (type exports)
- Modify: `prototypes/studio/shared/extraction.contract.ts` (`extractionDiagnosticsSchema`, `extractionAttemptSchema`)
- Modify: `prototypes/studio/api/_extractions.ts` (`transportDiagnostics`, `extractionAttemptDto`)
- Test: `packages/extraction/src/kei-artifact.test.ts`, `prototypes/studio/api/_extractions.test.ts`, `prototypes/studio/shared/extraction.contract.test.ts`
- Run (unchanged): `prototypes/parsing_service/tests/{test_extraction_methods,test_extraction_span_grounding,test_extraction_routing,test_grounding_study,test_extraction_evidence_policy}.py`

**Interfaces:**
- Consumes: Task 6's `acceptKeiArtifact` checks; `activeSettingsSchema` (Task 1); `ExtractionAttemptSnapshot.requestedSettings` (Task 4).
- Produces (TS, stored in `Extraction.diagnostics`):
  - `EffectiveMethod = Readonly<{ options: Readonly<Record<string, unknown>>; versions: Readonly<Record<string, number>> }>` — `options` is the artifact's `options` as kei-exp recorded it; `versions` holds `prompt` always and `method`, `spanGrounding`, `groundingRouting`, `rendering`, `grouping`, `selection` when the artifact reports them.
  - `GroundingEligibility = Readonly<{ allRecordLeaves: number; eligibleRecordLeaves: number; skipped: readonly Readonly<{ resultPath: ResultPath; policy: 'derived' | 'unverified' }>[]; eligibleGrounding: 'complete' | 'partial' | 'not_applicable' }>`
  - `SupportProof = Readonly<{ resultPath: ResultPath; segment: string; cell: string | null; quote: string; attribution: string; span?: string; start?: number; end?: number }>`
  - `ExtractionDiagnostics.effectiveMethod?: EffectiveMethod | null`, `.eligibility?: GroundingEligibility | null`, `.support?: readonly SupportProof[] | null`
  - Wire (`extractionDiagnosticsSchema`): the same three members, `.nullable().optional()`; `extractionAttemptSchema.requestedSettings: activeSettingsSchema.nullable().optional()` (null = "Not recorded"). A FAILED attempt has `diagnostics: null` — its effective method is unavailable by construction.

- [ ] **Step 1: Write the failing adapter tests**

  In `packages/extraction/src/kei-artifact.test.ts`:

  ```ts
  describe('what the Parsing Service reports it ran', () => {
    const article = { context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
      prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema' }
    const options = { strategy: 'article', model: 'selected-model', discovery_chars: 48_000, record_chars: 24_000, article }

    it('keeps the recorded options and every protocol version the artifact reports', () => {
      const raw = { ...artifact({ options, prompt_version: 12 }), method_version: 1, span_grounding_version: 2 }
      const { extraction } = accept(raw, { settings: { article } })
      assert.deepEqual(extraction.diagnostics.effectiveMethod, { options, versions: { prompt: 12, method: 1, spanGrounding: 2 } })
    })

    it('keeps policy-skipped values, their reasons and the separate denominators; nothing eligible is not applicable', () => {
      const skipped = [{ path: ['records', 0, 'title'], policy: 'derived' }, { path: ['records', 0, 'year'], policy: 'unverified' }]
      const raw = { ...artifact({ options, evidence: [], ungrounded: [['records', 0, 'title'], ['records', 0, 'year']] }),
        method_version: 1, grounding_eligibility: { all_record_leaves: 2, eligible_record_leaves: 0, skipped },
        completion: { processing: true, grounding: 'partial', eligible_grounding: 'not_applicable' } }
      const { extraction } = accept(raw, { settings: { article } })
      assert.deepEqual(extraction.diagnostics.eligibility, {
        allRecordLeaves: 2, eligibleRecordLeaves: 0, eligibleGrounding: 'not_applicable',
        skipped: [{ resultPath: ['records', 0, 'title'], policy: 'derived' }, { resultPath: ['records', 0, 'year'], policy: 'unverified' }],
      })
      assert.deepEqual(extraction.evidence, [])
      assert.deepEqual(extraction.diagnostics.ungroundedPaths, [['records', 0, 'title'], ['records', 0, 'year']])
      assert.equal(extraction.complete, false)
    })

    it('keeps exact code-point ranges and never upgrades coarse geometry', () => {
      const proof = { path: ['records', 0, 'title'], segment: 'p1_s0', cell: null, span: 'p1_s0@3:9', start: 3, end: 9,
        quote: 'Ålpha 🜁', attribution: 'model_attested' }
      const raw = { ...artifact({ options, evidence: [keiExpEvidence({ precision: 'segment' })] }), method_version: 1, span_grounding_version: 2,
        quoted_support: [proof] }
      const { extraction } = accept(raw, { settings: { article } })
      assert.deepEqual(extraction.diagnostics.support, [{ resultPath: proof.path, segment: 'p1_s0', cell: null, span: 'p1_s0@3:9',
        start: 3, end: 9, quote: 'Ålpha 🜁', attribution: 'model_attested' }])
      assert.equal(extraction.evidence?.[0]?.precision, 'segment')
    })

    it('a proof without an accepted link creates no Evidence; refusals and NONE stay visible as issues', () => {
      const refusals = [
        { code: 'unknown_label', detail: 'year was linked to "E9", which was not offered', record: 0, path: ['records', 0, 'year'] },
        { code: 'grounding_exceeds_budget', detail: 'one unit does not fit', record: 0, path: ['records', 0, 'title'] },
      ]
      const raw = { ...artifact({ options, evidence: [], issues: refusals, ungrounded: [['records', 0, 'title'], ['records', 0, 'year']] }),
        method_version: 1, quoted_support: [{ path: ['records', 0, 'year'], segment: 'p1_s1', cell: null, quote: '1827', attribution: 'model_attested' }] }
      const { extraction } = accept(raw, { settings: { article } })
      assert.deepEqual(extraction.evidence, [])
      assert.deepEqual(extraction.diagnostics.groundingIssues.map((issue) => issue.code), ['unknown_label', 'grounding_exceeds_budget'])
    })

    it('a reference run reports no Article method; a recipe run with verification off keeps typed proposals, not links', () => {
      assert.deepEqual(accept(artifact({ prompt_version: 12 })).extraction.diagnostics.effectiveMethod?.versions, { prompt: 12 })
      const proposed = [{ path: ['records', 0, 'title'], value: 'Alpha', quote: 'Alpha', key: null, provenance: 'token', spans: [], alternatives: [], window: 0, reason: 'verification_disabled' }]
      const grounded = keiExpGroundedArtifact({ proposed, evidence: [], completeness: { processing: true, coverage: true, grounding: false, recall: 'unmeasured' } })
      const { extraction } = accept(grounded, { strategy: 'CATALOG', recipe: `${grounded.segmentation.recipe.id}@${grounded.segmentation.recipe.version}` })
      assert.deepEqual(extraction.diagnostics.grounded?.proposed, proposed)
      assert.equal(extraction.diagnostics.grounded?.completeness.grounding, false)
      assert.deepEqual(extraction.evidence, [])
    })
  })
  ```
  (Adjust `keiExpGroundedArtifact` overrides to the fixture's field names if they differ; the assertions are the contract.)

  In `prototypes/studio/api/_extractions.test.ts`, add: an attempt snapshot with `requestedSettings: { article: null }` and diagnostics carrying `effectiveMethod`, `eligibility`, `support` produces a DTO that `extractionAttemptSchema` parses with those members unchanged; a FAILED attempt has `diagnostics: null` and its `requestedSettings`; a historical attempt without `requestedSettings` produces `requestedSettings: null`.

  Run: `cd packages/extraction && npx tsx --test src/kei-artifact.test.ts` — Expected: FAIL.

- [ ] **Step 2: Keep what the artifact reports**

  `packages/extraction/src/kei-artifact.ts`, extend `artifactSchema` (non-strict object; these were stripped until now):

  ```ts
    // An explicit Article method records its method and protocol versions and its evidence accounting; the reference
    // artifact (no `options.article`) carries none of them.
    method_version: z.number().int().optional(),
    span_grounding_version: z.number().int().optional(),
    grounding_routing_version: z.number().int().optional(),
    rendering_version: z.number().int().optional(),
    grouping_version: z.number().int().optional(),
    selection_version: z.number().int().optional(),
    completion: z.object({ eligible_grounding: z.enum(['complete', 'partial', 'not_applicable']).optional() }).optional(),
    grounding_eligibility: z.object({
      all_record_leaves: z.number().int().nonnegative(),
      eligible_record_leaves: z.number().int().nonnegative(),
      skipped: z.array(z.object({ path, policy: z.enum(['derived', 'unverified']) })),
    }).optional(),
    // The quote or offered source span each accepted link was verified with; code-point offsets into its segment.
    quoted_support: z.array(z.object({
      path, segment: z.string(), cell: z.string().nullable(), quote: z.string(), attribution: z.string(),
      span: z.string().optional(), start: z.number().int().nonnegative().optional(), end: z.number().int().nonnegative().optional(),
    })).optional(),
  ```
  and in the returned `diagnostics`, after `models`:

  ```ts
      effectiveMethod: {
        options: artifact.options,
        versions: Object.fromEntries(([
          ['prompt', artifact.prompt_version], ['method', artifact.method_version], ['spanGrounding', artifact.span_grounding_version],
          ['groundingRouting', artifact.grounding_routing_version], ['rendering', artifact.rendering_version],
          ['grouping', artifact.grouping_version], ['selection', artifact.selection_version],
        ] as const).filter(([, version]) => version !== undefined)),
      },
      eligibility: artifact.grounding_eligibility
        ? {
            allRecordLeaves: artifact.grounding_eligibility.all_record_leaves,
            eligibleRecordLeaves: artifact.grounding_eligibility.eligible_record_leaves,
            skipped: artifact.grounding_eligibility.skipped.map(({ path: resultPath, policy }) => ({ resultPath, policy })),
            eligibleGrounding: artifact.completion?.eligible_grounding
              ?? (artifact.grounding_eligibility.eligible_record_leaves === 0 ? 'not_applicable' : 'partial'),
          }
        : null,
      support: artifact.quoted_support?.map(({ path: resultPath, ...proof }) => ({ resultPath, ...proof })) ?? null,
  ```
  (Evidence links are still built only from `artifact.evidence`; a proof never becomes a link. `precision` passes through unchanged.)

  `packages/extraction/src/types.ts`: add the three types above `ExtractionDiagnostics` and its three optional members with one-line comments ("What the Parsing Service reports it ran…", "Schema-policy verification's accounting…", "The quote or exact source span each accepted Article link was verified with…"); export the types from `index.ts`.

- [ ] **Step 3: Carry them to the wire**

  `prototypes/studio/shared/extraction.contract.ts` (import `activeSettingsSchema` from `extraction/extraction-method`):

  ```ts
  const effectiveMethodSchema = z
    .object({ options: z.record(z.string(), z.json()), versions: z.record(z.string(), z.number().int()) })
    .strict()
  const groundingEligibilitySchema = z
    .object({
      allRecordLeaves: z.number().int().nonnegative(),
      eligibleRecordLeaves: z.number().int().nonnegative(),
      skipped: z.array(z.object({ resultPath: resultPathSchema, policy: z.enum(['derived', 'unverified']) }).strict()),
      eligibleGrounding: z.enum(['complete', 'partial', 'not_applicable']),
    })
    .strict()
  const supportProofSchema = z
    .object({
      resultPath: resultPathSchema, segment: z.string(), cell: z.string().nullable(), quote: z.string(), attribution: z.string(),
      span: z.string().optional(), start: z.number().int().nonnegative().optional(), end: z.number().int().nonnegative().optional(),
    })
    .strict()
  ```
  `extractionDiagnosticsSchema` gains `effectiveMethod: effectiveMethodSchema.nullable().optional()`, `eligibility: groundingEligibilitySchema.nullable().optional()`, `support: z.array(supportProofSchema).nullable().optional()`; `extractionAttemptSchema` gains, after `requestedModels`:

  ```ts
      /** The settings admitted with the run; null when it predates recorded settings ("Not recorded"). */
      requestedSettings: activeSettingsSchema.nullable().optional(),
  ```

  `prototypes/studio/api/_extractions.ts`: `transportDiagnostics` adds `...(diagnostics.effectiveMethod ? { effectiveMethod: diagnostics.effectiveMethod } : {})` and the same for `eligibility` and `support`; `extractionAttemptDto` adds `requestedSettings: extraction.requestedSettings ?? null,` after `requestedModels`.

- [ ] **Step 4: Run the adapter tests and the Python evidence regressions**

  ```bash
  cd packages/extraction && pnpm test
  cd ../../prototypes/studio && npx vitest run api/_extractions.test.ts shared/extraction.contract.test.ts src/ResultsTab.test.tsx
  cd ../parsing_service && PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src:. .venv/bin/python -m pytest -q \
    tests/test_extraction_methods.py tests/test_extraction_span_grounding.py tests/test_extraction_routing.py \
    tests/test_grounding_study.py tests/test_extraction_evidence_policy.py -m 'not postgres and not live_model'
  ```
  Expected: PASS (the Python suites are unchanged regressions of E1–E3/E5's service side).

- [ ] **Step 5: Commit**

  ```bash
  git add -u packages prototypes
  git commit -m "feat(extraction): keep the effective method, schema-policy accounting and support proofs through result adapters"
  ```

---

### Task 8: Advanced draft state and its local helpers

**Files:**
- Modify: `prototypes/studio/src/providerConfig/useProviderConfigDraft.ts`
- Create: `prototypes/studio/src/providerConfig/advancedSettings.ts`
- Create: `prototypes/studio/src/providerConfig/advancedSettings.test.ts`
- Create: `prototypes/studio/src/providerConfig/useProviderConfigDraft.test.tsx`

**Interfaces:**
- Consumes: `ARTICLE_KEYS`, `REFERENCE_ARTICLE`, `REFERENCE_CATALOG`, `articleSettingsIssues`, `extractionSettingsSchema`, `settingsShapeIssues`, `METHOD_MESSAGES`, `type ArticleSettings`, `type CatalogSettings`, `type MethodIssue` (Task 1); `ModelConfig.extractionSettings` (Task 3).
- Produces:
  - Draft (one owner, `useProviderConfigDraft`): `customize(strategy: AdvancedStrategy)`, `useServiceDefaults(strategy: AdvancedStrategy)`, `setArticle<K extends ArticleKey>(key: K, value: ArticleSettings[K] | undefined)`, `replaceArticle(article: ArticleSettings | undefined)`, `addIdentityField(text: string): string | null` (returns the refusal message or null), `removeIdentityField(name: string)`, `setCatalogFactor(key: CatalogFactor, on: boolean)`, `setNumber(path: NumberPath, text: string)`, `numberEdits: Readonly<Partial<Record<NumberPath, string>>>`, `numberIssues: Readonly<Partial<Record<NumberPath, string>>>`, `settingsIssues: readonly MethodIssue[]` (paths `article.<key>`, `catalog.generic.<key>`, `catalog.recipe.<key>`, including number-text issues). `dirty` also counts `numberEdits`. `commit`/`discard`/`initialize` clear the number edits.
  - `advancedSettings.ts` (local data and pure functions, no extraction policy): `type AdvancedStrategy = 'article' | 'catalog'`, `type ArticleKey = keyof ArticleSettings`, `type ArticleSection = 'context' | 'identity' | 'input' | 'evidence'`, `type NumberPath`, `type CatalogFactor`, `ARTICLE_SECTIONS`, `SECTION_OF`, `CONTROL_LABELS`, `CONTROL_HINTS`, `ARTICLE_CHOICES`, `CATALOG_LABELS`, `NUMBER_MESSAGES`, `orderedArticle(partial)`, `orderedCatalog(catalog)`, `unavailableReason(article, key, value): string | null`, `effectiveSummary(article | undefined): string`, `sectionSummary(article, section): string`, `changedSections(draft, saved): ReadonlySet<ArticleSection>`, `STARTING_POINTS`, `withStartingPoint(article | undefined, point): ArticleSettings`, `settingsDelta(before | undefined, after): readonly SettingChange[]`, `matchingStartingPoint(article | undefined): StartingPoint | null`, `issueSection(path: string): ArticleSection | 'generic' | 'recipe' | null`.

- [ ] **Step 1: Write the failing helper tests**

  `prototypes/studio/src/providerConfig/advancedSettings.test.ts`:

  ```ts
  import { readFileSync } from 'node:fs'
  import { describe, expect, it } from 'vitest'
  import { articleSettingsIssues, METHOD_MESSAGES, REFERENCE_ARTICLE, type ArticleSettings } from 'extraction/extraction-method'
  import {
    ARTICLE_CHOICES, changedSections, effectiveSummary, matchingStartingPoint, orderedArticle, sectionSummary,
    settingsDelta, STARTING_POINTS, unavailableReason, withStartingPoint, type ArticleKey,
  } from './advancedSettings'

  const inventory = JSON.parse(readFileSync(new URL(
    '../../../parsing_service/tests/fixtures/contracts/article-options.json', import.meta.url), 'utf8')).inventory as {
    context_tokens: number; identity_fields: string[]; factors: Record<string, unknown[]>; verdicts: string }

  /** The order a researcher would set choices in: parents before the children they enable. */
  const ORDER: readonly ArticleKey[] = ['context', 'context_tokens', 'identity_fields', 'identity', 'prompt', 'rendering', 'grounding',
    'grounding_schedule', 'evidence_policy', 'grounding_routing', 'selection', 'grouping', 'overlap_passages']

  function* inputs(): Generator<Record<string, unknown>> {
    const names = Object.keys(inventory.factors)
    const walk = function* (index: number, chosen: Record<string, unknown>): Generator<Record<string, unknown>> {
      if (index === names.length) {
        yield { ...chosen, context_tokens: inventory.context_tokens,
          identity_fields: chosen.identity === 'conservative' ? inventory.identity_fields : [] }
        return
      }
      for (const value of inventory.factors[names[index]!]!) yield* walk(index + 1, { ...chosen, [names[index]!]: value })
    }
    yield* walk(0, {})
  }

  describe('every categorical combination through the Advanced controls', () => {
    it('each accepted one is reachable without a disabled choice; each refused one ends disabled or blocked', () => {
      let index = 0
      for (const target of inputs()) {
        let draft: ArticleSettings = REFERENCE_ARTICLE
        let disabled = false
        for (const key of ORDER) {
          const value = (target[key] ?? undefined) as never
          if (unavailableReason(draft, key, value) !== null) disabled = true
          draft = orderedArticle({ ...draft, [key]: value })
        }
        const accepted = inventory.verdicts[index] === '1'
        if (accepted) expect({ index, disabled, issues: articleSettingsIssues(draft) }).toEqual({ index, disabled: false, issues: [] })
        else expect(disabled || articleSettingsIssues(draft).length > 0, `#${index}`).toBe(true)
        index += 1
      }
      expect(index).toBe(6144)
    })
  })

  describe('choices', () => {
    it('a new incompatible choice is disabled with the design reason; the selected one never is', () => {
      expect(unavailableReason(REFERENCE_ARTICLE, 'overlap_passages', 1)).toBe(METHOD_MESSAGES.bounded)
      expect(unavailableReason(REFERENCE_ARTICLE, 'selection', 'supported')).toBe(METHOD_MESSAGES.bounded)
      expect(unavailableReason(REFERENCE_ARTICLE, 'grouping', 'structural')).toBe(METHOD_MESSAGES.bounded)
      expect(unavailableReason(REFERENCE_ARTICLE, 'evidence_policy', 'schema')).toBe(METHOD_MESSAGES.schemaPolicy)
      expect(unavailableReason({ ...REFERENCE_ARTICLE, grounding: 'off' }, 'grounding_schedule', 'unresolved')).toBe(METHOD_MESSAGES.schedule)
      expect(unavailableReason({ ...REFERENCE_ARTICLE, grounding: 'spans' }, 'grounding_routing', 'origin_lexical')).toBe(METHOD_MESSAGES.routing)
      // A parent change that breaks a child stays available: the child is kept and shown invalid instead.
      expect(unavailableReason({ ...REFERENCE_ARTICLE, context: 'bounded', overlap_passages: 1 }, 'context', 'full')).toBeNull()
      expect(unavailableReason({ ...REFERENCE_ARTICLE, overlap_passages: 1 }, 'overlap_passages', 1)).toBeNull()
      expect(ARTICLE_CHOICES.grounding.map((choice) => choice.label)).toEqual(['Source labels', 'Generated quotes', 'Source spans', 'Off'])
    })

    it('an optional factor switched off leaves no key behind, in ArticleOptions order', () => {
      const on = orderedArticle({ ...REFERENCE_ARTICLE, context: 'bounded', grouping: 'structural' })
      expect(Object.keys(orderedArticle({ ...on, grouping: undefined }))).toEqual(Object.keys(REFERENCE_ARTICLE))
      expect(JSON.stringify(orderedArticle({ grounding: 'semantic', ...REFERENCE_ARTICLE }))).toBe(JSON.stringify(REFERENCE_ARTICLE))
    })
  })

  describe('summaries', () => {
    it('service defaults and the explicit reference read as the documented reference', () => {
      expect(effectiveSummary(undefined)).toBe('Full source · Plain text · Source-label verification')
      expect(effectiveSummary(REFERENCE_ARTICLE)).toBe('Full source · Plain text · Source-label verification')
      expect(sectionSummary(REFERENCE_ARTICLE, 'context')).toBe('Full source')
      expect(sectionSummary(REFERENCE_ARTICLE, 'identity')).toBe('Reference')
      expect(sectionSummary(REFERENCE_ARTICLE, 'input')).toBe('Reference prompt · Plain text')
      expect(sectionSummary(REFERENCE_ARTICLE, 'evidence')).toBe('Source labels · All fields')
    })

    it('inactive values never reach a summary', () => {
      const full = { ...REFERENCE_ARTICLE, context_tokens: 16384 }
      expect(sectionSummary(full, 'context')).toBe('Full source')
      const spans = withStartingPoint(undefined, STARTING_POINTS[1]!)
      expect(effectiveSummary(spans)).toBe('Bounded source units (12,288 tokens) · Plain text · Source-span verification')
      expect(sectionSummary(spans, 'evidence')).toBe('Source spans · Schema policies · Until first support')
      expect(sectionSummary({ ...spans, identity: 'conservative', identity_fields: ['species', 'preparation'] }, 'identity'))
        .toBe('Declared identity fields: species, preparation')
    })

    it('a section is Changed only when one of its values differs from the saved settings', () => {
      expect(changedSections(REFERENCE_ARTICLE, undefined)).toEqual(new Set())
      expect(changedSections({ ...REFERENCE_ARTICLE, grounding: 'spans' }, REFERENCE_ARTICLE)).toEqual(new Set(['evidence']))
      expect(changedSections({ ...REFERENCE_ARTICLE, context_tokens: 16384 }, REFERENCE_ARTICLE)).toEqual(new Set())
    })
  })

  describe('starting points', () => {
    it('assign exactly the documented values, keep identity fields, and carry no preset identity', () => {
      const declared = { ...REFERENCE_ARTICLE, identity_fields: ['species'] }
      const explore = withStartingPoint(declared, STARTING_POINTS[1]!)
      expect(explore).toEqual({
        context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: ['species'],
        prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema',
      })
      expect(withStartingPoint(explore, STARTING_POINTS[0]!)).toEqual({ ...REFERENCE_ARTICLE, identity_fields: ['species'] })
      expect(matchingStartingPoint(explore)?.name).toBe('Explore spans and schema policies')
      expect(matchingStartingPoint({ ...explore, grounding: 'quoted' })).toBeNull()
      expect(JSON.stringify(explore)).not.toMatch(/preset|"name"|"id"/)
    })

    it('the delta lists every changed setting, from service defaults too', () => {
      expect(settingsDelta(undefined, withStartingPoint(undefined, STARTING_POINTS[1]!))).toEqual([
        { label: 'Article settings', from: 'Service defaults', to: 'Customized' },
        { label: 'Scope', from: 'Full source', to: 'Bounded source units' },
        { label: 'Context ceiling', from: 'Used with bounded source units', to: '12,288 tokens' },
        { label: 'Instructions', from: 'Reference', to: 'Schema-driven' },
        { label: 'Verification', from: 'Source labels', to: 'Source spans' },
        { label: 'Fields to verify', from: 'All populated record fields', to: 'Follow schema policies' },
        { label: 'Continue verification', from: 'Across all source units', to: 'Until first support' },
      ])
      expect(settingsDelta(REFERENCE_ARTICLE, REFERENCE_ARTICLE)).toEqual([])
    })
  })
  ```

  `prototypes/studio/src/providerConfig/useProviderConfigDraft.test.tsx`:

  ```tsx
  // @vitest-environment jsdom
  import { act, renderHook } from '@testing-library/react'
  import { describe, expect, it, vi } from 'vitest'
  import { METHOD_MESSAGES, REFERENCE_ARTICLE, REFERENCE_CATALOG } from 'extraction/extraction-method'
  import type { ModelConfig } from '../../shared/modelConfig.contract'
  import { useProviderConfigDraft } from './useProviderConfigDraft'

  const saved: ModelConfig = {
    connections: [], routes: { schemaSuggestion: null, interaction: null },
    extractionModels: { fields: 'instruct' }, ingestionModels: {},
    extractionSettings: { catalog: { generic: { record_chars: 30000 } } },
  }
  function draftHook() {
    const hook = renderHook(() => useProviderConfigDraft({
      accountId: 'acct', providers: [], scheduleProbe: vi.fn(), cancelProbe: vi.fn(), disposeProbe: vi.fn(),
    }))
    act(() => hook.result.current.initialize(saved))
    return hook
  }

  describe('the Advanced draft', () => {
    it('Customize creates the explicit reference; Use service defaults removes only that strategy', () => {
      const { result } = draftHook()
      act(() => result.current.customize('article'))
      expect(result.current.draft?.extractionSettings.article).toEqual(REFERENCE_ARTICLE)
      expect(result.current.dirty).toBe(true)
      act(() => result.current.useServiceDefaults('catalog'))
      expect(result.current.draft?.extractionSettings).toEqual({ article: REFERENCE_ARTICLE })
      expect(result.current.draft?.extractionModels).toEqual({ fields: 'instruct' })
      act(() => result.current.useServiceDefaults('article'))
      act(() => result.current.customize('catalog'))
      expect(result.current.draft?.extractionSettings).toEqual({ catalog: REFERENCE_CATALOG })
    })

    it('an optional factor switched off and on again, or a number edited back, is not an unsaved change', () => {
      const { result } = draftHook()
      act(() => result.current.initialize({ ...saved, extractionSettings: { article: { ...REFERENCE_ARTICLE, grounding: 'spans', evidence_policy: 'schema' } } }))
      act(() => result.current.setArticle('evidence_policy', undefined))
      expect(result.current.dirty).toBe(true)
      act(() => result.current.setArticle('evidence_policy', 'schema'))
      expect(result.current.dirty).toBe(false)
      act(() => result.current.setNumber('article.context_tokens', '16384'))
      expect(result.current.dirty).toBe(true)
      act(() => result.current.setNumber('article.context_tokens', '12288'))
      expect(result.current.dirty).toBe(false)
    })

    it('a parent change keeps an incompatible child and reports it; switching back resolves it', () => {
      const { result } = draftHook()
      act(() => result.current.customize('article'))
      act(() => result.current.setArticle('context', 'bounded'))
      act(() => result.current.setArticle('overlap_passages', 1))
      act(() => result.current.setArticle('context', 'full'))
      expect(result.current.draft?.extractionSettings.article?.overlap_passages).toBe(1)
      expect(result.current.settingsIssues).toEqual([{ path: 'article.overlap_passages', message: METHOD_MESSAGES.bounded }])
      act(() => result.current.setArticle('context', 'bounded'))
      expect(result.current.settingsIssues).toEqual([])
    })

    it('number text is never clamped: invalid text is kept, reported and blocks; Discard clears it', () => {
      const { result } = draftHook()
      act(() => result.current.customize('article'))
      act(() => result.current.setArticle('context', 'bounded'))
      for (const text of ['8191', '12288.5', '12,288', '', 'abc']) {
        act(() => result.current.setNumber('article.context_tokens', text))
        expect(result.current.settingsIssues).toContainEqual({ path: 'article.context_tokens', message: METHOD_MESSAGES.contextTokens })
      }
      expect(result.current.numberEdits['article.context_tokens']).toBe('abc')
      act(() => result.current.setNumber('article.context_tokens', '16384'))
      expect(result.current.draft?.extractionSettings.article?.context_tokens).toBe(16384)
      expect(result.current.numberEdits).toEqual({})
      act(() => result.current.setNumber('catalog.recipe.output_tokens', '12'))
      act(() => result.current.discard())
      expect(result.current.numberEdits).toEqual({})
      expect(result.current.draft).toEqual(saved)
    })

    it('identity fields are trimmed, exact-case, unique and non-empty', () => {
      const { result } = draftHook()
      act(() => result.current.customize('article'))
      let refused: string | null = null
      act(() => { refused = result.current.addIdentityField('  Species ') })
      expect(refused).toBeNull()
      act(() => { refused = result.current.addIdentityField('Species') })
      expect(refused).toBe(METHOD_MESSAGES.identityNames)
      act(() => { refused = result.current.addIdentityField('   ') })
      expect(refused).toBe(METHOD_MESSAGES.identityNames)
      expect(result.current.draft?.extractionSettings.article?.identity_fields).toEqual(['Species'])
      act(() => result.current.setArticle('identity', 'conservative'))
      act(() => result.current.removeIdentityField('Species'))
      expect(result.current.settingsIssues).toEqual([{ path: 'article.identity_fields', message: METHOD_MESSAGES.identity }])
    })

    it('replaceArticle restores a prior draft exactly, including an invalid one', () => {
      const { result } = draftHook()
      act(() => result.current.customize('article'))
      act(() => result.current.setArticle('overlap_passages', 2))
      const prior = result.current.draft!.extractionSettings.article
      act(() => result.current.replaceArticle({ ...REFERENCE_ARTICLE, grounding: 'quoted' }))
      act(() => result.current.replaceArticle(prior))
      expect(result.current.draft?.extractionSettings.article).toEqual(prior)
      act(() => result.current.replaceArticle(undefined))
      expect(result.current.draft?.extractionSettings.article).toBeUndefined()
    })
  })
  ```

  Run: `cd prototypes/studio && npx vitest run src/providerConfig/advancedSettings.test.ts src/providerConfig/useProviderConfigDraft.test.tsx`
  Expected: FAIL (modules/functions missing).

- [ ] **Step 2: Write the local helpers**

  `prototypes/studio/src/providerConfig/advancedSettings.ts`:

  ```ts
  import {
    ARTICLE_KEYS, articleSettingsIssues, METHOD_MESSAGES, REFERENCE_ARTICLE, type ArticleSettings,
  } from 'extraction/extraction-method'

  /** The Advanced tab's labels, one-line hints, summaries and availability. Local data and pure functions: the method
   *  rules themselves are the contract's (`articleSettingsIssues`); nothing here partitions tokens or checks evidence. */

  export type AdvancedStrategy = 'article' | 'catalog'
  export type ArticleKey = keyof ArticleSettings
  export type ArticleSection = 'context' | 'identity' | 'input' | 'evidence'
  export type CatalogFactor = 'glossary' | 'headings' | 'overlap' | 'verification'
  export type NumberPath =
    | 'article.context_tokens'
    | 'catalog.generic.discovery_chars' | 'catalog.generic.record_chars'
    | 'catalog.recipe.input_tokens' | 'catalog.recipe.output_tokens'

  export const ARTICLE_SECTIONS: readonly { section: ArticleSection; title: string; keys: readonly ArticleKey[] }[] = [
    { section: 'context', title: 'Source context', keys: ['context', 'context_tokens', 'grouping', 'overlap_passages', 'selection'] },
    { section: 'identity', title: 'Record identity', keys: ['identity', 'identity_fields'] },
    { section: 'input', title: 'Extraction input', keys: ['prompt', 'rendering'] },
    { section: 'evidence', title: 'Evidence', keys: ['grounding', 'evidence_policy', 'grounding_schedule', 'grounding_routing'] },
  ]
  export const SECTION_OF = Object.fromEntries(
    ARTICLE_SECTIONS.flatMap(({ section, keys }) => keys.map((key) => [key, section])),
  ) as Readonly<Record<ArticleKey, ArticleSection>>

  export const CONTROL_LABELS: Readonly<Record<ArticleKey, string>> = {
    context: 'Scope', context_tokens: 'Context ceiling', grouping: 'Grouping', overlap_passages: 'Previous passages',
    selection: 'Value evidence', identity: 'Reconciliation', identity_fields: 'Identity fields', prompt: 'Instructions',
    rendering: 'Source representation', grounding: 'Verification', evidence_policy: 'Fields to verify',
    grounding_schedule: 'Continue verification', grounding_routing: 'Unit order',
  }

  export const CONTROL_HINTS: Readonly<Record<ArticleKey, string>> = {
    context: 'Full source reads the whole document at once; bounded source units split it into parts that fit a ceiling.',
    context_tokens: 'Tokens per request, including instructions and the output reserve; each served model can lower it.',
    grouping: 'How bounded units are formed: by token budget, or following headings, captions and tables.',
    overlap_passages: 'Whole earlier passages repeated as context. They never own records; not pages or sentences.',
    selection: 'Which units record-value calls read. Inventory, document fields and verification still visit every unit.',
    identity: 'Reference merges records by the model’s identity; declared fields key records by the fields you list.',
    identity_fields: 'Exact top-level scalar field names, checked against the schema when an Extraction starts.',
    prompt: 'Reference instructions include historical laboratory examples; schema-driven ones are built from the schema.',
    rendering: 'Structured input labels blocks and table cells. It keeps the source characters and cannot recover missing OCR text or cells.',
    grounding: 'How each populated record value is checked against the source.',
    evidence_policy: 'All populated record fields, or only those your schema policies mark quoted.',
    grounding_schedule: 'Across all source units keeps checking later units; it does not detect contradictions.',
    grounding_routing: 'Which units a value is checked against first. Unresolved values still reach every eligible unit.',
  }

  type Choice<V> = Readonly<{ value: V; label: string }>
  export const ARTICLE_CHOICES = {
    context: [{ value: 'full', label: 'Full source' }, { value: 'bounded', label: 'Bounded source units' }],
    grouping: [{ value: undefined, label: 'Token budget' }, { value: 'structural', label: 'Structure-aware' }],
    overlap_passages: [{ value: 0, label: '0' }, { value: 1, label: '1' }, { value: 2, label: '2' }],
    selection: [{ value: undefined, label: 'All source units' }, { value: 'supported', label: 'Supported units' }],
    identity: [{ value: 'reference', label: 'Reference' }, { value: 'conservative', label: 'Declared identity fields' }],
    prompt: [{ value: 'reference', label: 'Reference' }, { value: 'schema', label: 'Schema-driven' }],
    rendering: [{ value: undefined, label: 'Plain text' }, { value: 'structured', label: 'Structured blocks and tables' }],
    grounding: [
      { value: 'semantic', label: 'Source labels' }, { value: 'quoted', label: 'Generated quotes' },
      { value: 'spans', label: 'Source spans' }, { value: 'off', label: 'Off' },
    ],
    evidence_policy: [{ value: undefined, label: 'All populated record fields' }, { value: 'schema', label: 'Follow schema policies' }],
    grounding_schedule: [{ value: undefined, label: 'Across all source units' }, { value: 'unresolved', label: 'Until first support' }],
    grounding_routing: [{ value: undefined, label: 'Source order' }, { value: 'origin_lexical', label: 'Origin and lexical relevance' }],
  } as const satisfies { [K in Exclude<ArticleKey, 'context_tokens' | 'identity_fields'>]: readonly Choice<ArticleSettings[K] | undefined>[] }

  export const CATALOG_LABELS = {
    discovery_chars: 'Discovery text limit', record_chars: 'Record text limit',
    input_tokens: 'Input budget', output_tokens: 'Output reserve',
    glossary: 'Glossary', headings: 'Inherited headings', overlap: 'Neighboring context', verification: 'Verification',
  } as const

  export const NUMBER_MESSAGES: Readonly<Record<NumberPath, string>> = {
    'article.context_tokens': METHOD_MESSAGES.contextTokens,
    'catalog.generic.discovery_chars': METHOD_MESSAGES.characters,
    'catalog.generic.record_chars': METHOD_MESSAGES.characters,
    'catalog.recipe.input_tokens': METHOD_MESSAGES.budgetTokens,
    'catalog.recipe.output_tokens': METHOD_MESSAGES.budgetTokens,
  }

  /** Rebuilds an Article draft in `ArticleOptions` order without unset factors, so equal drafts serialize alike. */
  export function orderedArticle(article: Readonly<Partial<Record<ArticleKey, unknown>>>): ArticleSettings {
    return Object.fromEntries(ARTICLE_KEYS.flatMap((key) =>
      article[key] === undefined || article[key] === null ? [] : [[key, article[key]]])) as ArticleSettings
  }

  /** Why choosing `value` would break a rule at this very control, or null. A parent choice that breaks a child stays
   *  available (the child is kept and shown invalid); the choice already selected is never disabled. */
  export function unavailableReason<K extends ArticleKey>(article: ArticleSettings, key: K, value: ArticleSettings[K] | undefined): string | null {
    if (article[key] === value) return null
    const issue = articleSettingsIssues(orderedArticle({ ...article, [key]: value })).find((candidate) => candidate.path === key)
    return issue?.message ?? null
  }

  const numberText = (value: number) => value.toLocaleString('en-US')
  const VERIFICATION: Readonly<Record<ArticleSettings['grounding'], string>> = {
    semantic: 'Source-label verification', quoted: 'Generated-quote verification', spans: 'Source-span verification', off: 'No verification',
  }
  const label = <K extends keyof typeof ARTICLE_CHOICES>(key: K, value: unknown) =>
    ARTICLE_CHOICES[key].find((choice) => choice.value === (value ?? undefined))!.label

  /** The one line under "Settings for"; service defaults read as the documented reference. */
  export function effectiveSummary(article: ArticleSettings | undefined): string {
    const shown = article ?? REFERENCE_ARTICLE
    const scope = shown.context === 'bounded' ? `Bounded source units (${numberText(shown.context_tokens)} tokens)` : 'Full source'
    return [scope, label('rendering', shown.rendering), VERIFICATION[shown.grounding]].join(' · ')
  }

  /** A collapsed row's value, derived from the draft; inactive values are left out. */
  export function sectionSummary(article: ArticleSettings, section: ArticleSection): string {
    switch (section) {
      case 'context':
        return article.context === 'full' ? 'Full source' : [
          'Bounded', `${numberText(article.context_tokens)} tokens`,
          ...(article.grouping ? ['Structure-aware'] : []),
          ...(article.overlap_passages > 0 ? [`${article.overlap_passages} previous passage${article.overlap_passages === 1 ? '' : 's'}`] : []),
          ...(article.selection ? ['Supported units'] : []),
        ].join(' · ')
      case 'identity':
        return article.identity === 'conservative'
          ? `Declared identity fields: ${article.identity_fields.join(', ') || 'none'}`
          : article.identity_fields.length > 0 ? `Reference · fields: ${article.identity_fields.join(', ')}` : 'Reference'
      case 'input':
        return `${article.prompt === 'schema' ? 'Schema prompt' : 'Reference prompt'} · ${label('rendering', article.rendering)}`
      case 'evidence':
        return [
          label('grounding', article.grounding),
          article.evidence_policy ? 'Schema policies' : 'All fields',
          ...(article.grounding_schedule ? ['Until first support'] : []),
          ...(article.grounding_routing ? ['Origin and lexical order'] : []),
        ].join(' · ')
    }
  }

  const shownValue = (article: ArticleSettings, key: ArticleKey): string =>
    key === 'context_tokens'
      ? (article.context === 'bounded' ? `${numberText(article.context_tokens)} tokens` : 'Used with bounded source units')
      : key === 'identity_fields'
        ? (article.identity_fields.join(', ') || 'None')
        : label(key as keyof typeof ARTICLE_CHOICES, article[key])

  /** Sections whose shown values differ from the saved settings (service defaults compare as the reference). */
  export function changedSections(draft: ArticleSettings, saved: ArticleSettings | undefined): ReadonlySet<ArticleSection> {
    const before = saved ?? REFERENCE_ARTICLE
    return new Set(ARTICLE_KEYS.filter((key) => shownValue(draft, key) !== shownValue(before, key)).map((key) => SECTION_OF[key]))
  }

  export type StartingPoint = Readonly<{ name: string; description: string; assign: Readonly<Partial<Record<ArticleKey, unknown>>> }>

  /** Design §6: two transparent assignments, not recommendations. Identity fields are never assigned. */
  export const STARTING_POINTS: readonly StartingPoint[] = [
    {
      name: 'Reference controls',
      description: 'Explicit full source, reference identity and prompt, plain input, source-label verification and no optional factors. A current-runtime reference configuration, not an exact reproduction of historical R1 v11.',
      assign: {
        context: 'full', context_tokens: 12288, overlap_passages: 0, grouping: undefined, selection: undefined, identity: 'reference',
        prompt: 'reference', rendering: undefined, grounding: 'semantic', evidence_policy: undefined, grounding_schedule: undefined,
        grounding_routing: undefined,
      },
    },
    {
      name: 'Explore spans and schema policies',
      description: 'Explicit bounded 12,288, no previous passages, token grouping, all value units, reference identity, schema prompt, plain input, source spans, schema policies, until first support and source order. It explores the combined method family. It is not a recommendation, a speed claim or a pilot reproduction.',
      assign: {
        context: 'bounded', context_tokens: 12288, overlap_passages: 0, grouping: undefined, selection: undefined, identity: 'reference',
        prompt: 'schema', rendering: undefined, grounding: 'spans', evidence_policy: 'schema', grounding_schedule: 'unresolved',
        grounding_routing: undefined,
      },
    },
  ]

  export function withStartingPoint(article: ArticleSettings | undefined, point: StartingPoint): ArticleSettings {
    return orderedArticle({ ...(article ?? REFERENCE_ARTICLE), ...point.assign })
  }

  /** A starting point's name when the settings match all its assignments; names are derived, never stored. */
  export function matchingStartingPoint(article: ArticleSettings | undefined): StartingPoint | null {
    if (!article) return null
    return STARTING_POINTS.find((point) => Object.entries(point.assign).every(([key, value]) =>
      (article[key as ArticleKey] ?? undefined) === value)) ?? null
  }

  export type SettingChange = Readonly<{ label: string; from: string; to: string }>

  /** Every setting a change would alter, in control order, as the researcher reads them. */
  export function settingsDelta(before: ArticleSettings | undefined, after: ArticleSettings): readonly SettingChange[] {
    const base = before ?? REFERENCE_ARTICLE
    return [
      ...(before ? [] : [{ label: 'Article settings', from: 'Service defaults', to: 'Customized' }]),
      ...ARTICLE_SECTIONS.flatMap(({ keys }) => keys)
        .filter((key) => shownValue(base, key) !== shownValue(after, key))
        .map((key) => ({ label: CONTROL_LABELS[key], from: shownValue(base, key), to: shownValue(after, key) })),
    ]
  }

  /** Which disclosure an issue opens: an Article section, or a Catalog one. */
  export function issueSection(path: string): ArticleSection | 'generic' | 'recipe' | null {
    const [scope, member] = path.split('.')
    if (scope === 'article' && member) return SECTION_OF[member as ArticleKey] ?? null
    if (scope === 'catalog' && (member === 'generic' || member === 'recipe')) return member
    return null
  }

  const GENERIC_KEYS = ['discovery_chars', 'record_chars'] as const
  const RECIPE_KEYS = ['input_tokens', 'output_tokens', 'factors'] as const

  /** A Catalog draft in the contract's key order, without unset values; like `orderedArticle`, it never validates. */
  export function orderedCatalog(catalog: Readonly<{ generic?: Record<string, unknown>; recipe?: Record<string, unknown> }>): CatalogSettings {
    const pick = (member: Record<string, unknown> | undefined, keys: readonly string[]) =>
      member && Object.fromEntries(keys.flatMap((key) => (member[key] === undefined ? [] : [[key, member[key]]])))
    const generic = pick(catalog.generic, GENERIC_KEYS)
    const recipe = pick(catalog.recipe, RECIPE_KEYS)
    return { ...(generic ? { generic } : {}), ...(recipe ? { recipe } : {}) } as CatalogSettings
  }
  ```
  (add `type CatalogSettings` to the import from `extraction/extraction-method`).

  Note the delta order: `ARTICLE_SECTIONS` key order (Scope, Context ceiling, Grouping, Previous passages, Value evidence, Reconciliation, Identity fields, Instructions, Source representation, Verification, Fields to verify, Continue verification, Unit order); the test above lists the changed ones in that order.

- [ ] **Step 3: Extend the one draft owner**

  In `prototypes/studio/src/providerConfig/useProviderConfigDraft.ts` (imports: `REFERENCE_ARTICLE`, `REFERENCE_CATALOG`, `extractionSettingsIssues`, `extractionSettingsSchema`, `settingsShapeIssues`, `METHOD_MESSAGES`, `type ArticleSettings`, `type MethodIssue` from `extraction/extraction-method`; `NUMBER_MESSAGES`, `orderedArticle`, `orderedCatalog`, `type AdvancedStrategy`, `type ArticleKey`, `type CatalogFactor`, `type NumberPath` from `./advancedSettings`):

  ```ts
    const [numberEdits, setNumberEdits] = useState<Readonly<Partial<Record<NumberPath, string>>>>({})

    // in initialize(config): setNumberEdits({})

    function setSettings(change: (settings: ModelConfig['extractionSettings']) => ModelConfig['extractionSettings']): void {
      setDraft((current) => current && { ...current, extractionSettings: change(current.extractionSettings) })
    }

    /** Customize: that strategy's override starts from the documented reference settings. */
    function customize(strategy: AdvancedStrategy): void {
      setSettings((settings) => ({ ...settings, [strategy]: strategy === 'article' ? REFERENCE_ARTICLE : REFERENCE_CATALOG }))
    }

    /** Use service defaults: removes only that strategy's override; Models, Connections and the other strategy stay. */
    function useServiceDefaults(strategy: AdvancedStrategy): void {
      setSettings(({ [strategy]: _removed, ...rest }) => rest)
      setNumberEdits((edits) => Object.fromEntries(Object.entries(edits).filter(([path]) => !path.startsWith(`${strategy}.`))))
    }

    /** `undefined` switches an optional factor off (omitted, never null). A parent change keeps its children as they are. */
    function setArticle<K extends ArticleKey>(key: K, value: ArticleSettings[K] | undefined): void {
      setSettings((settings) => settings.article ? { ...settings, article: orderedArticle({ ...settings.article, [key]: value }) } : settings)
    }

    /** A starting point, and its Undo: the whole Article override, or none. */
    function replaceArticle(article: ArticleSettings | undefined): void {
      setSettings(({ article: _previous, ...rest }) => (article ? { ...rest, article: orderedArticle(article) } : rest))
    }

    function addIdentityField(text: string): string | null {
      const name = text.trim()
      const fields = draft?.extractionSettings.article?.identity_fields ?? []
      if (name === '' || fields.includes(name)) return METHOD_MESSAGES.identityNames
      setArticle('identity_fields', [...fields, name])
      return null
    }

    function removeIdentityField(name: string): void {
      setArticle('identity_fields', (draft?.extractionSettings.article?.identity_fields ?? []).filter((field) => field !== name))
    }

    function setCatalogFactor(key: CatalogFactor, on: boolean): void {
      setSettings((settings) => {
        const recipe = settings.catalog?.recipe ?? {}
        const factors = { ...REFERENCE_CATALOG.recipe!.factors!, ...recipe.factors, [key]: on }
        return { ...settings, catalog: orderedCatalog({ ...settings.catalog, recipe: { ...recipe, factors } }) }
      })
    }

    /** Digits only: a whole number reaches the draft (its minimum is then the contract's to report); any other text
     *  stays in the input, marked invalid, and blocks Apply. Nothing is clamped or rounded. */
    function setNumber(path: NumberPath, text: string): void {
      if (!/^\d+$/.test(text)) {
        setNumberEdits((edits) => ({ ...edits, [path]: text }))
        return
      }
      setNumberEdits(({ [path]: _cleared, ...edits }) => edits)
      const value = Number(text)
      const [scope, member, key] = path.split('.') as [AdvancedStrategy, string, string]
      if (scope === 'article') setArticle(member as ArticleKey, value as never)
      else setSettings((settings) => {
        const catalog = (settings.catalog ?? {}) as Record<string, Record<string, unknown> | undefined>
        // Never parsed here: a value below its minimum must stay in the draft, visible and reported.
        return { ...settings, catalog: orderedCatalog({ ...catalog, [member]: { ...catalog[member], [key]: value } }) }
      })
    }
  ```
  (A draft is never parsed with the contract's schemas: parsing would fill defaults and could not hold a below-minimum value.)

  Issues and dirtiness:

  ```ts
    /** Every Advanced issue the page shows and Apply waits for: shape (minimums, names), cross-field rules, and number
     *  text that is not a whole number. Paths are relative to `extractionSettings`. */
    const settingsIssues: readonly MethodIssue[] = (() => {
      if (!draft) return []
      const parsed = extractionSettingsSchema.safeParse(draft.extractionSettings)
      const found = parsed.success ? extractionSettingsIssues(parsed.data) : settingsShapeIssues(parsed.error)
      const typed = (Object.keys(numberEdits) as NumberPath[]).map((path) => ({ path, message: NUMBER_MESSAGES[path] }))
      return [...typed, ...found.filter((issue) => !typed.some((edit) => edit.path === issue.path))]
    })()

    const dirty = draft !== null && saved !== null &&
      (JSON.stringify(draft) !== JSON.stringify(saved) || Object.keys(keyEdits).length > 0 || Object.keys(numberEdits).length > 0)
  ```
  Return the new functions and `numberEdits`, `settingsIssues` from the hook. (Cross-field rules are only evaluated when the shape parses; a below-minimum number is reported by the shape first, which is the field-addressed message the researcher needs.)

- [ ] **Step 4: Run the tests**

  Run: `cd prototypes/studio && npx vitest run src/providerConfig && cd ../.. && pnpm typecheck && pnpm lint`
  Expected: PASS (the existing `ProviderConfigPage.test.tsx` is unaffected: the page does not render the new state yet).

- [ ] **Step 5: Commit**

  ```bash
  git add prototypes/studio/src/providerConfig/useProviderConfigDraft.ts prototypes/studio/src/providerConfig/advancedSettings.ts \
    prototypes/studio/src/providerConfig/advancedSettings.test.ts prototypes/studio/src/providerConfig/useProviderConfigDraft.test.tsx
  git commit -m "feat(studio): Advanced settings in the one Model Configuration draft, with local labels and availability"
  ```

---

### Task 9: The Advanced tab

**Files:**
- Create: `prototypes/studio/src/providerConfig/AdvancedTab.tsx`
- Modify: `prototypes/studio/src/providerConfig/ProviderConfigPage.tsx` (tabs, blocking, footer issue summary)
- Test: `prototypes/studio/src/providerConfig/ProviderConfigPage.test.tsx`

**Interfaces:**
- Consumes: Task 8's draft API (`customize`, `useServiceDefaults`, `setArticle`, `addIdentityField`, `removeIdentityField`, `setCatalogFactor`, `setNumber`, `numberEdits`, `settingsIssues`) and helpers (`ARTICLE_SECTIONS`, `ARTICLE_CHOICES`, `CONTROL_LABELS`, `CONTROL_HINTS`, `CATALOG_LABELS`, `effectiveSummary`, `sectionSummary`, `changedSections`, `unavailableReason`, `issueSection`); `REFERENCE_ARTICLE`, `CATALOG_DEFAULTS`, `extractionMethod`, `keiMethodOptions` (Task 1).
- Produces: `AdvancedTab(props: { draft: ModelConfig; saved: ModelConfig; editor: AdvancedEditor; focusIssue: boolean; onIssueFocused: () => void; children?: ReactNode })` — `children` is the slot Task 10 fills with "How this works"; every settable control carries `data-setting="<issue path>"`; `Disclosure` is exported for Task 10's Explain actions to sit in its summary row; Explain buttons are added in Task 10. Page: tabs `Models · Connections · Advanced`; Apply disabled while `settingsIssues` is non-empty; footer button "1 issue blocks Apply" / "N issues block Apply" that opens Advanced and focuses the first invalid control.

Copy (design §1–§4, exact): tab "Advanced"; heading "Advanced extraction"; "Applies to new Extractions in your Projects."; "Settings for:" with "Article"/"Catalog"; caption "Settings for future Extractions using this strategy."; "Use service defaults"; "Customize"; row titles "Source context", "Record identity", "Extraction input", "Evidence", "Effective settings"; "Changed"; "Used with bounded source units"; "Service defaults; resolved for the Extraction"; "Generic Catalog", "Recipe Catalog". Plan-chosen copy (flag in review): "Article document-level fields currently remain unverified.", "Applies when a Catalog Extraction uses Model discovery.", "Applies when a Catalog Extraction uses a numbered-catalogue recipe.", "Off keeps typed values as proposals, not accepted evidence.", "Conservative reconciliation is the choice that requires declared fields.", "Fix the issues above to preview the request.", "Add field", "Remove <name>".

- [ ] **Step 1: Write the failing component tests**

  Append to `prototypes/studio/src/providerConfig/ProviderConfigPage.test.tsx` (helpers `studio`, `renderPage`, `apply`, `config` exist; import `METHOD_MESSAGES`, `REFERENCE_ARTICLE` from `extraction/extraction-method`):

  ```tsx
  const openAdvanced = () => fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }))
  const openSection = (title: string) => fireEvent.click(screen.getByText(title, { selector: 'summary *' }))
  const radio = (group: string, name: string) => within(screen.getByRole('group', { name: group })).getByRole('radio', { name })

  describe('Advanced', () => {
    it('opens clean on Article with the reference summary: no save, no model call, omission kept', async () => {
      const server = studio(config())
      await renderPage()
      openAdvanced()
      expect(screen.getByRole('heading', { name: 'Advanced extraction' })).toBeInTheDocument()
      expect(screen.getByText('Full source · Plain text · Source-label verification')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Use service defaults', pressed: true })).toBeInTheDocument()
      openSection('Source context')
      expect(radio('Scope', 'Full source')).toBeDisabled()
      fireEvent.click(screen.getByRole('radio', { name: 'Catalog' }))
      expect(screen.getByText('Settings for future Extractions using this strategy.')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
      openAdvanced()
      expect(screen.getByText('Everything saved')).toBeInTheDocument()
      expect(server.puts()).toEqual([])
      expect(server.request.mock.calls.map(([url]) => String(url))).not.toContainEqual(expect.stringMatching(/extractions|generation|model_probe$/))
    })

    it('a model choice and a span setting survive tab switches; Discard restores both', async () => {
      const server = studio(config({ extractionModels: { fields: 'nuextract' } }))
      await renderPage()
      fireEvent.click(within(step('Extracting data')).getByRole('button', { name: 'Use defaults' }))
      openAdvanced()
      fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
      openSection('Evidence')
      fireEvent.click(radio('Verification', 'Source spans'))
      expect(screen.getByText('Changed')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
      expect(within(step('Extracting data')).getByRole('button', { name: 'Change' })).toBeInTheDocument()
      openAdvanced()
      openSection('Evidence')
      expect(radio('Verification', 'Source spans')).toBeChecked()
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
      expect(screen.getByRole('button', { name: 'Use service defaults', pressed: true })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
      expect(within(step('Extracting data')).getByRole('button', { name: 'Use defaults' })).toBeInTheDocument()
      expect(screen.getByText('Everything saved')).toBeInTheDocument()
      expect(server.puts()).toEqual([])
    })

    it('Apply saves the whole draft; a failed Apply keeps the draft and the saved state', async () => {
      let fail = true
      const server = studio(config(), { put: () => (fail ? jsonResponse({ error: { code: 'persistence_unavailable', message: 'Unavailable.' } }, 503) : undefined) })
      await renderPage()
      openAdvanced()
      fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
      openSection('Evidence')
      fireEvent.click(radio('Verification', 'Source spans'))
      apply()
      expect(await screen.findByRole('alert')).toHaveTextContent('persistence_unavailable')
      expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
      expect(radio('Verification', 'Source spans')).toBeChecked()
      expect(server.stored().extractionSettings).toEqual({})
      fail = false
      apply()
      await waitFor(() => expect(screen.getByText('Everything saved')).toBeInTheDocument())
      expect(server.stored().extractionSettings).toEqual({ article: { ...REFERENCE_ARTICLE, grounding: 'spans' } })
    })

    it('Bounded + overlap 1 → Full keeps overlap 1 visibly invalid and blocks Apply; Bounded again resolves it', async () => {
      studio(config())
      await renderPage()
      openAdvanced()
      fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
      openSection('Source context')
      expect(radio('Previous passages', '1')).toBeDisabled()
      expect(screen.getAllByText(`(${METHOD_MESSAGES.bounded})`).length).toBeGreaterThan(0)
      fireEvent.click(radio('Scope', 'Bounded source units'))
      fireEvent.click(radio('Previous passages', '1'))
      fireEvent.click(radio('Scope', 'Full source'))
      expect(radio('Previous passages', '1')).toBeChecked()
      expect(radio('Previous passages', '1')).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByText(METHOD_MESSAGES.bounded, { selector: 'p' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: '1 issue blocks Apply' }))
      await waitFor(() => expect(radio('Previous passages', '1')).toHaveFocus())
      fireEvent.click(radio('Scope', 'Bounded source units'))
      expect(radio('Previous passages', '1')).toBeChecked()
      expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
    })

    it('an invalid section opens itself even when it was collapsed', async () => {
      studio(config({ extractionSettings: { article: { ...REFERENCE_ARTICLE, grounding: 'spans', evidence_policy: 'schema' } } }))
      await renderPage()
      openAdvanced()
      openSection('Evidence')
      fireEvent.click(radio('Verification', 'Source labels'))
      openSection('Evidence') // the researcher collapses it; the issue keeps it open
      expect(screen.getByText(METHOD_MESSAGES.schemaPolicy, { selector: 'p' })).toBeVisible()
    })

    it('numbers state their unit and minimum and are never clamped', async () => {
      const server = studio(config())
      await renderPage()
      openAdvanced()
      fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
      openSection('Source context')
      const ceiling = screen.getByRole('textbox', { name: /Context ceiling/ })
      expect(ceiling).toHaveAttribute('readonly')
      expect(screen.getByText('Used with bounded source units')).toBeInTheDocument()
      fireEvent.click(radio('Scope', 'Bounded source units'))
      for (const text of ['8191', '12288.5', 'twelve']) {
        fireEvent.change(ceiling, { target: { value: text } })
        expect(ceiling).toHaveValue(text)
        expect(screen.getByText(METHOD_MESSAGES.contextTokens, { selector: 'p' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
      }
      fireEvent.change(ceiling, { target: { value: '8192' } })
      apply()
      await waitFor(() => expect(server.puts()).toHaveLength(1))
      expect(server.puts()[0]!.extractionSettings.article?.context_tokens).toBe(8192)
    })

    it('identity fields: chips keep exact case, refuse empty and duplicate names, and conservative needs one', async () => {
      studio(config())
      await renderPage()
      openAdvanced()
      fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
      openSection('Record identity')
      const name = screen.getByRole('textbox', { name: 'Identity field name' })
      fireEvent.change(name, { target: { value: '  Species ' } })
      fireEvent.click(screen.getByRole('button', { name: 'Add field' }))
      expect(within(screen.getByRole('list', { name: 'Identity fields' })).getByText('Species')).toBeInTheDocument()
      fireEvent.change(name, { target: { value: 'Species' } })
      fireEvent.click(screen.getByRole('button', { name: 'Add field' }))
      expect(screen.getByText(METHOD_MESSAGES.identityNames)).toBeInTheDocument()
      fireEvent.click(radio('Reconciliation', 'Declared identity fields'))
      fireEvent.click(screen.getByRole('button', { name: 'Remove Species' }))
      expect(screen.getByText(METHOD_MESSAGES.identity, { selector: 'p' })).toBeInTheDocument()
    })

    it('Catalog keeps generic limits and recipe factors apart; Use service defaults removes only Catalog', async () => {
      const server = studio(config({ extractionSettings: { article: REFERENCE_ARTICLE } }))
      await renderPage()
      openAdvanced()
      fireEvent.click(screen.getByRole('radio', { name: 'Catalog' }))
      fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
      openSection('Recipe Catalog')
      expect(screen.getByText('Applies when a Catalog Extraction uses a numbered-catalogue recipe.')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('switch', { name: 'Verification' }))
      expect(screen.getByText('Off keeps typed values as proposals, not accepted evidence.')).toBeInTheDocument()
      apply()
      await waitFor(() => expect(server.puts()).toHaveLength(1))
      expect(server.puts()[0]!.extractionSettings.catalog?.recipe?.factors?.verification).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'Use service defaults' }))
      apply()
      await waitFor(() => expect(server.puts()).toHaveLength(2))
      expect(server.puts()[1]!.extractionSettings).toEqual({ article: REFERENCE_ARTICLE })
    })

    it('the tablist keeps arrow-key navigation across three tabs', async () => {
      studio(config())
      await renderPage()
      const models = screen.getByRole('tab', { name: 'Models' })
      fireEvent.keyDown(models, { key: 'ArrowLeft' })
      expect(screen.getByRole('tab', { name: 'Advanced' })).toHaveFocus()
      expect(screen.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'true')
    })
  })
  ```

  Run: `cd prototypes/studio && npx vitest run src/providerConfig/ProviderConfigPage.test.tsx`
  Expected: FAIL (no Advanced tab).

- [ ] **Step 2: Write the Advanced tab**

  `prototypes/studio/src/providerConfig/AdvancedTab.tsx`:

  ```tsx
  import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
  import {
    CATALOG_DEFAULTS, extractionMethod, keiMethodOptions, REFERENCE_ARTICLE, type ArticleSettings,
  } from 'extraction/extraction-method'
  import type { ModelConfig } from '../../shared/modelConfig.contract'
  import {
    ARTICLE_CHOICES, ARTICLE_SECTIONS, CATALOG_LABELS, CONTROL_HINTS, CONTROL_LABELS, changedSections, effectiveSummary,
    issueSection, sectionSummary, unavailableReason, type AdvancedStrategy, type ArticleKey, type ArticleSection,
    type CatalogFactor, type NumberPath,
  } from './advancedSettings'
  import type { ProviderConfigDraft } from './useProviderConfigDraft'

  export type AdvancedEditor = Pick<ProviderConfigDraft,
    'customize' | 'useServiceDefaults' | 'setArticle' | 'addIdentityField' | 'removeIdentityField' | 'setCatalogFactor' |
    'setNumber' | 'numberEdits' | 'settingsIssues'>

  type Props = {
    draft: ModelConfig
    saved: ModelConfig
    editor: AdvancedEditor
    /** Set by the footer's issue summary: show the first issue's section, focus its control, then report it handled. */
    focusIssue: boolean
    onIssueFocused: () => void
    /** "How this works" and its starting points (the guide). */
    children?: ReactNode
  }

  const STRATEGIES: readonly { value: AdvancedStrategy; label: string }[] = [
    { value: 'article', label: 'Article' }, { value: 'catalog', label: 'Catalog' },
  ]
  const textButton = 'text-[11.5px] font-semibold transition-colors'

  /** Saved method settings for future Extractions, per strategy, in the page's one draft. Choosing which strategy's
   *  settings to edit never changes any Extraction's strategy. */
  export function AdvancedTab({ draft, saved, editor, focusIssue, onIssueFocused, children }: Props) {
    const [strategy, setStrategy] = useState<AdvancedStrategy>('article')
    const root = useRef<HTMLDivElement>(null)
    const headingId = useId()
    const custom = draft.extractionSettings[strategy] !== undefined

    useEffect(() => {
      const first = editor.settingsIssues[0]
      if (!focusIssue || !first) return
      setStrategy(first.path.startsWith('catalog.') ? 'catalog' : 'article')
      requestAnimationFrame(() => {
        root.current?.querySelector<HTMLElement>(`[data-setting="${first.path}"]`)?.focus()
        onIssueFocused()
      })
      // eslint-disable-next-line react-hooks/exhaustive-deps -- once per request from the footer
    }, [focusIssue])

    return (
      <section ref={root} aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id={headingId} className="text-[13px] font-bold text-ink">Advanced extraction</h3>
          {children}
        </div>
        <p className="-mt-2 text-[11.5px] text-ink-faint">Applies to new Extractions in your Projects.</p>
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="sr-only">Settings for</legend>
          <span aria-hidden="true" className="text-[11.5px] font-semibold text-ink-muted">Settings for:</span>
          {STRATEGIES.map((option) => (
            <label key={option.value} className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[12px] text-ink">
              <input type="radio" name={`${headingId}-strategy`} checked={strategy === option.value} onChange={() => setStrategy(option.value)} />
              {option.label}
            </label>
          ))}
        </fieldset>
        <p className="-mt-1 text-[11px] text-ink-faint">Settings for future Extractions using this strategy.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-pressed={!custom} className={`${textButton} rounded-md border border-line px-2.5 py-1 ${custom ? 'text-ink-muted hover:text-accent' : 'bg-surface-muted text-ink'}`}
            onClick={() => editor.useServiceDefaults(strategy)}>Use service defaults</button>
          <button type="button" aria-pressed={custom} className={`${textButton} rounded-md border border-line px-2.5 py-1 ${custom ? 'bg-surface-muted text-ink' : 'text-accent hover:underline'}`}
            onClick={() => { if (!custom) editor.customize(strategy) }}>Customize</button>
        </div>
        {strategy === 'article'
          ? <ArticleSettingsView draft={draft} saved={saved} editor={editor} />
          : <CatalogSettingsView draft={draft} editor={editor} />}
      </section>
    )
  }

  function ArticleSettingsView({ draft, saved, editor }: Pick<Props, 'draft' | 'saved' | 'editor'>) {
    const explicit = draft.extractionSettings.article
    const custom = explicit !== undefined
    const article = explicit ?? REFERENCE_ARTICLE
    const changed = changedSections(article, saved.extractionSettings.article)
    const invalid = new Set(editor.settingsIssues.map((issue) => issueSection(issue.path)))
    const issueAt = (key: ArticleKey) => editor.settingsIssues.find((issue) => issue.path === `article.${key}`)?.message ?? null
    const set = <K extends ArticleKey>(key: K) => (value: ArticleSettings[K] | undefined) => editor.setArticle(key, value)
    const choice = (key: keyof typeof ARTICLE_CHOICES) => (
      <ChoiceGroup key={key} settingKey={key} article={article} custom={custom} error={issueAt(key)} onChange={set(key) as (value: unknown) => void} />
    )
    const controls: Readonly<Record<ArticleSection, ReactNode>> = {
      context: <>
        {choice('context')}
        <NumberField path="article.context_tokens" label={CONTROL_LABELS.context_tokens} hint={CONTROL_HINTS.context_tokens}
          unit="tokens, at least 8,192" value={article.context_tokens} edit={editor.numberEdits['article.context_tokens']}
          disabled={!custom} inactive={article.context === 'full'} error={issueAt('context_tokens')} onText={editor.setNumber} />
        {choice('grouping')}{choice('overlap_passages')}{choice('selection')}
      </>,
      identity: <>
        {choice('identity')}
        <IdentityFields fields={article.identity_fields} custom={custom} error={issueAt('identity_fields')}
          add={editor.addIdentityField} remove={editor.removeIdentityField} />
      </>,
      input: <>{choice('prompt')}{choice('rendering')}</>,
      evidence: <>
        {choice('grounding')}{choice('evidence_policy')}{choice('grounding_schedule')}{choice('grounding_routing')}
      </>,
    }
    return (
      <>
        <p className="text-[12px] text-ink">{effectiveSummary(explicit)}</p>
        <ul className="flex flex-col gap-2">
          {ARTICLE_SECTIONS.map(({ section, title }) => (
            <li key={section}>
              <Disclosure title={title} value={sectionSummary(article, section)} changed={changed.has(section)} forcedOpen={invalid.has(section)}>
                <fieldset disabled={!custom} className="flex min-w-0 flex-col gap-3">{controls[section]}</fieldset>
                {section === 'evidence' && <p className="text-[11px] text-ink-faint">Article document-level fields currently remain unverified.</p>}
              </Disclosure>
            </li>
          ))}
          <li>
            <Disclosure title="Effective settings" value="" changed={false} forcedOpen={false}>
              {custom
                ? <p className="text-[12px] text-ink">{effectiveSummary(explicit)}</p>
                : <p className="text-[12px] text-ink">Service defaults; resolved for the Extraction. Today’s documented reference: {effectiveSummary(undefined)}, using each served model’s context size.</p>}
              <p className="text-[11.5px] text-ink-muted">Field and reasoning models follow the Models tab: field values {draft.extractionModels.fields ?? 'deployment default'}, reasoning {draft.extractionModels.reasoning ?? 'deployment default'}.</p>
              <details className="text-[11px] text-ink-muted">
                <summary className="cursor-pointer font-semibold text-ink">Technical details</summary>
                {editor.settingsIssues.some((issue) => issue.path.startsWith('article.'))
                  ? <p>Fix the issues above to preview the request.</p>
                  : <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono">{JSON.stringify(keiMethodOptions(
                      extractionMethod('ARTICLE', null, draft.extractionModels, { article: explicit ?? null })), null, 2)}</pre>}
              </details>
            </Disclosure>
          </li>
        </ul>
      </>
    )
  }

  /** A native disclosure row: title, the draft's value, and one "Changed" label. An issue inside keeps it open. */
  export function Disclosure({ title, value, changed, forcedOpen, children }: { title: string; value: string; changed: boolean; forcedOpen: boolean; children: ReactNode }) {
    const [opened, setOpened] = useState(false)
    return (
      <details open={opened || forcedOpen} className="rounded-xl border border-line bg-surface"
        onToggle={(event) => {
          // Collapsing a section with an issue inside would hide why Apply is blocked.
          if (forcedOpen && !event.currentTarget.open) event.currentTarget.open = true
          setOpened(event.currentTarget.open)
        }}>
        <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
          <span className="text-[12.5px] font-semibold text-ink">{title}</span>
          <span className="min-w-0 flex-1 text-[12px] text-ink-muted">{value}</span>
          {changed && <span className="rounded border border-accent/50 px-1 text-[10.5px] font-semibold text-accent">Changed</span>}
        </summary>
        <div className="flex flex-col gap-3 border-t border-line px-3 py-3">{children}</div>
      </details>
    )
  }

  function ChoiceGroup<K extends keyof typeof ARTICLE_CHOICES>({ settingKey, article, custom, error, onChange }: {
    settingKey: K; article: ArticleSettings; custom: boolean; error: string | null; onChange: (value: unknown) => void
  }) {
    const id = useId()
    // One key's choices; the cast only names the element type the `as const` table already has for this key.
    const options = ARTICLE_CHOICES[settingKey] as readonly Readonly<{ value: ArticleSettings[K] | undefined; label: string }>[]
    return (
      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className="text-[11px] font-semibold text-ink-muted">{CONTROL_LABELS[settingKey]}</legend>
        <p id={`${id}-hint`} className="text-[10.5px] text-ink-faint">{CONTROL_HINTS[settingKey]}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {options.map((option, index) => {
            const selected = (article[settingKey] ?? undefined) === option.value
            const reason = custom ? unavailableReason(article, settingKey, option.value) : null
            return (
              <label key={option.label} className="flex items-baseline gap-1.5 text-[12px] text-ink">
                <input type="radio" name={id} checked={selected} disabled={reason !== null}
                  data-setting={selected ? `article.${settingKey}` : undefined}
                  aria-invalid={selected && error ? true : undefined}
                  aria-describedby={[`${id}-hint`, reason ? `${id}-reason-${index}` : null, selected && error ? `${id}-error` : null].filter(Boolean).join(' ')}
                  onChange={() => onChange(option.value)} />
                {option.label}
                {reason && <span id={`${id}-reason-${index}`} className="text-[10.5px] text-ink-faint">({reason})</span>}
              </label>
            )
          })}
        </div>
        {error && <p id={`${id}-error`} aria-live="polite" className="text-[11px] font-semibold text-danger">{error}</p>}
      </fieldset>
    )
  }

  function NumberField({ path, label, hint, unit, value, edit, disabled, inactive = false, error, onText }: {
    path: NumberPath; label: string; hint: string; unit: string; value: number; edit: string | undefined
    disabled: boolean; inactive?: boolean; error: string | null; onText: (path: NumberPath, text: string) => void
  }) {
    const id = useId()
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={id} className="text-[11px] font-semibold text-ink-muted">{label}</label>
        <p id={`${id}-hint`} className="text-[10.5px] text-ink-faint">{hint}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input id={id} type="text" inputMode="numeric" data-setting={path} value={edit ?? String(value)} readOnly={inactive}
            disabled={disabled} aria-invalid={error ? true : undefined}
            aria-describedby={[`${id}-hint`, `${id}-unit`, error ? `${id}-error` : null].filter(Boolean).join(' ')}
            onChange={(event) => onText(path, event.target.value)}
            className="w-32 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[12px] text-ink read-only:bg-surface-muted" />
          <span id={`${id}-unit`} className="text-[11px] text-ink-muted">{inactive ? 'Used with bounded source units' : unit}</span>
        </div>
        {error && <p id={`${id}-error`} aria-live="polite" className="text-[11px] font-semibold text-danger">{error}</p>}
      </div>
    )
  }

  function IdentityFields({ fields, custom, error, add, remove }: {
    fields: readonly string[]; custom: boolean; error: string | null; add: (text: string) => string | null; remove: (name: string) => void
  }) {
    const id = useId()
    const [text, setText] = useState('')
    const [refusal, setRefusal] = useState<string | null>(null)
    const submit = () => {
      const refused = add(text)
      setRefusal(refused)
      if (refused === null) setText('')
    }
    return (
      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className="text-[11px] font-semibold text-ink-muted">{CONTROL_LABELS.identity_fields}</legend>
        <p id={`${id}-hint`} className="text-[10.5px] text-ink-faint">{CONTROL_HINTS.identity_fields} Conservative reconciliation is the choice that requires declared fields.</p>
        <ul aria-label="Identity fields" className="flex flex-wrap gap-1.5">
          {fields.map((name) => (
            <li key={name} className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 font-mono text-[11.5px] text-ink">
              {name}
              <button type="button" aria-label={`Remove ${name}`} disabled={!custom} className="text-ink-faint hover:text-danger" onClick={() => remove(name)}>×</button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="Identity field name" data-setting="article.identity_fields" value={text} disabled={!custom}
            aria-invalid={error ? true : undefined}
            aria-describedby={[`${id}-hint`, error ? `${id}-error` : null, refusal ? `${id}-refusal` : null].filter(Boolean).join(' ')}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }}
            className="w-48 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[12px] text-ink" />
          <button type="button" disabled={!custom} onClick={submit} className={`${textButton} text-accent hover:underline`}>Add field</button>
        </div>
        {refusal && <p id={`${id}-refusal`} aria-live="polite" className="text-[11px] text-danger">{refusal}</p>}
        {error && <p id={`${id}-error`} aria-live="polite" className="text-[11px] font-semibold text-danger">{error}</p>}
      </fieldset>
    )
  }

  const FACTORS: readonly CatalogFactor[] = ['glossary', 'headings', 'overlap', 'verification']

  function CatalogSettingsView({ draft, editor }: Pick<Props, 'draft' | 'editor'>) {
    const catalog = draft.extractionSettings.catalog
    const custom = catalog !== undefined
    const generic = { discovery_chars: CATALOG_DEFAULTS.discovery_chars, record_chars: CATALOG_DEFAULTS.record_chars, ...catalog?.generic }
    const recipe = { input_tokens: CATALOG_DEFAULTS.input_tokens, output_tokens: CATALOG_DEFAULTS.output_tokens, ...catalog?.recipe }
    const factors = { glossary: true, headings: true, overlap: true, verification: true, ...recipe.factors }
    const issueAt = (path: NumberPath) => editor.settingsIssues.find((issue) => issue.path === path)?.message ?? null
    const invalid = new Set(editor.settingsIssues.map((issue) => issueSection(issue.path)))
    const number = (path: NumberPath, key: keyof typeof CATALOG_LABELS, value: number, unit: string, hint: string) => (
      <NumberField path={path} label={CATALOG_LABELS[key]} hint={hint} unit={unit} value={value} edit={editor.numberEdits[path]}
        disabled={!custom} error={issueAt(path)} onText={editor.setNumber} />
    )
    const off = FACTORS.filter((factor) => !factors[factor]).map((factor) => CATALOG_LABELS[factor].toLowerCase())
    return (
      <>
        <p className="text-[12px] text-ink">
          {custom
            ? `Generic: ${generic.discovery_chars.toLocaleString('en-US')} / ${generic.record_chars.toLocaleString('en-US')} characters · Recipe: ${recipe.input_tokens.toLocaleString('en-US')} + ${recipe.output_tokens.toLocaleString('en-US')} tokens, ${off.length === 0 ? 'all factors on' : `off: ${off.join(', ')}`}`
            : 'Service defaults'}
        </p>
        <ul className="flex flex-col gap-2">
          <li>
            <Disclosure title="Generic Catalog" value="Applies when a Catalog Extraction uses Model discovery." changed={false} forcedOpen={invalid.has('generic')}>
              <fieldset disabled={!custom} className="flex flex-col gap-3">
                {number('catalog.generic.discovery_chars', 'discovery_chars', generic.discovery_chars, 'characters, at least 1,000', 'Source text per discovery call. A supported control, not a studied factor.')}
                {number('catalog.generic.record_chars', 'record_chars', generic.record_chars, 'characters, at least 1,000', 'Source text per record call. Not the Article whole-passage guarantee.')}
              </fieldset>
            </Disclosure>
          </li>
          <li>
            <Disclosure title="Recipe Catalog" value="Applies when a Catalog Extraction uses a numbered-catalogue recipe." changed={false} forcedOpen={invalid.has('recipe')}>
              <fieldset disabled={!custom} className="flex flex-col gap-3">
                {number('catalog.recipe.input_tokens', 'input_tokens', recipe.input_tokens, 'tokens, at least 64', 'Per-entry input budget; it must fit the served model with the output reserve.')}
                {number('catalog.recipe.output_tokens', 'output_tokens', recipe.output_tokens, 'tokens, at least 64', 'Reserved for each reply. Budgets that do not fit are refused before model calls.')}
                {FACTORS.map((factor) => (
                  <label key={factor} className="flex items-center gap-2 text-[12px] text-ink">
                    <input type="checkbox" role="switch" aria-checked={factors[factor]} checked={factors[factor]}
                      data-setting={`catalog.recipe.factors.${factor}`} onChange={(event) => editor.setCatalogFactor(factor, event.target.checked)} />
                    {CATALOG_LABELS[factor]}
                  </label>
                ))}
                {!factors.verification && <p className="text-[11px] text-ink-muted">Off keeps typed values as proposals, not accepted evidence.</p>}
                <p className="text-[10.5px] text-ink-faint">Switches never turn off structural ownership or canonical spans. Glossary off also turns off glossary normalization.</p>
              </fieldset>
            </Disclosure>
          </li>
        </ul>
      </>
    )
  }
  ```

  If `pnpm lint` flags the `ChoiceGroup` generic or the `set` helper's cast, keep the behavior and narrow the types rather than widening them to `any`.

- [ ] **Step 3: Add the tab to the page**

  In `ProviderConfigPage.tsx`: `type Tab = 'models' | 'connections' | 'advanced'`; `const TABS: readonly Tab[] = ['models', 'connections', 'advanced']`; `tabIds` gains `advanced: useId()`; the tab label becomes `key === 'models' ? 'Models' : key === 'connections' ? \`Connections · ${routable.length}\` : 'Advanced'`; `const [focusIssue, setFocusIssue] = useState(false)`; `const blocked = Object.keys(keyIssues).length > 0 || editor.settingsIssues.length > 0`; the tabpanel renders `<AdvancedTab draft={draft} saved={saved!} editor={editor} focusIssue={focusIssue} onIssueFocused={() => setFocusIssue(false)} />` when `tab === 'advanced'`. In the footer, before the Discard/Apply pair:

  ```tsx
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[11.5px] text-ink-faint">{dirty ? 'Unsaved changes' : 'Everything saved'}</span>
          {editor.settingsIssues.length > 0 && (
            <button type="button" className="text-[11.5px] font-semibold text-danger underline"
              onClick={() => { setTab('advanced'); setFocusIssue(true) }}>
              {editor.settingsIssues.length === 1 ? '1 issue blocks Apply' : `${editor.settingsIssues.length} issues block Apply`}
            </button>
          )}
        </div>
  ```
  (replacing the lone status `span`). The footer gets `flex-wrap` so the summary and buttons stack at 360 px. Nothing else in the page changes: Apply still sends the whole draft, Discard still restores the saved whole draft (Task 8 clears the number edits).

- [ ] **Step 4: Run the tests**

  Run: `cd prototypes/studio && npx vitest run src/providerConfig && cd ../.. && pnpm typecheck && pnpm lint && pnpm test`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add prototypes/studio/src/providerConfig/AdvancedTab.tsx prototypes/studio/src/providerConfig/ProviderConfigPage.tsx \
    prototypes/studio/src/providerConfig/ProviderConfigPage.test.tsx
  git commit -m "feat(studio): Advanced tab for Article and Catalog method settings in the Model Configuration draft"
  ```

---

### Task 10: Explain guide, How this works, starting points and study evidence

**Files:**
- Create: `prototypes/studio/src/providerConfig/advancedGuide.data.ts` (local explanatory content)
- Create: `prototypes/studio/src/providerConfig/AdvancedGuide.tsx` (the one Explain dialog, How this works, starting points)
- Create: `prototypes/studio/src/providerConfig/AdvancedGuide.test.tsx`
- Modify: `prototypes/studio/src/providerConfig/AdvancedTab.tsx` (Explain actions, How this works, Undo notice)
- Modify: `prototypes/studio/src/providerConfig/ProviderConfigPage.test.tsx` (U9 through the page)

**Interfaces:**
- Consumes: `ModalDialog` (`src/ui`); Task 8's `STARTING_POINTS`, `withStartingPoint`, `settingsDelta`, `matchingStartingPoint`, `ARTICLE_SECTIONS`; the draft's `replaceArticle`; Task 9's `AdvancedTab` and its `children` slot.
- Produces: `type GuideTopicId = 'scope' | 'grouping' | 'selection' | 'identity' | 'format' | 'grounding' | 'policy' | 'scheduling' | 'catalog'`; `GUIDE_TOPICS`, `EVIDENCE_SOURCES`, `SECTION_TOPIC: Record<ArticleSection | 'generic' | 'recipe', GuideTopicId>`, `FLOW_TEXT`; `GuideProvider({ article, onUseSettings, children })`, `ExplainButton({ topic, subject })`, `HowThisWorksButton()`. Explaining never touches the draft; only "Use these settings" calls `onUseSettings(article)`.

Required copy (design §5–§6, exact): section tabs "Meaning · Example · Study evidence"; "Technical details"; "How this works"; "Use these settings"; "Reference controls"; "Explore spans and schema policies"; "Text range is exact. Highlight precision depends on available geometry."; "E1 is a compact transport label, not the stored evidence ID."; "Not measured"; "Combination not studied"; each topic's takeaway exactly as in the design's §5 table (reproduced in the data below).

- [ ] **Step 1: Write the failing guide tests**

  `prototypes/studio/src/providerConfig/AdvancedGuide.test.tsx`:

  ```tsx
  // @vitest-environment jsdom
  import '@testing-library/jest-dom/vitest'
  import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
  import { afterEach, describe, expect, it, vi } from 'vitest'
  import { REFERENCE_ARTICLE } from 'extraction/extraction-method'
  import { ExplainButton, GuideProvider, HowThisWorksButton } from './AdvancedGuide'
  import { EVIDENCE_SOURCES, GUIDE_TOPICS } from './advancedGuide.data'
  import { STARTING_POINTS } from './advancedSettings'

  afterEach(cleanup)

  function renderGuide(onUseSettings = vi.fn(), article = REFERENCE_ARTICLE) {
    render(
      <GuideProvider article={article} onUseSettings={onUseSettings}>
        <ExplainButton topic="grounding" subject="Evidence" />
        <ExplainButton topic="catalog" subject="Recipe Catalog" />
        <HowThisWorksButton />
      </GuideProvider>,
    )
    return onUseSettings
  }
  const dismiss = (dialog: HTMLElement) => fireEvent(dialog, new Event('cancel', { cancelable: true }))

  describe('the Explain guide', () => {
    it('opens at the section topic with Meaning, Example and Study evidence; Escape returns focus to the trigger', async () => {
      renderGuide()
      const trigger = screen.getByRole('button', { name: 'Explain Evidence' })
      trigger.focus()
      fireEvent.click(trigger)
      const dialog = screen.getByRole('dialog', { name: 'Verification' })
      for (const anchor of ['Meaning', 'Example', 'Study evidence']) expect(within(dialog).getByRole('link', { name: anchor })).toBeInTheDocument()
      expect(within(dialog).getByText('Technical details')).toBeInTheDocument()
      expect(within(dialog).queryByRole('button', { name: 'Apply' })).toBeNull()
      dismiss(dialog)
      await waitFor(() => expect(trigger).toHaveFocus())
    })

    it('exploring the span example changes no settings and shows the exact limits', () => {
      const onUseSettings = renderGuide()
      fireEvent.click(screen.getByRole('button', { name: 'Explain Evidence' }))
      const dialog = screen.getByRole('dialog', { name: 'Verification' })
      fireEvent.click(within(dialog).getByRole('radio', { name: 'Source span E1' }))
      expect(within(dialog).getByText('Text range is exact. Highlight precision depends on available geometry.')).toBeInTheDocument()
      expect(within(dialog).getByText('E1 is a compact transport label, not the stored evidence ID.')).toBeInTheDocument()
      expect(within(dialog).getByText('Exact source location alone is not proof that the entire claim is supported. Wrong-subject 15.6 must not become support.')).toBeInTheDocument()
      expect(within(dialog).getByText(/linked a compound claim the source only partly supports/)).toBeInTheDocument()
      expect(onUseSettings).not.toHaveBeenCalled()
    })

    it('study evidence names date, corpus, revision and evidence type; unmeasured effects say so', () => {
      renderGuide()
      fireEvent.click(screen.getByRole('button', { name: 'Explain Recipe Catalog' }))
      const dialog = screen.getByRole('dialog', { name: 'Catalog' })
      expect(within(dialog).getByText('Not measured')).toBeInTheDocument()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Verification' }))
      const table = within(screen.getByRole('dialog', { name: 'Verification' })).getByRole('table', { name: 'Study evidence' })
      for (const header of ['Finding', 'Date', 'Corpus', 'Method revision', 'Evidence type', 'Limits'])
        expect(within(table).getByRole('columnheader', { name: header })).toBeInTheDocument()
      expect(within(table).getAllByText('2026-09-28').length).toBeGreaterThan(0)
    })

    it('every topic has a purpose, stage, example, figure text, combinations and a verbatim takeaway', () => {
      expect(GUIDE_TOPICS.map((topic) => topic.id)).toEqual(['scope', 'grouping', 'selection', 'identity', 'format', 'grounding', 'policy', 'scheduling', 'catalog'])
      for (const topic of GUIDE_TOPICS) {
        for (const text of [topic.purpose, topic.stage, topic.combinations, topic.takeaway, topic.technical]) expect(text.length).toBeGreaterThan(10)
        expect(topic.example.options.length).toBeGreaterThan(1)
        for (const option of topic.example.options) expect(option.outcome.length).toBeGreaterThan(10)
      }
      expect(GUIDE_TOPICS.find((topic) => topic.id === 'selection')!.takeaway)
        .toBe('Lower value-call count can omit relevant evidence. It is not grounding routing.')
      for (const source of EVIDENCE_SOURCES) for (const field of [source.date, source.corpus, source.revision, source.evidence, source.limits]) expect(field).not.toBe('')
    })

    it('makes no recommendation, speed or accuracy claim', () => {
      const text = JSON.stringify([GUIDE_TOPICS, EVIDENCE_SOURCES, STARTING_POINTS])
      expect(text).not.toMatch(/\bbest\b|\bfastest\b|\brecommended\b|more accurate|improves accuracy|\bsafer\b/i)
    })

    it('How this works shows the flow with a text equivalent and each starting point\'s full delta before it is used', () => {
      const onUseSettings = renderGuide()
      fireEvent.click(screen.getByRole('button', { name: 'How this works' }))
      const dialog = screen.getByRole('dialog', { name: 'How this works' })
      expect(within(dialog).getByRole('figure')).toHaveAccessibleName(/Canonical Source Context feeds Context and grouping/)
      const point = within(dialog).getByRole('region', { name: 'Explore spans and schema policies' })
      fireEvent.click(within(point).getByRole('button', { name: 'Show changes' }))
      expect(within(point).getByText('Source labels → Source spans', { exact: false })).toBeInTheDocument()
      fireEvent.click(within(point).getByRole('button', { name: 'Use these settings' }))
      expect(onUseSettings).toHaveBeenCalledWith(expect.objectContaining({ grounding: 'spans', evidence_policy: 'schema', context: 'bounded' }), STARTING_POINTS[1]!.name)
    })
  })
  ```

  Append to `ProviderConfigPage.test.tsx` (U9 through the page):

  ```tsx
  it('a starting point changes only the Article draft, Undo restores it, and service defaults restore the request shape', async () => {
    const server = studio(config({ extractionModels: { fields: 'nuextract' }, extractionSettings: { catalog: { generic: { record_chars: 30000 } } } }))
    await renderPage()
    openAdvanced()
    fireEvent.click(screen.getByRole('button', { name: 'How this works' }))
    const dialog = screen.getByRole('dialog', { name: 'How this works' })
    const point = within(dialog).getByRole('region', { name: 'Explore spans and schema policies' })
    fireEvent.click(within(point).getByRole('button', { name: 'Show changes' }))
    fireEvent.click(within(point).getByRole('button', { name: 'Use these settings' }))
    expect(screen.getByText('Settings from “Explore spans and schema policies” are in your draft. Apply saves them.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByText('Everything saved')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'How this works' }))
    const again = within(within(screen.getByRole('dialog', { name: 'How this works' })).getByRole('region', { name: 'Explore spans and schema policies' }))
    fireEvent.click(again.getByRole('button', { name: 'Show changes' }))
    fireEvent.click(again.getByRole('button', { name: 'Use these settings' }))
    apply()
    await waitFor(() => expect(server.puts()).toHaveLength(1))
    expect(server.puts()[0]).toMatchObject({ extractionModels: { fields: 'nuextract' }, extractionSettings: { catalog: { generic: { record_chars: 30000 } }, article: { grounding: 'spans' } } })
    expect(JSON.stringify(server.puts()[0])).not.toMatch(/preset|Explore spans/)
    fireEvent.click(screen.getByRole('button', { name: 'Use service defaults' }))
    apply()
    await waitFor(() => expect(server.puts()).toHaveLength(2))
    expect(server.puts()[1]!.extractionSettings).toEqual({ catalog: { generic: { record_chars: 30000 } } })
  })
  ```

  Run: `cd prototypes/studio && npx vitest run src/providerConfig/AdvancedGuide.test.tsx` — Expected: FAIL (modules missing).

- [ ] **Step 2: Write the guide content**

  `prototypes/studio/src/providerConfig/advancedGuide.data.ts`:

  ```ts
  import type { ArticleSection } from './advancedSettings'

  /** The Explain guide's content: illustrations and dated study findings, never a recommendation. Ordinary local data. */

  export type GuideTopicId = 'scope' | 'grouping' | 'selection' | 'identity' | 'format' | 'grounding' | 'policy' | 'scheduling' | 'catalog'
  /** One labelled block of an illustration; `note` is its state in words (never colour alone); `mark` highlights an
   *  exact code-point range of `text`. */
  export type FigureBlock = Readonly<{ label: string; text: string; note?: string; mark?: readonly [number, number] }>
  export type ExampleOption = Readonly<{ label: string; blocks: readonly FigureBlock[]; outcome: string }>
  export type EvidenceSourceId = 'r1r3r4' | 'r2a' | 'pilot' | 'audit' | 'harvey' | 'labels' | 'overflow'
  export type GuideTopic = Readonly<{
    id: GuideTopicId
    title: string
    purpose: string
    stage: string
    example: Readonly<{ caption: string; options: readonly ExampleOption[]; notes?: readonly string[] }>
    combinations: string
    takeaway: string
    evidence: readonly Readonly<{ source: EvidenceSourceId; finding: string }>[]
    technical: string
  }>

  export const SECTION_TOPIC: Readonly<Record<ArticleSection | 'generic' | 'recipe', GuideTopicId>> = {
    context: 'scope', identity: 'identity', input: 'format', evidence: 'grounding', generic: 'catalog', recipe: 'catalog',
  }

  export const EVIDENCE_SOURCES: readonly Readonly<{
    id: EvidenceSourceId; title: string; date: string; corpus: string; revision: string; evidence: string; limits: string; path: string
  }>[] = [
    { id: 'r1r3r4', title: 'Completed R1/R3/R4 development cells', date: '2026-09-28',
      corpus: 'Six development documents; R1 79/79, R3 12/12 and R4 4/12 cells',
      revision: 'Frozen historical runtimes, schemas and canonical parses (R1 v11)',
      evidence: 'Exact replay of completed fresh-generation cells',
      limits: 'Development corpus; pending review stays in the denominator; not a prediction for today’s runtime',
      path: 'docs/validation/2026-09-28-completed-development-study.md' },
    { id: 'r2a', title: 'Value-unit selection (R2a)', date: '2026-09-28',
      corpus: '30 conditional-replay cells on the registered development documents',
      revision: 'Registered R2a selection replay', evidence: 'Conditional fixed-reply replay, grounding disabled',
      limits: 'Fixed-reply savings do not establish fresh-model speed or evidence recall',
      path: 'docs/validation/2026-09-28-extraction-selection-results.md' },
    { id: 'pilot', title: 'Grounding pilot', date: '2026-09-28',
      corpus: 'One selected development document; six cells of the registered R5 matrix',
      revision: 'Registered R5 grounding settings with the original span labels', evidence: 'Fresh generation, exactly replayed',
      limits: 'One document; linked-claim counts are not semantic accuracy; identical requests varied',
      path: 'docs/validation/2026-09-28-grounding-pilot.md' },
    { id: 'audit', title: 'Grounding pilot audit', date: '2026-09-28',
      corpus: '101 saved pilot requests and 35 separately authorized fresh calls',
      revision: 'The pilot’s captured requests', evidence: 'Capture recheck and independent model review',
      limits: 'Reviewers disagreed on attribution; no semantic gold standard',
      path: 'docs/validation/2026-09-28-grounding-pilot-audit.md' },
    { id: 'harvey', title: 'Harvey grounding micro-pilot', date: '2026-09-28',
      corpus: 'One previously inspected document; 12 cells, 16 selected decisions',
      revision: 'Frozen span-label versions 1 and 2, before the #145/#146 integration', evidence: 'Fresh generation, exactly replayed',
      limits: 'A development diagnostic, not full-document accuracy or generalization',
      path: 'docs/validation/2026-09-28-harvey-grounding-micro.md' },
    { id: 'labels', title: 'Compact span labels', date: '2026-09-28',
      corpus: 'Saved span-grounding requests', revision: 'Compact span labels, version 2 (684723f7)',
      evidence: 'Tokenizer-only admission check and offline replay', limits: 'Not a semantic-quality evaluation',
      path: 'docs/validation/2026-09-28-compact-span-labels.md' },
    { id: 'overflow', title: 'Singleton overflows', date: '2026-09-28',
      corpus: '15 pinned requests across eight catalogues (unannotated examples)', revision: 'Compact span labels, version 2 (PR #146)',
      evidence: 'Tokenizer-only diagnosis', limits: 'Examples, not evaluation gold',
      path: 'docs/validation/2026-09-28-grounding-singleton-overflows.md' },
  ]

  const unit = (label: string, text: string, note?: string): FigureBlock => ({ label, text, ...(note ? { note } : {}) })

  export const GUIDE_TOPICS: readonly GuideTopic[] = [
    {
      id: 'scope', title: 'Full source or bounded source units',
      purpose: 'Choose whether each model call reads the whole Source Document or bounded units that fit a token ceiling.',
      stage: 'Source context for inventory, record values and verification.',
      example: {
        caption: 'Six labelled blocks, one table and one heading.',
        options: [
          { label: 'Full source', blocks: [unit('Unit 1', 'H1 heading · P1 · P2 · T1 table · P3 · P4 · P5', 'owns every block')],
            outcome: 'One unit holds every block; the served model’s context size is the limit.' },
          { label: 'Bounded source units', blocks: [
              unit('Unit 1', 'H1 heading · P1 · P2', 'owns these blocks'),
              unit('Unit 2', 'P2 · T1 table · P3', 'P2 repeated as context; owns T1 whole and P3'),
              unit('Unit 3', 'P4 · P5', 'owns these blocks'),
              unit('Refused', 'An intact block larger than the ceiling', 'refused, never cut'),
            ],
            outcome: 'Each block has one owning unit. A repeated previous passage is context, not a new record. The whole table stays in one unit.' },
        ],
        notes: ['The diagram is illustrative, not live tokenizer output.'],
      },
      combinations: 'Previous passages, supported units and structure-aware grouping need bounded source units. Every verification method works with either scope.',
      takeaway: 'Whole tables stay intact; repeated context is not a new record; a too-large block is refused. Diagram is illustrative, not live tokenizer output.',
      evidence: [
        { source: 'r1r3r4', finding: 'Bounded context changed mean accuracy by −33.35 percentage points [−49.06, −16.40] against the full-source schema arm.' },
        { source: 'r1r3r4', finding: 'One preceding passage on bounded context: +3.55 [−3.79, +14.42].' },
        { source: 'overflow', finding: 'Short span labels do not make every source unit fit: single-claim requests still exceeded a 10,240-token input allowance.' },
      ],
      technical: '`context=full|bounded`; `context_tokens` (bounded only, at least 8,192); `overlap_passages` 0–2. Explicit Article runs record `method_version`.',
    },
    {
      id: 'grouping', title: 'Grouping',
      purpose: 'Choose how bounded units are formed: by token budget alone, or following headings, captions and tables.',
      stage: 'Bounded source units.',
      example: {
        caption: 'Heading → paragraph and caption → table → footnote.',
        options: [
          { label: 'Token budget', blocks: [unit('Unit 1', 'Heading · Paragraph · Caption'), unit('Unit 2', 'Table · Footnote')],
            outcome: 'Units fill up to the budget in source order; a caption can land apart from its table.' },
          { label: 'Structure-aware', blocks: [unit('Unit 1', 'Heading · Paragraph'), unit('Unit 2', 'Heading · Caption · Table · Footnote', 'heading repeated as context')],
            outcome: 'The caption, its table and its footnote stay together under their heading; the extra context can mean more refusals and cost.' },
        ],
      },
      combinations: 'Structure-aware grouping needs bounded source units.',
      takeaway: 'Structure adds context and can increase refusal/cost; it does not reconstruct missing tables or infer arbitrary heading hierarchies.',
      evidence: [{ source: 'r1r3r4', finding: 'Not measured: only 4 of 12 R4 cells completed, all of them controls.' }],
      technical: '`grouping=structural`; token budget is the omitted default. Runs record `grouping_version`.',
    },
    {
      id: 'selection', title: 'Value evidence',
      purpose: 'Choose whether record-value calls read every source unit or only the units that support the record.',
      stage: 'Record values; not inventory, document fields or verification.',
      example: {
        caption: 'One identity supported in units 1 and 4.',
        options: [
          { label: 'All source units', blocks: [unit('Unit 1', 'read for values'), unit('Unit 2', 'read for values'), unit('Unit 3', 'read for values'), unit('Unit 4', 'read for values')],
            outcome: 'Every unit is read for the record’s values.' },
          { label: 'Supported units', blocks: [unit('Unit 1', 'read for values'), unit('Unit 2', 'not read for values', 'omitted'), unit('Unit 3', 'not read for values', 'omitted'), unit('Unit 4', 'read for values')],
            outcome: 'Fewer value calls; a relevant value in unit 2 or 3 would not be read. Inventory and verification still visit all four units.' },
        ],
      },
      combinations: 'Supported units need bounded source units. Selection removes value inputs; unit order (routing) only orders verification.',
      takeaway: 'Lower value-call count can omit relevant evidence. It is not grounding routing.',
      evidence: [{ source: 'r2a', finding: '30 conditional-replay cells: fewer value calls with fixed replies; fresh-model speed and evidence recall were not measured.' }],
      technical: '`selection=supported`; all units is the omitted default. Runs record `selection_version` and their selections.',
    },
    {
      id: 'identity', title: 'Record identity',
      purpose: 'Choose how records found in different places are merged.',
      stage: 'Inventory and identity.',
      example: {
        caption: 'Two records share a species but differ by preparation.',
        options: [
          { label: 'Reference', blocks: [unit('Found', 'Mus musculus · skull'), unit('Found', 'Mus musculus · skin')],
            outcome: 'The model’s own identity may merge both into one record.' },
          { label: 'Declared: species and preparation', blocks: [unit('Record 1', 'Mus musculus · skull'), unit('Record 2', 'Mus musculus · skin')],
            outcome: 'Two records: species and preparation together tell them apart.' },
          { label: 'Declared: species', blocks: [unit('Record 1', 'Mus musculus · skull + skin', 'merged')],
            outcome: 'One record: a key that is too broad merges them.' },
        ],
      },
      combinations: 'Declared identity fields need at least one top-level scalar record field; they are checked against the schema when an Extraction starts. Reference identity may also carry fields.',
      takeaway: 'Too broad a key can merge records; missing declared keys can leave duplicates.',
      evidence: [{ source: 'r1r3r4', finding: 'Conservative identity changed mean accuracy by −0.18 [−0.53, 0.00].' }],
      technical: '`identity=reference|conservative`; `identity_fields` are exact, case-sensitive field names.',
    },
    {
      id: 'format', title: 'Extraction input',
      purpose: 'Choose the instructions and how source text is presented to the model.',
      stage: 'Model input for record values and verification.',
      example: {
        caption: 'The same small 2×2 table.',
        options: [
          { label: 'Plain text', blocks: [unit('Input', 'Site Year / Hill 1827')],
            outcome: 'The parsed characters as they are.' },
          { label: 'Structured blocks and tables', blocks: [unit('Input', '[T1] r1c1 Site | r1c2 Year ; r2c1 Hill | r2c2 1827', 'labelled cells with row and column')],
            outcome: 'The same characters, plus labels that consume tokens.' },
        ],
      },
      combinations: 'Both instruction sets and both representations work with every other choice. Reference instructions include historical laboratory examples.',
      takeaway: 'Exact input text is preserved; added markup consumes tokens.',
      evidence: [
        { source: 'r1r3r4', finding: 'Structured rendering changed mean accuracy by −24.12 [−49.79, −3.93].' },
        { source: 'r1r3r4', finding: 'Schema-driven instructions changed mean accuracy by −0.76 [−2.27, 0.00].' },
      ],
      technical: '`prompt=reference|schema`; `rendering=structured` (plain text is omitted). Runs record `rendering_version`.',
    },
    {
      id: 'grounding', title: 'Verification',
      purpose: 'Choose how each populated record value is checked against the source.',
      stage: 'Evidence verification.',
      example: {
        caption: 'Source: “ASC: 18.6 °C. PSC: 15.6 °C.” Claim: ASC temperature = 18.6.',
        options: [
          { label: 'Source labels', blocks: [unit('Passage p1_s0', 'ASC: 18.6 °C. PSC: 15.6 °C.', 'linked as a whole')],
            outcome: 'The model picks the labelled passage that supports the claim; the passage is linked, not an exact range.' },
          { label: 'Generated quotes', blocks: [unit('Quote', 'ASC: 18.6 °C', 'must occur in the source and be attributed to ASC')],
            outcome: 'The quote must occur verbatim; an invented sentence or a quote about PSC is refused.' },
          { label: 'Source span E1', blocks: [{ label: 'Span E1 in p1_s0', text: 'ASC: 18.6 °C. PSC: 15.6 °C.', mark: [0, 12], note: 'exact range 0–12' }],
            outcome: 'The model chooses offered span E1; that exact range is linked. The exact range does not prove every part of a claim.' },
          { label: 'Off', blocks: [unit('Claim', 'ASC temperature = 18.6', 'not verified')],
            outcome: 'No verification: the value stays visibly ungrounded.' },
        ],
        notes: [
          'Text range is exact. Highlight precision depends on available geometry.',
          'E1 is a compact transport label, not the stored evidence ID.',
          '15.6 belongs to PSC: a wrong-subject match is never support.',
        ],
      },
      combinations: 'Schema policies need generated quotes or source spans. Until first support needs a verification method. Origin and lexical order needs quotes or spans and until first support.',
      takeaway: 'Exact source location alone is not proof that the entire claim is supported. Wrong-subject 15.6 must not become support.',
      evidence: [
        { source: 'pilot', finding: 'Source spans with schema policies and until-first-support used 10 versus 40 calls and 89,770 versus 222,156 input tokens compared with generated quotes, on one selected document.' },
        { source: 'audit', finding: 'Identical requests returned different decisions in 4 of 20 groups; reviewers disagreed on attribution.' },
        { source: 'harvey', finding: 'Compact span labels admitted all 16 selected decisions that the original labels refused, but used 80,806 versus 34,910 input tokens; both methods linked a compound claim the source only partly supports.' },
        { source: 'r1r3r4', finding: 'Quoted verification on bounded context: −1.52 [−4.55, 0.00]; its upstream records also changed, so this is no verifier-quality estimate.' },
        { source: 'labels', finding: 'The span protocol version is recorded with each run; it is not a setting.' },
      ],
      technical: '`grounding=semantic|quoted|spans|off`. Span runs record `span_grounding_version`.',
    },
    {
      id: 'policy', title: 'Fields to verify',
      purpose: 'Choose whether verification follows the pinned schema’s evidence policies.',
      stage: 'Which record values verification considers.',
      example: {
        caption: 'Parent notes is derived; its child temperature is quoted; its child method inherits derived.',
        options: [
          { label: 'All populated record fields', blocks: [unit('notes › temperature', 'checked'), unit('notes › method', 'checked')],
            outcome: 'Every populated record value is checked.' },
          { label: 'Follow schema policies', blocks: [unit('notes › temperature', 'checked', 'quoted: eligible'), unit('notes › method', 'kept, not checked', 'derived (inherited): skipped')],
            outcome: 'Only quoted values are checked; skipped values stay visibly ungrounded with their policy. Results count all and eligible values separately.' },
        ],
      },
      combinations: 'Needs generated quotes or source spans. Policies belong to the Extraction Schema; this choice never edits them.',
      takeaway: '“Quoted” means source support required, including with span grounding; derived does not compute/validate a value; skipped leaves remain ungrounded.',
      evidence: [{ source: 'pilot', finding: 'Not measured separately: studied only together with source spans and until-first-support on one selected document.' }],
      technical: '`evidence_policy=schema`. Results list each skipped path with its policy; no eligible value reads as not applicable.',
    },
    {
      id: 'scheduling', title: 'Continue verification and unit order',
      purpose: 'Choose whether a value keeps being checked after its first support, and which units are tried first.',
      stage: 'Order and extent of evidence verification.',
      example: {
        caption: 'One claim against three units: NONE in unit 1, support in unit 2.',
        options: [
          { label: 'Across all source units', blocks: [unit('Unit 1', 'NONE'), unit('Unit 2', 'support'), unit('Unit 3', 'still checked')],
            outcome: 'Every unit is checked, also after support.' },
          { label: 'Until first support', blocks: [unit('Unit 1', 'NONE', 'search continues'), unit('Unit 2', 'support', 'stops here'), unit('Unit 3', 'not checked')],
            outcome: 'NONE in unit 1 does not stop the search; support in unit 2 does.' },
          { label: 'Until first support, origin and lexical order', blocks: [unit('Unit 2', 'support', 'tried first, stops here'), unit('Unit 1', 'not checked'), unit('Unit 3', 'not checked')],
            outcome: 'Preferred units are tried first; unresolved values still reach every eligible unit.' },
        ],
      },
      combinations: 'Until first support needs a verification method. Origin and lexical order needs generated quotes or source spans and until first support.',
      takeaway: 'NONE/failure does not stop later search; routing orders work, selection removes value inputs; first support does not settle contradictions.',
      evidence: [
        { source: 'pilot', finding: 'Until-first-support was studied only together with source spans and schema policies on one selected document.' },
        { source: 'pilot', finding: 'The routed run used one extra call and kept two fewer links than the unrouted combined run; identical requests also varied.' },
      ],
      technical: '`grounding_schedule=unresolved`; `grounding_routing=origin_lexical`. Routed runs record `grounding_routing_version`.',
    },
    {
      id: 'catalog', title: 'Catalog',
      purpose: 'Generic Catalog limits apply to Model discovery; recipe budgets and factors apply to numbered-catalogue recipes.',
      stage: 'Catalog discovery and per-entry extraction.',
      example: {
        caption: 'Heading “Grav 7”, an abbreviated material and a neighbouring line.',
        options: [
          { label: 'All factors on', blocks: [unit('Entry', 'Grav 7 · Kn. · next line')],
            outcome: 'The glossary expansion sits beside the raw value, the heading is inherited, the neighbouring line is context, and values are verified.' },
          { label: 'Glossary off', blocks: [unit('Entry', 'Kn.', 'raw value only')], outcome: 'The abbreviation stays raw; glossary normalization is off too.' },
          { label: 'Inherited headings off', blocks: [unit('Entry', 'Kn.', 'no heading binding')], outcome: '“Grav 7” is not bound to the entry.' },
          { label: 'Neighbouring context off', blocks: [unit('Entry', 'Grav 7 · Kn.', 'no neighbouring line')], outcome: 'The neighbouring line is not shown.' },
          { label: 'Verification off', blocks: [unit('Entry', 'Kn.', 'proposal')], outcome: 'Typed values are kept as proposals, not accepted evidence.' },
        ],
      },
      combinations: 'Factor switches never turn off structural ownership or canonical spans. A recipe is chosen per Extraction.',
      takeaway: 'Verification Off yields proposals; a recipe’s applicability is source-specific.',
      evidence: [],
      technical: '`discovery_chars`, `record_chars` (generic); `catalog.input_tokens`, `catalog.output_tokens`, `catalog.factors.{glossary,headings,overlap,verification}` (recipe).',
    },
  ]

  /** How this works: the text equivalent of the one flow diagram (design §5). */
  export const FLOW_TEXT =
    'Canonical Source Context feeds Context and grouping. Context and grouping feeds Inventory and identity, Record values and Evidence verification. Inventory and identity feeds Record values. Record values feeds Evidence verification. Schema policies feed Evidence verification. Evidence verification feeds Extraction Result and review.'
  export const FLOW_NOTE =
    'Rendering and the prompt affect model input, selection affects record-value contexts, and scheduling and routing affect verification. The diagram is conceptual: filename and document fields and recipe Catalog have their own paths and are not Article stages.'
  ```

  The design's takeaway for Catalog reads "Verification Off yields proposals; a recipe's applicability is source-specific." — keep that exact text (the `’` above is a typographic apostrophe; use the design's plain `'` instead if the review prefers byte equality with the design).

- [ ] **Step 3: Write the guide component**

  `prototypes/studio/src/providerConfig/AdvancedGuide.tsx`:

  ```tsx
  import { createContext, type ReactNode, type RefObject, useContext, useId, useRef, useState } from 'react'
  import { ARTICLE_KEYS, REFERENCE_ARTICLE, type ArticleSettings } from 'extraction/extraction-method'
  import { ModalDialog } from '../ui'
  import {
    EVIDENCE_SOURCES, FLOW_NOTE, FLOW_TEXT, GUIDE_TOPICS, type FigureBlock, type GuideTopic, type GuideTopicId,
  } from './advancedGuide.data'
  import { settingsDelta, STARTING_POINTS, withStartingPoint, type StartingPoint } from './advancedSettings'

  type Opened = Readonly<{ topic: GuideTopicId | 'overview'; trigger: RefObject<HTMLButtonElement | null> }>
  const GuideContext = createContext<((opened: Opened) => void) | null>(null)

  /** The one Explain dialog for the Advanced tab. It holds no configuration: examples are local, and only "Use these
   *  settings" hands an Article draft to `onUseSettings` (the page's draft owner). */
  export function GuideProvider({ article, onUseSettings, children }: {
    article: ArticleSettings | undefined
    onUseSettings: (article: ArticleSettings, name: string) => void
    children: ReactNode
  }) {
    const [opened, setOpened] = useState<Opened | null>(null)
    return (
      <GuideContext value={setOpened}>
        {children}
        {opened && (
          <GuideDialog opened={opened} article={article} onTopic={(topic) => setOpened({ ...opened, topic })}
            onClose={() => setOpened(null)}
            onUse={(point) => { onUseSettings(withStartingPoint(article, point), point.name); setOpened(null) }} />
        )}
      </GuideContext>
    )
  }

  export function ExplainButton({ topic, subject }: { topic: GuideTopicId; subject: string }) {
    const open = useContext(GuideContext)!
    const trigger = useRef<HTMLButtonElement>(null)
    return (
      <button ref={trigger} type="button" aria-label={`Explain ${subject}`} onClick={() => open({ topic, trigger })}
        className="text-[11.5px] font-semibold text-accent hover:underline">Explain</button>
    )
  }

  export function HowThisWorksButton() {
    const open = useContext(GuideContext)!
    const trigger = useRef<HTMLButtonElement>(null)
    return (
      <button ref={trigger} type="button" onClick={() => open({ topic: 'overview', trigger })}
        className="text-[11.5px] font-semibold text-accent hover:underline">How this works</button>
    )
  }

  function GuideDialog({ opened, article, onTopic, onClose, onUse }: {
    opened: Opened; article: ArticleSettings | undefined; onTopic: (topic: GuideTopicId | 'overview') => void
    onClose: () => void; onUse: (point: StartingPoint) => void
  }) {
    const titleId = useId()
    const close = useRef<HTMLButtonElement>(null)
    const topic = GUIDE_TOPICS.find((item) => item.id === opened.topic)
    return (
      <ModalDialog labelledBy={titleId} initialFocusRef={close} returnFocusRef={opened.trigger} onDismiss={onClose}
        className="m-0 h-full max-h-none w-full max-w-none overflow-y-auto bg-surface p-4 text-ink backdrop:bg-ink/35 sm:m-auto sm:h-auto sm:max-h-[85vh] sm:w-[42rem] sm:max-w-[92vw] sm:rounded-xl sm:border sm:border-line">
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-[14px] font-bold">{topic ? topic.title : 'How this works'}</h2>
          <button ref={close} type="button" onClick={onClose} className="text-[11.5px] font-semibold text-ink-muted hover:text-ink">Close</button>
        </div>
        <nav aria-label="Topics" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
          <button type="button" aria-current={opened.topic === 'overview' ? 'page' : undefined} onClick={() => onTopic('overview')}>How this works</button>
          {GUIDE_TOPICS.map((item) => (
            <button key={item.id} type="button" aria-current={opened.topic === item.id ? 'page' : undefined} onClick={() => onTopic(item.id)}>{item.title}</button>
          ))}
        </nav>
        {topic ? <TopicBody key={topic.id} topic={topic} /> : <Overview article={article} onUse={onUse} />}
      </ModalDialog>
    )
  }

  function TopicBody({ topic }: { topic: GuideTopic }) {
    const id = useId()
    const [choice, setChoice] = useState(0)
    const option = topic.example.options[choice]!
    return (
      <div className="mt-3 flex flex-col gap-3 text-[12px]">
        <nav aria-label="On this topic" className="text-[11.5px]">
          <a href={`#${id}-meaning`}>Meaning</a> · <a href={`#${id}-example`}>Example</a> · <a href={`#${id}-evidence`}>Study evidence</a>
        </nav>
        <section id={`${id}-meaning`} aria-label="Meaning">
          <p>{topic.purpose}</p>
          <p className="text-ink-muted">Stage: {topic.stage}</p>
          <p className="text-ink-muted">{topic.combinations}</p>
        </section>
        <section id={`${id}-example`} aria-label="Example" className="flex flex-col gap-2">
          <p className="font-semibold">{topic.example.caption}</p>
          <fieldset className="flex flex-wrap gap-x-3 gap-y-1">
            <legend className="sr-only">Example</legend>
            {topic.example.options.map((item, index) => (
              <label key={item.label} className="flex items-center gap-1.5">
                <input type="radio" name={`${id}-example`} checked={choice === index} onChange={() => setChoice(index)} />
                {item.label}
              </label>
            ))}
          </fieldset>
          <Figure blocks={option.blocks} caption={option.outcome} />
          {topic.example.notes?.map((note) => <p key={note} className="text-[11px] text-ink-muted">{note}</p>)}
          <p className="font-semibold">{topic.takeaway}</p>
        </section>
        <section id={`${id}-evidence`} aria-label="Study evidence">
          {topic.evidence.length === 0 ? <p className="font-semibold">Not measured</p> : <EvidenceTable rows={topic.evidence} />}
        </section>
        <details>
          <summary className="cursor-pointer font-semibold">Technical details</summary>
          <p className="mt-1 font-mono text-[11px] text-ink-muted">{topic.technical}</p>
        </details>
      </div>
    )
  }

  /** An illustration and its equivalent text: each block's label, text and state in words. */
  function Figure({ blocks, caption }: { blocks: readonly FigureBlock[]; caption: string }) {
    const text = blocks.map((block) => `${block.label}: ${block.text}${block.note ? ` (${block.note})` : ''}`).join('; ')
    return (
      <figure aria-label={`${text}. ${caption}`} className="flex flex-col gap-1.5">
        <ol className="flex flex-wrap gap-2">
          {blocks.map((block, index) => (
            <li key={index} className="rounded-md border border-line bg-surface-muted px-2 py-1">
              <span className="block text-[10.5px] font-semibold text-ink-muted">{block.label}</span>
              <Marked text={block.text} mark={block.mark} />
              {block.note && <span className="block text-[10.5px] text-ink-faint">{block.note}</span>}
            </li>
          ))}
        </ol>
        <figcaption>{caption}</figcaption>
      </figure>
    )
  }

  /** `mark` is a code-point range, like span Evidence's offsets. */
  function Marked({ text, mark }: { text: string; mark?: readonly [number, number] }) {
    if (!mark) return <span>{text}</span>
    const points = Array.from(text)
    return <span>{points.slice(0, mark[0]).join('')}<mark>{points.slice(mark[0], mark[1]).join('')}</mark>{points.slice(mark[1]).join('')}</span>
  }

  function EvidenceTable({ rows }: { rows: GuideTopic['evidence'] }) {
    return (
      <div className="overflow-x-auto">
        <table aria-label="Study evidence" className="w-full text-left text-[11px]">
          <thead><tr>{['Finding', 'Date', 'Corpus', 'Method revision', 'Evidence type', 'Limits'].map((header) => <th key={header} scope="col">{header}</th>)}</tr></thead>
          <tbody>
            {rows.map((row) => {
              const source = EVIDENCE_SOURCES.find((item) => item.id === row.source)!
              return (
                <tr key={row.finding}>
                  <td>{row.finding} <span className="text-ink-faint">({source.title}; {source.path})</span></td>
                  <td>{source.date}</td><td>{source.corpus}</td><td>{source.revision}</td><td>{source.evidence}</td><td>{source.limits}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  const FLOW: readonly string[] = ['Canonical Source Context', 'Context and grouping', 'Inventory and identity', 'Record values', 'Schema policies', 'Evidence verification', 'Extraction Result and review']

  function Overview({ article, onUse }: { article: ArticleSettings | undefined; onUse: (point: StartingPoint) => void }) {
    // Choices away from the reference; two or more together were never evaluated as one combination.
    const factors = article
      ? ARTICLE_KEYS.filter((key) => key !== 'context_tokens' && key !== 'identity_fields' &&
          (article[key] ?? undefined) !== (REFERENCE_ARTICLE[key] ?? undefined)).length
      : 0
    return (
      <div className="mt-3 flex flex-col gap-3 text-[12px]">
        <figure aria-label={FLOW_TEXT}>
          <ol className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {FLOW.map((stage) => <li key={stage} className="rounded-md border border-line px-2 py-1">{stage}</li>)}
          </ol>
          <figcaption className="mt-1 text-ink-muted">{FLOW_TEXT}</figcaption>
        </figure>
        <p className="text-ink-muted">{FLOW_NOTE}</p>
        {factors >= 2 && <p className="font-semibold">Combination not studied: no study evaluated your current settings together; each finding describes its own conditions.</p>}
        {STARTING_POINTS.map((point) => <StartingPointCard key={point.name} point={point} article={article} onUse={onUse} />)}
        <p className="text-ink-muted">Normal customization reaches every supported setting without these examples.</p>
      </div>
    )
  }

  function StartingPointCard({ point, article, onUse }: { point: StartingPoint; article: ArticleSettings | undefined; onUse: (point: StartingPoint) => void }) {
    const titleId = useId()
    const [shown, setShown] = useState(false)
    const delta = settingsDelta(article, withStartingPoint(article, point))
    return (
      <section aria-labelledby={titleId} className="rounded-xl border border-line p-3">
        <h3 id={titleId} className="text-[12.5px] font-semibold">{point.name}</h3>
        <p className="text-ink-muted">{point.description}</p>
        <button type="button" aria-expanded={shown} onClick={() => setShown(!shown)} className="text-[11.5px] font-semibold text-accent hover:underline">Show changes</button>
        {shown && (delta.length === 0
          ? <p>Your Article draft already uses these settings.</p>
          : <ul className="mt-1 list-disc pl-5">{delta.map((change) => <li key={change.label}>{change.label}: {change.from} → {change.to}</li>)}</ul>)}
        <button type="button" disabled={!shown} onClick={() => onUse(point)} className="mt-2 rounded-md border border-line px-2.5 py-1 text-[11.5px] font-semibold">Use these settings</button>
      </section>
    )
  }
  ```

  "Use these settings" stays disabled until the delta has been shown (design §6: the complete delta is shown before the example is applied). In the component test above, click "Show changes" before "Use these settings"; update the page test's second use to click "Show changes" first as well.

- [ ] **Step 4: Put the guide on the Advanced tab**

  In `AdvancedTab.tsx`: wrap the tab's content in `<GuideProvider article={draft.extractionSettings.article} onUseSettings={useStartingPoint}>`, pass `<HowThisWorksButton />` as the heading row's action (the `children` slot), and put `<div className="flex justify-end"><ExplainButton topic={SECTION_TOPIC[section]} subject={title} /></div>` as the first child of each Article `Disclosure` and of both Catalog disclosures (`subject` "Generic Catalog" / "Recipe Catalog"). `AdvancedEditor` gains `replaceArticle`. Add the notice:

  ```tsx
    const [applied, setApplied] = useState<{ name: string; prior: ArticleSettings | undefined } | null>(null)
    const useStartingPoint = (article: ArticleSettings, name: string) => {
      setApplied({ name, prior: draft.extractionSettings.article })
      editor.replaceArticle(article)
      setStrategy('article')
    }
    // …below the "Settings for" caption; a Discard or an Apply makes the draft the saved document again, which hides it:
    {applied && draft !== saved && (
      <p role="status" className="flex flex-wrap items-baseline gap-2 text-[11.5px] text-ink">
        {`Settings from “${applied.name}” are in your draft. Apply saves them.`}
        <button type="button" className="font-semibold text-accent hover:underline"
          onClick={() => { editor.replaceArticle(applied.prior); setApplied(null) }}>Undo</button>
      </p>
    )}
  ```
  (`initialize` sets `draft` and `saved` to the same object after both Discard and a successful Apply, so the notice disappears without an effect; the next "Use these settings" replaces `applied`.)

- [ ] **Step 5: Run the tests**

  Run: `cd prototypes/studio && npx vitest run src/providerConfig && cd ../.. && pnpm typecheck && pnpm lint && pnpm test`
  Expected: PASS. Then read every string in `advancedGuide.data.ts` against design §5 and the cited reports once more (E4 content review): no finding may be phrased as a prediction, a recommendation or a generalized saving.

- [ ] **Step 6: Commit**

  ```bash
  git add prototypes/studio/src/providerConfig/advancedGuide.data.ts prototypes/studio/src/providerConfig/AdvancedGuide.tsx \
    prototypes/studio/src/providerConfig/AdvancedGuide.test.tsx prototypes/studio/src/providerConfig/AdvancedTab.tsx \
    prototypes/studio/src/providerConfig/ProviderConfigPage.test.tsx
  git commit -m "feat(studio): Explain guide with worked examples, dated study evidence and transparent starting points"
  ```

---

### Task 11: Start views show the saved method and refresh a stale one

**Files:**
- Create: `prototypes/studio/src/methodSummary.ts`, `prototypes/studio/src/methodSummary.test.ts`
- Create: `prototypes/studio/src/SavedMethodSummary.tsx`, `prototypes/studio/src/SavedMethodSummary.test.tsx`
- Modify: `prototypes/studio/src/providerConfig/advancedSettings.ts` (export `describeArticleValue`, the `shownValue` of Task 8 under a public name)
- Modify: `prototypes/studio/src/useExtraction.ts` (`onMethodChanged`), `src/useExtraction.test.tsx`
- Modify: `prototypes/studio/src/App.tsx`, `src/App.test.tsx`
- Modify: `prototypes/studio/src/projectContexts/batchExtractions.ts` (`BatchRequestError` with `status` and `code`), `BatchExtractionsPanel.tsx`, `batchSchemaSuggestionMachine.ts` (keep the refusal code), `useBatchSchemaSuggestion.ts`, and their tests

**Interfaces:**
- Consumes: `useSavedMethod`, `savedMethodFor`, `SavedMethodState` (Task 4); `effectiveSummary`, `CONTROL_LABELS`, `CATALOG_LABELS`, `ARTICLE_SECTIONS` (Task 8); HTTP 409 `method_changed` (Tasks 4–5).
- Produces:
  - `methodSummary.ts`: `type MethodLine = Readonly<{ label: string; value: string }>`, `settingsHeadline(settings: ActiveSettings | null): string` ('Not recorded' for null, 'Service defaults' for a null member), `methodLines(settings: ActiveSettings | null): readonly MethodLine[]`, `modelsLine(models: ExtractionModelChoice | null): string`. Task 12 reuses all three.
  - `SavedMethodSummary({ saved, method, conflict, onRefresh, variant })` with `variant: 'toolbar' | 'panel'`.
  - `useExtraction` option `onMethodChanged?: (message: string) => void` — a 409 `method_changed` starts nothing, keeps the previous attempt on screen, and is not a toast.
  - `BatchRequestError(status: number, code: string | null, message: string)` thrown by `batchExtractions.ts` `read` for non-suggestion routes; the suggestion machine keeps `runFailureCode: string | null` beside its message.

Copy (plan-chosen, flagged for review): "Saved advanced settings" (design); "Loading saved advanced settings…"; "Saved advanced settings could not be read. Nothing can start until they load."; "Retry"; "Refresh summary"; "Change them on the Model Configuration page’s Advanced tab."; the conflict text is the server's `METHOD_CHANGED_MESSAGE`: "Your saved advanced settings changed after this summary was shown. Nothing was started; review the updated summary and start again."

- [ ] **Step 1: Write the failing tests**

  `prototypes/studio/src/methodSummary.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest'
  import { REFERENCE_ARTICLE, REFERENCE_CATALOG } from 'extraction/extraction-method'
  import { methodLines, modelsLine, settingsHeadline } from './methodSummary'

  describe('method summaries', () => {
    it('say what was requested, service defaults, or that nothing was recorded', () => {
      expect(settingsHeadline(null)).toBe('Not recorded')
      expect(settingsHeadline({ article: null })).toBe('Service defaults')
      expect(settingsHeadline({ generic: null })).toBe('Service defaults')
      expect(settingsHeadline({ article: { ...REFERENCE_ARTICLE, context: 'bounded', grounding: 'spans' } }))
        .toBe('Bounded source units (12,288 tokens) · Plain text · Source-span verification')
      expect(settingsHeadline({ recipe: REFERENCE_CATALOG.recipe! })).toBe('Input budget 4,096 tokens · Output reserve 1,024 tokens · All factors on')
      expect(settingsHeadline({ recipe: { factors: { glossary: true, headings: true, overlap: true, verification: false } } }))
        .toBe('Input budget service default · Output reserve service default · Off: verification')
      expect(settingsHeadline({ generic: { record_chars: 30000 } })).toBe('Discovery text limit service default · Record text limit 30,000 characters')
    })

    it('list every Article control, leaving the unused ceiling out', () => {
      const lines = methodLines({ article: REFERENCE_ARTICLE })
      expect(lines.map((line) => line.label)).not.toContain('Context ceiling')
      expect(lines).toContainEqual({ label: 'Verification', value: 'Source labels' })
      expect(methodLines({ article: null })).toEqual([])
      expect(modelsLine(null)).toBe('Field values: deployment default · Reasoning: deployment default')
      expect(modelsLine({ fields: 'instruct' })).toBe('Field values: instruct · Reasoning: deployment default')
    })
  })
  ```

  `prototypes/studio/src/SavedMethodSummary.test.tsx`:

  ```tsx
  // @vitest-environment jsdom
  import '@testing-library/jest-dom/vitest'
  import { cleanup, fireEvent, render, screen } from '@testing-library/react'
  import { afterEach, expect, it, vi } from 'vitest'
  import { REFERENCE_ARTICLE } from 'extraction/extraction-method'
  import { SavedMethodSummary } from './SavedMethodSummary'

  afterEach(cleanup)
  const ready = { status: 'ready' as const, config: {} as never }

  it('shows the saved method it will submit, expandable', () => {
    render(<SavedMethodSummary variant="panel" saved={ready} conflict={null} onRefresh={vi.fn()}
      method={{ models: { fields: 'instruct' }, settings: { article: { ...REFERENCE_ARTICLE, grounding: 'spans' } } }} />)
    fireEvent.click(screen.getByText('Saved advanced settings', { exact: false }))
    expect(screen.getByText('Full source · Plain text · Source-span verification')).toBeInTheDocument()
    expect(screen.getByText('Field values: instruct · Reasoning: deployment default')).toBeInTheDocument()
  })

  it('a stale preview opens with the refusal and a refresh', () => {
    const onRefresh = vi.fn()
    render(<SavedMethodSummary variant="toolbar" saved={ready} method={{ models: null, settings: { article: null } }}
      conflict="Your saved advanced settings changed after this summary was shown. Nothing was started; review the updated summary and start again."
      onRefresh={onRefresh} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing was started')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh summary' }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('an unreadable configuration offers a retry and says nothing can start', () => {
    const onRefresh = vi.fn()
    render(<SavedMethodSummary variant="panel" saved={{ status: 'error', message: 'x' }} method={null} conflict={null} onRefresh={onRefresh} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing can start until they load.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })
  ```

  In `useExtraction.test.tsx` add: a `requestExtraction` rejection with `new ApiRequestError(message, 409, 'method_changed')` calls `onMethodChanged(message)`, not `onError`, leaves `state` as before the request, and posts once. In `App.test.tsx` add: with the mocked saved configuration, the toolbar shows "Saved advanced settings"; a `method_changed` refusal opens its panel with the message, and "Refresh summary" calls the mocked `refresh`. In `BatchExtractionsPanel.test.tsx` add: the panel shows "Saved advanced settings"; a `BatchRequestError(409, 'method_changed', …)` from `openBatchExtraction` shows the refusal with "Refresh summary" and no run notice.

  Run: `cd prototypes/studio && npx vitest run src/methodSummary.test.ts src/SavedMethodSummary.test.tsx` — Expected: FAIL.

- [ ] **Step 2: Write the summaries and the start-view component**

  In `advancedSettings.ts`, rename `shownValue` to an exported `describeArticleValue(article: ArticleSettings, key: ArticleKey): string` (update its two callers).

  `prototypes/studio/src/methodSummary.ts`:

  ```ts
  import type { ActiveSettings } from 'extraction/extraction-method'
  import type { ExtractionModelChoice } from '../shared/extraction.contract'
  import {
    ARTICLE_SECTIONS, CATALOG_LABELS, CONTROL_LABELS, describeArticleValue, effectiveSummary,
  } from './providerConfig/advancedSettings'

  /** How a start view and "Method used" describe a method: one headline, and a line per setting. Words only. */
  export type MethodLine = Readonly<{ label: string; value: string }>

  const amount = (value: number | undefined, unit: string) => (value === undefined ? 'service default' : `${value.toLocaleString('en-US')} ${unit}`)
  const FACTORS = ['glossary', 'headings', 'overlap', 'verification'] as const

  export function methodLines(settings: ActiveSettings | null): readonly MethodLine[] {
    if (settings === null) return []
    if ('article' in settings) {
      const article = settings.article
      if (!article) return []
      return ARTICLE_SECTIONS.flatMap(({ keys }) => keys)
        .filter((key) => !(key === 'context_tokens' && article.context === 'full'))
        .map((key) => ({ label: CONTROL_LABELS[key], value: describeArticleValue(article, key) }))
    }
    if ('generic' in settings) {
      const generic = settings.generic
      return generic ? [
        { label: CATALOG_LABELS.discovery_chars, value: amount(generic.discovery_chars, 'characters') },
        { label: CATALOG_LABELS.record_chars, value: amount(generic.record_chars, 'characters') },
      ] : []
    }
    const recipe = settings.recipe
    if (!recipe) return []
    const off = recipe.factors ? FACTORS.filter((factor) => !recipe.factors![factor]).map((factor) => CATALOG_LABELS[factor].toLowerCase()) : []
    return [
      { label: CATALOG_LABELS.input_tokens, value: amount(recipe.input_tokens, 'tokens') },
      { label: CATALOG_LABELS.output_tokens, value: amount(recipe.output_tokens, 'tokens') },
      { label: 'Factors', value: off.length === 0 ? 'All factors on' : `Off: ${off.join(', ')}` },
    ]
  }

  export function settingsHeadline(settings: ActiveSettings | null): string {
    if (settings === null) return 'Not recorded'
    if ('article' in settings) return settings.article ? effectiveSummary(settings.article) : 'Service defaults'
    const lines = methodLines(settings)
    return lines.length === 0 ? 'Service defaults' : lines.map((line) => (line.label === 'Factors' ? line.value : `${line.label} ${line.value}`)).join(' · ')
  }

  export function modelsLine(models: ExtractionModelChoice | null): string {
    return `Field values: ${models?.fields ?? 'deployment default'} · Reasoning: ${models?.reasoning ?? 'deployment default'}`
  }
  ```

  `prototypes/studio/src/SavedMethodSummary.tsx`:

  ```tsx
  import type { ExtractionMethodIntent } from 'extraction/extraction-method'
  import { methodLines, modelsLine, settingsHeadline } from './methodSummary'
  import type { SavedMethodState } from './savedMethod'

  /** "Saved advanced settings" beside a start action: exactly what the start will submit and admission will pin. A
   *  refusal because the account's settings changed opens it with a refresh; nothing is started in between. */
  export function SavedMethodSummary({ saved, method, conflict, onRefresh, variant }: {
    saved: SavedMethodState
    method: ExtractionMethodIntent | null
    conflict: string | null
    onRefresh: () => void
    variant: 'toolbar' | 'panel'
  }) {
    const link = 'font-semibold text-accent hover:underline'
    if (saved.status === 'loading') return <p className="text-[11.5px] text-ink-muted">Loading saved advanced settings…</p>
    if (saved.status === 'error' || method === null)
      return (
        <p role="alert" className="text-[11.5px] text-danger">
          Saved advanced settings could not be read. Nothing can start until they load.{' '}
          <button type="button" className={link} onClick={onRefresh}>Retry</button>
        </p>
      )
    const lines = methodLines(method.settings)
    return (
      <details open={conflict !== null || undefined} className={variant === 'toolbar' ? 'relative shrink-0 text-xs' : 'text-[12px]'}>
        <summary className="cursor-pointer font-medium text-ink-muted">
          Saved advanced settings{variant === 'panel' ? `: ${settingsHeadline(method.settings)}` : ''}
        </summary>
        <div className={variant === 'toolbar'
          ? 'absolute right-0 z-20 mt-1 w-80 max-w-[90vw] rounded-md border border-line bg-surface p-3 shadow-float'
          : 'mt-1 rounded-md border border-line bg-surface p-3'}>
          {conflict && (
            <p role="alert" className="mb-2 text-[11.5px] text-danger">
              {conflict}{' '}<button type="button" className={link} onClick={onRefresh}>Refresh summary</button>
            </p>
          )}
          <p className="text-[12px] text-ink">{settingsHeadline(method.settings)}</p>
          <p className="text-[11.5px] text-ink-muted">{modelsLine(method.models)}</p>
          {lines.length > 0 && (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
              {lines.map((line) => [<dt key={`${line.label}-t`} className="text-ink-muted">{line.label}</dt>, <dd key={`${line.label}-d`} className="text-ink">{line.value}</dd>])}
            </dl>
          )}
          <p className="mt-1 text-[10.5px] text-ink-faint">Change them on the Model Configuration page’s Advanced tab.</p>
        </div>
      </details>
    )
  }
  ```

- [ ] **Step 3: Route a stale-preview refusal to the start views**

  `useExtraction.ts`: add the option and, in `runRequest`'s catch, before the generic `definiteRejection` branch:

  ```ts
      if (definiteRejection(error) && error.code === METHOD_CHANGED) {
        // Nothing started: the previous attempt stays, and the start view refreshes its summary.
        monitorRef.current = null
        setState(extractionStateFromAttempt(attempt))
        onMethodChanged?.(error.message)
        return null
      }
  ```
  with `const METHOD_CHANGED = 'method_changed'` beside `SOURCE_REPRESENTATION_SUPERSEDED`, and `onMethodChanged` in `UseExtractionOptions` with a one-line doc comment.

  `App.tsx`: `const [methodConflict, setMethodConflict] = useState<string | null>(null)`; pass `onMethodChanged: setMethodConflict` to `useExtraction`; render, after the Boundaries select in the toolbar,

  ```tsx
          {!running && (
            <SavedMethodSummary variant="toolbar" saved={saved.state} conflict={methodConflict}
              method={saved.state.status === 'ready' ? savedMethodFor(saved.state.config, nextExtractionStrategy, nextExtractionStrategy === 'CATALOG' ? nextCatalogRecipe || null : null) : null}
              onRefresh={() => { setMethodConflict(null); void saved.refresh() }} />
          )}
  ```
  and clear `methodConflict` when a run starts (`runExtraction()` sets it to `null` before calling `extraction.runExtraction`). The summary is computed from the same `saved.state.config` and the same strategy/recipe the Run button submits.

  `batchExtractions.ts`: add

  ```ts
  /** A refused Batch Extraction request, with the server's code when it sent one (e.g. `method_changed`). */
  export class BatchRequestError extends Error {
    readonly status: number
    readonly code: string | null
    constructor(status: number, code: string | null, message: string) {
      super(message)
      this.name = 'BatchRequestError'
      this.status = status
      this.code = code
    }
  }
  ```
  and throw it from `read` instead of the plain `Error` (message unchanged; `code` from `value.error.code` when it is a string).

  `batchSchemaSuggestionMachine.ts`: `captureRunFailure` also keeps `runFailureCode` (the `BatchSchemaSuggestionRequestError`'s `failure.code`, else `null`) in context; `useBatchSchemaSuggestion` exposes it.

  `BatchExtractionsPanel.tsx`: render `<SavedMethodSummary variant="panel" …>` beside the "Extraction Strategy" select, with `method = savedMethodFor(config, batchStrategy, null)`; a conflict is shown when `openExistingSchemaBatch`/`runOpenBatchAgain` catch a `BatchRequestError` with `code === 'method_changed'` (set `methodConflict`, not `runFailure`) or when the suggestion's `runFailureCode === 'method_changed'`; "Refresh summary" clears the conflict and calls `saved.refresh()`.

- [ ] **Step 4: Run the tests**

  Run: `cd prototypes/studio && npx vitest run src && cd ../.. && pnpm typecheck && pnpm lint && pnpm test`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add -u prototypes/studio
  git add prototypes/studio/src/methodSummary.ts prototypes/studio/src/methodSummary.test.ts \
    prototypes/studio/src/SavedMethodSummary.tsx prototypes/studio/src/SavedMethodSummary.test.tsx
  git commit -m "feat(studio): start views show the saved method they submit and refresh it after a stale-preview conflict"
  ```

---

### Task 12: Method used on Extraction details

**Files:**
- Create: `prototypes/studio/src/MethodUsed.tsx`
- Modify: `prototypes/studio/src/ResultsTab.tsx` (`AttemptDetails` renders `MethodUsed` above the diagnostics; the "Diagnostics are not available yet." line stays for the diagnostics part only)
- Test: `prototypes/studio/src/ResultsTab.test.tsx`

**Interfaces:**
- Consumes: `ExtractionAttempt.requestedModels`, `.requestedSettings`, `.diagnostics.effectiveMethod`, `.diagnostics.models`, `.diagnostics.eligibility`, `.executionStatus`, `.catalogRecipe` (Task 7 wire); `settingsHeadline`, `methodLines`, `modelsLine` (Task 11).
- Produces: `MethodUsed({ attempt }: { attempt: ExtractionAttempt })`, a `section` named "Method used" with "Requested" and "Effective" groups.

Copy: "Method used", "Requested", "Effective", "Not recorded", "Effective method unavailable" (design §7, exact); plan-chosen: "Not reported yet" (queued/running), "Versions", "Eligible values", "All eligible values grounded", "Some eligible values ungrounded", "Not applicable: no value was eligible", and the caption "Effective options and versions are what the Parsing Service reported for this run. Equal settings are not a promise of identical output on another runtime."

- [ ] **Step 1: Write the failing tests**

  In `prototypes/studio/src/ResultsTab.test.tsx`, reuse the `renderWith` pattern of "names the model each role ran on…" and add:

  ```tsx
  describe('Method used', () => {
    const SPANS = { context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
      prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema' } as const
    const renderWith = (attempt: ExtractionAttempt) => render(
      <ResultsTab {...defaultRunProps}
        controller={controller(attempt.executionStatus === 'FAILED'
          ? { status: 'error', message: attempt.failure!.message }
          : { status: 'ready', result: attempt.resultPayload!, evidenceLinks: [], ungroundedCount: 0 }, attempt)}
        schemaReady documentMarkdown="# Source" sourceDocumentName="Article.pdf" />)
    const methodUsed = () => { fireEvent.click(screen.getByRole('button', { name: 'Run details' })); return within(screen.getByRole('region', { name: 'Method used' })) }

    it('shows requested and effective methods with the versions the service reported', () => {
      renderWith({ ...articleAttempt, requestedModels: { fields: 'instruct' }, requestedSettings: { article: SPANS },
        diagnostics: { ...articleAttempt.diagnostics!, models: { fields: 'Qwen/Qwen3.8-27B-FP8', reasoning: 'Qwen/Qwen3.8-27B-FP8' },
          effectiveMethod: { options: { strategy: 'article', article: SPANS }, versions: { prompt: 12, method: 1, spanGrounding: 2 } },
          eligibility: { allRecordLeaves: 5, eligibleRecordLeaves: 0, skipped: [], eligibleGrounding: 'not_applicable' } } })
      const used = methodUsed()
      expect(used.getByText('Bounded source units (12,288 tokens) · Plain text · Source-span verification')).toBeInTheDocument()
      expect(used.getByText('Field values: instruct · Reasoning: deployment default')).toBeInTheDocument()
      expect(used.getByText('Prompt 12 · Method 1 · Span grounding 2')).toBeInTheDocument()
      expect(used.getByText('Not applicable: no value was eligible')).toBeInTheDocument()
    })

    it('a run that failed before a service result keeps its request and has no effective method', () => {
      renderWith({ ...articleAttempt, executionStatus: 'FAILED', outcome: null, complete: null, modelAttribution: null, diagnostics: null,
        resultPayload: null, evidenceLinks: null, reviewable: false, failure: { code: 'extraction_failed', message: 'Refused.' },
        requestedSettings: { article: SPANS } })
      const used = methodUsed()
      expect(used.getByText('Effective method unavailable')).toBeInTheDocument()
      expect(used.getByText('Bounded source units (12,288 tokens) · Plain text · Source-span verification')).toBeInTheDocument()
    })

    it('a historical run is Not recorded, never borrowing today\'s configuration', () => {
      renderWith({ ...articleAttempt, requestedSettings: null })
      expect(methodUsed().getAllByText('Not recorded')).toHaveLength(2)
    })
  })
  ```
  (import `within` from `@testing-library/react`.)

  Run: `cd prototypes/studio && npx vitest run src/ResultsTab.test.tsx` — Expected: FAIL.

- [ ] **Step 2: Write the component**

  `prototypes/studio/src/MethodUsed.tsx`:

  ```tsx
  import { useId } from 'react'
  import type { ExtractionAttempt } from '../shared/extraction.contract'
  import { methodLines, modelsLine, settingsHeadline } from './methodSummary'

  const VERSION_LABELS: Readonly<Record<string, string>> = {
    prompt: 'Prompt', method: 'Method', spanGrounding: 'Span grounding', groundingRouting: 'Grounding routing',
    rendering: 'Rendering', grouping: 'Grouping', selection: 'Selection',
  }
  const ELIGIBLE: Readonly<Record<'complete' | 'partial' | 'not_applicable', string>> = {
    complete: 'All eligible values grounded', partial: 'Some eligible values ungrounded', not_applicable: 'Not applicable: no value was eligible',
  }

  /** What an Extraction was admitted with, beside what the Parsing Service reports it ran. Recorded values only: a
   *  run without a record says so and never borrows today's account configuration. */
  export function MethodUsed({ attempt }: { attempt: ExtractionAttempt }) {
    const headingId = useId()
    const requested = attempt.requestedSettings ?? null
    const effective = attempt.diagnostics?.effectiveMethod ?? null
    const eligibility = attempt.diagnostics?.eligibility ?? null
    const strategy = attempt.strategy === 'CATALOG'
      ? `Catalog · ${attempt.catalogRecipe ?? 'Model discovery'}` : 'Article'
    return (
      <section aria-labelledby={headingId} className="mb-3 flex flex-col gap-1.5 text-[11.5px]">
        <p id={headingId} className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-muted">Method used</p>
        <div>
          <p className="font-semibold text-ink">Requested</p>
          <p className="text-ink">{strategy} · <span>{settingsHeadline(requested)}</span></p>
          <p className="text-ink-muted">{modelsLine(attempt.requestedModels ?? null)}</p>
          {methodLines(requested).length > 0 && (
            <details className="text-[11px] text-ink-muted">
              <summary className="cursor-pointer">Settings</summary>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3">
                {methodLines(requested).map((line) => [<dt key={`${line.label}-t`}>{line.label}</dt>, <dd key={`${line.label}-d`} className="text-ink">{line.value}</dd>])}
              </dl>
            </details>
          )}
        </div>
        <div>
          <p className="font-semibold text-ink">Effective</p>
          {attempt.executionStatus === 'FAILED' ? <p className="text-ink">Effective method unavailable</p>
            : attempt.executionStatus !== 'COMPLETED' ? <p className="text-ink-muted">Not reported yet</p>
            : effective === null ? <p className="text-ink">Not recorded</p>
            : <>
                {attempt.diagnostics?.models && <p className="text-ink">Field values ran on {attempt.diagnostics.models.fields} · Reasoning on {attempt.diagnostics.models.reasoning}</p>}
                <p className="text-ink-muted">Versions: <span className="text-ink">{Object.entries(effective.versions).map(([key, version]) => `${VERSION_LABELS[key] ?? key} ${version}`).join(' · ')}</span></p>
                <details className="text-[11px] text-ink-muted">
                  <summary className="cursor-pointer">Technical details</summary>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono">{JSON.stringify(effective.options, null, 2)}</pre>
                </details>
              </>}
          {eligibility && (
            <p className="text-ink-muted">
              Eligible values: {eligibility.eligibleRecordLeaves} of {eligibility.allRecordLeaves} populated record values; {eligibility.skipped.length} skipped by schema policy. <span className="text-ink">{ELIGIBLE[eligibility.eligibleGrounding]}</span>
            </p>
          )}
        </div>
        <p className="text-[10.5px] text-ink-faint">Effective options and versions are what the Parsing Service reported for this run. Equal settings are not a promise of identical output on another runtime.</p>
      </section>
    )
  }
  ```

  The versions line in the test reads "Prompt 12 · Method 1 · Span grounding 2" — render the versions `span` so that exact text is one text node (as above, with "Versions: " outside it).

  In `ResultsTab.tsx` `AttemptDetails`, render `<MethodUsed attempt={attempt} />` before `<ExtractionDiagnostics attempt={attempt} />`.

- [ ] **Step 3: Run the tests and commit**

  ```bash
  cd prototypes/studio && npx vitest run src/ResultsTab.test.tsx && cd ../.. && pnpm typecheck && pnpm lint && pnpm test
  git add prototypes/studio/src/MethodUsed.tsx prototypes/studio/src/ResultsTab.tsx prototypes/studio/src/ResultsTab.test.tsx
  git commit -m "feat(studio): show the requested and effective method on Extraction details"
  ```

---

### Task 13: Browser and real-service coverage

**Files:**
- Modify: `prototypes/studio/e2e/model-configuration.spec.ts` (a `test.describe('the Advanced tab', …)` block reusing its `routeModelServers`, `signIn`, `openModelConfiguration`, `apply`, `storedConfiguration`, `reload`)
- Modify: `prototypes/studio/e2e/real-service.spec.ts` (two cases)

**Interfaces:**
- Consumes: everything user-visible from Tasks 3–12; `REQUIRED_VIEWPORTS`, `emulateBrowserZoom200`, `activateWithKeyboard`, `expectOperableInViewport` (`e2e/accessibility.ts`).
- Produces: browser evidence for U1, U3, U4, U8 (and U2's second account), and real-boundary evidence for P1 and F1. Screenshots under the test's output directory for the acceptance phase's visual inspection.

- [ ] **Step 1: Write the Advanced browser cases**

  Append to `prototypes/studio/e2e/model-configuration.spec.ts` (import `REQUIRED_VIEWPORTS`, `activateWithKeyboard`, `emulateBrowserZoom200`, `expectOperableInViewport` from `./accessibility.js`):

  ```ts
  test.describe('the Advanced tab', () => {
    test.describe.configure({ mode: 'serial' })
    const openAdvanced = async (dialog: Locator) => {
      const models = dialog.getByRole('tab', { name: 'Models' })
      await models.focus()
      await dialog.page().keyboard.press('ArrowLeft')
      await expect(dialog.getByRole('tab', { name: 'Advanced' })).toBeFocused()
      await expect(dialog.getByRole('heading', { name: 'Advanced extraction' })).toBeVisible()
    }
    const section = (dialog: Locator, title: string) => dialog.locator('details').filter({ has: dialog.page().locator('summary', { hasText: title }) })

    test('opening, explaining and switching strategies saves nothing; an Apply survives a reload; a second account sees none of it', async ({ page, browser }) => {
      await routeModelServers(page)
      await signIn(page)
      let puts = 0
      page.on('request', (request) => { if (pathOf(request.url()) === '/api/model_config' && request.method() === 'PUT') puts += 1 })
      const dialog = await openModelConfiguration(page)
      await openAdvanced(dialog)
      await dialog.getByRole('radio', { name: 'Catalog' }).check()
      await dialog.getByRole('radio', { name: 'Article' }).check()
      await section(dialog, 'Evidence').locator('summary').click()
      await dialog.getByRole('button', { name: 'Explain Evidence' }).click()
      await expect(page.getByRole('dialog', { name: 'Verification' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: 'Verification' })).toBeHidden()
      await expect(dialog).toBeVisible()
      await expect(dialog.getByText('Everything saved')).toBeVisible()
      expect(puts).toBe(0)

      await dialog.getByRole('button', { name: 'Customize' }).click()
      await section(dialog, 'Evidence').getByRole('radio', { name: 'Source spans' }).check()
      const committed = await apply(page, dialog)
      expect(committed.extractionSettings.article?.grounding).toBe('spans')
      await reload(page)
      const reopened = await openModelConfiguration(page)
      await openAdvanced(reopened)
      await section(reopened, 'Evidence').locator('summary').click()
      await expect(section(reopened, 'Evidence').getByRole('radio', { name: 'Source spans' })).toBeChecked()
      expect(await storedConfiguration(page)).toEqual(committed)

      const other = await browser.newContext()
      try {
        const pageB = await other.newPage()
        await routeModelServers(pageB)
        await signIn(pageB)
        const dialogB = await openModelConfiguration(pageB)
        await openAdvanced(dialogB)
        await expect(dialogB.getByRole('button', { name: 'Use service defaults', pressed: true })).toBeVisible()
        expect((await storedConfiguration(pageB)).extractionSettings).toEqual({})
      } finally {
        await other.close()
      }
    })

    test('a failed Apply keeps the draft and the saved document', async ({ page }) => {
      await routeModelServers(page)
      await signIn(page)
      const dialog = await openModelConfiguration(page)
      await openAdvanced(dialog)
      await dialog.getByRole('button', { name: 'Customize' }).click()
      await page.route('**/api/model_config', (route) => route.request().method() === 'PUT'
        ? route.fulfill({ status: 503, json: { error: { code: 'persistence_unavailable', message: 'Unavailable.' } } })
        : route.fallback())
      await dialog.getByRole('button', { name: 'Apply' }).click()
      await expect(dialog.getByRole('alert')).toContainText('persistence_unavailable')
      await expect(dialog.getByText('Unsaved changes')).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Customize', pressed: true })).toBeVisible()
      await page.unroute('**/api/model_config')
      expect((await storedConfiguration(page)).extractionSettings).toEqual({})
    })

    test('by keyboard: an invalid child is kept, announced, summarized and focusable; the parent back resolves it', async ({ page }) => {
      await routeModelServers(page)
      await signIn(page)
      const dialog = await openModelConfiguration(page)
      await openAdvanced(dialog)
      await activateWithKeyboard(page, dialog.getByRole('button', { name: 'Customize' }))
      const context = section(dialog, 'Source context')
      await context.locator('summary').focus()
      await page.keyboard.press('Enter')
      await context.getByRole('radio', { name: 'Bounded source units' }).check()
      await context.getByRole('group', { name: 'Previous passages' }).getByRole('radio', { name: '1' }).check()
      await context.getByRole('radio', { name: 'Full source' }).check()
      const overlap = context.getByRole('group', { name: 'Previous passages' }).getByRole('radio', { name: '1' })
      await expect(overlap).toBeChecked()
      await expect(overlap).toHaveAttribute('aria-invalid', 'true')
      await expect(context.getByText('This choice requires bounded source units.', { exact: true }).last()).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Apply' })).toBeDisabled()
      await activateWithKeyboard(page, dialog.getByRole('button', { name: '1 issue blocks Apply' }))
      await expect(overlap).toBeFocused()
      await context.getByRole('radio', { name: 'Bounded source units' }).check()
      await expect(overlap).toBeChecked()
      await expect(dialog.getByRole('button', { name: 'Apply' })).toBeEnabled()
    })

    test('reflows without horizontal scrolling at 360 px, the required viewports and 200% zoom; Explain returns focus', async ({ page }, testInfo) => {
      await routeModelServers(page)
      await signIn(page)
      for (const viewport of [{ width: 360, height: 800 }, ...REQUIRED_VIEWPORTS]) {
        await page.setViewportSize(viewport)
        const expand = page.getByRole('button', { name: 'Expand projects' })
        if (viewport.width < 860 && await expand.isVisible()) await activateWithKeyboard(page, expand)
        const dialog = await openModelConfiguration(page)
        await openAdvanced(dialog)
        await dialog.getByRole('button', { name: 'How this works' }).click()
        const guide = page.getByRole('dialog', { name: 'How this works' })
        await expect(guide.getByRole('figure')).toHaveAccessibleName(/Canonical Source Context feeds Context and grouping/)
        await page.keyboard.press('Escape')
        await expect(dialog.getByRole('button', { name: 'How this works' })).toBeFocused()
        for (const control of ['Customize', 'Apply', 'Discard'])
          await expectOperableInViewport(page, dialog.getByRole('button', { name: control }))
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
        await page.screenshot({ path: testInfo.outputPath(`advanced-${viewport.width}x${viewport.height}.png`), fullPage: true })
        await page.keyboard.press('Escape')
      }
      await emulateBrowserZoom200(page)
      const zoomed = await openModelConfiguration(page)
      await openAdvanced(zoomed)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      await page.screenshot({ path: testInfo.outputPath('advanced-zoom-200.png'), fullPage: true })
    })
  })
  ```

  Adjust only locator plumbing if the stack's markup requires it (e.g. the narrow-layout expand step mirrors `authentication-accessibility.spec.ts`); never weaken an assertion.

- [ ] **Step 2: Write the real-service cases**

  Append to `prototypes/studio/e2e/real-service.spec.ts`:

  ```ts
  const EMPTY_DOCUMENT = { connections: [], routes: { schemaSuggestion: null, interaction: null }, extractionModels: {}, ingestionModels: {} }

  test('kei receives the saved Article method byte for value, and the Extraction records it', async ({ page }, testInfo) => {
    const service = await startRealService(testInfo.outputPath('parsing-service.log'))
    try {
      const project = await createProject(page, 'Method transport')
      const article = { context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
        prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema' }
      const saved = await page.request.put('/api/model_config', { headers, data: { config: { ...EMPTY_DOCUMENT, extractionSettings: { article } } } })
      expect(saved.status(), await saved.text()).toBe(200)
      const { sourceDocumentId } = await uploaded(page, project, cataloguePdf())
      const revision = await articleSchema(page, project)
      const id = randomUUID()
      const admitted = await page.request.post('/api/extractions', { headers, data: {
        id, strategy: 'ARTICLE', schemaRevisionId: revision, sourceRepresentationRevisionId: await representation(page, project, sourceDocumentId),
        method: { models: null, settings: { article } },
      } })
      expect(admitted.status(), await admitted.text()).toBe(201)
      expect(extractionReadResponseSchema.shape.extraction.parse(await admitted.json()).requestedSettings).toEqual({ article })
      await expect.poll(async () => (await service.keiWorkflows(`kei-extract:${id}`)).length, { timeout: 120_000 }).toBe(1)
      const [child] = await service.keiWorkflows(`kei-extract:${id}`)
      expect((child!.input as [{ request: { options: unknown } }])[0].request.options).toEqual({ strategy: 'article', article })
      const cancelled = await page.request.delete(`/api/extractions/${id}`, { headers })
      expect([202, 404]).toContain(cancelled.status())
    } finally { await service.close() }
  })

  test('a recipe budget the served model cannot hold is refused before model calls and keeps its requested budget', async ({ page }, testInfo) => {
    test.skip(Boolean(process.env.FREE_REAL_EXTRACT_URL), 'The served context is the scripted model boundary’s 16,384 tokens.')
    const service = await startRealService(testInfo.outputPath('parsing-service.log'))
    try {
      const project = await createProject(page, 'Refused budget')
      const recipe = { input_tokens: 4096, output_tokens: 16000, factors: { glossary: true, headings: true, overlap: true, verification: true } }
      expect((await page.request.put('/api/model_config', { headers, data: { config: { ...EMPTY_DOCUMENT, extractionSettings: { catalog: { recipe } } } } })).status()).toBe(200)
      const { sourceDocumentId } = await uploaded(page, project, numberedCataloguePdf(), 'katalog.pdf')
      const schema = await page.request.post('/api/schema-revisions', { headers, data: {
        projectContextId: project, recordDescription: 'One numbered catalogue entry.',
        schemaNodes: [{ id: 'entry_no', name: 'entry_no', type: 'integer', description: 'The catalogue number.' }],
      } })
      expect(schema.status(), await schema.text()).toBe(201)
      const id = randomUUID()
      const admitted = await page.request.post('/api/extractions', { headers, data: {
        id, strategy: 'CATALOG', catalogRecipe: 'numbered-catalogue-de@1', schemaRevisionId: (await schema.json()).revision.schemaRevisionId,
        sourceRepresentationRevisionId: await representation(page, project, sourceDocumentId), method: { models: null, settings: { recipe } },
      } })
      expect(admitted.status(), await admitted.text()).toBe(201)
      await expect.poll(async () =>
        extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json()).extraction.executionStatus,
      { timeout: 300_000, intervals: [500, 1000] }).toBe('COMPLETED')
      const { extraction } = extractionReadResponseSchema.parse(await (await page.request.get(`/api/extractions/${id}`)).json())
      expect(extraction.requestedSettings).toEqual({ recipe })
      expect(extraction.complete).toBe(false)
      expect(extraction.evidenceLinks).toEqual([])
      expect(extraction.diagnostics?.grounding?.issueCodes).toContain('budget_exceeds_context')
      expect((extraction.diagnostics?.effectiveMethod?.options.catalog as { output_tokens: number }).output_tokens).toBe(16000)
    } finally { await service.close() }
  })
  ```
  (`articleSchema`, `createProject`, `representation`, `uploaded`, `headers` are this file's existing helpers.) If the recipe refusal surfaces under `diagnostics.grounded` rather than `grounding.issueCodes`, assert the code where the wire actually carries the artifact's `issues`; the requirement is that the refusal is visible and `output_tokens` stays 16,000 (no trimming, no fallback).

- [ ] **Step 3: Run the tiers**

  ```bash
  pnpm test:e2e            # creates and removes its own PostgreSQL + mock OIDC stack (Docker)
  pnpm test:service        # real Python API/worker, scripted model boundary; downloads Docling weights on first use
  ```
  Expected: PASS. Inspect the saved screenshots (`prototypes/studio/test-results/**/advanced-*.png`) for clipped controls, overlapping text and colour-only status; note findings for the acceptance receipt.

- [ ] **Step 4: Commit**

  ```bash
  git add prototypes/studio/e2e/model-configuration.spec.ts prototypes/studio/e2e/real-service.spec.ts
  git commit -m "test(studio): Advanced tab keyboard, reflow and persistence; method transport and refused budgets at the real service"
  ```

---

### Task 14: README, CONTEXT and contract documentation

**Files:**
- Modify: `README.md` (product contract items 5 and 7; "Extraction execution")
- Modify: `CONTEXT.md` (new terms; Extraction Model Choice wording)
- Modify: `docs/operations/deployment.md` (Model Configuration page description near line 318)
- Modify: `openspec/changes/advanced-extraction-configuration/tasks.md` (check 1.1–3.3 with their commits; leave 4.x for the controller)

**Interfaces:**
- Consumes: the released behavior of Tasks 1–13 (verify each sentence against code and tests before writing it).
- Produces: documentation only.

- [ ] **Step 1: Update README**

  Item 5 ("Durable, versioned state"), after "…schema revisions it used,": add "and to the extraction method it was admitted with (its Extraction Model Choice and Extraction Method Settings),".

  Item 7 ("Model-provider surface"), after "…the Extraction Model Choice and the Ingestion Model Choice.": add "It also holds the account's Extraction Method Settings: per Extraction Strategy, how future Extractions run (the Model Configuration page's Advanced tab). Unset settings keep the Parsing Service's defaults; saved settings never edit an Extraction Schema and never hold a key."

  In "Extraction execution", after the sentence ending "…each Extraction records the models its roles ran on.", add:

  > Every single and Batch Extraction is admitted with the saved method its start view shows ("Saved advanced settings"): the Extraction Model Choice and the Extraction Method Settings for its strategy (Article; generic Catalog; a recipe Catalog's budgets and factors — a Batch Extraction has no recipe). Admission compares that method with the account's saved one under the configuration row's lock and refuses a stale one, starting nothing; otherwise it pins the method on the Extraction (and on the Batch Extraction and each member). `runExtraction` sends only the pinned method, also after a restart; saving new settings affects only later admissions. A repeated request with the same Extraction ID and method replays its Extraction; the same ID with another method is a conflict. Extraction details show the requested method beside the options and protocol versions the Parsing Service reports; a run from before methods were recorded shows "Not recorded". The Parsing Service remains the authority on method rules and re-validates every request; Studio's copy of the rules (`packages/extraction/src/extraction-method.ts`) is pinned to it by shared fixtures in `prototypes/parsing_service/tests/fixtures/contracts/`.

- [ ] **Step 2: Update CONTEXT.md**

  After **Extraction Model Choice**, add:

  ```markdown
  **Extraction Method Settings**:
  A Researcher Account's saved choices, per Extraction Strategy, of how future Extractions run: Article's source context, record identity, instructions, source representation, value evidence and verification choices; generic Catalog's text limits; a recipe Catalog's budgets and factors. They are set on the Model Configuration page's Advanced tab; unset settings keep the Parsing Service's defaults. They never edit an Extraction Schema: whether verification follows the schema's evidence policies is a setting, the policies are the schema's.
  _Avoid_: preset, profile, pipeline configuration, advanced extraction

  **Extraction Method**:
  What one Extraction is admitted with and pinned to: its Extraction Strategy, recipe, Extraction Model Choice and the applicable Extraction Method Settings. It never changes after admission, and execution reads only it; Extraction details show it beside the options and protocol versions the Parsing Service reports for the run. Equal methods do not promise identical model output across runtime revisions.
  _Avoid_: current settings, configuration, method profile
  ```
  In **Extraction Model Choice**, replace "Every single and batch Extraction is requested on its Project Context owner's choice current when it starts" with "Every single and batch Extraction is requested on its Project Context owner's choice as its start view showed it, pinned at admission".

- [ ] **Step 3: Update the deployment runbook**

  In `docs/operations/deployment.md`, where the Model Configuration page's steps are described (near line 318), add one sentence: "The Advanced tab holds each account's Extraction Method Settings for future Extractions; they need no deployment configuration."

- [ ] **Step 4: Check links, wording and examples**

  ```bash
  node -e "
  const fs=require('fs'),path=require('path');let bad=0;
  for (const file of ['README.md','CONTEXT.md','docs/operations/deployment.md']) {
    for (const [,link] of fs.readFileSync(file,'utf8').matchAll(/\]\(([^)#]+)(#[^)]*)?\)/g)) {
      if (/^https?:/.test(link)) continue;
      if (!fs.existsSync(path.join(path.dirname(file), link))) { console.log(file, link); bad++ }
    }
  }
  process.exit(bad)"
  grep -n "advanced extraction" README.md CONTEXT.md docs/operations/deployment.md
  ```
  Expected: no broken relative link; "advanced extraction" appears only in CONTEXT's avoid list. Re-read each new sentence against the code paths it names (admission, `runExtraction`, the DTO) — the docs describe released behavior only.

- [ ] **Step 5: Commit**

  ```bash
  git add README.md CONTEXT.md docs/operations/deployment.md openspec/changes/advanced-extraction-configuration/tasks.md
  git commit -m "docs: extraction method settings, pinned admission and Method used"
  ```

---

## Acceptance phase (controller)

These are OpenSpec tasks 4.1–4.3. They are not implementer tasks: the controller runs them on the exact final tree after Task 14.

**4.1 — Validation receipt.** On the final candidate (record `git rev-parse HEAD` and `git write-tree`):
- `pnpm typecheck`, `pnpm lint`, `pnpm test` (fast tier; includes the Parsing Service fast tier through `uv run --no-sync`, or run it with the shim venv command from Global Constraints).
- `pnpm test:postgres` with `PROJECT_STORE_POSTGRES_URL`, `EXTRACTION_TEST_DATABASE_URL` (= `DATABASE_URL`) and `PARSING_TEST_DATABASE_URL` on fresh, migrated loopback:5432 `free_test_*` databases (M1, P2–P6, U3).
- `pnpm test:e2e` (U1, U3, U4, U8, U2's second account; includes the recovery config) and `pnpm test:service` (P1, F1 at the real boundary, plus the existing restart flows).
- The focused Python command from verification.md (`test_extraction_methods.py test_extraction_span_grounding.py test_extraction_routing.py test_grounding_study.py`, with `PYTHONPATH=src:.`), and `tests/test_serving_imports.py`.
- M1 on populated data: the Task 2 PostgreSQL check (backfill SQL on pre-release-shaped documents, a malformed document and an already-migrated one) plus the Task 6 recovery cases (a pre-release `loadAdmitted` checkpoint; a restart across a settings change). `pnpm test:safety` only if deployment/safety configuration changed (none is planned).
- Screenshot inspection from Task 13 (desktop, 390, 360, 200% zoom).
Write `docs/validation/2026-09-28-advanced-extraction-configuration.md` (or the actual date): command, candidate hash, outcome, artifact path per tier; map each result to its matrix IDs (U1–U9, P1–P7, E1–E5, F1–F2, M1, A1); state unrun checks (no live-model smoke; no accuracy/speed claim) and evidence boundaries (a scripted-service pass is not provider execution; categorical parity is compatibility, not quality).

**4.2 — Independent review and maintenance probe.** Freeze the candidate diff. Give one fresh read-only reviewer the original request, AGENTS/README/CONTEXT, the OpenSpec change, this plan's discrepancy rulings, the exact diff, surrounding callers and the 4.1 receipts. Ask for concrete correctness failures, ownership/dependency defects (design §8's three invariants; A1), and removable machinery (a settings framework, duplicated state, preset storage, a second workflow, hidden retries, version flags). Then run verification.md's maintenance probe in a disposable branch: (a) drive `packages/extraction` through its test seam with a valid method descriptor and no provider-config React imports or account reads, confirming it runs on the supplied immutable settings; (b) add a help-only guide topic and confirm it touches only `advancedGuide.data.ts` and its test (no database, workflow or parser change). Discard the probe.

**4.3 — Revalidate and present.** Repair only concrete findings, re-run the affected checks against the final tree, make sure the review refers to that exact tree, and present: what shipped, the discrepancy rulings as taken, unrun checks, and empirical limits (configuration coverage is not an accuracy gain; study findings are dated development evidence). After two failed repair rounds on one finding, stop and surface it. Check tasks 4.1–4.3 in the OpenSpec `tasks.md` only when done.

---

## Appendix: Pre-flight conflict table

**Cross-task interfaces (producer → consumer)**

| # | Shared file / interface | Producer | Consumer(s) | Check and result |
| --- | --- | --- | --- | --- |
| 1 | Settings shape (`extractionSettingsSchema`, snake_case service names, Article defaults, Catalog members) | T1 | T3 (`modelConfigSchema.extractionSettings`), T8 (draft), T9 (controls) | Same schema object is imported everywhere; T3 makes the member required (discrepancy 6). No mismatch. |
| 2 | Contract shape consumed by admission (`accountMethod` parses `extractionModels` + `extractionSettings` of the stored document) | T1 | T4, T5 | Admission parses only those two members (non-strict), with the same schemas Studio's whole-document schema embeds (T3). A stored document Studio would reject fails `accountMethod` too (`invalid_model_config` → 500), matching the existing server-fault contract. |
| 3 | The descriptor the start view submits = the canonical object admission compares | T1 (`activeMethod`, `canonicalIntent`, `canonicalArticle`, `present`) | T4/T5 client (`savedMethodFor` = `activeMethod` over the GET document), T4/T5 admission (`canonicalIntent` of the submission vs `accountMethod` of the locked document) | Both sides reduce to `activeMethod` + `canonicalArticle`/`present`; key order is `ARTICLE_KEYS`/shape order; `isDeepStrictEqual` ignores order anyway. Explicit reference ≠ omission on both sides (tested T1, T4). Inactive-strategy settings are excluded by `activeSettings` on both sides (Review Focus 1). |
| 4 | Snapshot column shape (`Extraction.requestedSettings`, `BatchExtraction.requestedModels/requestedSettings`; NULL = not recorded; value = `ActiveSettings`) | T2 (columns), T4/T5 (writes) | T4 `sameAdmission`, T5 batch replay, T6 `loadAdmitted`/`keiExtractRequest`, T7 attempt read model, T12 "Method used" | Writers always write an `ActiveSettings` object (never NULL) for new admissions; every reader treats NULL as "not recorded" (`storedSettings` → null; `sameAdmission` → never equal; `keiMethodOptions` → reference request; UI → "Not recorded"). |
| 5 | Row lock (`lockModelConfiguration(client, id)`) | T2 | T4, T5 | Takes the pooled `client` of `withPoolClientTransaction` (not the ORM `transaction`), so the FOR SHARE lock belongs to the admission transaction. Lock order doc rows → config row in every caller; `apply` takes only the config row (discrepancy 12). |
| 6 | `ExtractionHandlerDependencies` / `configuredExtractionModels` | existing | T4 (single stops using), T5 (batch/suggestion stop using, then deleted) | T4 keeps the type exported so `batch_extractions.ts`/`batch_schema_suggestions.ts` still compile; T5 deletes both after its last caller. |
| 7 | `FreshExtractionInput.method` / `ScheduleBatchInput.method` / `ScheduleSuggestedBatchInput.method` | T4, T5 | Studio handlers (same tasks), crash scenarios and e2e posters (same tasks) | Each type change lands with every caller in the same task (grep in T4 Step 8 / T5 Step 5), so every commit typechecks. |
| 8 | `useSavedMethod` / `savedMethodFor` / `runExtraction(method, …)` | T4 | T5 (panel), T11 (summary UI) | Introduced with plumbing only in T4; T11 adds the visible summary using the same state object the submit uses. |
| 9 | `savedMethodStillCurrent`, `refuseUnusableIdentityFields`, `METHOD_CHANGED_MESSAGE` | T4 | T5 | Exported from `postgres-admission.ts`; suggested batch receives them via its `helpers` object. |
| 10 | Identity pre-check message | T1 (`identityFieldsMessage`, reasons incl. `filename`) | T4 test, T5 tests, T11 (shown as the server message) | T4's expected string is built from T1's reason labels ("not in this schema", "taken from the source’s filename"). Python parity via `identity-fields.json`. |
| 11 | DBOS rule vs the workflow change | Global rule | T6 | No step added/removed/renamed/reordered; input stays `[extractionId]`; only `loadAdmitted`'s output gains an optional field, and a pre-release checkpoint without it yields the reference request (Review Focus 4). No `DBOS.patch()`, no `studio@1` change. Kei's workflow untouched. |
| 12 | `acceptKeiArtifact` | T6 (requested-options check) | T7 (effective method, eligibility, support) | T7 edits the same function after T6; both use `artifact.options` as recorded. Test fixtures (`deterministicArtifact`, `artifactFor`) echo request options from T6 on, so T7's tests run against honoring artifacts. |
| 13 | Wire diagnostics (`effectiveMethod.versions` keys, `eligibility.eligibleGrounding`) | T7 | T12 | Keys `prompt, method, spanGrounding, groundingRouting, rendering, grouping, selection` map 1:1 to `VERSION_LABELS`; `eligibleGrounding` values map to `ELIGIBLE`. |
| 14 | Draft API (`customize`, `useServiceDefaults`, `setArticle`, `replaceArticle`, `addIdentityField`, `removeIdentityField`, `setCatalogFactor`, `setNumber`, `numberEdits`, `settingsIssues`) | T8 | T9, T10 | Names and signatures identical in T8 Interfaces, T9 `AdvancedEditor`, T10's added `replaceArticle`. |
| 15 | Helpers (`STARTING_POINTS`, `withStartingPoint`, `settingsDelta`, `describeArticleValue`) | T8 (+ T11 rename of `shownValue`) | T10, T11, T12 | T11 renames the internal `shownValue` to exported `describeArticleValue` and updates its T8 callers; no earlier task references the new name. |
| 16 | `AdvancedTab` slot and `Disclosure` export | T9 | T10 | T10 fills `children` with `HowThisWorksButton` and puts `ExplainButton` as each disclosure's first child. |
| 17 | Suggestion refusal codes | T5 (`batchSchemaSuggestionErrorSchema` enum) | T11 (`runFailureCode === 'method_changed'`) | Enum extended in T5 so T11's code check can match. |

**Per-task self-consistency**

| Task | Check | Result |
| --- | --- | --- |
| T1 | TS canonical Article equals the Python dump for every accepted contract case; categorical verdicts equal the Python fixture; wire example exact; no invented values | Tested in both languages from one fixture; `context_tokens` under full is the one documented canonicalization (discrepancy 8) and does not occur in the fixtures. |
| T2 | Additive nullable columns only; backfill touches object documents without the member only; replay-safe | Static ops test + populated PostgreSQL check. |
| T3 | Strict document: structural → 400, cross-field → 409, stored canonical = returned = reloaded | Tests; Review Focus 5. |
| T4 | Replay before config; config compare and snapshot in one transaction under lock; identity refusal before enqueue; historical rows never replay | Integration tests incl. barrier in both directions. |
| T5 | Batch replay before config; selection hash includes canonical descriptor only; recipe slot refused for batches; suggested-batch replay unchanged | Integration tests. |
| T6 | Only the admitted snapshot reaches kei; old checkpoints → reference request; artifacts that ran another method refused | Unit, PostgreSQL and Studio restart tests; A1 checks. |
| T7 | Adapters add, never drop: effective options, versions, eligibility, proofs; no proof becomes a link; precision passes through | Adapter tests + Python regressions. |
| T8 | One draft owner; ordered keys; invalid children kept; number text never clamped; identity chips exact | Hook and helper tests; UI reachability over 6,144 inputs. |
| T9 | Disabled-with-reason only at the control whose rule breaks; parent changes allowed; invalid sections forced open; Apply blocked by any issue | Component tests. |
| T10 | Guide never edits the draft except "Use these settings", which requires the shown delta; Undo restores exactly; no claims | Component + content tests. |
| T11 | Summary and submission use the same state and function; 409 starts nothing and offers refresh | Component/hook tests. |
| T12 | Requested vs effective; FAILED → "Effective method unavailable"; NULL → "Not recorded" | Component tests. |
| T13 | Browser/real-service cases assert behavior, not markup | e2e tiers. |
| T14 | Docs describe released behavior; links resolve | Link check. |
