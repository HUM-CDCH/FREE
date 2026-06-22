## 1. Fix coordinate offset

- [x] 1.1 In `prototypes/mine/pdf-render/src/EvidenceHighlightLayer.tsx`, in the `render` function, add `pageEl.clientTop` to `pageTop` and `pageEl.clientLeft` to `pageLeft` when computing each page's canvas draw origin
