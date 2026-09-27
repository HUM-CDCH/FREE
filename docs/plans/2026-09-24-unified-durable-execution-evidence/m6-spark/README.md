# DBOS M6 on the DGX Spark: cutover and end-to-end smoke (pending)

The Spark cutover and its smoke remain pending. The local verification record is [here](../../../validation/2026-09-26-dbos-m6-verification.md); the ordered controller steps are in [M6 Tasks 15–16](../../2026-09-26-dbos-m6-gc-docs-cutover.md).

- `make_scans.py` renders the repository's grave reports into image-only PDFs for OCR and layout checks.
- `queries.sql` reads workflow, schedule, pool and orphan evidence, then probes the kei role's isolation.
- `planted-key-scan.sh` prints match counts for a synthetic key in the database dump, volumes and logs.

The generated PDFs live only in `/tmp/free-m6-spark/`; they are not committed.
