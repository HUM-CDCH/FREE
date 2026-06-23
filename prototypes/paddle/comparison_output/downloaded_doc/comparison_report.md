# Extraction Comparison Report
    
- **Document**: `downloaded_doc.pdf`
- **Total Pages**: 9
- **DPI for Images**: 150
- **PaddleOCR Device**: gpu:0

## Performance & Extraction Metrics

| Pipeline | Status | Total Time (s) | Avg Time/Page (s) | Extracted Characters |
|---|---|---|---|---|
| **Docling (PDF Direct)** | Success | 35.04 | 3.89 | 34022 |
| **Docling (Images)** | Success | 104.16 | 11.57 | 31925 |
| **PaddleOCR (Images)** | Success | 241.33 | 26.81 | 31240 |

## Directory Structure of Outputs

All generated comparison files are structured under: `comparison_output/downloaded_doc/`

- **Images**: `comparison_output/downloaded_doc/images/` (rendered PNG files per page)
- **Docling (PDF Direct)**: `comparison_output/downloaded_doc/docling_pdf/document.md`
- **Docling (Images)**: `comparison_output/downloaded_doc/docling_images/` (extracted Markdown files per page)
- **PaddleOCR (Images)**: `comparison_output/downloaded_doc/paddleocr_images/` (extracted Markdown and structure JSON files per page)

## Pipeline Observations

1. **Docling (PDF Direct)**:
   - Reads digital PDF elements natively. Fast and doesn't suffer from pixelation artifacts. Good structure representation.
2. **Docling (Images)**:
   - Processes the visual page render. Leverages OCR (like EasyOCR/Tesseract) inside Docling's pipeline.
3. **PaddleOCR (Images)**:
   - Uses Paddle's deep learning PPStructure pipeline to identify layouts (texts, tables, images) and run OCR on individual components.
