## Why

Studio currently opens exactly one Source Document at a time: clicking a document in the Project rail immediately navigates the whole workspace to it, and `AppFrame` remounts `DocumentWorkspace` from scratch (`key={workspace.persistedExtraction?.extractionId ?? workspace.pdfUrl}`). That remount also tears down the right rail, so the Schema panel resets even though `ExtractionSchema` belongs to the `ProjectContext`, not to the Source Document — a researcher comparing two Source Documents against the same Extraction Schema loses their place and any in-progress schema view every time they switch. There is also no lightweight way to glance at a Source Document without committing to keeping it open: a single click in the rail is already a full, permanent navigation. Researchers who work through a Project Context's documents one by one need the low-friction, multi-document browsing model this pattern is built for.

## What Changes

- Add a VS Code–style tab strip above the PDF viewer. Each opened Source Document is its own tab; several can stay open at once within a Project Context.
- Add a breadcrumb bar below the tab strip showing `Project Context name > Source Document name` for the active tab.
- Single-clicking a Source Document in the Project rail opens it as a **preview tab**: rendered in italics, and reused/replaced in place if another preview tab is already open (does not accumulate tabs). Double-clicking a Source Document in the rail, or interacting with an already-open preview tab, promotes it to a permanently open tab.
- Visually merge the PDF viewer and the right-hand rail (Schema/Results/Evidence) into a single bordered card so they read as one workspace surface instead of two independent panes.
- Switching tabs within the same Project Context swaps the PDF viewer, breadcrumb, and Results/Evidence content to the newly active Source Document's own Extraction, but leaves the Schema panel showing the Project Context's current Extraction Schema — it does not reset or reload.
- Closing a tab does not close others; closing the active tab activates the tab that was open before it.

## Capabilities

### New Capabilities

- `studio-tabbed-workspace`: Tab strip and breadcrumb navigation over open Source Documents within a Project Context, preview-vs-pinned tab lifecycle, and Schema-panel continuity across tab switches within the same Project Context.

## Impact

Changes Studio's routing/navigation state (`projectNavigation.ts`, `AppFrame.tsx`) to track multiple open Source Documents per Project Context instead of one, changes `ProjectContextRail.tsx`'s click handling to distinguish single- from double-click, and changes `App.tsx`/`RightRail.tsx` so the Schema panel's lifetime is scoped to the Project Context rather than the currently keyed Source Document while Results/Evidence stay scoped to it. Does not change persistence, the extraction pipeline, or any backend contract — `ExtractionSchema` is already Project Context-scoped in `packages/db`; this only fixes the frontend's per-document remount to match.
