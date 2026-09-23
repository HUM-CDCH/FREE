# Grounded numbered-catalogue KIE: validation record

Created: 2026-09-23. Status: **M0–M5 implemented and tested; M6 and M7 partial
(data-independent parts only); M8–M10 not started for lack of data.** Nothing
here is a measured accuracy, coverage or confidence claim for a real
catalogue.

Plan: [grounded KIE for long scanned catalogues](../plans/2026-09-23-grounded-kie-opus-5.5.md).
Contract: [grounded catalogue design](../../prototypes/parsing_service/docs/superpowers/specs/2026-09-23-grounded-catalogue-design.md).
Product decisions: [OpenSpec change](../../openspec/changes/grounded-numbered-catalogue/proposal.md).
The implementation ledger (every ruling and the review consensus) is in
`.superpowers/sdd/2026-09-23-grounded-kie-opus-5.5/progress.md` in the working tree.

## Change under test

Branch `feat/kei-exp-parser` at `3801f7b`, plus the uncommitted working tree:
nothing in this record is committed. The earlier uncommitted prompt-v4,
launcher and fixture changes are preserved.

## What exists

- **Canonical evidence identity.** Extraction reads verified canonical page
  files: segment id `p{page}_s{index}`, unit (book page of a spread), crop and
  status. Spans are half-open Unicode code-point ranges over the segment text.
  Studio uploads choose single pages or two-page spreads, and the choice is
  recorded in the parse recipe.
- **Recipe segmentation.** `numbered-catalogue-de@1` holds structure rules
  (entry markers, heading levels, sections, glossary syntax) and field
  bindings.
  - The segmenter assigns exactly one role to every non-blank line.
  - Start roles are resolved by an exact minimum-exception reading of the
    numbering.
  - Ambiguous cases are reported (`ambiguous_start`, `potential_duplicate`,
    unclassified headings); none is guessed.
  - Result: an immutable segmentation artifact per parse generation and recipe
    structure, with a coverage ledger. It makes no model calls.
- **Grounded extraction (result version 2).**
  - One bounded call per entry, or per window of an oversized entry.
  - The code verifies every candidate, which ends up accepted, proposed or
    rejected.
  - Structural fields (printed label, inherited headings) never come from the
    model. A keyed field is accepted only after its recipe key.
  - Every request is counted with the served model's own tokenizer before it
    is sent. An endpoint without one is refused.
  - Completeness is reported per dimension (processing, coverage, grounding).
    Recall is always `unmeasured`.
- **Studio.** A per-Extraction "Record boundaries" choice (D1). The job stores
  it and the result pins it.
  - v1/v2 results decode through a version-discriminated union, so accepted v1
    artifacts read unchanged.
  - A read-only "Recipe review" panel shows coverage, processing, proposals and
    rejections, and states that recall is not measured.
  - Each v2 value gets a caption saying what tied it to its field, and gives
    its glossary expansion when the document's glossary defines it.
- **Evaluation machinery (M6).** `python -m kei_exp.kie.boundaries
  report|prefill|score RUN_DIR`.
  - The frozen block-F1 matching `exact-line-set@1` is in design §9, with a
    boundary/interior breakdown.
  - Seeded stratified page sampling picks the 20 pages.
  - A pre-fill for reviewers records the segmentation it came from and is never
    gold.
  - The command reads the run and never writes into it.

## Verification (2026-09-23)

Backend and unit tiers ran on the DGX Spark from a separate synced directory.
PostgreSQL and browser tiers ran locally against disposable targets.

| Tier | Where | Result |
| --- | --- | --- |
| `pnpm test:unit` (all packages) | Spark | parsing-service 799 passed / 75 skipped; Studio 96 files, 1047 tests; db 53; extraction 31; export 33; scripts 44 + 4 |
| `pnpm typecheck`, `pnpm lint`, ruff | local | exit 0; 0 errors (3 pre-existing hook warnings); clean |
| `pnpm test:safety`, `pnpm build`, `pnpm architecture:check` | local | 14/14; built; valid |
| parsing-service PostgreSQL tier | local | 111 passed, 4 skipped (optional research PDFs absent) |
| job recovery incl. opt-in database outage | local | 6 passed |
| extraction PostgreSQL integration | local | 22 passed |
| db project-store check | local | 3 passed |
| `pnpm test:e2e` (ordinary browser cases) | local | 50 passed, 1 skipped (developer-UI profile only) |
| `pnpm test:service` (scripted model boundary) | local | 2 passed — see below |
| live model (qwen3:8b, Ollama 0.34.2) | Spark | 9 passed: tokenizer counts equal served counts, and the grounded continuation fixture |

**Final review.** An independent read-only review (Codex) found six major and
three minor defects:

- a model boolean was accepted without evidence;
- window cuts could manufacture token and key boundaries;
- rounded, truncated or unsigned numbers were accepted;
- structural values ignored field types;
- duplicate observations were compared across pages;
- a cached counter kept a stale context size;
- calibration requests went unreported;
- normalization metadata was stripped;
- an empty pre-fill crashed.

Each was reproduced and fixed test-first. Four follow-up rounds tightened the
fixes; the last round found no remaining acceptance defect.

One review point was kept as a ruling, not fixed: a number before `/` is still
found. The real catalogue prints pairs such as `0,6/0,7`, and telling a
fraction from a pair is recipe-specific typing (M7).

A second, independent whole-branch review (three rounds) found four more major
defects:

- a native list item that had lost its number was absorbed into the entry
  before it;
- reading-order disagreements did not affect coverage and never reached Studio;
- non-object and `null` replies counted as successful processing;
- a candidate without provenance could make the TypeScript decoder reject the
  whole result.

It also found gaps in the artifact checks. All were fixed test-first; its last
round found no remaining defect.

The table above shows the results after all review fixes. The rulings are in
the ledger.

**Real-service browser workflow (scripted model boundary).** A real two-page
native PDF runs through the real API, worker, PostgreSQL and authenticated
Studio:

1. The upload is parsed.
2. A recipe Catalog extraction runs; the expected results:

   | Record | entry_no | kreis | fundart | site_name |
   | --- | --- | --- | --- | --- |
   | 1 | 31 | Heide | G | null |
   | 2 | 32 | Heide | EF | null |

3. The 6 evidence links have exact `linkedBy`, provenance and page:
   - entry 32's `FA:` value is grounded on page 2;
   - both Kreis values are inherited from the page 1 heading.
4. The two site names are proposed and never accepted.
5. It makes 2 model calls, counted by the vLLM-style `/tokenize` counter.
6. The review is saved.
7. After an API/worker restart the artifact is byte-equal and the segmentation
   directory is unchanged.
8. Browser evidence navigation focuses page 2 for `fundart` and page 1 for
   `kreis`, and the captions are visible.

The original Article/Catalog workflow still passes unchanged.

**Not covered by the browser test.**
- Two entries inside one segment: a native PDF cannot produce it, because
  Docling joins paragraph lines. That case is covered by the service fixture
  and the real scanned run below.
- A real model on the recipe path: that is the live service test on Spark.
- The scanned/spread upload path.

## Real catalogue: what is and is not known

The one full-catalogue observation is a local in-memory segmentation of an
existing Surya run (`20260921-150840-surya-df0d`, generation
`…547953a5`). That run was produced by kei-exp before this branch, so it says
nothing about FREE's own scan/spread upload path.

| Measure | Value |
| --- | --- |
| Time | 0.35 s |
| Lines | 3360 |
| Blocks | 373 (entries 1..378) |
| Continuations | 67 |
| List items | 70 |
| Unresolved lines | 140 |

The 140 unresolved lines by reason:

| Reason | Lines |
| --- | --- |
| Scoped `a`/`u` series and addendum (D4) | 92 |
| Orphans before the first entry | 17 |
| Numbering outliers that look like OCR misreadings | 11 |
| Backward labels | 7 |
| Duplicate identities | 6 |
| Orphans after a heading | 4 |
| Unclassified headings | 3 |

46 blocks have no inherited heading, after 3 heading hints.

These figures predate the final-review fixes. Only the duplicate-observation
fix touches segmentation, and it cannot change a spread run: there, each unit
is a book-page number, unique to its PDF page.

Expected coverage is **unknown**: no inspected ground truth exists, and the
segmenter's output is not used as its own gold standard. In this session the
auto-mode permission classifier refused re-reading that run, so `boundaries
report` and `prefill` have not been run on it.

## Missing evidence and next gates

- **M6 Phase 1 gate** needs three things:
  - a full scan/spread run through FREE (Surya on GPU plus the source PDF);
  - a reviewer correcting 20 pre-filled pages;
  - labelled lines for an OCR comparison against a second engine.

  Commands, once the run is available:
  `uv run python -m kei_exp.kie.boundaries report RUN_DIR`, then `prefill RUN_DIR > labels.json`,
  correct `entry` per line, then `score RUN_DIR labels.json`.
- **M7:** only glossary normalization exists. Map sheets, coordinates,
  inventory numbers and citations need inspected examples. Real line or
  character alignment, crop re-reads, full evidence cards and UTF-16 span
  highlighting are not implemented.
- **M8–M10:** 200 corrected entry annotations with agreement, frozen
  partitions, model and scheduler comparisons, calibration, a second catalogue
  and 4090 throughput. None exists; no target is reported as met.
- **Open product decisions:** D2 (binding editing), D3 (schema confirmation),
  D4 (scoped identity for restarts and prefixed series).
