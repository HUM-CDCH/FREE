# FREE records diagnostic preparation — 1 October 2026

Status: **offline preparation complete; annotation inputs incomplete; no run authorized**.
Based on the clean `feat/extraction-research-harness` worktree at `3ea3aadc`.
The main worktree's newer changes were left alone. Historical reports, responses,
contracts, accounting and eight reserved final-test groups were untouched.
[proposal.json](proposal.json) records scopes, versions, missing inputs, two
validated proposed configurations and uncertain cost scenarios. It is not a freeze.

## Confirmed defect and repair

`experiments/harness/merge.py::_Cluster.joins` accepted equality of every
populated normalized field as identity. Two keyless equal rows in one reply
became one; the same occurred across chunks and after case/whitespace folding.
The new regression file failed **7 tests, with 2 passing**, before the fix.
The private `red.txt` records these failures against the original implementation.

The shared harness merger now uses value equality only to flag possible repeated
records. Distinct reply items survive. A key repeated within one reply is disputed
across all its candidates and retained for review. Missing keys stay missing;
different complete keys remain separate; conflicting non-key values under a
justified key remain unresolved with alternatives and contributing evidence.
Field-recovery subdivisions retain `Task.part`, so two actual replies sharing a
source region are not mistaken for repeated keys within one reply.

Without direct key matching, a shared span must be resolved, unambiguous,
non-approximate and on a **declared identity field**, from separate replies.
A contextual field citation is insufficient. Multiple possible clusters stay
ambiguous. Explicit adjacent continuation handling and conflict preservation
remain shared by both arms. Keys and continuation are not enabled to conceal the
regression: the same-reply and cross-chunk tests exercise keyless assembly.
The overlap test disables direct key matching and uses an identity-field source
occurrence; the continuation test has no declared key.

`record_identity_ambiguous` issues identify retained candidates by chunk, group
and reply index. The existing ledger now records required passage IDs and each
processed/failed task's passages and fields, including recovery subdivisions.
This is operational coverage, never proof of record recall. The harness is version
2; configuration hashes change. Production method defaults and native extraction
implementation are unchanged. Historical version-1 cells must retain their pinned
implementation; do not resume or relabel them with these hashes.

## Evidence actually exercised

The records response is an array of FREE schema-shaped records. In ID mode,
each **top-level field of each record** is `{value, ids}`. `reply_schema` constrains
IDs to shown passages; local validation deliberately also accepts unknown IDs so
they remain visible citation failures. `_candidates` keeps fields by reply item,
`entries_for` resolves against shown canonical passages, `refine_entries` locates
the predicted value inside selected text, and consolidation retains winning
entries and all contributing candidates. No gold enters these steps.

Sanitized **synthetic**, not extracted, example:

```json
{"records":[{"entry_no":{"value":7,"ids":["p1_s0"]},
             "site":{"value":"Rome","ids":["p1_s0"]}},
            {"entry_no":{"value":7,"ids":["p2_s0"]},
             "site":{"value":"Rome","ids":["p2_s0"]}}]}
```

For canonical fixture text `7 Rome`, record 0's site becomes
`path=["records",0,"site"]`, segment `p1_s0`, physical page 1 and half-open
code-point span `[2,6)`. Its original selection remains `[0,6)` in `raw_spans`.
Record 1 independently resolves to `p2_s0`, physical page 2. Missing geometry
stays missing; no coordinates are generated. Source generation/digest bound the
IDs. Typed normalization of `7.0` to `7` preserves raw value and evidence.
Missing IDs, multiple candidate spans and unresolved support remain visible.
A justified key merge retains both pages' evidence and contributions.

These tests also call **FREE's native** `assembly.ground_records` and
`assembly.artifact`: each record's grounded field keeps its own native
`["records", item, field]` path and canonical segment/page. Native grounding uses
claim-label replies and separate verification calls, not the harness's extraction
wrappers. Existing Article, Catalog, evidence, schema and production-adapter tests
exercise those boundaries. The proposed diagnostic uses the harness's records
extraction with shared FREE schema types, canonical inputs and native-compatible
records/evidence paths; it is not a full authenticated Studio/DBOS execution or
an equivalence claim about native Article/Catalog discovery and grounding.

Distinguish three things:

- Chunk primary/heading/overlap passages are collection input context.
- A declared identity-field occurrence or native owned record slice locates a
  record. A shared heading or a matching identifier value alone is no field proof.
- A field's selected and localized spans are its candidate supporting evidence.
  Literal occurrence establishes location, not correct field/record attribution.

No evidence representation change was needed: **evidence protocol 2, prompt
version 1** remain. `item_ids_v2` is the existing treatment under records scope,
not the earlier document-scope A3 configuration. A nested array/object inside a
harness field still has one wrapper for that whole field; it has no per-child
support. If the approved schema requests nested findings, label their values and
multiplicity, but report child semantic support as unmeasured. Do not inherit a
parent citation as proof of every child. Native grounding can use deeper paths;
that does not upgrade the harness wrapper. No all-passage lists or evidence caps
were added. Synthetic behavior checks establish no real extraction accuracy.

## Catalogue sources and human handoff

Both sources were already authorized by the prior all-`examples` validation
([record](../../validation/2026-09-26-article-extraction.md#additional-examples-validation)).
The PDF is authoritative; native `pdftotext` is a reading aid, not a canonical
parse. Physical pages are never renumbered to match printed pages.

| Case | Declared scope | Source observations to review |
| --- | --- | --- |
| Short: `examples/Beretning_Ellekilde_8_13.pdf` | All 6 physical pages of the supplied excerpt, grave-description records. Complete supplied file, not complete archaeological report. | Seven heading hints. Grav 13 crosses physical pages 1–2; Grav 30 crosses 5–6. Grav 31 is partial at the excerpt's end. Distinct bone rows 8-3 and 8-4 look alike; include them if the schema requests those nested rows. |
| Medium: `examples/graves/Hvissinge_Ost_TAK_1728.pdf` | All 21 physical pages, grave-description records; illustrations/captions are context, not extra graves. | Six grave descriptions expected from source inspection, not reviewed gold. Grav 1 crosses pages 6–7. Native text omits most narrative visible on rendered page 7 and misses the first strict heading match. Review the PDF independently. |

No quota of repeated top-level rows is asserted. Review genuine repetitions that
exist, including nested rows where in schema. Do not fabricate similar records.
Neither source establishes `entry_no` identity. A grave heading's identifier is
document-local and distinct from find/bone numbering. Before declaring
`record_key=["grave_id"]`, review every section for restarts, repeated headings
and continuations and check the approved schema's identifier definition. Retain
the printed prefix if the schema requires it. If numbering restarts, declare a
schema-supported section key or retain ambiguity; do not silently use global
number equality. Pending input files currently declare **no identity key**.

Private materials are under
`.scratch/records-diagnostic-2026-10-01/dataset-v1/`:

- `dataset.pending.json`: existing dataset format v1, development groups only.
- `inputs/{ellekilde,hvissinge}.json`: source/schema references, records scope;
  deliberately unusable until the missing canonical revisions and schema arrive.
- `annotations/{ellekilde,hvissinge}.pending.json`: `gold: []`,
  `exhaustive: false`, explicit pending status. Empty gold means **no annotations**,
  not zero records. These files are not scoreable human gold.
- `review/{ellekilde,hvissinge}.json` and `.native-text.txt`: unreviewed source
  checklist and physical-page reading aid. Their hints are not candidate answers.

Exact missing inputs, relative to that private dataset root:

1. `schema/grave-entry.json`: the previously approved FREE grave-entry schema
   revision referenced by `experiments/extraction/register.py`. Its copy is not
   available here; no replacement schema was invented.
2. `canonical/ellekilde/result/result.json` and every referenced hashed page JSON
   file for the supplied PDF SHA-256 in `proposal.json`.
3. `canonical/hvissinge/result/result.json` and every referenced hashed page JSON
   file for the supplied PDF SHA-256. Verify narrative coverage against the PDF;
   the incomplete native layer is insufficient to certify source recovery.

No source PDF is missing. No canonical conversion, OCR, tokenizer or model
service was invoked. Providing these parse revisions and schema enables the
field-level annotation handoff. Until then PDF occurrence inventory can proceed,
but field gold and stable canonical support references remain pending.

Use the existing JSON review workflow, with the PDF open beside it:

1. Inventory **every source occurrence from the PDF**, including occurrences
   missing/misread by the parser. Record physical page, printed page if present,
   occurrence boundaries, section, continuation pages and repeated-looking rows
   in evaluator-only `annotations.records`. Source inventory precedes predictions.
2. Once the approved schema is supplied, add one `gold` record per in-scope
   occurrence with `fields` and `cross_page`. `{"value": v}` means reviewed
   present; `{"absent": true}` means reviewed absence; `{}` or a missing field
   means not annotated. Keep unreadable fields as `{}` with
   `annotations.records[].field_states[field]="unreadable"` and a reason. Use
   `"pending"` for not-yet-reviewed fields. Never convert either to null/absence.
3. Record canonical `{segment,start,end}` supporting spans in each present
   field's `evidence`; offsets are half-open Unicode code points. Use only spans
   resolved in the pinned generation. Context needed to establish field/record
   attribution belongs in review notes, distinguished from the value span.
   For parser omissions keep expected PDF values, original pages and
   `parser_limitations`; canonical span evidence stays unannotated where it cannot
   resolve. Do not invent segment IDs or boxes for missing text.
4. Freeze per-field normalization before predictions: preserve uncertainty and
   punctuation; ordinary strings use the existing Unicode/case/whitespace rule,
   identifiers follow the approved scope, numeric fields use existing typing.
   No new fuzzy/date/unit rule based on development answers.
5. Save a separate `annotations/*.reviewed.json` and `dataset.reviewed.json`,
   with reviewer/date, reviewed inventory and field states. Set `exhaustive:true`
   only after the PDF-wide inventory is certified, even if some values remain
   unreadable/unannotated. Validate with existing `load_cases`/`resolve`; checksum
   sources, canonical files, schema, scopes, rules and reviewed annotations.

Review labels and source text stay in ignored private storage. Do not place gold
in extraction prompts, alignment, candidate identity or assembly. The inference
boundary remains `Case.inference()`. A declared identity rule is source/schema
knowledge, never a lookup of a gold identifier or corrected gold value.

## Future comparison — exactly two arms, not executed

`base` is **A0 records, repaired** with no generated evidence.
`item_ids_v2` uses the same extractor with the verified per-record, per-top-level
field ID treatment. Only the `evidence` section differs. Input rendering, source
content, canonical artifacts, schema, identity/merge rules, normalization, model
and provider settings, output limit, sampling and recovery stay identical.
The proposed key setting requires the reviewed scope above; it is not an escape
from keyless regression coverage. **The continuation ablation is retired**;
there is no third arm or historical rerun.

Necessary evidence differences are the `{value,ids}` wrappers, evidence prompt
instruction, ID enums and offline citation resolution/checks. The semantic
verifier, evidence gate and conflict resolver are off in both arms. No repeated
all-passage lists, generated coordinates or evidence truncation. A record citation
does not prove all fields. Identical assembly rules see different available
citations; report citation-based identity joins separately from declared-key joins
if they occur. Do not claim evidence is purely postprocessing.

Freeze a **new** contract with existing dataset/case/config/evaluator/code pins
after reviewed labels and canonical inputs exist, and request a fresh explicit
allowance. No clock or provider was opened here (`provider:null`, study allowance
0). The old development tolerance remains historical, selected with known
development results; it is not an independent confirmatory test for these two
catalogues. This is a descriptive development diagnostic, not a significance gate.

Report each case and arm even on failure:

- Values: raw/canonical precision, recall and F1; unresolved, omitted, unreadable
  and unannotated denominators; missing/spurious/duplicate records and genuine
  source multiplicity, including parser omissions. Existing evaluator v4 uses
  reviewed keys and annotated values only for evaluation alignment.
- Coverage: required source passages/fields, processed and failed/refused regions
  from the ledger; recovered failures, length finishes, JSON/schema validity and
  sealing are separate measures. Completion requires all declared regions/fields
  processed, not merely successful HTTP, valid schema or a sealed cell. Record
  recall is measured only against certified PDF inventory.
- Evidence: joint correct value plus overlap with **reviewed supporting spans**
  using the frozen evaluator rule (IoU .5); separately label conditional span
  quality among correct returned values. Page hits, valid IDs and literal matching
  are localization diagnostics. Evaluator `semantic_support` remains null: span
  agreement is a support-label proxy, not independent semantic adjudication of
  every future generated citation. Nested child support and parser-missing spans
  are unmeasured unless separately annotated; list their denominators.
- Operations: ID occurrences, unique selected IDs, raw/refined span counts,
  serialized citation bytes, response bytes and actual tokens, calls, failed
  attempts, completion and wall time, with fresh/replayed work separate.

Incomplete arms remain in operational reporting and full-scope error accounting.
If complete-only paired accuracy is unavailable, state that limitation; never
remove the arm or score only its successful source regions as the full scope.
With two development catalogues, no calibration, confidence fitting or training.

### Allowance estimate: provisional, source-specific

Native text contains 20,491 characters for Ellekilde and 12,879 for Hvissinge;
the latter omits visible narrative and **cannot size a complete parse**. The
following are capacity scenarios, not measured canonical requests:

| Source | Plausible canonical layout chars | Initial calls per arm at 4,000 primary chars | Both arms including depth-1 worst-case recovery |
| --- | ---: | ---: | ---: |
| Ellekilde | 24k–36k | 6–10 | 36–60 |
| Hvissinge | 40k–65k, highly uncertain because body text is missing | 10–17 | 60–102 |

These include rough layout overhead and assume individually admissible passages;
one oversized indivisible passage can instead be refused. They imply 32–54
initial calls, or at most **162** under these recovery scenarios. No allowance
is granted by that number. After canonical inputs arrive, recompute actual
chunks with `chunks_of`, source sizes with `render`, and schema/prompt bytes
with `reply_schema`/`system_prompt`, offline. Uncovered canonical/body regions
cannot be hidden by using native character counts.

The actual compact wrapper adds **26 bytes** for a field selecting one
`p1_s0`-length ID, plus approximately 8–16 bytes per additional ID depending on
its length. This is serialization arithmetic, not an extraction token multiplier.
For `R` emitted records, `F` top-level populated fields, mean value bytes `V` and
field-name bytes `K`, A0 output is approximately `R*F*(K+V+4)` plus framing;
the evidence arm adds `26*R*F` plus extra selected IDs. Lists/objects can dominate
`V`. `R` includes repeated appearances across chunks, not just unique PDF records.

For scale only, **if** the approved schema has 8 populated top-level fields and
average `K=12,V=60`, one complete appearance of the seven Ellekilde records is
about 4.3k A0 bytes plus 1.5k evidence bytes; six Hvissinge records about 3.7k
plus 1.3k. These are conditional scenarios, not a substituted eight-field schema
or a quota. The missing approved schema prevents a final output estimate.
Budget input/output tokens heuristically at 3–5 chars/token until authorized
provider counting is available. Include repeated prompts, schemas and recovery;
do not use the earlier document A3 multiplier as records-mode cost. A planning
wall-time ceiling around six hours for 162 worst-case calls is uncertain and must
be replaced by the frozen source-specific estimate before requesting a run.

## Verification and review boundary

All checks used `unshare -rn`. Loopback alone was enabled for the three existing
scripted HTTP adapter tests; no route to an external service was available.
The initial loopback-down run had 329 passes and three expected fixture connection
failures; the isolated-loopback rerun passed. The integrated final run passed
**334 tests, 3 live tests deselected**. Adding the native artifact regression then
passed the focused **14-test** records file (335 distinct tested scenarios overall).
No live-model or database tier ran. Saved benchmark responses were unnecessary
because they do not exercise this new records regression; no historical benchmark
was repeated.

Logs: `.scratch/records-diagnostic-2026-10-01/{red,tests,tests-verified}.txt`.
Rendered source checks: `pdf/{ellekilde-1,hvissinge-7}.png` under that same root.
[verification.json](verification.json) pins the final implementation, new test,
proposal and private handoff files. Zero dependencies were added. Inspect the
final diff before committing. Intended commits, neither pushed nor merged:

1. `fix(harness): preserve distinct records and expose failed source regions`
2. `docs(research): prepare two FREE catalogue annotations and records protocol`

| Final check | Answer |
| --- | --- |
| Are we testing FREE's actual records path? | The harness records path and FREE's native evidence assembly are tested; native discovery and full Studio execution are not claimed equivalent. |
| Can equal-looking rows remain separate source occurrences? | Yes, with keyless same-reply and cross-chunk regressions. |
| Is entry_no genuinely an identity key in its declared scope? | Not established for these catalogues; it is not declared. Grave-heading identity still needs source/schema review. |
| Does each item have its own evidence rather than a collection-wide list? | Each top-level record and field does; nested children inside one harness field do not. |
| Are field support and record location distinguished? | Yes; semantic accuracy remains unmeasured. |
| Can annotation detect records the parser or model omitted? | PDF-wide inventory must precede predictions and retain parser omissions. |
| Are pending labels kept separate from genuine absence? | Yes; pending files are non-exhaustive and not reviewed gold. |
| Will incomplete execution remain visible in the next result? | Required/processed/failed regions and incomplete arms remain reported. |
| Is every code change necessary for this specific diagnostic? | Identity repair, reply-part preservation, ambiguity issues, region ledger and version pinning have focused regression coverage. |

Stop here; reviewed gold, a frozen contract and fresh authorization are
prerequisites to any inference.

WHAT COULD I BE WRONG ABOUT?
