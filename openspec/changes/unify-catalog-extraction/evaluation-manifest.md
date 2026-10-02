# Evaluation manifest (draft, not frozen)

Date: 2026-09-29. Status: **draft; not registered.** The researcher registers
the families, splits, labels, thresholds and model configurations below, and
freezes this file (commit hash recorded here) before any held-out result is
inspected. Nothing has been evaluated; no threshold below is chosen yet.

## Families

A family is one publication or series, never pages of one book split at
random. Each needs a development part and a held-out part.

| Family | Numbering / script | Layout traits | Source | Development | Held-out | Status |
| --- | --- | --- | --- | --- | --- | --- |
| German numbered catalogue (Beier) | decimal, Latin | headings, glossary, cross-page entries | original PDF outside the repository (`PARSING_FIXTURE_DIR`) | regression only | — | regression fixture, not evidence for cutover |
| _to register_ | unnumbered | | | | | missing |
| _to register_ | alphanumeric or restarted labels | | | | | missing |
| _to register_ | non-Latin script | | | | | missing |
| _to register_ | table catalogue | dense tables, cells | | | | missing |
| _to register_ | nested lists, multiple entries per segment, OCR layout | | | | | missing |

Every family also needs very long entries, late document fields, repeated
values, conflicting candidates and nested arrays, including labelled
cross-window partial items.

## Labels

Per held-out document, by people, before the run: entry boundaries (canonical
ranges), field values per entry with their supporting ranges, document fields,
and the list items known to cross a window cut at the registered budgets.

## Metrics (reported per family)

- Boundary precision and recall against labelled entries.
- Field quality against labels; evidence precision of accepted values.
- Partial-item rate: partials count as unresolved — never correct, never
  wrong — and stay in the expected-item recall denominator.
- Processing coverage: unresolved ranges, failed windows, undecided
  verifications, document-field processing.
- Calls, input/output tokens and latency per stage, document fields included.

## Thresholds (to register before the held-out run)

| Family | Boundary P / R | Field quality | Evidence precision | Max partial-item rate | Max unresolved range share | Baseline compared |
| --- | --- | --- | --- | --- | --- | --- |
| each registered family | _blank_ | _blank_ | _blank_ | _blank_ | _blank_ | legacy generic Catalog; the numbered recipe only on its own family |

## Model configurations

Two role-correct configurations (fields, reasoning), both served with
`/tokenize` and a reported context size: _to register_. An unavailable model
is an unmet gate, not a pass.

## Registered method

Unified Catalog defaults version 1 (`unified.DEFAULTS[1]`), prompt version 1,
discovery version 1; budgets as registered here. Tuning uses development parts
only.
