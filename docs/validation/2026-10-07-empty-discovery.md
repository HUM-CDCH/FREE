# Empty discovery after a field correction — 7 October 2026

Status: implementation and actual-source verification complete; independent
Claude Code Fable 5.1 review approved. Release verification pending.

## Failure and controlled comparisons

Five new Catalog extractions of a previously successful source saved a single
discovery response with zero places, both continuation flags true, finish `stop`
and 18 output tokens. The UI consequently displayed “No records were found in
the source.” The source revision and admitted method matched the successful
205-record extraction. Reads were scoped through the owning Project and Source
Document and used a read-only database connection.

The full discovery requests differed only in an appended, eligible field-value
correction example. The earlier full response had exceeded the 4,096-token
reply allowance, so existing recovery split its window into two and discovered
205 records. The new schema-valid empty reply did not invoke that recovery.

Controlled replays used the captured request and the internal deployed model;
no extraction records, corrections or result snapshots were written:

| Change from failing request | Input tokens | Output tokens | Result |
| --- | ---: | ---: | --- |
| None | 21,174 | 18 | Zero places, `stop`, 1.63 seconds |
| Remove field example only | 20,395 | 4,096 | `length`; existing split recovery applies |
| Remove JSON constraint only | 21,174 | 3,787 | 203 places, `stop` |
| Use earlier small window, retaining example | 9,935 | 2,619 | 178 places, `stop` |

This establishes an interaction between field guidance, constrained decoding
and the large window; it does not establish that every guided discovery fails
or that the provider's schema compiler is invalid.

## Change and actual-source acceptance

New discovery calls exclude field-value correction examples: discovery locates
record boundaries, while those examples correct schema field values. Each
excluded revision remains recorded in the captured input's `omissions` with
reason `stage`. Other stages retain their existing compatible, budgeted
guidance. Already finalized inputs and outputs are replayed unchanged.

A read-only live check loaded the same pinned canonical source generation,
verified that generation, and ran the existing discovery algorithm through the
fixed composer and actual model. It read the canonical source, not debug
artifacts, and used an in-memory diagnostic lease without database writes.
The source was counted by the serving tokenizer; the transport retained the
streaming and usage options used by the worker.

The full request reached its output limit. The two recovery windows returned
181 and 178 places respectively (including non-record boundaries), producing
**205 record entries, zero failed windows and zero unresolved source ranges**
in 207.89 seconds. No field extraction was invoked and no live result was
published. This verifies discovery recovery, not the semantic accuracy of
subsequent field values.

## Regression and release boundary

The new regression exercises the real durable planner and unified Catalog
algorithm with a scripted provider reproducing the observed empty guided
discovery. Before the fix it failed with an empty record list; after the fix it
finds both synthetic records and proves that field extraction still captures
the correction example. A second test keeps a previously finalized guided
discovery request immutable on retry. Existing honest empty-source tests remain
in the verification set.

No database schema, authentication, export projection, workflow step sequence or
DBOS application version changes. Existing completed empty extractions retain
their history; a fresh extraction creates new discovery inputs.

Private request data stays outside Git. Reproducible fast verification:
`pnpm --filter parsing-service test` and the focused
`tests/test_durable_extraction.py` / `tests/test_unified_catalog.py` suites.

The complete fast Python tier passed: 1,440 tests, 72 skipped and 88 database or
live-model tests deselected. The initial environment lacked tracing and grammar
dependencies; installing them into a temporary test-only directory allowed the
entire tier to run. The production image and repository dependency declarations
were not changed. Independent Fable 5.1 review approved the code, replay safety,
capture trace and regression tests; it did not run the tests itself.
