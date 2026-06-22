# Design: fix-highlight-border-offset

## Context

The PDF viewer uses `pdfjs-dist`'s `PDFViewer`. Each rendered page is a `.page` div with a **9px transparent border** (defined in `pdf_viewer.css` and noted in the project's `pdf-viewer.css`). The border is invisible but real — it provides spacing and is used for shadow pseudo-elements.

`EvidenceHighlightLayer` draws highlight rectangles on a canvas overlay. To convert text-layer coordinates (PDF viewport space, relative to the page content area) to canvas coordinates, the code calls `getBoundingClientRect()` on the `.page` element and subtracts the container's rect. However, `getBoundingClientRect()` returns the **border box** — the outer edge including the border — so the computed origin is 9px too far left and 9px too far up relative to where the content actually starts.

## Goals / Non-Goals

**Goals:**

- Correct the per-page origin used when drawing highlight rectangles so it points to the content area, not the border box edge.

**Non-Goals:**

- Changing how text-layer coordinates are computed.
- Handling padding (`.page` has no padding).
- Device-pixel-ratio scaling (a separate concern).

## Decisions

### Decision: Use `clientTop` / `clientLeft` to read the border width at runtime

**Choice:** Add `pageEl.clientTop` and `pageEl.clientLeft` to the computed `pageTop` and `pageLeft` values.

```typescript
const pageTop  = pageRect.top  - containerRect.top  + containerEl.scrollTop  + pageEl.clientTop
const pageLeft = pageRect.left - containerRect.left + containerEl.scrollLeft + pageEl.clientLeft
```

**Rationale:** `clientTop` and `clientLeft` return the rendered border-top-width and border-left-width in CSS pixels, reading directly from the live element. This is robust against any future change to the border value in CSS — no magic number required. The fix is two characters of change per line.

**Alternatives considered:**

- Hardcode `9`: brittle if the border ever changes.
- Use `querySelector('canvas')` inside the page: also correct, but more fragile to PDF.js DOM structure changes; `clientTop`/`clientLeft` is simpler and more self-documenting.

## Risks / Trade-offs

- Minimal risk: `clientTop`/`clientLeft` are standard DOM properties, always defined on HTML elements (0 if no border).
- If PDF.js ever removes the transparent border, the fix naturally degrades to 0 with no side effects.
