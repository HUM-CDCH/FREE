# Durable Extraction monitor recovery reproduction

Status: reproduced; implementation handed off at the user's request.
Unresolved work: [issue #192](https://github.com/HUM-CDCH/FREE/issues/192).
Backend fix: [PR #191](https://github.com/HUM-CDCH/FREE/pull/191), merged as
`961a815a56d0097f0d940bab7341db6f76bc13d7` and released on Baratheon.

## Observed behavior

During a real authenticated production Retry, Studio displayed “Unable to
update status. The extraction may still be running.” with a Reconnect button.
The researcher confirmed that clicking Reconnect clears the warning. A read-only
check at 09:03 UTC showed the attempt still running, 406 saved calls, snapshot
202, and no recorded failure. This was an intermediate observation, not a
completion claim. Studio server logs did not show a corresponding exception.
The initial failed request's cause remains unidentified.

A subsequent read-only check at 09:07 UTC confirmed this production attempt
`COMPLETED`: 205 records, 1,025 root values, 454 populated values, all 454 with
evidence, no provisional or failed values, no in-flight calls, and the final
processing-complete proof. Phoenix's matching `extractDurableV1` span ended with
status `OK` at 09:03:46 UTC. This verifies backend completion while the UI
recovery issue remains unresolved.

The primary monitor in `prototypes/studio/src/useExtraction.ts` pauses after
any failed status read. `acceptDurableStatus` returns immediately for an unchanged
lifecycle status, so a healthy `RUNNING` report cannot clear the warning or resume
that paused monitor. In `prototypes/studio/src/DurableResults.tsx`, the callback
effect depends on the status string rather than each accepted live read, so
successive healthy reads with the same status do not notify the controller.

## Executable reproduction

The adjacent [regression patch](2026-10-06-durable-monitor-reconnect.patch) adds
one test to the existing hook suite. Apply it on a clean implementation branch:

```bash
git apply docs/validation/2026-10-06-durable-monitor-reconnect.patch
pnpm --filter studio exec vitest run src/useExtraction.test.tsx -t 'fresh durable status reconnects'
```

The test fails at `expect(result.current.monitorError).toBeNull()`:

1. Open an existing `RUNNING` Extraction.
2. Simulate one failed primary GET with status 502.
3. Confirm the disconnected warning.
4. Restore the reader and deliver a fresh durable `RUNNING` status.
5. Expect the warning to clear, subsequent primary polling to resume, no POST,
   and no terminal callback.

The observed warning remains set at step 5. This patch is a known failing
reproduction artifact, separate from the executable suite until implementation.
It contains synthetic identities and no source document or account data.

## Next implementation and acceptance

Recover the paused primary monitor on a healthy current live status, including
an unchanged lifecycle. Forward each accepted live durable read to that recovery
path. Use `loaded.state`, not a pinned historical result page. Keep read-generation,
abort, ownership, and monotonic-version guards intact.

Add a call-site regression proving that unchanged healthy live reads reach the
controller. Verify that stale, aborted, or different-Extraction reads cannot
recover it. Preserve pinned result/decision pairs and drafts. Recovery must not
admit another Extraction or announce terminal completion twice. Retain manual
Reconnect when no successful live reader is available.

If the initial request failure recurs, capture its actual response/status through
the normal authenticated path. A mocked 502 proves the UI recovery defect; it does
not establish the status code or cause of the original production failure.

## Completed backend and release evidence

PR #191's exact canonical document replay completed using the deployment models
in an isolated database: 205 discovered records, 1,025 root values, 461 populated
values with evidence, no provisional or failed values, zero failed processing
windows, and zero undecided verification results. Completed checkpoints survived
Retry and a worker restart. Source accounting and processing completeness passed;
boundary/evidence completeness did not, and recall was unmeasured. These diagnostics
require researcher review; successful processing is not a perfect-recall claim.

The final candidate passed 15 native lifecycle cases, five native recovery cases,
both PostgreSQL upgrade paths, 90 database unit cases, and 1,403 Parsing Service
cases. CI passed. The normal `free-deploy release` completed with a consistent
backup, unchanged backup before/after data counts, healthy replacement application
containers, preserved model and other protected services, and passing HTTP/auth
gates. The user's authenticated production Retry subsequently completed as
recorded above. No release is needed for this documentation-only handoff.

Private source material, request bodies, Phoenix spans, credentials, and deployment
inventory remain in ignored task artifacts. The original user's worktree was not
modified; implementation and evidence were prepared in the isolated E2E checkout.
