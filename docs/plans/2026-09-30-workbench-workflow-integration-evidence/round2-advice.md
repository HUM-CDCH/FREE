**Verdict: ITERATE.** The plan is close. Its direction is sound and most of your rebuttals hold. Six planning prerequisites remain, and two of them are internal contradictions rather than missing detail. None require new states or migrations.

## Your rebuttals

- **1, missing cells.** Conceded. A sample decision is scoped to sampled occurrences, so "absent" would not have claimed source-wide absence, but anchor-free approval still breaks the Evidence rule and the workbench contract. Dropping it is right. The gap it leaves is unaddressed: without any decision kind, a missing cell can never leave the attention list except by adding a value through PR3. Either missing cells are excluded from the completion denominator, or the attention view needs a local, unpersisted dismissal. The plan says neither. That is a real prerequisite, not a future idea.
- **2, acknowledgment.** Conceded. A client-only gate is cosmetic. The remaining risk is product, not plan: if the old gate was reacting to real cost incidents, a warning will not stop them. Decide from usage.
- **3, reviewTransfer already exists.** Conceded. My migration claim was unverified and is withdrawn. Boundedness assessed below.
- **4, cheap link.** Conceded. I asserted reuse without knowing that membership and identity live on the row. Deferral is correct.
- **5, PR4 non-blocking.** Agreed, but the plan still specifies the jump against a moving target. "Pass IDs to PR4's correction context when available" means two jump behaviours depending on merge order. State it once: PR5 ships the jump with no PR4 hook, and whichever lands second adds the hook.
- **6, coverage accuracy.** Agreed, with one correction to your wording. Distinct physical pages across sources is meaningless. Deduplicate per source revision, then sum sources. The PR5 task says "deduplicated physical page coverage" without that key.
- **7, recheck heads.** Agreed. The session's git status also shows an untracked OpenSpec change named unify-catalog-extraction and unstaged docs edits. The plan must say whether those are inside or outside its baseline before the integration branch is cut.

## Contradictions and missing prerequisites

1. **PR5 classification mixes two axes.** The first task lists "present+grounded, present+ungrounded, missing, undecided, draft-decided and finalized" as one set. Grounding is a property of the cell. Decision state is a property of the decision. Finalization is a property of the review, not the cell. Specify two orthogonal axes and one review-level flag, or the read model will encode "finalized" per cell and drift from the existing decision set on day one.
2. **Batch-start warning depends on a projection PR5 conditionally defers.** The seventh PR5 task says project-wide facts wait for an owned projection and "until supplied, show document-local facts". The eighth task promises the collection start view will distinguish reviewed samples from full results. A batch spans many sources, so document-local facts cannot produce that warning. Resolve by scoping the warning to the selected sources under the pinned revision. That is bounded, owned, and needs no project-wide projection.
3. **PR6 assumes the create path accepts caller-supplied node IDs.** Acceptance requires confirmation to write "the same node IDs" built at preview. If the existing schema-create or revision path assigns stable IDs server-side, that acceptance is unreachable without touching the revision contract, which the plan lists as a seam but never budgets. Verify before committing to the acceptance line.
4. **PR6 size limits are unenforceable without a parser choice.** The 25MiB expanded-ZIP bound requires a library that exposes entry sizes before inflation or streams with a byte budget. Most convenient xlsx readers inflate first. Name the parser and how the bound is checked, or downgrade the limit to "input size only".
5. **PR7 needs a consumer audit of reviewTransfer.** Today a row with batchExtractionId set always has reviewTransfer null. Every read path that branches on reviewTransfer presence, including prepare and recover-draft, has never seen the combination of both being set. The plan should list those consumers and prove the combination is safe before the spec exclusion is lifted. This is the one place where "behavioural extension, not migration" understates the risk.
6. **PR5 classifier depends on PR3 semantics, not only its UI.** Dependencies say PR3 is needed "before offering ungrounded correction actions". The classifier's "ungrounded and decided" class is defined by PR3's Evidence rule. Either the classifier ships after PR3, or it must state which rule it implements meanwhile.

## PR boundaries

- **PR5** is end-to-end but wide. It bundles the read model, attention filter, field jump, re-run, derived guidance, coverage, and the batch-start warning. That is the "smaller first delivery" reversed. Keep the number, but plan two mergeable steps inside it: read model plus attention navigation first, then jump, re-run and guidance. Reviewers cannot check seven behaviours against one diff.
- **PR6** is well bounded and end-to-end, subject to items 3 and 4.
- **PR7** is appropriately bounded on paper. The dependency on checked single-transfer acceptance is the right gate. The acceptance list is missing partial-failure and multi-sample behaviour, listed below. "Keep snapshot work visible" is not an acceptance criterion. Give it a bound or drop the line.

## Missing acceptance and counterexample scenarios

1. **Missing cell exit.** A sample with three missing cells and no corrections reaches a finalizable review, and its completion count does not show three permanently unresolved items.
2. **Classification parity.** The API summary and the grid computed on one fixture produce identical counts per class. The plan asserts one definition but never tests it.
3. **Node ID round trip.** An imported tree confirmed through the ordinary path is reloaded with the preview's IDs. If this fails, item 3 above is confirmed.
4. **Partial batch snapshot failure.** One member's snapshot query fails during a six-member admission. Either the whole admission rolls back or the member admits with no carried decisions. The plan must choose, and no half-admitted batch may exist.
5. **Two samples, one source, conflicting decisions.** Batch transfer must reuse whichever precedence rule single transfer already applies, and the scenario must be stated for batch because batches make it common.
6. **Reprocessed source drops from coverage.** After reprocessing, that source's samples leave coverage counts and the batch-start warning for that source changes accordingly.
7. **Dirty editor on field jump.** Jumping into the editor with unsaved edits pending must not discard them silently. The plan covers dirty re-run but not dirty navigation.
8. **Hostile workbook headers.** Duplicate headers, empty headers, a merged header row, separator characters inside a header, and exactly 200 columns each produce a column-specific error, not a truncated tree.
9. **Selected-sources warning.** A batch over three sources, one sampled and two not, shows sample facts per selected source and never a project total.

## Real blockers versus future ideas

Items 1 through 6 above are planning prerequisites. They can be resolved in the plan text and by targeted seam checks before implementation. Future ideas, correctly parked: a server-side readiness gate, whole-result reuse, spreadsheet persistence, absent-value decisions. Nothing in the plan needs a new state or migration.

Once the classification axes are separated, the batch-start warning is rescoped to selected sources, and the three seam checks are recorded, the plan is ready for implementation planning.
