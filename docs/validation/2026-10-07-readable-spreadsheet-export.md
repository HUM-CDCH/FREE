# Readable spreadsheet export restoration — 7 October 2026

Status: implementation and local verification complete; independent review
follow-up pending in [PR #208](https://github.com/HUM-CDCH/FREE/pull/208).

## Regression and scope

[PR #188](https://github.com/HUM-CDCH/FREE/pull/188) replaced the schema-led
research table with a technical audit export and made ordinary exports load
every saved snapshot and model capture. PR #207 added retry and visible export
feedback, but did not change that payload or workbook format. The researcher
requested the previous meaningful Excel/CSV output.

Restore the pre-#188 pure table projection over the durable result page, without
bringing back legacy result readers. Each saved value supplies its producing
field name and type. The current selection orders matching producing fields;
older or differently typed fields remain represented. Compatible edits replace
model values and rejected values become empty cells. Default rows are records;
the repeated-object row axis and indexed-column choices are restored. CSV is a
plain table. Excel adds compact Extraction and Evidence sheets. Batch rows carry
human source names and identities.

Normal exports never request history. Persistence, ownership, authentication,
durable coordination and the saved History UI contract are unchanged.

## Actual-run acceptance

An owner-scoped, read-only production read captured result version 411 and
decision version 1: 1,025 field values across 205 records. No model or correction
writes were made. Private source text and generated spreadsheets stay outside
Git in ignored local artifacts.

The previous history response was 297,191,419 bytes; the audit workbook was
73,408,830 bytes. The restored three-sheet workbook is approximately 35 KB;
CSV is 3,819 bytes. Results has 205 rows with these six columns, in the original
schema order:

`grave_id`, `leather_material`, `leather_mentions.0.context`,
`leather_mentions.0.description`, `sex`, `age`.

All result cells and CSV text match the pure projection from commit 94328e65.
The downloaded workbook's ZIP integrity, actual cell values, column order and
native boolean types were checked independently of the exporter.

Chromium at 375px used the real saved cut with a read-only API fixture and the
development CSP. Both formats downloaded through the restored options dialog.
There were zero history requests, zero correction writes and zero page errors.
Review shortcuts on the dialog's buttons cannot change the underlying review;
Escape dismisses the dialog and retains one-by-one mode.

## Verification and review

Claude Code ran with the explicitly requested `claude-fable-5-1` model for
implementation and independent review. Its initial review found a blocking
dialog keyboard ownership defect, plus batch repeated-column ordering and
Evidence-label inconsistencies. Those received failing regressions before
correction. An unavailable batch row choice now explains how to select Root
result, rather than silently substituting a different projection.

Verified locally after corrections:

- Studio: 182 files, 2,011 tests pass.
- Export package: 36 tests pass, including actual XLSX/CSV serialization.
- Studio and export-package type checks pass.
- ESLint for all changed TypeScript files passes.
- Production client build passes (existing large-chunk advisory remains).
- Actual-run browser downloads and old-projection comparison pass.

Reproducible deterministic checks: `pnpm --filter extraction-result-export test`,
`pnpm --filter studio test`, both packages' `typecheck` commands, and Studio's
production build. Infrastructure e2e specifications were updated for the restored
format; authenticated infrastructure suites were not executed locally.

The separate large History view can still be expensive. This restoration
addresses the ordinary research export; it does not claim to eliminate a
browser network change affecting other requests.
