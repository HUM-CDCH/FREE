# PR 188 Baratheon merge acceptance

Date: 2026-10-06 (Europe/Rome). Status: **required infrastructure, live-model and
exploratory UI acceptance passed. The final record commit must also pass its own
CI and exact-head confirmation before merge.** Production deployment is separate.

PR: <https://github.com/HUM-CDCH/FREE/pull/188>. This completes acceptance left
open by [the repair record](2026-10-06-pr188-independent-review-followup.md).

## Source and isolation

Baratheon is spark-a892, ARM64. Private checkout:
/home/geba/Projects/FREE-pr188-review-fixes-20261006, with frozen Node 24.21.0,
pnpm 12.8.1 and Python 3.13.

Runtime candidate 7f1b499d9fc58e9f98efd478d721d6cb452506e1 integrates current dev
935c2457 (shared Compose tracing). Its durable implementation is unchanged from
verified b6b3cbe2. Candidate 778d62f77e32ce9eb1f9c663d53d564ef486ab95 adds one
browser fixture correction: seven URLs use the existing e2eStudioPath helper
under /free. It changes no product source or assertion.

Every tier owned its Compose project, loopback ports, PostgreSQL/mock-OIDC
containers, volumes, inbox and account. Docker network lifecycle was serialized
during browsers. Existing Qwen/GLiFormer endpoints were used only for inference;
no model was restarted. Production /srv/free/checkout, services and database
were not changed. Task resources were removed after each tier.

## Executed acceptance

| Check | Result | Candidate / evidence |
| --- | --- | --- |
| Unmodified root pnpm test:system | 15 passed, no skips | 7f1b499d; system/7f1b499d/test-system.log |
| Launcher / safety | 49 / 29 passed, no skips | 7f1b499d; static/launcher.log, safety.log |
| Standard authenticated browser | 71 passed, 4 conditional skips | 7f1b499d; browser/standard-final.json |
| Unified preferences opt-in | All 3 default-skipped cases passed | 7f1b499d; browser/unified-final.json |
| Restart/recovery browser | 5 passed, no skips | 7f1b499d; browser/recovery-final.json |
| Durable review browser | 18 passed, no skips | 7f1b499d; browser/durable-final.json |
| /free base path / affected root-path case | 1 / 1 passed, no skips | 778d62f7; browser/base-path-fixed.json, standard-schema-fixed.json |
| Typecheck / lint after fixture fix | Passed | 778d62f7; static/typecheck-778d62f7.log, lint-778d62f7.log |
| Live Article and unified Catalog browser/worker | 2 passed, no skips | 778d62f7; live-manual/live-provider-final.log |
| Focused exploratory Studio browser | 5 passed, no skips; zero page errors | 778d62f7; studio-manual/runner-final.log, report.json |
| Settled narrow finalization view | 1 passed; 375px visually inspected | 778d62f7; studio-manual/runner-narrow-final.log |

Paths are under the private checkout's artifacts/review-merge-acceptance/.
Copies were independently inspected locally. Playwright JSON reports have zero
unexpected failures and zero flaky cases. One remaining conditional case needs
an explicitly supplied private scanned PDF and OCR/model endpoints; it is not
counted as a pass. All three unified preference skips were executed successfully
with FREE_CATALOG_METHOD=unified.

The system stack built current source without an ARM overlay or runtime-source
replacement. It exercised real native parsing, durable Article completion,
87,539-character suggestion through two complete windows and one union,
whole-stack restart, permanent deletion and every GC phase. Image checks matched
721 tracked Studio/workspace source/manifests and all 93 Parsing source/manifests
in each API and worker image, with zero mismatches. Only the system tier's
external model responses were scripted.

Python PostgreSQL 45, recovery 5, service 1 and all 13 native lifecycle plus 5
crash cases still test the same Python/coordination implementation. Actual logs
and skip accounting remain in the linked repair record; CI's Node-only run does
not substitute for those checks.

## Live providers and exploratory UI

Live Article used nvidia/Qwen3.8-27B-NVFP4. Unified Catalog used real
knowledgator/gliformer-large-v1 native fields (protocol 1, revision
d0a4e53d09cebe6bc963dd9be319d4279084bb2d) and Qwen reasoning. Both tests checked
actual immutable requests, output digests, saved results and downloaded capture
history without requiring an exact stochastic value or record count.

An additional persistent Chromium session was operated through ad hoc Playwright
commands, inspecting the UI before choosing each next action. It completed real
OIDC login, UI Project creation, native PDF upload, an Article schema and explicit
Qwen choices. UI admission returned 201; two real calls completed. Opening the
grounded Site catalogue value highlighted page 1 anchor a_p1_s0. Typed Edit saved
an ungrounded correction without finalizing it. The separate **Finalize results
3 · decisions 1** action finalized that exact pair. Reload retained it; CSV
export preserved both original captures exactly. Requested/effective producing
method history was visible. There were zero page errors.

The focused scenarios used real OIDC, admission/read/review APIs, an owned
producer fixture for lifecycle publication, and deliberate 502/404 faults:

- Completion with Results collapsed or an earlier finalized pair inspected:
  toast appeared; **Review now** selected the latest attempt.
- Run disabled for QUEUED, RUNNING, PAUSING, PAUSED, FAILED and STOPPING latest
  attempts during older finalized inspection.
- Uncertain POST 502 then GET 404 retained the alert and previous results.
  Reconnect remained GET-only. After moving from page 1 to page 2, **Retry
  original request** sent identical original JSON and ID, including page 1;
  the actual API admitted it.
- Producing method history, explicit earlier-pair finalization and retained named
  cuts when newer data appeared; readable settled layout at 375px.

Seeded presentation is separate from real worker/provider evidence. The only
console errors were the three injected 502/404 responses. Selected synthetic
native-source screenshots: [evidence](2026-10-06-pr188-merge-acceptance/article-evidence.png),
[method](2026-10-06-pr188-merge-acceptance/article-method.png),
[reloaded finalization](2026-10-06-pr188-merge-acceptance/article-finalized.png),
[unified values](2026-10-06-pr188-merge-acceptance/unified-values.png).

## Diagnostics, review and final gate

Preliminary parallel browsers hit Chromium ERR_NETWORK_CHANGED during bootstrap.
All four cases passed in the complete serialized run. The /free fixture failure
also existed at a7a0919b; the authored helper fixed it without weakening assertions.
Exploratory locator assumptions, a late toast observer, approved rows hidden by
To check and an animation-time screenshot were resolved by inspecting actual
state. They are not silently counted as passes. Focused checks observed the
toast at the correct time; settled narrow layout was inspected separately.

The [independent final review](2026-10-06-pr188-final-candidate-review.md)
adjudicates required A–D findings and inspects executed evidence. No admission
gate, legacy reader/shim or deleted-workflow stub is present.

The final record commit adds documentation, selected screenshots and OpenSpec
archive metadata only. Before merge, its exact HEAD must pass CI, complete
Compose/browser acceptance, both live cases and focused manual scenarios.
Head stamps/rerun logs remain under the artifact root; the exact final SHA and
results are recorded in the PR body. Earlier green runs do not replace that
check. Main specs were already synced; archive uses --skip-specs to avoid
reapplying the removed capability.
