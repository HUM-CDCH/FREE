# Legacy and compatibility removal plan (2026-11-15)

Decision this plan serves: FREE is not in production, so the tree keeps no code that exists only to read old runs,
old settings or historical generations. Stored dev data need not stay readable; no version flags replace removed code.
Status: tier 1 landed first on this branch; tier 2 (migration `20261116T0040_retire_legacy_contracts`) and tier 3 (unified as the only Catalog, migration `20261116T0847_unified_catalog`) were then merged in from their own branches. The tier 2 and 3 tables are the survey as written, not a checklist of what landed. Original base: `origin/dev` at `dd54a55b`; grounding items also read PR #390
(`codex/record-aware-grounding`), which another session owns.

## The finding that reorders everything

The "legacy" generic Catalog (`catalog.extract`, result version 1) and recipe Catalog (`grounded.extract`, version 2)
are **not legacy in practice: they are the default deployed method.** The unified Catalog runs only when Studio's
environment sets `FREE_CATALOG_METHOD=unified` (`packages/extraction/src/extraction-method.ts:171`); `compose.yaml:173`
leaves it empty, `tests/safety.test.mjs:632` asserts that, and `.env.example:59-63` says not to set it before the
unified method passes an independent held-out evaluation. Every batch and every single Catalog Extraction without a
recipe runs the generic executor today. Removing them is therefore a product decision (ship unified as the only
Catalog), not a cleanup. It is tier 3 below; nothing in tiers 1-2 depends on it.

Article is not legacy either: it is the only document-scope method, and its version 1 artifact (`assembly.py`) is the
one it writes today. What is legacy is a set of vestiges inside it (rows 2.4-2.6).

## How stored data is handled

Run directories need nothing: the pipeline already refuses old formats (`pagefile.py:239` accepts result version 5
only, `segmentation.py:141` likewise) and reruns stale ingest stages. The dependence is all in Postgres: pinned
`requestedSettings`/selection options, account `modelConfiguration.extractionSettings`, dead columns and DBOS
checkpoints. Instead of one data migration per item, the plan is **one Prisma migration per tier that drops dead
columns/tables and sets `NOT NULL` where a null meant "old row", plus a dev-DB reset (or a delete of the rows that no
longer parse)**. Docker was not running during this survey, so no dev DB was inspected; the "dev data" column names
the tables and JSON fields that would hold old shapes, not counts.

DBOS: in-flight workflows started before a patch need that patch to replay. Drain the queue or reset the `kei_dbos`
and Studio DBOS system schemas before removing patch calls (rows 1.6, 2.9).

## Tier 1 — delete now (no decision, no stored data that matters)

| # | Path | Keeps working | Still called by | Deleting breaks | Dev data |
|---|---|---|---|---|---|
| 1.1 | `experiments/extraction/legacy_article.py` (historical identity inventory + exact-union assembly) and its replay chain: `fixed_upstream.py:79-84,109-112` (v1 / pre-resolution Article artifacts), `grounding_study.py` historical params | Replays of captured historical Article studies | Experiments only (`fixed_upstream`, `grounding_study`, `extraction_grounding_replay`, `study.py`); tests `test_article`, `test_extract_stages`, `test_extraction_methods`, `test_extraction_routing`, `test_list_occurrences`, `test_grounding_study` (params 1/10/11) | Those test imports: tests of `reconcile_values`/`inventory` go; `grounding_study` keeps running on current artifacts only | Captured cells outside the repo |
| 1.2 | `routing.value_origins` without `item_sources` (exact-union origins) | `legacy_article` and single-reading Article | Production: `article.py:333` passes `None` when there is one reading; `legacy_article.py:109`; tests in `test_extraction_routing`, `test_grounding_progress`, `test_article_occurrence_origins:55` | After 1.1: make `item_sources` required, have `article.py:333` always pass it; check the single-reading case keeps its index-preserving origins (`test_article_occurrence_origins`) | none |
| 1.3 | Stale-page `article: null` admission (`postgres-admission.ts:62-80`, `canonicalIntent` null branch) | Browser tabs opened before Article defaults were recorded | Studio admission | Its tests | none |
| 1.4 | Older-client/server fallbacks (`recentActivity.default([])`, optional `trial` + size fallback, "older server" null branches) | Deploy skew | Studio UI/API; the server always sends both fields | Their tests. Keep `?latest=1` (a real feature) | none |
| 1.5 | Dead `ExtractionErrorCode` members (`grounding_failed`, `not_reviewable`, `invalid_review`, `batch_*`, `catalog_discovery_failed`, `extraction_failed`, `catalog_no_records`, `cancelled`, `review_conflict`, `invalid_source_representation`) and the dead case at `api/extractions.ts:42`; `types.ts` `verbatim?` and never-produced `citation_lexical` | Nothing | Types/comments only | Type narrowing only | none |
| 1.6 | DBOS: `DBOS.deprecate_patch("extract-wait-first")` (`durable_extract.py:325`), `priority = 0` / `.get("priorities", {})` defaults (`:256-261,377-378`); Studio patches `WINDOWED_SUGGESTION`, `BATCH_WINDOWED_SUGGESTION`, `SCHEMA_CHAT_ANSWERS`, `RETAIN_FAILED_SOURCE`, optional `sourceCoverage`/`history` in checkpoints | Replay of workflows started before each patch | Every durable attempt (the patch call), never the old branch | Nothing found | In-flight DBOS workflows: drain or reset first |
| 1.7 | `unified.py:275-277` `"extraction_id": None` in the v3 execution record | Vestigial field | Production artifact | Fixtures `extract.result.v3.json:267`, `extract.gliformer.json`; no TS reader | none |
| 1.8 | Upgrade-only test cases: `test_durable_extraction.py:392`, `test_durable_calls.py:160-170` (`schema_visible=False`), `test_article_resolution.py:672` | Attempts carried across upgrades | Tests | — | — |
| 1.9 | Separate Article plan stage `article-contexts:fallback` (`article.py:132-137`) | Attempts planned before Article v10 | Production (stage name only) | Possibly a stage-name assertion | Old plans |
| 1.10 | "Legacy" wording where the thing is live: `schema.py:93` and `run.py:104` (a schema without `recordScope` is a live Studio draft state — `project-store.ts:706` — refused at admission with `record_scope_required`; only the CLI and harness reach Python without one), stale comments `stages.py:60`, `pagefile.py:132`, `docs/extraction-experiments.md:56,69-71` | — | — | — | — |

**Tier 1 status (done on this branch).** All rows landed except these, which stay with a reason:
- 1.3: `canonicalIntent`'s `article: null` branch stays; `durable-repository.ts` replays stored `{article: null}` pins through it, so it moves to 2.2.
- 1.4: `chatGuide.ts` `exportableResults` still handles a null `project.latest` (now unreachable); removing it means rewriting the chatGuide and RailChat fixtures.
- 1.5: `EvidenceLink.verbatim` stays optional; Studio's own provisional marks (`provisionalMarks.ts:37`) omit it, so it is not an "older links" field.
- 1.8: `test_article_resolution.py:672` stays; it tests request-keyed call reuse, a current property.
- 1.10: `grounding.py`'s module docstring line on `linked_by: "lexical"` is left for PR #390's session.
- Also: `BatchSourceCoverage.combined: false` is no longer produced but is still read from stored rows (Tier 2).

## Tier 2 — delete with a migration (drop columns or refuse old JSON; reset dev rows)

| # | Path | Keeps working | Still called by | Deleting breaks | Dev data that depends on it |
|---|---|---|---|---|---|
| 2.1 | Unified defaults versions 1-4 and 6-9: `unified.py` `DEFAULTS` (l.109-193), per-version prompt/discovery mapping (l.275-293), `defaults>=5/9` branches, pinned old prompts incl. v7 `ENTRY_HEADING`/`VERIFY_HEADING`, feature `.get()` fallbacks, version-gated `discovery.py` paths; TS zod union `extraction-method.ts:164` | Every unified defaults version ever admitted, replayed unchanged | New admissions use only 10 (and 5 for Pro mode); the rest serve old Extractions, tests, experiments `discovery_windows.py`, `entry_replanning.py` | **Largest rewrite**: `test_unified_catalog` helper pins `defaults: 1`; `test_unified_heading_context` (v7), `test_unified_single_pass`, `test_catalog_corrections`, `test_durable_entry_reuse`; shared fixtures `unified-catalog-options.json`, `gliformer-compatibility.json`, `extract.result.v3.json`, `extract.gliformer.json` | `requestedSettings.unified.defaults` ∉ {5, 10}; resume/retry of those rows fails |
| 2.2 | `{article: null}` replay / `UNRECORDED_ARTICLE` (`DurableInputs`, `AdvancedTab` `unrecordedArticle`, `methodSummary:68`); Python side `article.py:109` (`options.article or REFERENCE`) and the reference-case omissions in `article.py:199-218`, `assembly.py:86-99` | Resume/Retry of runs admitted before the explicit Article default | Studio UI; production via null settings; CLI and experiments | `test_article_grounding_scale.py:327` and fingerprint pins; the service default becomes Studio's (overflow windows) | `extraction`/`batchExtraction.requestedSettings = {"article": null}` |
| 2.3 | NULL `requestedSettings` shown as "Not recorded" (`storedSettings`/`recordedSettings`, `postgres-attempts:146`, `postgres-batches:28,119`) | Runs admitted before settings were recorded | Studio UI | Their tests | `requestedSettings IS NULL` → delete rows, `SET NOT NULL` |
| 2.4 | Retired Article keys: `ADDITIONAL_ARTICLE_KEYS`/`RETIRED_ARTICLE_KEYS`, "Additional saved settings", "(retired)" guide topics; Python `method.py:22,49-51` `grounding_routing` (`article.py:329-331`) | Saved values for controls the UI no longer offers | Studio UI and admission | `test_extraction_routing.py:168`; must change with `ArticleOptions` in the same PR | `extractionSettings.article.{selection,identity,identity_fields,prompt,grounding_schedule,grounding_routing}` |
| 2.5 | Article identity inventory that is never sent: `article.inventory_request` (`article.py:344-392`), kept to size bounded contexts as old runs did; `method.py` `identity`, `identity_fields`, `prompt`; artifact field `inventory` (`article.py:190`); `run.py` `_identity_fields_exist` | Bounded-context boundaries identical to version 1 Article | Production bounded sizing; Studio Advanced settings and guide | `test_article`, `test_extract_stages`, `test_extraction_methods`; experiments `study.py`, `occurrence_study.py`. Sizing by the direct budget changes boundaries and fingerprints | Settings carrying these keys (with 2.4) |
| 2.6 | Pre-durable Extraction model: columns `outcome, complete, failure, modelAttribution, diagnostics, resultPayload, evidenceLinks, reviewable, reviewedAt, reviewDraft*`, enum `ExtractionOutcome`, tables `ExtractionReview`, `ReviewDecision` | Pre-durable rows, ignored by readers | Only `seedPreMigrationHistory` (8 postgres checks) and `project-store.postgres.check` | Rewrite the history fixture | Those columns/tables |
| 2.7 | Sample columns `requestedPages`, `reviewTransfer`, `reviewPairings`, `carriedFrom` and the `sameAdmission` null check (`postgres-admission.ts:200,216,240`); `BatchSchemaSuggestion.draftVersion`, `batchExtractionId`; `AnnotationSetRevision` table and the reopen API's `annotationSet` field | Old sample/suggestion/annotation rows | Admission null check; reopen API; one test fixture | Small | Those columns/table |
| 2.8 | Tolerant readers: source coverage (`batch_schema_suggestions.ts:51-56,86-94`, `document_reopen.ts:52-57`, `project-store.ts:136-140`), retired project-chat kinds (`project_chat.ts:24-28`), spreadsheet non-strict column and NULL `rows` | Old `coverage`/`modelAttribution`/draft shapes, old chat entries, old uploads | GET APIs; the Python `eval_watcher` reads spreadsheet `rows` | Parse strictly; coordinate `rows` with `eval_watcher` | `batchSchemaSuggestion.coverage/draft`, `schemaRevision.modelAttribution`, `projectChatEntry.entry`, `projectSpreadsheetVersion` |
| 2.9 | Migration-backfill checks and `seedPreMigrationHistory` | Tests that backfills work on old-shaped data | Tests only | — | Optional: squash migrations into one baseline and reset dev DBs, which also removes most of 2.6-2.8's per-column work |

## Tier 3 — needs the owner's decision first: unified as the only Catalog

Do this only after deciding to drop the `FREE_CATALOG_METHOD` gate against the `.env.example` evaluation warning.
TypeScript lands first (admission stops offering generic/recipe), then Python deletes the executors.

| # | Path | Still called by | Deleting breaks | Dev data |
|---|---|---|---|---|
| 3.1 | Studio/packages: `FREE_CATALOG_METHOD` gate, generic/recipe settings schemas and slots, `catalogRecipes.ts`, `catalogRecipe` field, `SchemaPanel` Boundaries selector (`:902-917`), `App.tsx:678-683,886,1175`, `AdvancedTab` `CatalogSettingsView`, kei-evidence v2 links, `_deployment_models`, unified Playwright config (becomes the default suite); the "migration required" bridge (`legacyCatalogOverrides`, `catalog_migration_required`, `SavedMethodSummary`, `retiredCatalog`) | **Production default** | Default e2e suite and lifecycle scenarios for generic/recipe; `tests/safety.test.mjs:632` | `extraction.catalogRecipe`; `requestedSettings` `{generic}`/`{recipe}`; account `catalog.generic/recipe` |
| 3.2 | `run.py`: `Options.discovery_chars`/`record_chars`, `Options.catalog`, `_unified_stands_alone`, `_recipe_is_known`, the `dumped()` branches, `dispatch`'s generic/recipe arm; `unified` becomes the Catalog (no `options.unified` switch, no version flag); CLI `main()` sends the unified method | Production default; CLI (generic only) | `test_extract_options`, `test_record_scope` | as 3.1 |
| 3.3 | Generic Catalog: `extract/catalog.py`, its parts of `assembly.py`, `grounding.GROUNDING` and the non-projected `verify` path (only the generic Catalog grounds unprojected: `assembly.ground_records` with no identities) | Production default (every batch) | `test_legacy_catalog_golden` (generic-v1.json), `test_extraction_checks`, `test_extraction_implementations`, `test_catalogue_fixtures`, `test_extract_stages`, generic params in `test_durable_extraction`; README:240-242 | as 3.1 |
| 3.4 | Recipe Catalog: `grounded.py`, `CatalogOptions`, `method.CatalogFactors`, `segmentation_run.py`, `segmentation.py`, `recipe.py`, `recipes/`, `stages/segment.py`, `stages/route.py`, `boundaries.py`, `durable_extract.py:23,125,283`, recipe-only helpers in `catalog_result.py`, `acceptance.py`, `windows.py` | Production when a recipe is chosen | `test_extract_grounded(_live)`, golden recipe-v2.json, `test_kie_segment`, `test_kie_route`, `test_kie_boundaries`, `test_segmentation_dependencies`, `test_catalog_chunks`, `test_tracing`, recipe params in durable tests. **Keep** `evidence_link`/`place`/`spans_json`, `Outcome`/`typed_value`, `windows.Unit`, `locate`, `blocks`: unified, discovery and gliformer import them | Rows pinned to a recipe; `<run>/segmentations/` become orphans |

## Keep, with reason

| Path | Why it stays |
|---|---|
| `grounding.py` `QUOTED_GROUNDING`, `SPAN_GROUNDING`, `off`, and (PR #390) the non-bundled "legacy label replies" fixed reserve | Live: Studio's Article "Verification" control offers Source labels / Generated quotes / Source spans / Off (`advancedSettings.ts:68-70`; the schema preset uses `spans`, `:163`). The fixed-reserve branch runs exactly for Article with quoted or spans. Removing them is a product choice about those options, and it belongs to the PR #390 session. `RECORD_GROUNDING` is the bundled default for Article semantic. |
| `schema.py` `record_scope: None` | Live Studio draft state until the researcher picks Article or Catalog; only the wording "legacy" is wrong (1.10) |
| Article (`article.extract`) and its version 1 artifact | The only document-scope method, written today |
| Unified defaults 5 and 10 | Pro mode and current |
| `gliformer-compatibility.ts`, `durable-feedback`/`durable-repository` correction compatibility, `historicalProposals`, retained-entry reuse ("historical" in `durable.py`, `retained.py`, `coordination.py`) | Capability checks and product features, not old-data readers |
| `effective()`'s `model_construct` over pinned options; `ArticleOptions` serializer dropping unset factors | ADR 0015 pinning; the canonical form shared with TS `canonicalArticle` |
| Tests asserting old shapes are refused (`model` option, legacy limits with unified, `adapterVersion`) | They guard the refusal, not the old shape |

## Suggested order

1. Tier 1 as one PR (Python + TS, no migration). Drain or reset DBOS before merging 1.6.
2. Tier 2 as one or two PRs with one Prisma migration and a dev-DB reset; 2.1 (unified defaults) is the bulk of the test churn and can be its own PR.
3. Tier 3 only on a decision to make unified the only Catalog; TS first, then Python.

Not checked: live dev-DB contents (Docker was down); whether any test asserts the `article-contexts:fallback` stage
name; multi-line `throw` forms in the error-code sweep; packages/db SQL routines beyond `git grep`.
