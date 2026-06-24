import os
import sys
import time
import argparse
import subprocess
import json
from pdf_utils import convert_pdf_to_images, download_file

def parse_args():
    parser = argparse.ArgumentParser(description="Compare Docling and PaddleOCR extraction on PDF pages.")
    parser.add_argument(
        "--source",
        type=str,
        default="https://arxiv.org/pdf/2408.09869",
        help="Path or URL to the input PDF file (default: arXiv paper URL)."
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="comparison_output",
        help="Directory to save comparison results."
    )
    parser.add_argument(
        "--dpi",
        type=int,
        default=150,
        help="DPI for converting PDF to images (default: 150)."
    )
    parser.add_argument(
        "--device",
        type=str,
        default="gpu:0",
        help="Device to use for PaddleOCR (e.g., gpu:0, cpu) (default: gpu:0)."
    )
    parser.add_argument(
        "--pipeline",
        type=str,
        choices=["all", "docling", "docling_pdf", "docling_images", "paddleocr"],
        default="all",
        help="Which pipeline step to run (default: all, which runs subprocesses)."
    )
    return parser.parse_args()

def main():
    args = parse_args()

    # 1. Resolve source and download if URL
    source = args.source
    os.makedirs(args.output_dir, exist_ok=True)

    if source.startswith("http://") or source.startswith("https://"):
        pdf_name = source.split("/")[-1]
        if not pdf_name.endswith(".pdf"):
            pdf_name = "downloaded_doc.pdf"
        local_pdf_path = os.path.join(args.output_dir, pdf_name)
        if not os.path.exists(local_pdf_path):
            download_file(source, local_pdf_path)
        else:
            print(f"Using cached PDF at {local_pdf_path}")
    else:
        local_pdf_path = os.path.abspath(source)
        pdf_name = os.path.basename(local_pdf_path)

    if not os.path.exists(local_pdf_path):
        print(f"Error: PDF file does not exist at {local_pdf_path}")
        return

    pdf_base = os.path.splitext(pdf_name)[0]
    pdf_output_dir = os.path.join(args.output_dir, pdf_base)
    os.makedirs(pdf_output_dir, exist_ok=True)

    # 2. Convert PDF to images
    images_dir = os.path.join(pdf_output_dir, "images")
    print(f"\n--- Converting PDF to images ({args.dpi} DPI) ---")
    start_time = time.time()
    image_paths = convert_pdf_to_images(local_pdf_path, images_dir, dpi=args.dpi)
    conv_duration = time.time() - start_time
    print(f"Converted {len(image_paths)} pages in {conv_duration:.2f} seconds.")

    # 3. Subprocess Orchestration
    if args.pipeline == "all":
        print("\n==================================================")
        print("Starting isolated pipeline runs to prevent CUDA OOM conflicts")
        print("==================================================")

        # Step A: Run Docling subprocess
        docling_cmd = [
            sys.executable, __file__,
            "--source", args.source,
            "--output-dir", args.output_dir,
            "--dpi", str(args.dpi),
            "--device", args.device,
            "--pipeline", "docling"
        ]
        print(f"\nSpawning Docling process: {' '.join(docling_cmd)}")
        subprocess.run(docling_cmd, check=True)

        # Step B: Run PaddleOCR subprocess
        paddle_cmd = [
            sys.executable, __file__,
            "--source", args.source,
            "--output-dir", args.output_dir,
            "--dpi", str(args.dpi),
            "--device", args.device,
            "--pipeline", "paddleocr"
        ]
        print(f"\nSpawning PaddleOCR process: {' '.join(paddle_cmd)}")
        subprocess.run(paddle_cmd, check=True)

        # Step C: Load stats and build final report
        stats_docling = {}
        stats_paddle = {}

        stats_docling_path = os.path.join(pdf_output_dir, "stats_docling.json")
        stats_paddle_path = os.path.join(pdf_output_dir, "stats_paddleocr.json")

        if os.path.exists(stats_docling_path):
            with open(stats_docling_path, "r") as f:
                stats_docling = json.load(f)
        if os.path.exists(stats_paddle_path):
            with open(stats_paddle_path, "r") as f:
                stats_paddle = json.load(f)

        # Merge stats
        comparison_stats = {
            "pages": len(image_paths),
            "docling_pdf": stats_docling.get("docling_pdf", {"time": 0.0, "char_count": 0, "status": "Failed to run"}),
            "docling_images": stats_docling.get("docling_images", {"time": 0.0, "char_count": 0, "status": "Failed to run"}),
            "paddle_images": stats_paddle.get("paddle_images", {"time": 0.0, "char_count": 0, "status": "Failed to run"})
        }

        # Save summary report
        report_path = os.path.join(pdf_output_dir, "comparison_report.md")
        docling_pdf_dir = os.path.join(pdf_output_dir, "docling_pdf")
        docling_img_dir = os.path.join(pdf_output_dir, "docling_images")
        paddle_dir = os.path.join(pdf_output_dir, "paddleocr_images")

        report_content = f"""# Extraction Comparison Report

- **Document**: `{pdf_name}`
- **Total Pages**: {comparison_stats["pages"]}
- **DPI for Images**: {args.dpi}
- **PaddleOCR Device**: {args.device}

## Performance & Extraction Metrics

| Pipeline | Status | Total Time (s) | Avg Time/Page (s) | Extracted Characters |
|---|---|---|---|---|
| **Docling (PDF Direct)** | {comparison_stats["docling_pdf"]["status"]} | {comparison_stats["docling_pdf"]["time"]:.2f} | {comparison_stats["docling_pdf"]["time"]/comparison_stats["pages"]:.2f} | {comparison_stats["docling_pdf"]["char_count"]} |
| **Docling (Images)** | {comparison_stats["docling_images"]["status"]} | {comparison_stats["docling_images"]["time"]:.2f} | {comparison_stats["docling_images"]["time"]/comparison_stats["pages"]:.2f} | {comparison_stats["docling_images"]["char_count"]} |
| **PaddleOCR (Images)** | {comparison_stats["paddle_images"]["status"]} | {comparison_stats["paddle_images"]["time"]:.2f} | {comparison_stats["paddle_images"]["time"]/comparison_stats["pages"]:.2f} | {comparison_stats["paddle_images"]["char_count"]} |

## Directory Structure of Outputs

All generated comparison files are structured under: `{os.path.relpath(pdf_output_dir, os.getcwd())}/`

- **Images**: `{os.path.relpath(images_dir, os.getcwd())}/` (rendered PNG files per page)
- **Docling (PDF Direct)**: `{os.path.relpath(docling_pdf_dir, os.getcwd())}/document.md`
- **Docling (Images)**: `{os.path.relpath(docling_img_dir, os.getcwd())}/` (extracted Markdown files per page)
- **PaddleOCR (Images)**: `{os.path.relpath(paddle_dir, os.getcwd())}/` (extracted Markdown and structure JSON files per page)

## Pipeline Observations

1. **Docling (PDF Direct)**:
   - Reads digital PDF elements natively. Fast and doesn't suffer from pixelation artifacts. Good structure representation.
2. **Docling (Images)**:
   - Processes the visual page render. Leverages OCR (like EasyOCR/Tesseract) inside Docling's pipeline.
3. **PaddleOCR (Images)**:
   - Uses Paddle's deep learning PPStructure pipeline to identify layouts (texts, tables, images) and run OCR on individual components.
"""
        with open(report_path, "w", encoding="utf-8") as f:
            f.write(report_content)

        print(report_content)
        print(f"\nReport successfully saved to {report_path}")
        return

    # 4. Docling Pipeline Subprocess
    if args.pipeline in ["docling", "docling_pdf", "docling_images"]:
        print(f"\n--- Running Docling pipelines: {args.pipeline} ---")
        docling_pdf_dir = os.path.join(pdf_output_dir, "docling_pdf")
        docling_img_dir = os.path.join(pdf_output_dir, "docling_images")

        stats = {}

        # Run Docling PDF Direct
        if args.pipeline in ["docling", "docling_pdf"]:
            os.makedirs(docling_pdf_dir, exist_ok=True)
            stats["docling_pdf"] = {"time": 0.0, "char_count": 0, "status": "Not run"}
            start_time = time.time()
            try:
                from docling.document_converter import DocumentConverter
                converter = DocumentConverter()
                doc_result = converter.convert(local_pdf_path).document
                docling_pdf_md = doc_result.export_to_markdown()

                docling_pdf_path = os.path.join(docling_pdf_dir, "document.md")
                with open(docling_pdf_path, "w", encoding="utf-8") as f:
                    f.write(docling_pdf_md)

                stats["docling_pdf"]["time"] = time.time() - start_time
                stats["docling_pdf"]["char_count"] = len(docling_pdf_md)
                stats["docling_pdf"]["status"] = "Success"
                print(f"Docling PDF direct completed in {stats['docling_pdf']['time']:.2f} seconds.")
            except Exception as e:
                stats["docling_pdf"]["status"] = f"Failed: {e}"
                print(f"Error running Docling on PDF: {e}")

        # Run Docling on converted page images
        if args.pipeline in ["docling", "docling_images"]:
            os.makedirs(docling_img_dir, exist_ok=True)
            stats["docling_images"] = {"time": 0.0, "char_count": 0, "status": "Not run"}
            start_time = time.time()
            docling_img_mds = []
            try:
                from docling.document_converter import DocumentConverter
                converter = DocumentConverter()
                for idx, img_path in enumerate(image_paths):
                    print(f"Processing page {idx+1}/{len(image_paths)} with Docling...")
                    page_res = converter.convert(img_path).document
                    page_md = page_res.export_to_markdown()

                    page_output_path = os.path.join(docling_img_dir, f"page_{idx+1:02d}.md")
                    with open(page_output_path, "w", encoding="utf-8") as f:
                        f.write(page_md)
                    docling_img_mds.append(page_md)

                stats["docling_images"]["time"] = time.time() - start_time
                stats["docling_images"]["char_count"] = sum(len(md) for md in docling_img_mds)
                stats["docling_images"]["status"] = "Success"
                print(f"Docling Images completed in {stats['docling_images']['time']:.2f} seconds.")
            except Exception as e:
                stats["docling_images"]["status"] = f"Failed: {e}"
                print(f"Error running Docling on images: {e}")

        # Merge stats if stats_docling.json exists
        stats_path = os.path.join(pdf_output_dir, "stats_docling.json")
        existing_stats = {}
        if os.path.exists(stats_path):
            try:
                with open(stats_path, "r") as f:
                    existing_stats = json.load(f)
            except Exception:
                pass
        existing_stats.update(stats)

        with open(stats_path, "w") as f:
            json.dump(existing_stats, f)
        return

    # 5. PaddleOCR Pipeline Subprocess
    if args.pipeline == "paddleocr":
        print(f"\n--- Running PaddleOCR page images ---")
        # Set PaddlePaddle environment flags before any paddle imports
        os.environ["FLAGS_fraction_of_gpu_memory_to_use"] = "0.85"
        os.environ["FLAGS_allocator_strategy"] = "auto_growth"
        os.environ["FLAGS_eager_delete_tensor_gb"] = "0.0"
        os.environ["FLAGS_use_onednn"] = "0"

        paddle_dir = os.path.join(pdf_output_dir, "paddleocr_images")
        os.makedirs(paddle_dir, exist_ok=True)

        stats = {
            "paddle_images": {"time": 0.0, "char_count": 0, "status": "Not run"}
        }

        start_time = time.time()
        paddle_texts = []
        try:
            from paddleocr import PPStructureV3
            pipeline = PPStructureV3(
                text_detection_model_name="PP-OCRv6_medium_det",
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                device=args.device,
            )

            for idx, img_path in enumerate(image_paths):
                print(f"Processing page {idx+1}/{len(image_paths)} with PaddleOCR...")
                output = pipeline.predict(img_path)

                page_paddle_dir = os.path.join(paddle_dir, f"page_{idx+1:02d}")
                os.makedirs(page_paddle_dir, exist_ok=True)

                for res in output:
                    res.save_to_markdown(save_path=page_paddle_dir)
                    res.save_to_json(save_path=page_paddle_dir)

                    md_dict = getattr(res, "markdown", {})
                    if md_dict and isinstance(md_dict, dict):
                        paddle_texts.append(md_dict.get("markdown_texts", ""))

            stats["paddle_images"]["time"] = time.time() - start_time
            stats["paddle_images"]["char_count"] = sum(len(txt) for txt in paddle_texts)
            stats["paddle_images"]["status"] = "Success"
            print(f"PaddleOCR completed in {stats['paddle_images']['time']:.2f} seconds.")
        except Exception as e:
            stats["paddle_images"]["status"] = f"Failed: {e}"
            print(f"Error running PaddleOCR: {e}")

        with open(os.path.join(pdf_output_dir, "stats_paddleocr.json"), "w") as f:
            json.dump(stats, f)
        return

if __name__ == "__main__":
    main()
