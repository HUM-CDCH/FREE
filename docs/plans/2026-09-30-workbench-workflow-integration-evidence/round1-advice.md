**Bottom line:** your direction is mostly right, but three pieces need correction. Readiness should be soft everywhere except one acknowledgment at batch admission. Batch transfer does not belong now. The missing/ungrounded semantics should keep workbench's optional-decision model and borrow only the classification from workflow, not its obligation.

## 1. Keep / adapt / defer

| Candidate | Verdict | Pushback |
|---|---|---|
| A derived guidance | Adapt | Pure derived read model over existing phase plus counts. If any "step done" state is persisted, it is a second lifecycle. One selector, one CTA component, nothing stored. |
| B field-context jump | Keep as navigation intent | No SchemaIssueFlag table. Carry nodeId plus a few example cells as transient state. "Re-run same scope" already exists via scoped admission and flush-before-run. |
| C classification | Adapt | Rename "success" to "grounded". Success implies correctness, which a review grid cannot know. Classes must map one-to-one onto existing decision and Evidence states or they drift. |
| D null anchors | Resolve, see section 3 | Not "useful" as designed. Workflow's mandatory decision per occurrence is the opposite of workbench's optional model. |
| E spreadsheet import | Adapt, bounded | Ephemeral import to a schema proposal only. Versioned spreadsheet slot, filename gold linkage and persisted column mapping exist for evaluation, not schema import. Do not carry them. |
| F hard stabilise | Defer hard, adopt soft | The gate was bypassable in the old branch anyway. With page sampling, "reviewed pilot" would have to mean a full-document Extraction, which forces the workflow you are avoiding. |
| G whole-result reuse | Defer, but note the cheap version | The clone design is broken. Admission-time dedupe is different: skip a source that already has a finalized full Extraction on the same schema revision, method and model pin. That is a link, not a copy. |
| H ingestion sidebar | Superseded | Durable ingestion covers it. |
| I parallel parsing | Defer | Processor concern, and it has a scanned-PDF defect. |
| J gold/evaluation | Defer | Independent product. |

## 2. Soft versus hard readiness, and batch transfer

**Readiness: soft, with one acknowledgment.** Show facts, never a verdict: which schema revision, how many reviewed sample Extractions, pages and sources covered, unresolved fields, and whether the current revision has any review at all. Label samples as samples in every count. The one hard-ish point is the batch admission dialog: if the pinned schema revision has zero reviewed Extractions, require an explicit acknowledgment. No server rejection, so there is no gate to bypass and no second path to police.

Counterargument you should weigh: the old hard gate existed because someone ran large batches on untested schemas and paid for it. If that is still happening, a server-side gate on "at least one reviewed Extraction on this revision" is cheaper than the model calls it prevents. Decide that from usage, not from principle.

**Batch transfer: not now.** Reasons in order of weight:

- **It changes persisted admission data.** Every other candidate is derived or transient. This one multiplies the surface that 9b87c307 just fixed.
- **Atomicity.** A batch of many sources needs one snapshot per member computed inside the admission step. One stale pairing on one source then affects the whole batch admission path.
- **Low overlap.** Transfer works only within the same document and source representation. Batches mostly target unsampled sources.
- **PR2 acceptance is unchecked.** Extending unvalidated semantics is the wrong order.

If you do it later, it is a per-member call of the same snapshot function with identical rules and no new rules. Put it last.

## 3. Missing and ungrounded semantics

Keep workbench's model. Decisions stay optional and non-authoritative until finalization. Borrow only the vocabulary.

- **Grounded value:** value present with model Evidence anchor. Approval carries the anchor.
- **Ungrounded value:** value present, no anchor. Approval requires researcher-picked reviewedEvidence, which PR3 already plans. Do not add an "accepted unverified" state. That is a third truth nobody can act on.
- **Missing:** value null or absent. Allow one explicit decision kind, "confirmed absent", with no Evidence. This is the only anchor-free approval. It is distinct from "approved value" everywhere it is stored and displayed.
- **Partial:** an array or record where some aligned occurrences are decided and some not. This is a classification, never a decision.
- **Rejection:** unchanged, no Evidence required.

Transfer rule for the new kind: "confirmed absent" carries only onto an aligned node whose new value is also null or absent. It never carries onto a node that now has a value, even a matching one. That keeps the exact value and Evidence checks intact.

Completion: workflow's "every occurrence decided" becomes a summary metric, decided over total per class, not a gate. An undecided grounded cell is undecided, never implicitly approved.

## 4. PR boundaries after PR3 and PR4

**PR5 Review attention read model.** Server-side classification per leaf occurrence and per aligned record, plus completion counts. Unresolved-field navigation in the review grid. Depends on PR3 for the "confirmed absent" kind. No migration.

**PR6 Field jump, re-run, guidance.** From a review grid field header, open the schema editor on that nodeId with a few example cells as transient state. Land in the same editor surface PR4 uses so proposals and manual edits share one path. "Re-run same scope" reuses scoped admission with the identical page set and the existing flush-before-run identity. Derived project guidance panel built from phase plus PR5 counts, including the soft readiness facts. Depends on PR4 and PR5. No migration.

**PR7 Spreadsheet schema import.** Upload, parse with null-prototype maps and own-property checks, reject reserved header names, cap columns and rows, split headers on an optional separator into a field tree, infer types as hints, enum inference opt-in per field. Output is an ordinary schema proposal the researcher confirms through the existing revision path. Independent of PR5 and PR6 but after PR4 to reuse its confirmation UI. No migration if the file is not persisted.

**PR8, optional and last. Batch member transfer.** Per-member snapshot at batch admission using the single-admission function unchanged. One forward migration on the current chain for the member snapshot column. Depends on PR2 acceptance and independent review being checked.

## 5. Risks, counterexamples, acceptance, seams

**Risks and counterexamples**

- **Sample inflation.** Five reviewed two-page samples of one source must not read as "well tested". Guidance must say sample, pages and sources separately.
- **Stale nodeId on jump.** The grid shows revision R. The editor is on R+1 and the node was removed or retyped. The jump degrades to path plus a warning, never to a silent no-op.
- **Unsaved schema edits on re-run.** Re-run with a dirty editor must flush or block, using the existing identity check. Otherwise the researcher reviews output from a revision they did not intend.
- **Enum inference blocks transfer.** Inferring allowed values from a handful of rows creates disallowed-value failures under the 9b87c307 rule on the next sample. Hence opt-in.
- **Classification drift.** If the grid computes classes client-side and the summary server-side, they disagree within a week. Compute once.
- **Guidance persisting state.** Any "dismissed" or "completed" flag turns A into lifecycle. Keep it derived; dismissals live in local UI state if at all.
- **Header attacks.** Beyond the known prototype case: duplicate headers, empty headers, merged header rows, a very large column count, and separator characters inside quoted headers.

**Acceptance scenarios**

- A grounded, undecided cell shows as grounded and undecided. Completion counts it as undecided.
- A null cell approved as "confirmed absent" carries to a re-run where the cell is still null, and does not carry where the cell now has a value.
- A field jump from revision R after that node was renamed in R+1 opens the renamed node, or warns if removed.
- Re-run same scope produces the same sorted unique page set and the same scoped artifact identity for an unchanged schema.
- A spreadsheet whose first header is a reserved prototype name is rejected, and a subsequent schema validation sees an unpolluted prototype.
- Readiness for a revision with only sample reviews never uses the word "ready" and never shows a full-result count.
- Batch admission on a revision with zero reviews requires acknowledgment and still admits.

**Seams to inspect** before writing any of it. I have not read these, so verify names and locations:

- The reviewTransfer snapshot builder used at single admission, and where batch admission creates members.
- Review decision persistence and the Evidence ownership check PR3 will touch.
- The flush-before-run schema identity computation and the scoped artifact identity.
- The Interaction Route edit proposal loader planned in PR4.
- Project phase derivation, so guidance reads it rather than duplicating it.
- The current migration chain tip on the integrated branch.

## 6. Strongest reasons this direction could be wrong

- **PR4 may be the wrong first investment.** A manual field jump with example cells could deliver most of PR4's value with none of its instruction-generation risk. Consider swapping or folding PR4 into PR6.
- **Spreadsheet import may be the most valuable item, or worthless.** Humanities researchers often arrive with an Excel codebook. If that is your users, "bounded" under-invests. If schemas are already defined in the app, it is zero-value. Only usage evidence settles this.
- **Deferring whole-result reuse defers the only feature that saves money.** Admission-time dedupe fixes the clone defect by not cloning. It is small and may matter more than guidance.
- **Soft readiness may be ignored.** If the old gate was reacting to real cost incidents, advice will not stop them.
- **Scope after unvalidated work.** Acceptance and independent review of PR1 and PR2 are unchecked, and another worker is changing the same application files. Four more PRs planned on top of unverified seams is the biggest risk here. The honest minimal plan is: validate, ship PR5 plus PR6 as one unit, then reassess whether PR7 and PR8 are still wanted.
