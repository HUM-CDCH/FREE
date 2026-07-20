## 1. Path-based selection

- [x] 1.1 Carry result paths from extracted leaves through result-row click callbacks and highlight entries
- [x] 1.2 Select, clear, scroll, and dim highlights by exact path equality
- [x] 1.3 Replace the stale value-based result-tracing contract with path selection and an explicit clear action

## 2. Deterministic painting

- [x] 2.1 Extract a pure cached-entry paint helper with explicit normal, active, and dimmed alpha values
- [x] 2.2 Paint every cached rectangle once per repaint and remove active double painting

## 3. Evidence-aware lookup

- [x] 3.1 Prefer evidence snippets and page hints while preserving direct scalar search fallback
- [x] 3.2 Exclude evidence metadata and support searchable string, finite-number, and boolean leaves

## 4. Verification

- [x] 4.1 Add regression tests for duplicate values, clear focus, alpha selection, and single-paint behavior
- [x] 4.2 Validate the change and run the Studio test, lint, and build checks
