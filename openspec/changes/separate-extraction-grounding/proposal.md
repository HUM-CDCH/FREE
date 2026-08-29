## Why

Separate values extraction and canonical Evidence grounding are implemented,
including server-owned persistence and reopen. Live acceptance is incomplete
across the three shipped Source Documents: Ellekilde completed the live
lifecycle, Zhang failed closed on unavailable v2 Evidence geometry, and
`1790-06-17-1.pdf` did not publish because Camelot retained Windows file
handles during replacement.

## Remaining work

- Ingest all three examples through the current live Parsing Service into a
  disposable database and retained-package root.
- Run the current server-owned values and grounding stages with the exact
  configured model on every canonical-ready example, recording correctness,
  tokens, and latency.
- For each successful example, persist one accepted grounded result and verify
  canonical links, Review Decisions, highlights, and fresh-browser reopen.

Deterministic fixtures do not satisfy this live gate. Zhang may remain a
recorded fail-closed readiness result when canonical geometry is unavailable.
