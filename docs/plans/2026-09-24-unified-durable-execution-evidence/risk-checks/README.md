# Focused plan risk experiments — 2026-09-25

Status: **executed; all expected outcomes reproduced.** These are review probes,
not implementation of M2–M6. See [raw results](results.txt). The checked source
was `2605692`, with Node 24.21.0, PostgreSQL 17.11 and the installed Prisma Next
0.16.0. All ten existing migrations ran on a fresh disposable database.

| Finding | Experiment and result | Decision for tomorrow |
| --- | --- | --- |
| First generation in two tabs | The real `initializeSchemaRevision` ran in two PostgreSQL transactions, held just after both reads found no schema. Both created a schema. Acquiring one existing project-row lock before the same code produced one creation and one conflict. | No browser synchronization machinery. This is pre-existing and off the critical path; a row lock is the demonstrated small fix if required. Do not promise first-generation cross-tab exclusion meanwhile. |
| Late generation replaces local edits | The real editor and save coordinator used an observed persistence port. An edit appended against revision 1, then the late generation appended against revision 2, becoming revision 3. | Preserve existing live-tab behavior. Narrow the plan's base-only acceptance wording to reload recovery instead of adding a new editing restriction. |
| Cleanup races publication | Two PostgreSQL connections and an artifact older than 24 hours reproduced references-first → publish/finish → terminal-read → deletion of a referenced run. Terminal-first → fresh references preserved it. An unreferenced terminal control was still removed. | Specify read ordering and retain the race assertion in M6. No lock service or deletion barrier. |
| M2 removes dependencies before M4 | The real extraction job reader returned normally. Renaming its job table, simulating M2 removal, made the same reader fail with SQLSTATE `42P01`; restoring the table restored the read. | M2–M4 are one integration boundary. Component checks between them; no deployment of the incomplete middle state. |
| First request after restart has no key | A real local HTTP server set the boot header but waited for the key before responding. The planned response hook learned the boot ID only after `model_key_required` (409, zero provider calls). Sending the key before the action returned 200 with one call. The 60-second wait was shortened to 150 ms. | Await the existing key handoff before new model actions. Keep boot-header recovery for running work. |
| Backup omits staged input | A real `pg_dump`/`psql` round trip restored a synthetic queued-input reference. Copying only the listed volumes left its PDF missing (`ENOENT`). Adding `source-inbox` restored the exact bytes. | Add `source-inbox` to the backup set. No migration or backup framework. |

The schema and removed-table probes invoke current production functions. The
cleanup, key and backup probes execute the proposed protocols with synthetic
state, because those M2–M6 implementations do not exist yet. They establish the
counterexamples and small fixes, not full DBOS recovery, provider or browser
acceptance. These findings do not justify replacing the already-planned M0R
and milestone tests with another harness.

The overall plan in the main checkout is revision seven. The M1 worktree at
`dfd33fb` still has revision six. Refresh the implementation branch before M2;
this does not require redoing M1.

## Reproduce

Use an existing **test** PostgreSQL container published at loopback port 5432,
with PostgreSQL user `postgres` and `POSTGRES_PASSWORD` in its environment:

```bash
python3 docs/plans/2026-09-24-unified-durable-execution-evidence/risk-checks/run.py free-m1-pg
```

The runner validates both URLs with FREE's disposable-target guard, creates two
uniquely named `free_test_plan_risks_*` databases, runs the probes, and drops only
those databases in `finally`. It never stops the container or changes another
database. The test connection password is neither retained nor printed. All
files and the HTTP server are temporary. No models, provider keys or research
documents are used. The scripts are retained as evidence and are not wired into
CI. A successful run means the expected defect/control outcomes were observed.

The first backup attempt exceeded Node's default subprocess-output buffer while
dumping migration metadata. The final probe dumps only its synthetic admission
table; the final complete rerun passed.

Bloat audit: pass, no blockers. The large migration output was replaced with a
two-field summary. Deliberate faulty/fixed sequences exist only in these probes;
no application flags, compatibility layers, dependencies or coordination APIs
were added. The scanner's three legacy-wording alerts concern the earlier M1
plan edits, whose historical-row fixtures remain intentional. Remaining risk:
the future runtime still needs its named integration checks.
