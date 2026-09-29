# Tasks

Status: 1.1–3.3 implemented on `feat/advanced-extraction-configuration` (2026-09-29);
4.1–4.3 done (2026-09-29). Acceptance IDs refer to [verification.md](verification.md).

## 1. Establish the immutable method contract

- [x] 1.1 Extend the existing account and extraction method contracts with the documented active settings; validate the nineteen contract examples plus categorical parity and numeric/key boundaries (U5–U7, P7). — 12c3a806, c574b131, 542ed973
- [x] 1.2 Add authored forward migrations for account defaults and nullable historical method snapshots; verify populated disposable data and preserve existing keys/model choices (M1, F2); update the local persistence contract documentation. — 39c131a2, c49e16b7
- [x] 1.3 Extend single/batch admission and method translation, including stale-intent conflicts and replay ordering; verify exact worker requests, account-write races and method-sensitive batch identity (P1–P6). — 93cbac9c, ba409fcc, 4e207e2f
- [x] 1.4 Make durable execution read only the admitted method; verify queued/batch/recovered runs after account changes, review any DBOS step changes against local rules, and document the frozen-setting contract (P2, P3, M1, A1). — 83beac7b

## 2. Add the Advanced tab and explanations

- [x] 2.1 Add the Article/Catalog sections to the existing configuration draft and Apply/Discard flow; verify all controls, defaults, invalid-parent preservation, failed saves and account isolation (U1–U7, U9). — 96d01133, e0b6fcc6, ad902ff0, d6bcda8b
- [x] 2.2 Add the single Explain surface with the specified worked examples, accessible diagrams and dated study references; inspect content for unsupported recommendations and verify no side effects from exploring examples (U1, U8, E4). — 2738153f, c13d3284
- [x] 2.3 Add keyboard/focus/reflow browser coverage and inspect desktop/mobile/zoom renderings; verify labelled disabled choices and field-error navigation (U8). — 765d8c18, d296b8cd

## 3. Make method use reviewable

- [x] 3.1 Add the saved-method summary to single/batch start views and Method used to existing Extraction details; verify defaults, stale previews, failures and historical missing metadata (P5–P7, F1, F2). — df59960f, da4ccd07, 5863aa6b
- [x] 3.2 Preserve policy skips, denominators, proposal status and evidence precision through result adapters; run existing schema-policy/span/routing/recipe regressions at the adapter seam (E1–E3, E5). — 5863aa6b
- [x] 3.3 Update README/CONTEXT and relevant current contracts for the released account preference and pinned-run behavior, preserving domain language; verify examples and links against actual runtime behavior. — 97388f9c

## 4. Accept the exact candidate

- [x] 4.1 Run typecheck, lint and fast tests, then guarded PostgreSQL, authenticated browser/recovery and scripted real-service tiers; record candidate hash and separate evidence boundaries in a dated validation receipt (all applicable matrix IDs). — [receipt](../../../../docs/validation/2026-09-29-advanced-extraction-configuration.md), candidate 97388f9c
- [x] 4.2 Complete a fresh read-only correctness/architecture/simplification review of the final candidate and the disposable maintenance probe; resolve findings without weakening the contract and record remaining limitations. — Sonnet 5 xhigh and Codex gpt-6-astra xhigh reviews of 97388f9c; maintenance probe passed and discarded
- [x] 4.3 Revalidate any repairs, ensure review refers to the exact final tree, and present the result with unrun checks and empirical limitations stated; do not claim accuracy gains from configuration coverage. — fixes 5ec86c1c revalidated; see receipt addendum
