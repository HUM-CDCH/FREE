# Slopo consensus triage — 2026-08-23

Source: `.slopo/pipeline/results/consensus.md`, initially generated 2026-08-22
and rerun 2026-08-23 after parser consolidation. Native Slopo hashes were
resolved from exact source-member locations, rather than assuming ensemble
ranks matched native report filenames. Parser-service rows were reconciled
after the full and simple implementations became the single
`prototypes/parsing_service` boundary.

Verdicts:

- **Refactor**: real duplication worth changing.
- **Intentional**: the same behavior is deliberately local to an independent
  prototype, authorization boundary, adapter, or package boundary.
- **False positive**: superficial, idiomatic, or layer-shaped similarity with
  different responsibilities.
- **Resolved**: the duplication disappeared because one obsolete implementation
  was removed.

## Decisions

| # | Consensus ID | Verdict | Reason / task |
|---:|---|---|---|
| 1 | `dfd7778ecca0b87f` | Refactor | Nested lease-renewal callback; covered by T1. |
| 2 | `ada65d8d14c0c077` | Intentional | Tiny record guards are local narrowing primitives; centralizing three lines across browser, server, extraction, and export packages would increase coupling. |
| 3 | `2d7f76662b4a2b5e` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 4 | `58f14ea07bcb256c` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 5 | `e02d92070a565d2d` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 6 | `7cea32c85722e150` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 7 | `d882da1cb6f70817` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 8 | `44a2b06fabb5c141` | Refactor | Identical stable JSON serialization in two PostgreSQL packages; covered by T2. |
| 9 | `beb507b4abe65256` | Refactor | Nested stable-JSON entry serialization; subsumed by T2. |
| 10 | `2a28ae330973a349` | Refactor | Identical PostgreSQL unique-constraint detection; covered by T2. |
| 11 | `be5bd509035362ec` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 12 | `2fcd60ab828b5d6c` | Refactor | Same deterministic UUID algorithm in `db` and `extraction`; covered by T2. |
| 13 | `2fe2d53541929572` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 14 | `acc8cb1452cc1bff` | Refactor | The simple service defines UTC formatting twice internally; covered by T3. |
| 15 | `e4afa4171f6863f6` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 16 | `2ee6b9a7df7ecd52` | Refactor | Exact ID-availability query repeated by three persistence roles; covered by T4. |
| 17 | `af710c32a5be1f24` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 18 | `e60691b0fd74c636` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 19 | `8362795ea5ae3be9` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 20 | `6c05aa97e376ebe1` | Intentional | Failure-code selection is domain-specific; only the short durability envelope is similar. |
| 21 | `d3fb063977f0409c` | Refactor | Review result-path validation is duplicated inside persistence roles; covered by T5. |
| 22 | `3da70ea49efe9609` | Refactor | Input materialization and canonical artifact decoding repeat across three persistence roles; covered by T4. |
| 23 | `6feead353bf95c95` | Refactor | Review occurrence-ownership validation is duplicated; covered by T5. |
| 24 | `21e0100c40348d29` | Refactor | Terminal Extraction insert/replay/conflict logic is repeated across three persistence roles; covered by T6. The `module.ts` member is orchestration, not part of the extraction target. |
| 25 | `d77f7029dcbc50ed` | Refactor | Batch opening and replay/conflict logic is repeated with only authority/read differences; covered by T7. |
| 26 | `ec251bb23828ca21` | Refactor | Lease timer body; subsumed by T1. |
| 27 | `e8106c30ba2292f8` | Intentional | Typed SQL joins express different ownership and projection queries; extracting query fragments would obscure their relational shape. |
| 28 | `4acb9019163cae83` | Intentional | Similar typed SQL projections serve distinct queries and result shapes. |
| 29 | `c43bcb485ccf275e` | False positive | Persistence-to-domain mapping and HTTP-to-JSON mapping are different layers; ISO conversion and failure naming are deliberately HTTP-only. |
| 30 | `d2edf102f1f07f58` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 31 | `394fa5384ef6167f` | Refactor | Schema-description stripping is duplicated between Studio and the extraction package; covered by T8. |
| 32 | `26407fd81988f46e` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 33 | `b23a29517107a9a9` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 34 | `168f11b741199fe6` | Intentional | Both thin adapters already delegate to `persistSuggestedBatch`; another wrapper adds indirection without removing business logic. |
| 35 | `0777f6296dce50b7` | False positive | A one-line uniqueness refinement in two separate Zod contracts. |
| 36 | `607a4e3294c0f098` | False positive | Idiomatic React state updates with different lifecycle states. |
| 37 | `9d48f0c5bdd64145` | False positive | Two local immutable-array replacements inside one hook. |
| 38 | `76eea503dabe8367` | Refactor | Full lease-renewal guard; primary T1 cluster. |
| 39 | `1bd66100b6585cef` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 40 | `0af22d0ea82eedf7` | Refactor | Identical canonical Source Document ID normalization; covered by T2. |
| 41 | `250bf60294b03672` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 42 | `2f08a319663eeb5f` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 43 | `f31bec74661e3e19` | False positive | An HTTP client operation and its database implementation share a domain verb, not code responsibility. |
| 44 | `c5ee09dfd6229208` | False positive | Static-path rejection is a subset of base-path validation in a different security context. |
| 45 | `e31acb3d08fbd514` | Refactor | Authorization lookups differ, but canonical-package read/decode is repeated; covered by T4. |
| 46 | `8506c28ca48e6c1e` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 47 | `dc43d5c907c41c77` | Refactor | The document Extraction snapshot query is duplicated around one researcher-ownership precondition; covered by T9. |
| 48 | `94bec612f9976dd7` | Refactor | Nested batch scheduling transaction; subsumed by T7. |
| 49 | `b7470121255585a2` | Resolved | The obsolete full parser was removed during parsing-service consolidation. |
| 50 | `4f3626515b8fc513` | False positive | A two-use row/column comparator is clear at each local sort and has no independent policy. |
| 51 | `6c340aa57354ea0b` | Intentional | Both enforce the records envelope, but runtime validation returns `null` while export validation throws and accepts `unknown`; the boundary behavior is intentionally different. |

## Refactoring tasks

- [ ] **T1 — Extract a shared lease-renewal guard** (`1`, `26`, `38`). Put
  timer ownership, lost-lease aborting, renewal serialization, and cleanup in
  one server-side helper. Keep caller-specific outer signals and operation
  timeouts as options. Add fake-timer tests for renewal loss, renewal failure,
  overlapping ticks, outer cancellation, and cleanup.

- [ ] **T2 — Share deterministic PostgreSQL primitives** (`8`, `9`, `10`,
  `12`, `40`). Export one server-side module for stable JSON, stable UUIDs,
  SQLSTATE `23505` detection, and canonical Source Document IDs; update `db`
  and `extraction` call sites. Preserve existing deterministic outputs with
  table-driven tests before deleting local helpers.

- [ ] **T3 — Centralize the parser's UTC formatter** (`14`). Add one
  `app.timing.utc_now` (or equivalent cycle-free module), use it from storage
  and Docling publication.

- [ ] **T4 — Extract common Extraction persistence reads** (`16`, `22`,
  `45`). Keep authority-specific row selection in each persistence role, then
  share ID availability, canonical-package read/decode, and conversion of a
  selected input row into `LoadedExtractionInputs`. Test unscoped,
  researcher-owned, and claimed-batch denial paths.

- [ ] **T5 — Extract review-authority validation** (`21`, `23`). Move result
  path validation and reviewed-occurrence ownership checks into named pure
  helpers used by both finalization paths. Add invalid segment, missing anchor,
  and foreign occurrence tests.

- [ ] **T6 — Consolidate terminal Extraction persistence** (`24`). Extract
  one transaction-level insert/replay/conflict routine parameterized by the
  role-specific pin validator and expected Batch Extraction identity. Leave
  `module.ts::persistTerminal` as orchestration. Verify created, replayed,
  conflict, invalid pins, researcher ownership, and claimed-member cases.

- [ ] **T7 — Consolidate Batch Extraction scheduling** (`25`, `48`). Extract
  the shared open-and-replay algorithm with explicit authority and read
  callbacks; retain researcher-specific not-found behavior at the adapter.
  Cover empty selection, non-current schema, missing representation,
  idempotent replay, and identity conflict.

- [ ] **T8 — Make extraction schema transforms canonical** (`31`). Export
  description stripping from `extraction/schema`, consume it from Studio, and
  remove the Studio copy. Check the adjacent duplicated instruction compiler
  while editing, but do not broaden the task unless its public behavior is
  identical.

- [ ] **T9 — Share the document Extraction snapshot query** (`47`). Extract
  the transaction-level query that resolves selected/latest/latest-reviewed
  Extractions; perform researcher ownership once before calling it. Test both
  explicit-Extraction and latest-representation paths.

After each task, run the focused package tests and rerun the Slopo operational
pipeline. Confirmed clusters should disappear through code changes; ignored
clusters should stay absent through the per-model `slopo.ignore.txt` files.

## Validation

- Refreshed all four embedding configurations and ran `pipeline.ps1 all`
  successfully on the post-consolidation fingerprint `57b8f0ac54ef` (1,274
  units from 128 files).
- Native analysis applied 12 of 17 tracked Jina, 8 of 11 pplx, 5 of 8 Qwen,
  and 10 of 14 Voyage ignore hashes. Each ignore list has no duplicates, and
  none of its hashes remains in that model's regenerated native report.
- Review state now lives in tracked per-model files under
  `tools/slopo-benchmark/ignores/` plus
  `tools/slopo-benchmark/operational-adjudications.json`. Embed and analysis
  runs copy those canonical hashes into each native Slopo run directory.
- The operational ensemble now excludes the 13 current reviewed-negative
  variants without changing benchmark scoring. The post-consolidation rerun
  produced 36 consensus and 74 expanded candidates; none of the 19 parser
  cluster IDs marked **Resolved** remains in either strategy.
