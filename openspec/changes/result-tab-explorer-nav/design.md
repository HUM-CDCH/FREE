## Context

`ResultsTab.tsx` renders the extraction result as a recursive collapsible tree. The Review view renders correctly but has no spatial context — researchers cannot tell where they are in a deep schema, and expanding many nodes at once makes the panel very tall.

The existing `ResultValue` component already tracks every node's location via `path: string[]`. No data-model changes are needed.

## Goals / Non-Goals

**Goals:**
- Add a breadcrumb path bar and back/forward buttons above the Review content area.
- Clicking an ObjectSection or ArraySection header navigates into that node: only its children are shown, and the rest of the tree is hidden.
- Breadcrumb segments are clickable to jump to any ancestor.
- Back/forward buttons traverse the navigation history.
- At a fresh root, the bar shows "Results" only and history controls are hidden; Forward remains available after history returns to root.

**Non-Goals:**
- Changing the initial (root) view appearance — it stays identical to today.
- Changing primitive display semantics; Review remains read-only.
- Changing Raw JSON export semantics.
- Any backend or API changes.

## Decisions

### 1. Navigation state lives in `ResultsTab`

Three new state variables alongside the existing `view`:

```ts
const [navPath, setNavPath] = useState<string[]>([])   // current node path
const [backStack, setBackStack] = useState<string[][]>([])
const [forwardStack, setForwardStack] = useState<string[][]>([])
```

At `navPath = []` the root view is shown (identical to today). Navigating into a node pushes the current path onto `backStack`, clears `forwardStack`, and sets the new `navPath`.

### 2. `ObjectSection` and `ArraySection` accept an optional `onNavigate` callback

```ts
onNavigate?: () => void
```

When provided, clicking the row header fires `onNavigate` instead of the local expand/collapse toggle. When absent, existing behaviour is fully preserved — no regression risk.

`PrimitiveRow` is not touched.

### 3. Current node is resolved with a pure `getAtPath` function

```ts
function getAtPath(obj: unknown, path: string[]): unknown {
  return path.reduce((cur, key) =>
    Array.isArray(cur) ? cur[Number(key)] :
    isRecord(cur) ? (cur as Record<string, unknown>)[key] :
    undefined, obj)
}
```

The review section renders `getAtPath(displayResult, navPath)` as the root object, passing `onNavigate` callbacks that append one key to the path. Navigation state does not duplicate result data.

### 4. Breadcrumb bar layout

A thin bar sits between the stats/tab toolbar and the content list:

- Segments: `Results` (always) followed by each key in `navPath`, separated by `›`.
- Each segment except the last is a clickable button that navigates to that ancestor and places the abandoned deeper path in forward history.
- Back `‹` and forward `›` icon buttons flank the breadcrumb. They are hidden at a fresh root, while Forward remains visible after returning to root through history or a direct ancestor click.

### 5. History resets on new extraction result

An effect resets `navPath`, `backStack`, and `forwardStack` when the extraction state changes.

### 6. Canonical Markdown view

App passes the parsed document Markdown through RightRail. Markdown is a read-only local view with no model or API call. Copy JSON and Download continue to export the extraction result.

## Risks / Trade-offs

- **Array items** — `ArraySection` items also get `onNavigate`; navigating into an array item shows only that item's fields. Array index appears as `[0]`, `[1]`, etc. in the breadcrumb.
- **Shallow change** — the feature adds state and one prop to two components. Rollback is trivial.
