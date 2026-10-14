# PR #267 Article resolution: annotated live-model comparison

Declared before any model call of this comparison. Nothing below changes after
the first call; any deviation is reported as a deviation.

## Question

At `e4516d3c` (resolver blob `df1f4810fbf71bc5bdb071b2953061d6f3e8eedc`), what
does Article resolution delete and what does it retain, compared with assembly
alone, on Articles whose own values and own list items are annotated? This is
the comparison named in the release hold on HUM-CDCH/FREE#267.

## Corpus and annotation

12 collagen journal articles with existing gold, frozen 2026-10-07 by the
ablation study (`artifacts/ablation-20261007`):

- Dev (6): `gold/gold_dev_corrected.xlsx`, blind-corrected from the supplied
  workbook, sealed in `dev-gold-seal.json`; human sign-off pending. 28 rows.
  Canonical parses: the 360-dpi re-parses (`ocr360-*`).
- Held-out (6, H1-H6): `gold/gold_heldout.json`, drafted blind by two agents
  from the PDFs only, sealed in `heldout-gold-seal.json`; human sign-off
  pending. 15 rows.

Own scalars: `paper_title`, `doi`, `year` of each paper (36 places; H3 prints
no DOI, so its own DOI is null). Own list items: the gold rows (43).

## Method

- Schema: the sealed ablation B1 schema (`title`, `doi`, `year`,
  `sample_records` with nested `amino_acids` and `thermal_data`), unchanged.
- Article, `context=bounded`, `context_tokens=12288` (ADR 0019's measurement
  size; production falls back to parts of the served 32,768 tokens, so this
  forces more parts and more resolution decisions than production would make on
  these papers), no overlap, plain-text rendering, no grouping or selection,
  `record_chars` 1,000,000 as sealed.
- Condition N, the deployment default routes: fields `numind/NuExtract3-FP8`,
  reasoning `nvidia/Qwen3.8-27B-NVFP4`.
- Condition Q, the sealed collagen configuration: fields and reasoning
  `nvidia/Qwen3.8-27B-NVFP4`.
- Served on Baratheon by the live vLLM servers; adapter defaults (temperature
  0, thinking off). One execution per paper and condition, no reruns, no
  best-of-N. Failures are reported, never retried by hand.
- Pairing: each run calls `article.document_root` once with resolution on. The
  harness wraps `resolve`: assembly alone is the assembled root handed to
  `resolve`, conformed as `resolve_parts=False` would leave it; the resolved
  result is the root `resolve` returns, conformed. Both come from the same part
  readings, so their difference is resolution alone. Grounding is not run: it
  attaches evidence and changes no value or item.

## Matching (deterministic)

- Title: equal after NFKC, casefold, whitespace collapse and stripping a
  trailing period. DOI: equal after removing a leading `https://doi.org/`,
  `http://dx.doi.org/`, `doi.org/`, `doi:` or `DOI` prefix, whitespace, and
  casefolding. Year: equal as an integer. A null reading equals a null gold.
- An item matches a gold row of its paper when the species matches (normalized
  as the title; equal, or one contains the other) and either a printed value of
  the item (`thermal_data[].value`, `amino_acids[].value`) equals a value of the
  row (`thermal_value_celsius`, imino, hydroxyproline or proline value) within
  0.005, or the row has no value and its tissue matches the item's. One item may
  match several rows. A gold row is covered when at least one item matches it.
- Every lost own row, every lost own scalar and every dropped item that matches
  no gold row is adjudicated against the source text and labelled. Adjudication
  is reported beside the gold-based counts, never instead of them.

## Measures (per condition, per paper and in total)

1. Valid-item deletion: gold rows covered under assembly alone and not covered
   after resolution; also own-matched item occurrences dropped while another
   copy of the same row survives.
2. Value retention: title, DOI and year places whose own value is present under
   assembly alone and after resolution; gains, losses and each other state
   (wrong value, null by conflict, null unread).
3. Genuine repeated occurrences: (a) gold rows matched by items from two or more
   parts, kept with at least one copy or lost; (b) own scalar readings the
   resolution prompt shows as printed several times, kept or not.
4. Unopposed scalars removed by `NONE`: places read by exactly one part, with
   every other part null, that resolution sets to null; own value removed versus
   another value removed. Unopposed scalars kept are reported too.

Also reported: unmatched items dropped and kept, UNSURE answers, resolution call
counts and failures, and part counts.

## Acceptance (every criterion, in each condition, on the sealed gold)

- A1. Valid-item deletion is at most 5% of the gold rows assembly alone covered.
- A2. Over title, DOI and year, resolution leaves the own value in at least as
  many places as assembly alone, and loses an own value assembly alone had in at
  most one place.
- A3. No gold row read in several parts loses every copy, and at most one own
  scalar printed several times is lost.
- A4. No own scalar read by one part alone is set to null by `NONE`.

If any criterion fails in either condition, the hold stays and the results are
posted without lifting it. A paper whose part calls all fail is excluded from
the counts and reported.
