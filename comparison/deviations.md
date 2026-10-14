# Deviations from the sealed protocol

1. H1, condition Q: the first execution read its parts and called resolution, then the harness failed while
   writing its output (`ExtractModel.model` instead of `.repo`), so nothing of it was kept. The harness was fixed
   and H1/Q executed once more; that second execution is the one reported.
2. Amendment 1 (document-sourced scalars do not reach resolution): every run, H1/Q included, uses the amended
   schema. The H1/Q pilot under the original schema is kept in `pilot/` and not counted.
3. Scorer fix, no rule change: the 360-dpi dev parses are named `ocr360-<canonical run>.pdf`, so the scorer maps
   each to its gold document through the ablation's own source list (`run-dev-b1prime/extractor-config.json`).
