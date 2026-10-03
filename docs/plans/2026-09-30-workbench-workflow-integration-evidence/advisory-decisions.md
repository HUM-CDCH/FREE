# Claude advisory decisions

Date: 2026-09-30. Status: two advisory rounds completed; final plan revised locally.
Outcome: [integration plan](../2026-09-30-workbench-workflow-integration.md).
This records design advice, not implementation acceptance.

Both rounds ran Claude Code 2.1.285 with model `claude-fable-5-1`, high effort,
print/JSON output, no tools, an empty strict MCP configuration, safe mode,
no persistent session and plan permission mode. The user explicitly approved
export of the prepared repository brief and the subsequent plan draft. The
advisor received supplied evidence; it did not inspect the repository or run
tests. Both response receipts report `is_error: false` and the exact requested
canonical model.

| Round | Input and retained result | Contribution |
| --- | --- | --- |
| 1 | [brief](advisor-brief.md), [advice](round1-advice.md), [receipt](round1-response.json) | Challenged scope; favored derived guidance and ephemeral import; deferred batch transfer |
| 2 | [counterarguments and prompt](round2-prompt.txt), [reviewed draft](round2-plan-draft.txt), [critique](round2-advice.md), [receipt](round2-response.json) | Verdict ITERATE; identified classification, coverage, parser and consumer prerequisites |

The second round received the first advice, explicit rebuttals and the complete
draft. The exact input and draft are retained as plain text, preserving their
original Markdown paths rather than presenting them as current document links. The final document incorporates the adjudication below. There was no
third advisory round, so the final revisions do not carry a new Claude approval.

**Scope decisions**

| Advice or disputed claim | Decision and reason |
| --- | --- |
| Use derived next-action guidance instead of persistent readiness/issue state | Adopt; current guards, read data and XState actors already own these facts |
| Ship attention, field jump and deterministic spreadsheet preview before batch carry | Adopt; split attention and jump/guidance into PR5a and PR5b for usable review boundaries |
| Add anchor-free “confirmed absent” decisions | Reject; optional missing-value corrections still require PR3's canonical Evidence. A sampled occurrence cannot establish source-wide absence. The advisor conceded the contract conflict |
| Require a client batch-start acknowledgment | Reject for this change; show selected-source facts and warnings, preserve existing admission guards |
| Add a batch snapshot column/migration | Reject; Extraction.reviewTransfer already exists for every Extraction. The advisor withdrew the unverified migration claim after code evidence |
| Link/reuse whole finalized results as a cheap shortcut | Defer; membership and identity live on the Extraction row. This requires a separate history/cache design |
| Persist spreadsheets, gold filename links or automatic enums | Defer; preview is transient, filename is an ordinary field, enums require researcher choice |
| Couple field jump to PR4 generation | Reject coupling; manual navigation ships alone. The later merge adds the bounded correction-context hook |

**Second-round prerequisites and their resolutions**

1. Separate presence/grounding, decision/provenance and review-level finalization.
   Required completion counts cover grounded paths under current rules; optional
   missing/ungrounded attention remains descriptive after a review finalizes.
   Prepared defaults do not count as saved decisions. No extra dismissal state.
2. Scope collection warnings to the selected sources and selected Schema
   Revision. Deduplicate pages by document and Source Representation Revision
   before summing sources. The bounded owned projection is part of PR5b,
   while project-wide coverage is deferred.
3. Verify preview node IDs survive ordinary confirmation. Current revision
   contracts accept schemaNodes with supplied IDs; initialization/append stores
   the tree unchanged. Retain IDs, require uniqueness, and add a round-trip test.
   Also distinguish conflict-sensitive initialization from an idempotent create:
   reconcile an uncertain confirmation by reading the head before retry.
4. Name an enforceable parser design. PR6 uses streaming fflate ZIP preflight,
   actual expanded-byte accounting before ExcelJS, and a streaming WorkbookReader
   adapter with selected-sheet/header checks. Over-limit rows/columns fail
   explicitly. A guard-ordering fixture is required before upload UI. These
   application limits are not a claimed process-memory guarantee.
5. Audit non-null batchExtractionId + reviewTransfer consumers. The identified
   readers, module draft/pairing logic, DTO, client recovery and grid are listed
   in [seam evidence](seam-checks.md). The grid currently does not expose transfer
   detail, so PR7 must update its view model and test every consumer; source
   inspection alone is not evidence that this combination already works.
6. Make PR3 Evidence semantics a prerequisite for PR5a. PR4 model suggestions
   remain independently deliverable.
7. Make snapshot failures atomic: throw/roll back the whole batch transaction;
   never substitute null for failed capture. Equal-selection replay/recovery
   keeps pins; ordinary create-new captures a fresh snapshot. Existing
   multi-sample precedence is reused unchanged and tested for batch.
8. Add counterexamples: API/grid parity, three missing optional cells at
   finalization, dirty field navigation, source reprocessing, mixed selected-source
   coverage, hostile headers and exact import bounds, node-ID reload, a failing
   fourth member and conflicting samples.

The final plan retains implementation checks and current workbench acceptance
as unchecked work. No server gate, new review decision kind, persisted lifecycle
or migration was added to resolve the critique.
