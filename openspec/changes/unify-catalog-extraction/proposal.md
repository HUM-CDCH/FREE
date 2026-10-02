## Why

Researchers need one Catalog mode that processes the complete admitted source,
with useful controls on the Model Configuration page. Today FREE exposes two
implementations with different coverage and evidence semantics: generic Catalog
clips oversized record and document inputs, while recipe Catalog depends on
numbered-catalogue rules and still shortens document-level input.

Status: planning, 2026-09-29. Baseline: `dev` at
`80686ec4aea3f4a5d37dfcb643d29ac5a23e0ed3`. Requested by the researcher following
the discussion of [PR #150](https://github.com/HUM-CDCH/FREE/pull/150).
Implementation has not started. [discussion.md](discussion.md) records the
code-grounded exchanges with Claude Code `claude-fable-5-1`.

## What Changes

- Provide one Catalog implementation for new single and batch Extractions:
  source accounting, general record discovery, token-budgeted extraction of
  records and document fields, evidence validation and candidate reconciliation.
- Split oversized input into source-preserving windows; report any unprocessed
  ranges explicitly. Separate structural accounting, processing completion,
  evidence support and unmeasured semantic recall.
- Remove runtime dependency on a named catalogue recipe, fixed language,
  decimal numbering, domain field names or a particular extraction model.
- Replace Generic/Recipe settings and the per-run recipe selector with one
  Catalog configuration, preserving helpful budget, context and verification
  controls and the existing field/reasoning model choices.
- **BREAKING:** new Catalog admissions use a versioned unified method and result
  contract. Legacy recipe selectors and character limits cannot silently acquire
  new meanings. Preserve historical results, review decisions and replay of
  already admitted work through an explicit compatibility/cutover policy.
- Evaluate across independent document families and models; the German numbered
  catalogue remains a regression fixture, not the product's implicit template.

## Capabilities

### New Capabilities

- `unified-catalog-extraction`: general record discovery, complete budgeted
  processing, evidence and result semantics, versioned compatibility and
  generalization acceptance gates for the single Catalog mode.

### Modified Capabilities

- `advanced-extraction-configuration`: replace generic/recipe applicability
  with unified Catalog controls and define migration of saved preferences while
  retaining immutable admission, replay and requested/effective settings.

## Impact

- Parsing Service: `kie/extract/{run,catalog,grounded,windows,acceptance,
  catalog_result,tokens}.py`, source accounting and segmentation contracts,
  model calls and workflow execution compatibility.
- Extraction package: `extraction-method.ts`, single/batch admission and
  replay, `kei-artifact.ts`, handoff and result/review contracts.
- Studio: Catalog run controls in `App.tsx`, `shared/catalogRecipes.ts`,
  `providerConfig/{AdvancedTab,advancedSettings,useProviderConfigDraft}`,
  start summaries, result diagnostics and historical method display.
- Documentation and tests: root/service contracts, configuration specification,
  cross-language contract fixtures, diverse extraction evaluations and rollout
  checks. Exact database changes must follow the versioned method design rather
  than rewriting historical rows.
- Coordinate with active `grounded-numbered-catalogue`,
  `modular-extraction-ablation-study` and `sample-extraction-workbench` changes.
  This proposal does not edit their work or implement page-scoped extraction.
