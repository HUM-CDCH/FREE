# Durable interactive Extraction: planning review record

Date: 2026-10-04. Status: final readiness verdict READY; no unresolved critical choice. Baseline `a1ae85b7ce500aa57ffd4025453c4703665daca7`. Origin: [Map durable interactive extraction and project-wide feedback](https://github.com/HUM-CDCH/FREE/issues/169).

The researcher explicitly authorized completing all remaining map tickets and consulting Claude Code for uncertain judgment, asking the human only for important choices without common grounding. This overrides the skill's default one-ticket-per-session cadence for this run; the map remains planning-only. The requested model spelling was rejected with 404; the researcher approved the configured Claude Code default at high effort. Successful consultation results report actual model `claude-fable-5-1`.

Consultations were tool-disabled, read-only print requests, supplied the existing decision comments, facts, and draft assets. Claude did not edit production, access databases, execute migrations/tests, post to the tracker, or impersonate the researcher. No production provider calls, DBOS launches, or runtime database mutations were performed by this planning run. Browser checks target only the in-memory throwaway prototype.

| Review | Verdict and resolution |
| --- | --- |
| Interaction prototype | Grounded to resolve after concrete reducer defects. Fixed saving acknowledgement, per-target compatibility, saved/adopted selections, failed-boundary edits, control-aware restart, history, failed Retry, attribution, and focus/toggle semantics. Captured prototype branch and browser evidence. |
| Integration seam | Restricted PostgreSQL coordination namespace recommended over message-only consistency, with DBOS retaining execution. Accepted narrow worker routines/no app-table access. Strengthened durable pre-call capture and immutable exact inputs. |
| Architecture precision | Reviewer accepted the explicit constraints. Corrected best-effort feedback ordering to locked monotonic committed head capture; separated lease epoch from planned attempt fence; kept Stop drain publication; preserved capture history through reservation; pinned historical coverage and immutable plan publication. |
| Specification/release consistency | Fixed three concrete blockers: takeover epoch wording, refusal to admit partially checkpointed methods, and unchanged-selection Retry input reuse. Clarified Studio grants, role startup prerequisite, pending Resume, and recovery fault injection. The question about Retry after Stop was already answered by the researcher: terminal for every protocol; removed the erroneous legacy exception. |
| Final interaction rule | Later parameter edits cancel pending Resume and retain Paused for Apply/Discard; this reconciles automatic pending continuation with the agreed editing pause requirement. Added a concrete walkthrough. Reviewer returned READY and explicitly found no remaining blocker or human question. |

Accepted user decisions prevail over analogies suggested by the consultant. In particular, accepted Stop ends Stopped, while only Pause's final-completion race favors Completed. Compatible ungrounded guidance remains eligible; no automatic semantic conflict detection was added. Target compatibility is not a global flag: the same active text correction can match an unchanged text schema and fail a revised numeric schema. After supersession, only the new active correction revision is guidance.

The parallel root-checkout review redesign/ADR 0016 was read only for compatibility. Its existing-protocol path/anchor/grounded-only restrictions are explicitly separated from the new capability's durable identities and retained ungrounded corrections. The new proposed architecture ADR uses 0017 to avoid a numbering collision. Other sessions' tracked and untracked files were left untouched.

Implementation evidence remains future work, not a planning readiness claim: guarded migration/role tests, real DBOS process-recovery faults, per-method counting stubs, source Evidence validation, context-token limits, concurrent edits/export pagination, and reference-safe GC/deletion. The [release matrix](2026-10-04-durable-interactive-extraction-release.md) states those checks and safe entry points. The [specification](2026-10-04-durable-interactive-extraction-specification.md) fixes interfaces/ownership and coherent boundaries.

Implementation-session update: [incremental implementation evidence](../validation/2026-10-04-durable-interactive-extraction-implementation.md) records the candidate's disposable checks and bounded code reviews. The READY verdict above concerns the planning map; it does not approve the implementation or enable admissions. The completed results-review stack through PR 183 is imported and its shared components consume durable values. Combined release review and the requested baratheon Spark E2E matrix remain outstanding.

## Pre-production implementation scope amendment

Scope amendment, 2026-10-04: the user confirmed this is pre-production and
removed historical extraction compatibility from this feature. No legacy result
reader/identity mapping, failed-legacy upgrade Retry, protocol-0 fallback,
Cancel-to-Stop translation, or mixed-protocol export is required. Retry applies
to durable attempts in the same Extraction. Immutable producing inputs,
corrections, source Evidence, restricted coordination, and the admission gate
remain required. This amendment supersedes the original planning map's legacy
release requirements; it does not change the settled durable product decisions.

The earlier planning review describes the original scope; its legacy compatibility findings are no longer release requirements. Current removal and verification evidence is recorded in the implementation evidence document.
