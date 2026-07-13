## Why

The current Review view renders the entire extraction result tree at once, causing the panel to grow arbitrarily long for complex schemas. Researchers lose orientation and spend time scrolling instead of examining individual segments. A VS Code-style drill-down navigator lets researchers focus on one segment at a time and stay oriented via breadcrumbs and history navigation.

## What Changes

- The Review sub-view in ResultsTab is replaced with a **navigator view** that shows only one level of the result tree at a time.
- An always-visible **breadcrumb bar** at the top of the content area shows the path to the current node (e.g. `Results › site_info › excavation`).
- Clicking an ObjectSection or ArraySection header **navigates into** that node instead of expanding it in place.
- **Back / Forward buttons** let researchers retrace their path through the result tree.
- At the root level the breadcrumb shows "Results"; back/forward buttons are hidden.
- PrimitiveRow rendering (display, expand-long, edit) is unchanged.
- JSON and Markdown views, Copy JSON, Download, and all edit/onChange/onValueClick callbacks are unaffected.

## Capabilities

### New Capabilities

- `result-tree-navigator`: Stateful drill-down navigation (current path, history stack) for the Review view in ResultsTab, including breadcrumb bar and back/forward controls.

### Modified Capabilities

- `extraction-results-view`: The Review sub-view requirement changes from a fully-expanded collapsible tree to a single-level navigator. Breadcrumb, history navigation, and drill-down interaction become required behaviour.

## Impact

- **`prototypes/studio/src/ResultsTab.tsx`** — `view === 'review'` section refactored to use new navigator state.
- **`prototypes/studio/src/ResultValue.tsx`** — ObjectSection and ArraySection receive an optional `onNavigate` callback; clicking their headers fires navigation instead of local expand/collapse. PrimitiveRow is untouched.
- No new dependencies. No backend changes. No API changes.
