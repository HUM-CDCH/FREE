You are the requested Claude Code Fable 5.1 advisor and sparring partner for a repository implementation PLAN, not an implementer. No tools or writes are available in this session. Challenge my assumptions and propose a concrete, minimal, end-to-end integration. Do not claim you inspected files beyond the supplied evidence. You are not the decision maker; give strong counterarguments.

User request: "create a plan to include in workbench the useful feature from workflow. use claude code fable 5.1 as advisor and sparring partner".
Repository: FREE; authenticated humanities researchers define schemas, extract structured values from PDFs, review canonical source Evidence. Existing working branch feat/sample-extraction-workbench; use its DBOS architecture as foundation, not old workflow architecture.

Pinned evidence:
- workflow ba3e7cc105faa5a4ea021c4906d749a329fd914d forked at 5cf706c0 (Sept11), six private commits, 416 commits behind current origin/dev 287ccb4245b95654821849f91e067bbbd057c040.
- workbench current committed head 9b87c30792207a7a5aadff24df1e0c515f9824b0; original base dev80686ec4, roughly14 new dev commits to integrate. Another worker is changing application files concurrently; our scope is new plan docs plus a link from active workbench tasks. Never overwrite that work.
- A simulated workflow -> workbench merge at previous workbench21e7d85f had38 conflicted paths. Old workflow migrations start from an incompatible pre-DBOS hash and contain old ExtractionJob/BatchExtractionMember dependencies. Do not merge them.
- Current dev/workbench uses included kei_exp parser, one Extraction record from admission through outcome and review, Studio+Python DBOS, atomic row/workflow admission, method/source/schema/model choices pinned at admission. No new service, queue or duplicate persisted execution status.
- Current domain glossary: Sample Extraction=one Extraction over <=30 physical PDF pages, separate sample history, never latest/full result or project summary; Carried Review Decision starts a draft and stays non-authoritative until explicit finalization; Batch Extraction creates separate whole-document results for selected sources.

Already implemented workbench:
1 optional page scope, scoped artifact identity/replay, <=30 sorted unique pages, Article/general Catalog passages scoped, recipe Catalog segmentation remains whole source then selects entries; single and batch distinction preserved.
2 sample values beside schema fields with two-way PDF provenance, saved versioned drafts, existing schema flush-before-run/admission identity.
3 immutable reviewTransfer snapshot pinned at single admission, union from same document/source-representation/schema samples, latest decision wins per aligned node; record alignment by recipe segmentation or one-to-one mutual anchors, field=nodeId, array=anchors, exact value/Evidence checks. Carry approval/correction/rejection only on matching semantics; corrected evidence distinguishes fixed output. No authority until finalize.
4 persisted undoable one-to-one manual record pairings, unable to relax Evidence conditions. 9b87c307 fixes transfer across merge/stale pairing/disallowed values.
5 Batch members do NOT capture sample review transfer today.

Active workbench tasks:
PR1 page sampling/schema-tab review and PR2 transfer/manual pairing are checked.
PR3 still unchecked: nullable evidenceAnchorId for optional ungrounded decisions with canonical researcher-picked reviewedEvidence; multi-match correction Evidence picker and pick-on-page; inline rename/retype/add/remove.
PR4 still unchecked: propose descriptions/allowed-values from <=20 owned corrections loaded server-side into existing Interaction Route edit proposal; no Evidence text in stored instruction.
Acceptance/full validation and independent review unchecked.

workflow useful candidates:
A derived workflow progress/next-action guidance (ingest/schema/approve/pilot/review/collection), contextual CTA. Project context already has phase; should not create a second navigation/lifecycle.
B field-level "schema issue" action from review grid, carry example values/Evidence to schema editor; after editing run same source/page set. Proposed persistent SchemaIssueFlag table could be unnecessary if this is an immediate navigation intent.
C review classification/priority: success/partial/ungrounded/missing, honest completion summaries, guided unresolved-field attention.
D nullable review anchors and review of missing/ungrounded cells: workflow required decisions on every leaf/grid occurrence, approved null-anchor cells without source Evidence. This conflicts with workbench's current plan optional extra ungrounded decisions with canonical researcher-picked Evidence; choose semantics explicitly.
E spreadsheet-based schema suggestion from versioned project spreadsheet slot: ExcelJS, headers -> field tree, optional separator, type/enum inference; confirmed column->nodeId mapping; filename reserved for automatic gold-doc linkage in old branch. Optional gold/corpus evaluation infrastructure far larger than schema import.
F old hard "stabilise schema" action: every new revision unstabilised; >5document batch rejected unless at least1reviewed pilot Extraction. Usually full-document pilot rounds2-3 docs; previous rounds shown, readiness nudge if issue rate falls.
G reuse already fully reviewed whole-document pilot results in collection batch to avoid model calls; old branch cloned whole results+reviews. This is NOT the same as workbench review transfer, and a page sample must never count as a full result.
H project ingestion sidebar/cancel improvements; mostly superseded by current durable ingestion.
I opt-in old app/ multiprocessing parallel parsing; independent processor feature, should be deferred.
J evaluation corpora/gold alignment/identifying/tolerance scaffolding and retry/few-shot examples; much remains unchecked planned, should be independent.

Confirmed workflow defects from actual review:
P1 cloning uses different job and Extraction IDs -> clone404/document500; do not port clone design.
P1 spreadsheet __proto__.field header mutates Object.prototype before schema validation; safe dictionaries/own property handling required.
P2 suggested-schema confirmation bypasses hard stabilisation gate.
P2 parallel partition validates physical restored pages against prepared crop indices -> scanned PDFs fail.
P2 gold filename domain errors turned into generic503.
22 lint errors;1290Node tests passed despite missing behavioral coverage.

My preliminary direction for you to challenge:
- Workbench stays schema-centred. First finish existing evidence-aware review PR3/PR4.
- Include derived guidance, field-context jump, review attention/completion, and spreadsheet schema import as a bounded additional entry path.
- Consider adding sample-review draft transfer to batch members using existing immutable transfer rules, freshly extracting full sources, instead of legacy completed-result clone/reuse.
- Prefer readiness advice over mandatory schema stabilisation initially; no "sample proves schema ready" badge or implication that corrections automatically teach extraction.
- Defer gold benchmark/corpus, few-shot training/examples, whole-result reuse, parser parallelism, and unrelated ingestion rewrites.
- New authored forward migrations based on integrated current workbench/dev chain only.
- Keep existing page <=30 isolation, Evidence ownership, revision history, method pinning, DBOS recovery, transfer safety and draft conflicts.

Please return:
1 a keep/adapt/defer matrix, with pushback on anything falsely called useful;
2 recommend soft vs hard readiness and whether batch transfer belongs now;
3 resolve missing/ungrounded review semantics against current plan;
4 3-5 usable PR boundaries in dependency order (can depend on already planned PR3/PR4, don't duplicate them);
5 named risks/counterexamples, precise acceptance scenarios and which existing code seams to inspect;
6 strongest reasons this initial direction could be wrong.
Limit to about1500 words. Be direct and concrete; no code, no invented test results.
