Retained on 2026-09-30 from the original donor review. Integration direction is refined by the [current workbench adoption plan](../2026-09-30-workbench-workflow-integration.md); the tests below apply only to the pinned workflow branch.

# workflow → dev review

Date: 2026-09-29. Status: review complete; integration not implemented. No commits, pushes, PR creation or merges performed by this review.

Reviewed workflow: `ba3e7cc105faa5a4ea021c4906d749a329fd914d`.
Reviewed dev: `287ccb4245b95654821849f91e067bbbd057c040`.
Merge base: `5cf706c0ab717636b10cb46c3a16d48fe7fc395e` (2026-09-11).
Both remote tips were rechecked at the end and remained unchanged.

**Recommendation.** Port the selected features onto a new branch based on the pinned/current dev. Resolve the confirmed defects there and open a PR targeting dev. The old execution architecture and migration chain need adaptation to dev; resolving Git conflict markers alone will not produce a valid integration.

[Source comparison](https://github.com/HUM-CDCH/FREE/compare/287ccb4245b95654821849f91e067bbbd057c040...ba3e7cc105faa5a4ea021c4906d749a329fd914d).

**History and merge evidence**

- Six workflow-only commits; 416 dev-only commits.
- Branch diff: 188 files, 121,080 insertions and 615 deletions. Generated database contract snapshots dominate the size.
- `git merge-tree --write-tree --name-only <dev> <workflow>` returned 1 and 39 conflicted paths. It did not change branch references or working trees.
- Conflict transcript: [merge simulation](workflow-merge.txt).
- No workflow PR or head check-runs/status contexts were found at review time. The verify workflow triggers on PRs and pushes to dev, explaining the absence of checks on workflow pushes.
- dev has no enforced branch protection at review time. CONTRIBUTING still requires a PR and one review.

| Commit | Stated purpose | Actual scope to consider when porting |
| --- | --- | --- |
| 9caffffc | Kill parsing tasks on timeout | Old long-polling upload path; adapt any still-needed behavior to dev's durable ingestion/cancellation |
| 72345bcc | Show document during parsing | Also introduces spreadsheet/gold storage, evaluation helpers, review classification and parallel parsing; 123 changed files |
| 736e15f4 | Spreadsheet field fix | Frontend propagation of the confirmed schema after spreadsheet suggestion |
| 2ac01950 | Modify workflow | Guided phases, schema stabilisation/flags, pilot reuse/progress, review and supporting migrations |
| c1f46442 | Suggestion-to-approval workflow | Schema creation/edit/navigation and force deletion behavior |
| ba3e7cc1 | Review ungrounded records | Nullable review anchors, missing/ungrounded-cell validation and guided UI changes |

**Standards review**

1. **P1: reused pilot results become unreadable.** [postgres-persistence.ts:1833](https://github.com/HUM-CDCH/FREE/blob/ba3e7cc105faa5a4ea021c4906d749a329fd914d/packages/extraction/src/postgres-persistence.ts#L1833) inserts a cloned Extraction under a different ID from its completed ExtractionJob (1801–1812). The review grid reads that clone ID at useBatchExtractionReviewGrid.ts:249–251, but readExtractionAttempt requires a same-ID job at 1529–1540 and returns null; the API maps this to 404. Reopening the document can instead select the synthetic completed job and throw `Completed Extraction Job has no terminal Extraction`. This violates README's durable, readable extraction/review contract. Actual persistence methods reproduced both failures using a mocked ORM, without a database: [probe](workflow-clone-read-probe.mts). The integration test at extraction-module.integration.test.ts:1706–1709 deliberately avoids the direct read path. Preserve dev's single Extraction identity from admission through review when implementing reuse, and test grid/document reads.

2. **P1: spreadsheet headers mutate process-wide prototypes.** [\_spreadsheet_schema.ts:159](https://github.com/HUM-CDCH/FREE/blob/ba3e7cc105faa5a4ea021c4906d749a329fd914d/prototypes/studio/api/_spreadsheet_schema.ts#L159) follows inherited `__proto__` and assigns into Object.prototype. gold-spreadsheet.ts:40–49 repeats the unsafe construction. Authenticated spreadsheet suggestion creation reaches this builder before schema validation (batch_schema_suggestions.ts:173–192). A header `__proto__.__freeWorkflowReviewSentinel`, separator `.`, and inference disabled produced:
   `{"ok":true,"template":{},"prototypeHasSentinel":true,"inheritedByUnrelatedObject":"string"}`.
   The sentinel was removed in a finally block. Shared process mutation violates README's account-scoped writes. Cross-account data exposure has not been demonstrated. Use safe own-property access and null-prototype dictionaries or equivalent construction, including the gold-record builder.

3. **P3, judgment call: duplicated review-cell traversal.** grounding.ts:58–71 and useBatchExtractionReviewGrid.ts:48–59 implement matching scalar-path expansion. This agreement now decides review completeness. A shared traversal would reduce the chance of future client/server drift; this is not a merge blocker.

No additional confirmed ownership regression was found in the new scoped store methods.

**Spec review**

1. **P2: suggestion confirmation bypasses the pilot gate.** [postgres-suggested-batch.ts:262](https://github.com/HUM-CDCH/FREE/blob/ba3e7cc105faa5a4ea021c4906d749a329fd914d/packages/extraction/src/postgres-suggested-batch.ts#L262) creates a batch for all suggestion sources after creating an unstabilised revision. BatchExtractionsPanel.tsx:929–934 explicitly exempts schema suggestions from its gate. Selecting six or more documents, generating common fields and confirming therefore runs collection extraction without pilot review. guided-workflow-phases/spec.md:18–23 requires rejecting selections above the pilot limit against an unstabilised revision and creating no batch. Enforce the same rule at suggestion confirmation, with a server-side regression check.

2. **P2: parallel parsing rejects scanned-column input.** [docling_parser.py:450](https://github.com/HUM-CDCH/FREE/blob/ba3e7cc105faa5a4ea021c4906d749a329fd914d/prototypes/parsing_service/app/docling_parser.py#L450) checks restored physical page numbers against the prepared page_range. Four prepared crops for physical page 1 restore to page keys {1}, but the publisher expects {1,2,3,4}. A focused actual DoclingDocument/fake-converter reproduction raises `v2_physical_page_mapping_unavailable`. parallel-page-range-parsing/spec.md:5–7 explicitly includes scanned-column preparation; lines 49–56 require physical-coordinate fragments and complete merged coverage. Partitioning is disabled by default, limiting exposure. Carry the prepared-to-physical mapping through publication, merge and boundary checks and test cropped-page partitions.

3. **P2: gold filename validation is reported as an outage.** [batch_schema_suggestions.ts:319](https://github.com/HUM-CDCH/FREE/blob/ba3e7cc105faa5a4ea021c4906d749a329fd914d/prototypes/studio/api/batch_schema_suggestions.ts#L319) maps new `ExtractionError('invalid_request', ...)` from gold population to generic HTTP 503. An unmatched filename consequently loses the row/filename correction details. gold-standard-corpus/spec.md:135–137 requires an error identifying both, and no partial confirmation. Rollback is implemented; preserve the domain validation message through a suitable client error.

Unchecked future tasks for retry, field examples, later evaluation and gold-assisted review were not counted as completed-feature defects.

**Integration requirements**

dev replaced the old app/* parser with the included kei_exp service, portable DBOS handoffs and durable workflow cancellation. ADR 0012 specifies DBOS as the execution authority; ExtractionJob, BatchExtractionMember, the lease worker and suggestion pump are gone. Port desired behavior into the current workflows rather than restoring those removed mechanisms.

Migration ancestry is also incompatible:

- dev: 20260925T2356_baseline → 20260928T1410_extraction_settings → storage hash `sha256:6d030f6743048ce5fd51db16f42dc3a08e1a664123df6c575f84dce75fd4589f`.
- workflow's first new migration starts at `sha256:e02fde19d89b3efae211102fed6aa4926a7fbdaf1a940227f0a8175c56246f1a`, on the pre-DBOS chain; its final migration ends at `sha256:4c5e67f0f50f992f6554f7c45179161f123b9846787e08d975ca8b62352f307c`.
- None of workflow's four new migrations starts at dev's current tip. Add authored forward migrations based on dev after deciding the final models; retain dev's migration history, regenerate contract artifacts and lockfile using the target branch's tooling. Replaying the old migration directories is not a valid upgrade path.
- Preserve dev's per-account model configuration, credential rules, pinned extraction method and atomic workflow admission. The workflow branch predates these contracts.

Suggested end-to-end PR boundaries and merge order:

| Order | Boundary | Required adaptations |
| --- | --- | --- |
| 1 | Missing/ungrounded review cells and result classification | Current review rules/persistence, nullable anchors, full decision-set validation, UI and regression coverage |
| 2 | Spreadsheet schema suggestion and project spreadsheet/gold storage used by that flow | Safe field construction, current owned stores/schema suggestion surface, new migrations and correct filename errors |
| 3 | Guided schema approval, pilot rounds, stabilisation and reuse | Current extraction/workflow identity and admission, server-side gate on every path, reviewed-result reads and navigation |
| Separate | Parallel parsing | Current kei_exp converter/DBOS lanes, prepared-to-physical page mapping, bounded resource use and cancellation |
| Later scoped work | Unfinished evaluation/retry/example features | Follow remaining OpenSpec tasks; supporting helpers do not demonstrate the whole planned feature is complete |

These are suggested review boundaries, not a requirement to split by line count. Combine dependencies when separating them would leave a non-working intermediate layer.

Create integration work separately from the current dirty feature checkout, for example:

```bash
git fetch origin dev workflow
git worktree add -b integration/workflow-on-dev /tmp/free-workflow-integration origin/dev
```

Use workflow as a source of scoped changes; its mixed commits are poor automatic cherry-pick boundaries. After implementation, open a PR explicitly targeting dev, link the relevant OpenSpec changes, obtain the required review, and merge only after validation passes.

**Validation performed on workflow**

| Check | Result |
| --- | --- |
| Frozen Node dependency install, scripts disabled | Passed |
| pnpm db:generate | Passed |
| pnpm typecheck | Passed |
| Studio unit tests | 1,119 passed, 108 test files |
| Extraction unit tests | 105 passed |
| Database package unit tests | 66 passed; no live database |
| pnpm lint | Failed: 22 errors, 3 warnings |
| Four focused parser test files | 18 passed, 2 skipped for absent PyMuPDF |
| Prototype mutation probe | Reproduced; sentinel cleaned |
| Clone direct/document read probe | Reproduced with actual persistence + mock ORM |
| Scanned-column partition probe | Reproduced with actual DoclingDocument + fake converter |
| Merge simulation | 39 conflicted paths |

Parser checks reused the already-installed Python interpreter with locked python-multipart 0.0.32 installed only under /tmp. They are supplemental fast checks, not a frozen full Python environment. No live PostgreSQL, E2E browser suite, real-service/system test or model test was run. Node checks ran against workflow itself, not a resolved integration tree.

For each final integration boundary, run typecheck, lint, unit and safety checks, forward migration checks on fresh and upgraded disposable loopback free_test_* databases, the relevant DBOS/PostgreSQL integrations, and E2E flows. Parser changes additionally require local Python and real-service validation; dev's hosted CI sets FREE_SKIP_PYTHON=1 and does not cover those tiers. Test the confirmed failure scenarios explicitly.

Review ran in /tmp/free-workflow-review-ba3e7cc1, which remains available. No source files in the user's active checkout were changed by this review. Other ongoing work in that checkout was observed to change concurrently.

Standards: 3 findings, worst P1 (unreadable reused results and shared prototype mutation). Spec: 3 findings, worst P2 (pilot-gate bypass, scanned-column failure and hidden gold validation).
