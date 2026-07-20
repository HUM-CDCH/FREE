## 1. ResultValue — add onNavigate support

- [x] 1.1 Add optional `onNavigate?: () => void` to `ObjectSection` props; when provided, clicking the header fires `onNavigate` instead of the local expand/collapse toggle
- [x] 1.2 Add `onNavigate?: () => void` to `ArraySection` props with the same behaviour as ObjectSection
- [x] 1.3 Add `onNavigate` to `ResultValueProps` and thread it through to `ObjectSection` and `ArraySection`

## 2. ResultsTab — navigator state and helpers

- [x] 2.1 Add `getAtPath(obj, path)` pure function: traverses a nested object/array along a `string[]` path and returns the node value
- [x] 2.2 Add three navigator state variables: `navPath: string[]`, `backStack: string[][]`, `forwardStack: string[][]`, all initialised to empty arrays
- [x] 2.3 In the existing `useEffect` that resets `editedResult` on `state` changes, also reset `navPath`, `backStack`, and `forwardStack` to empty

## 3. ResultsTab — breadcrumb and navigation UI

- [x] 3.1 Add a breadcrumb bar at the top of the Review content area: always shows the "Results" label followed by each segment of `navPath`; render back/forward buttons only when `navPath.length > 0`
- [x] 3.2 Each ancestor segment in the breadcrumb (all but the last) is a clickable button: clicking pushes the current `navPath` onto `backStack`, clears `forwardStack`, and navigates to that ancestor path
- [x] 3.3 Back button: pushes current `navPath` onto `forwardStack`, pops the top of `backStack` as the new `navPath`
- [x] 3.4 Forward button: pushes current `navPath` onto `backStack`, pops the top of `forwardStack` as the new `navPath`

## 4. ResultsTab — wire up navigator rendering

- [x] 4.1 Resolve the current node with `getAtPath(displayResult, navPath)`; in the Review area render only that node's direct children (`navPath.length === 0` falls back to the unchanged root view)
- [x] 4.2 Pass an `onNavigate` callback to each rendered `ResultValue`: `() => navTo([...navPath, key])`, where `navTo` encapsulates push-backStack / clear-forwardStack / set-navPath

## 5. Styling

- [x] 5.1 Use existing design tokens (`text-ink-muted`, `text-ink`, `text-accent`, `border-line`, etc.) for the breadcrumb bar; use the same Tailwind classes as the existing toolbar buttons for back/forward controls

## 6. Navigator regression coverage

- [x] 6.1 Render only direct descendants and always show the Results breadcrumb
- [x] 6.2 Preserve Forward when Back returns to root
- [x] 6.3 Restore the canonical read-only Markdown result view
- [x] 6.4 Preserve Copy JSON and Download exports
