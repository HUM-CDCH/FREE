## Why

Studio now has per-Project-Context Source Document tabs, breadcrumbs, recent-tab
activation, and independent close behavior. Every rail click still opens a
permanent tab: `DocumentTab` has no preview state and `open()` always appends a
new tab. Quick browsing therefore accumulates tabs.

## Remaining work

- A single rail click opens or replaces one italic preview tab.
- A double-click, or interaction with the previewed document, promotes that
  preview to a permanent tab.
- Existing permanent tabs, breadcrumb routing, recent-tab close behavior, and
  Project-Context-scoped Schema state remain unchanged.

This is Studio UI state only. It does not change persistence, extraction, or
server contracts.
