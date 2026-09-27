# Design

## Context

See proposal.md and the dated execution plan. The baseline is FREE `6e641b6`:
Article inventories, extracts and grounds over the whole source; recipe Catalog already
has bounded calls, primary spans, heading state and checked candidates. The prior
six-paper evaluation is development evidence and combines multiple changed factors.

## Goals / Non-Goals

Goals: explicit stage contracts, reproducible named method variants, canonical provenance,
bounded experimental Article execution and controlled Article/Catalog studies.
Non-goals: a new workflow service, plugin framework, automatic production deployment,
unlabelled accuracy claims, or calling an adaptation a faithful paper reproduction.

## Decisions

1. **Refactor before algorithms.** Move Article inventory to `extract/article.py`; keep
   shared model calls/field extraction/grounding reusable. Then make Article orchestration
   explicit. Move definitions and callers together, with no compatibility re-export layer.
   Capture fixed-response behavior at baseline and compare the refactor before adding arms.
2. **Named method settings.** Validated settings select actual factors, never a collection
   of hidden fallback flags. Complete-source Article remains reproducible. Experimental
   settings travel through the same extraction entrypoint and participate in fingerprints.
   Defaults remain stable until measured evidence supports a change.
3. **Bounded units retain source identity.** Context consists of canonical segment/span
   references with primary ownership and optional neighboring context. Splitting must retain
   exact source offsets. A refusal or omitted context is explicit; no inferred geometry.
   Units are deterministic, use actual endpoint counts and preserve tables when possible.
4. **Identity is separate from values.** Provisional records retain labels, typed attributes
   and support. Equal partial attributes are not enough to merge distinct occurrences.
   Complete declared identity dimensions permit reconciliation across disjoint units. Partial
   keys also require the same label and supporting passages; conflicts remain inspectable.
   Gold identities never enter runtime configuration.
5. **Context selection is measurable.** Full source and bounded ownership/context are distinct
   settings. The first bounded assembly visits every unit for every record; it has no ranking
   heuristic that can silently omit a late measurement. Record units and budget refusals.
   Shared methods/qualifiers are context, not proof of applicability.
   A separately registered selector retains whole value units owning inventory support,
   adjacent canonical passages and at most one schema-relevant unit. It exposes omissions
   without concatenating noncontiguous text. Inventory/document/verification coverage stays
   fixed. R2a compares value selection with captured responses and grounding disabled in
   both arms; exact original bounded replay is its integrity gate. This conditional estimate
   cannot establish fresh model variability or end-to-end verification effects.
6. **Verification is a stage.** Article semantic-label, quoted-support and disabled policies
   preserve raw values and evidence distinctions. Quoted support checks exact source substrings
   and records model-attested attribution; it does not independently establish entailment.
   Catalog retains its deterministic candidate checks. A disabled verifier cannot manufacture
   accepted evidence. Structured checks and source location remain distinct from semantic truth.
7. **Catalog reuse.** Keep structural recipes and accepted/proposed/rejected outcomes. Expose
   glossary/context/heading factors without forking the entire extractor; fingerprints include
   every effective setting. Concurrent scheduling is a separate experiment from semantics.
8. **Study package.** `experiments/extraction/` owns manifest validation, execution/capture and analysis,
   outside the serving package to keep research orchestration out of runtime imports.
   It uses the production extraction entrypoint with explicit settings. Inputs and results
   are immutable; resumable cells are keyed by all effective inputs. Credentials and runtime
   connection headers are not capture artifacts. Original evaluation gold/scorer remain intact.
9. **Experimental validity.** Existing inspected papers stay development data. Freeze schemas,
   models, source generations, comparisons and scoring before live arms. A one-factor arm
   must differ in exactly its declared factor. Whole-pipeline baselines are labelled separately.
   Use per-document paired effects; repetitions of greedy calls test reproducibility. Failed
   cells are visible and stay in coverage/refusal denominators. Exact replay is not repetition.
10. **Metric boundaries.** The user confirmed no independent annotations are available. The
    frozen collagen projection therefore supplies the primary available accuracy measure,
    paired by document, while generic coverage, links and costs are diagnostics. Count unmatched
    records/extra observations separately. Unknown gold completeness produces
    unscored predictions, not fabricated true/false labels. Synthetic adversarial fixtures
    validate code behavior, not real-model generalization. Human adjudication is a named gate.
    Grounding runs do not alter raw record values: differences in raw accuracy between those
    arms reflect independently regenerated upstream replies, not a downstream correction.
    Interpret grounding effects on identical upstream records separately when reporting results.
11. **Preserve structure in model input as an independent factor.** The Docling audit found
    that source storage retains labels and table cells, while inventory/value prompts flatten
    them. Add an opt-in Article renderer over the existing canonical passages: block IDs,
    labels and pages, plus cell IDs, row/column positions, spans and available roles. Wrap
    the exact canonical text without inferring missing cells, headings, captions or geometry.
    Keep plain reference requests byte-identical. Document, inventory and value calls use
    the selected rendering, including tokenizer admission; grounding's existing cell-aware
    renderer stays unchanged. Fingerprint the rendering and its version. Semantic grouping
    remains a separate hypothesis. Register a fresh paired rendering comparison before
    inference; changed prompts cannot reuse old replies as treatment observations.
    Hypothesis: explicit types and spans reduce header/subject ambiguity, at the cost of
    more tokens and possible refusals. Existing R1 and R2a inputs stay frozen.

12. **Act on observed failures without rewriting the study.** A separate development
    checkout implements fixes while the pinned runners finish. Quoted verification
    uses one object-output instruction and checks literal source substrings (LMDX
    Algorithm 2), rather than case/whitespace-normalized matches. JSON decoding
    permits literal control characters inside strings, preserving them exactly;
    it does not repair missing syntax, truncate data or accept length-cut replies.
    This narrowly defined decoder extension handles the observed source-copying
    failures and is recorded by a new protocol version. Historical captures remain
    unchanged; offline decoding is not fresh model evidence.
13. **Structure guides bounded units.** Inspired by BLOCKIE's linked atoms, an
    independent `grouping=structural` factor uses existing labels, not an LLM
    rewrite: keep a table with immediately adjacent captions/footnotes, keep a
    heading with its first body block, and carry the latest heading as explicit
    context into continuation units. Preserve canonical order and single primary
    ownership. Headings have no reliable hierarchy in this representation, so do
    not invent one. Refuse an indivisible group plus its required heading when it
    cannot fit. This is deterministic layout-based grouping, not proof that a unit
    is semantically independent or a full BLOCKIE replication. References:
    https://arxiv.org/html/2505.13535v1 and https://arxiv.org/html/2309.10952v2.

## Risks / Trade-offs

- Bounded selection loses cross-section evidence → measure source coverage and field changes,
  retain full-source reference, keep selection provenance and do not silently fall back.
- Conservative identity matching leaves duplicates → expose collisions; compare duplicate
  and missing-record effects rather than optimize a single projected score.
- Small development corpus → report document counts and uncertainty, defer generalization
  conclusions until genuinely independent labelled documents exist.
- Live model availability/long calls → preflight endpoints, retain immutable cell status and
  exact captures, resume only verified cells; no model-service mutations.
- Too many independent controls → implement only factors with a registered hypothesis and
  comparison; ordinary functions and small typed records remain the architecture.

## Migration and verification

No database migration is expected. Existing source/result and worker contracts stay pinned.
Run the relevant unit and adapter suites after refactoring; use integration tests if workflow
behavior changes. The study writes into a dedicated artifact root, never prior baseline arms.
Deployment remains a later action. Maintain task status and the execution plan as gates close.
