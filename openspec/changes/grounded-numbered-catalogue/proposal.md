## Why

Catalog extraction discovers records with one model call over labelled
parser segments. It cannot split two numbered entries inside one segment,
misreads grouping headings as records, and its `complete` flag says nothing
about source coverage. The [execution plan](../../../docs/plans/2026-09-23-grounded-kie-opus-5.5.md)
replaces discovery for numbered catalogues with a recipe-driven structural
segmenter, bounded per-entry extraction and code-verified span evidence. The
service contract is
[fixed beside the service](../../../prototypes/parsing_service/docs/superpowers/specs/2026-09-23-grounded-catalogue-design.md).

## What Changes

- The Parsing Service segments numbered catalogues without a model, publishes
  an immutable segmentation artifact with complete source accounting, and
  writes extraction result version 2 (span evidence, rejected candidates,
  competitors, coverage, separated completeness) when an Extraction names a
  recipe.
- Studio chooses single PDF pages or scanned two-page spreads at upload,
  decodes result versions 1 and 2, and shows rejected proposals and
  unresolved coverage in the existing review flow.
- Generic Catalog discovery remains the default and an explicit policy; it is
  not a fallback of the recipe path.

## Open decisions

These need the product owner before the default changes. The service and
Studio implement each as an opt-in until decided.

- **D1 Recipe selection — settled 2026-09-23.** Per Extraction: a choice in
  the Catalog run controls, stored on the extraction job and pinned in its
  result. Generic Catalog discovery remains the default.
- **D2 Field bindings.** Recipes bind heading kinds and the printed entry
  label to schema fields by exact field name. Decide whether researchers edit
  bindings in the schema editor instead.
- **D3 Schema.** The proposed 20-field archaeological schema is a research
  fixture, not FREE's schema, until confirmed.
- **D4 Scoped identity.** Real sources restart numbering by section (an
  addendum) and use prefixed series (`a 1.`, `u 1.`). Until a scoped identity
  is specified, those lines are reported as unresolved, not extracted.
- **D5 Token counting — settled by implementation.** A byte upper bound was
  replaced (review consensus C8): every request is counted with the served
  model's own tokenizer (Ollama's `/api/show` vocabulary, vLLM's `/tokenize`)
  before it is sent, and an endpoint without one is refused.

## Non-goals

Calibrated confidence, sub-line geometry, OCR engine choice, scheduler and
resampling experiments, and independent-catalogue evaluation are later
milestones (plan M7–M10) with their own evidence gates.
