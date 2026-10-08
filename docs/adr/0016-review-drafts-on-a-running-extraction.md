# 0016: Review Decisions may be drafted on a running Extraction

> **Superseded by the [durable-only amendment of 0017](0017-durable-extraction-control-and-call-checkpoints.md#durable-only-amendment)** (2026-10-05).

Date: 2026-10-04. This decision let a researcher draft Review Decisions on the
finished records of a running Extraction, as a Review Draft keyed by result
path and Evidence Anchor and reconciled with the settled attempt when the run
ended. The durable-only change deleted that Review Draft, its settlement
reconciliation and the settled attempt's review authority together with the
non-durable execution path. Reviewing saved values while work continues
remains a product decision, met by durable corrections of stable saved values.
