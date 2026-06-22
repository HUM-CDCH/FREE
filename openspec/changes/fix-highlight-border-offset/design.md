# Design: fix-highlight-border-offset

## Context

`EvidenceHighlightLayer` draws highlight rectangles on a canvas overlay positioned over the PDF viewer. Two coordinate bugs prevented highlights from landing on the right text:

**Bug 1 — border offset:** Each `.page` div in PDF.js has a 9px transparent border. `getBoundingClientRect()` returns the border-box edge, so the computed page origin was 9px too far left and 9px too far up relative to the actual content area.

**Bug 2 — scale factor:** PDF.js renders pages at `currentScale × (96/72)`, converting PDF points to CSS pixels (`CSS_UNITS = 96.0 / 72.0`). Our viewport was created with `pdfPage.getViewport({ scale: currentScale })`, missing the `CSS_UNITS` factor. Text-layer coordinates were therefore scaled to ~75% of their correct size, making highlights appear shrunk and displaced towards the upper-left.

Additionally, the original evidence mechanism (model provides `{snippet, page}` per field) was abandoned: NuExtract3 does not reliably produce the augmented format, so highlights were never built. The component was rewritten to search the PDF text layer directly for each extracted string value.

## Goals / Non-Goals

**Goals:**

- Correct page-to-canvas coordinates so highlights align with rendered text.
- Replace model-provided evidence with direct text-layer search so highlights work independently of model output format.

**Non-Goals:**

- Handling PDF page rotation or skewed transforms.
- Device-pixel-ratio canvas sharpening (a separate quality concern).
- Highlighting non-string values (numbers, booleans).

## Decisions

### Decision: Multiply viewport scale by `CSS_UNITS = 96/72`

```typescript
const CSS_UNITS = 96.0 / 72.0
const viewport = pdfPage.getViewport({ scale: pdfViewer.currentScale * CSS_UNITS })
```

**Rationale:** PDF.js `PDFPageView` creates its rendering viewport the same way. Using the same factor ensures our text-content coordinate conversion matches the actual rendered page layout exactly, regardless of the user-set zoom level.

### Decision: Compensate for `.page` border with `clientTop` / `clientLeft`

```typescript
const pageTop  = pageRect.top  - containerRect.top  + containerEl.scrollTop  + pageEl.clientTop
const pageLeft = pageRect.left - containerRect.left + containerEl.scrollLeft + pageEl.clientLeft
```

**Rationale:** `clientTop`/`clientLeft` read the live rendered border width in CSS pixels, so the fix is robust to any future CSS change. No magic numbers.

### Decision: Direct value search instead of model-provided evidence

The component traverses the clean extraction result, collects all string leaf values, and searches each one in `pdfPage.getTextContent()`. Progressive shortening (full value → 5-word prefix → 3-word prefix) tolerates OCR and formatting differences. Highlights are colored by top-level result key using a 4-color palette.

**Rationale:** NuExtract3 is reliable at filling its native flat-value template format; augmenting the schema with `{value, snippet, page}` objects produced unstable output with high variance. Delegating text location to the frontend removes the model compliance requirement entirely.

## Risks / Trade-offs

- Direct search may fail to locate values that span multiple text items or that differ from the extracted string due to OCR normalization. Progressive shortening mitigates this partially.
- `clientTop`/`clientLeft` are always defined (0 when no border), so the fix degrades cleanly if PDF.js removes its transparent border.
