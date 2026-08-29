## Live lifecycle acceptance

- [ ] Ingest all three shipped examples through the live Parsing Service using
  a disposable PostgreSQL database and retained-package root.
- [ ] Run the current server-owned values and grounding stages with the exact
  configured model on every canonical-ready example; record correctness,
  per-stage and aggregate tokens, and latency.
- [ ] Persist one accepted grounded result per successful example and verify
  clean values, canonical Evidence links, Review Decisions, safe highlights,
  and fresh-browser reopen.
