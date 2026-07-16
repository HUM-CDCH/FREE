"""Benchmark-only parser comparison CLI.

Production ingestion no longer calls this script. Use it manually to compare
Docling/PaddleOCR behavior while the service worker uses the canonical Docling
DocTags runner.
"""

import argparse
import importlib
import json
import os
import re
import stat
import subprocess
import sys
import time

from app.parsing.render import convert_pdf_to_images

_SHARED_PAGE_IMAGE_RE = re.compile(r"page_([0-9]+)\.png")
# Paddle 3.x flag names are case-sensitive and must precede PaddleOCR import.
_PADDLE_ENV_FLAGS = {
    "FLAGS_fraction_of_gpu_memory_to_use": "0.85",
    "FLAGS_allocator_strategy": "auto_growth",
    "FLAGS_eager_delete_tensor_gb": "0.0",
    "FLAGS_use_onednn": "0",
}


def _discover_shared_page_images(images_dir: str) -> list[str]:
    try:
        names = os.listdir(images_dir)
    except OSError as exc:
        raise RuntimeError(
            "Could not read the shared benchmark image directory."
        ) from exc

    pages: dict[int, str] = {}
    for name in names:
        match = _SHARED_PAGE_IMAGE_RE.fullmatch(name)
        if match is None:
            if name.startswith("page_"):
                raise RuntimeError(f"Invalid shared page image filename: {name!r}.")
            continue

        try:
            page_number = int(match.group(1))
        except (TypeError, ValueError) as exc:
            raise RuntimeError(
                f"Invalid shared page image filename: {name!r}."
            ) from exc
        if page_number < 1:
            raise RuntimeError(
                f"Invalid shared page image filename: {name!r}; page numbers start at 1."
            )
        path = os.path.abspath(os.path.join(images_dir, name))
        try:
            file_mode = os.stat(path, follow_symlinks=False).st_mode
        except OSError as exc:
            raise RuntimeError(
                f"Could not inspect shared page image {name!r}."
            ) from exc
        if not stat.S_ISREG(file_mode):
            raise RuntimeError(
                f"Invalid shared page image {name!r}: expected a regular file."
            )
        if page_number in pages:
            raise RuntimeError(
                f"Duplicate shared page image number {page_number}: "
                f"{os.path.basename(pages[page_number])!r} and {name!r}."
            )
        pages[page_number] = path

    if not pages:
        raise RuntimeError(
            "The shared benchmark image directory contains no valid page images."
        )

    page_numbers = sorted(pages)
    first_gap = next(
        (
            expected
            for expected, actual in enumerate(page_numbers, start=1)
            if actual != expected
        ),
        None,
    )
    if first_gap is not None:
        raise RuntimeError(
            "Shared benchmark page images must be contiguous from page 1; "
            f"missing page {first_gap}."
        )
    return [pages[page_number] for page_number in page_numbers]


def ensure_dir(path: str):
    try:
        os.makedirs(path, exist_ok=True)
    except OSError as exc:
        raise RuntimeError(f"Could not create directory: {path}") from exc


def load_json_if_exists(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            loaded = json.load(f)
        return loaded if isinstance(loaded, dict) else {}
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Could not read JSON stats from {path}: {exc}")
        return {}


def write_json(path: str, data: dict):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except OSError as exc:
        raise RuntimeError(f"Could not write JSON file: {path}") from exc


def write_text(path: str, content: str):
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    except OSError as exc:
        raise RuntimeError(f"Could not write text file: {path}") from exc


def average_time_per_page(total_time: float, page_count: int) -> float:
    return total_time / page_count if page_count > 0 else 0.0


def parse_args():
    parser = argparse.ArgumentParser(
        description="Benchmark Docling and PaddleOCR parsing outputs; not used by production ingestion."
    )
    parser.add_argument(
        "--source",
        type=str,
        required=True,
        help="Path to the local PDF source document.",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="comparison_output",
        help="Directory to save comparison results.",
    )
    parser.add_argument(
        "--dpi",
        type=int,
        default=150,
        help="DPI for converting PDF to images (default: 150).",
    )
    parser.add_argument(
        "--device",
        type=str,
        default="cpu",
        help="Device to use for PaddleOCR (e.g., gpu:0, cpu) (default: cpu).",
    )
    parser.add_argument(
        "--images-dir",
        type=str,
        default=None,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--pipeline",
        type=str,
        choices=["all", "docling", "docling_pdf", "docling_images", "paddleocr"],
        default="all",
        help="Which pipeline step to run (default: all, which runs subprocesses).",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    # 1. Resolve the local Source Document.
    ensure_dir(args.output_dir)
    local_pdf_path = os.path.abspath(args.source)
    pdf_name = os.path.basename(local_pdf_path)

    if not os.path.exists(local_pdf_path):
        print(f"Error: PDF file does not exist at {local_pdf_path}")
        return

    pdf_base = os.path.splitext(pdf_name)[0]
    pdf_output_dir = os.path.join(args.output_dir, pdf_base)
    ensure_dir(pdf_output_dir)

    # 2. Convert PDF to images only for image-based pipelines. Direct Docling PDF
    # extraction should not eagerly rasterize the full source document.
    images_dir = os.path.join(pdf_output_dir, "images")
    image_paths: list[str] = []
    if args.pipeline in ["all", "docling", "docling_images", "paddleocr"]:
        reusable_images = getattr(args, "images_dir", None)
        if reusable_images:
            image_paths = _discover_shared_page_images(reusable_images)
        else:
            print(f"\n--- Converting PDF to images ({args.dpi} DPI) ---")
            start_time = time.time()
            image_paths = convert_pdf_to_images(
                local_pdf_path,
                images_dir,
                dpi=args.dpi,
            )
            conv_duration = time.time() - start_time
            print(f"Converted {len(image_paths)} pages in {conv_duration:.2f} seconds.")

    # 3. Subprocess Orchestration
    if args.pipeline == "all":
        print("\n==================================================")
        print("Starting isolated pipeline runs to prevent CUDA OOM conflicts")
        print("==================================================")

        # Step A: Run Docling subprocess
        docling_cmd = [
            sys.executable,
            __file__,
            "--source",
            local_pdf_path,
            "--output-dir",
            args.output_dir,
            "--dpi",
            str(args.dpi),
            "--device",
            args.device,
            "--pipeline",
            "docling",
            "--images-dir",
            images_dir,
        ]
        print(f"\nSpawning Docling process: {' '.join(docling_cmd)}")
        subprocess.run(docling_cmd, check=True)

        # Step B: Run PaddleOCR subprocess
        paddle_cmd = [
            sys.executable,
            __file__,
            "--source",
            local_pdf_path,
            "--output-dir",
            args.output_dir,
            "--dpi",
            str(args.dpi),
            "--device",
            args.device,
            "--pipeline",
            "paddleocr",
            "--images-dir",
            images_dir,
        ]
        print(f"\nSpawning PaddleOCR process: {' '.join(paddle_cmd)}")
        subprocess.run(paddle_cmd, check=True)

        # Step C: Load stats and build final report
        stats_docling_path = os.path.join(pdf_output_dir, "stats_docling.json")
        stats_paddle_path = os.path.join(pdf_output_dir, "stats_paddleocr.json")
        stats_docling = load_json_if_exists(stats_docling_path)
        stats_paddle = load_json_if_exists(stats_paddle_path)

        # Merge stats
        comparison_stats = {
            "pages": len(image_paths),
            "docling_pdf": stats_docling.get(
                "docling_pdf", {"time": 0.0, "char_count": 0, "status": "Failed to run"}
            ),
            "docling_images": stats_docling.get(
                "docling_images",
                {"time": 0.0, "char_count": 0, "status": "Failed to run"},
            ),
            "paddleocr": stats_paddle.get(
                "paddleocr",
                {"time": 0.0, "char_count": 0, "status": "Failed to run"},
            ),
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
| **Docling (PDF Direct)** | {comparison_stats["docling_pdf"]["status"]} | {comparison_stats["docling_pdf"]["time"]:.2f} | {average_time_per_page(comparison_stats["docling_pdf"]["time"], comparison_stats["pages"]):.2f} | {comparison_stats["docling_pdf"]["char_count"]} |
| **Docling (Images)** | {comparison_stats["docling_images"]["status"]} | {comparison_stats["docling_images"]["time"]:.2f} | {average_time_per_page(comparison_stats["docling_images"]["time"], comparison_stats["pages"]):.2f} | {comparison_stats["docling_images"]["char_count"]} |
| **PaddleOCR (Images)** | {comparison_stats["paddleocr"]["status"]} | {comparison_stats["paddleocr"]["time"]:.2f} | {average_time_per_page(comparison_stats["paddleocr"]["time"], comparison_stats["pages"]):.2f} | {comparison_stats["paddleocr"]["char_count"]} |

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
        write_text(report_path, report_content)

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
            ensure_dir(docling_pdf_dir)
            stats["docling_pdf"] = {"time": 0.0, "char_count": 0, "status": "Not run"}
            start_time = time.time()
            try:
                from docling.document_converter import DocumentConverter  # type: ignore[import-not-found]  # noqa: I001

                converter = DocumentConverter()
                doc_result = converter.convert(local_pdf_path).document
                docling_pdf_md = doc_result.export_to_markdown()

                docling_pdf_path = os.path.join(docling_pdf_dir, "document.md")
                write_text(docling_pdf_path, docling_pdf_md)

                stats["docling_pdf"]["time"] = time.time() - start_time
                stats["docling_pdf"]["char_count"] = len(docling_pdf_md)
                stats["docling_pdf"]["status"] = "Success"
                print(
                    f"Docling PDF direct completed in {stats['docling_pdf']['time']:.2f} seconds."
                )
            except Exception as e:
                stats["docling_pdf"]["status"] = f"Failed: {e}"
                print(f"Error running Docling on PDF: {e}")

        # Run Docling on converted page images
        if args.pipeline in ["docling", "docling_images"]:
            ensure_dir(docling_img_dir)
            stats["docling_images"] = {
                "time": 0.0,
                "char_count": 0,
                "status": "Not run",
            }
            start_time = time.time()
            docling_img_mds = []
            try:
                from docling.document_converter import DocumentConverter  # type: ignore[import-not-found]  # noqa: I001

                converter = DocumentConverter()
                for idx, img_path in enumerate(image_paths):
                    print(
                        f"Processing page {idx + 1}/{len(image_paths)} with Docling..."
                    )
                    page_res = converter.convert(img_path).document
                    page_md = page_res.export_to_markdown()

                    page_output_path = os.path.join(
                        docling_img_dir, f"page_{idx + 1:02d}.md"
                    )
                    write_text(page_output_path, page_md)
                    docling_img_mds.append(page_md)

                stats["docling_images"]["time"] = time.time() - start_time
                stats["docling_images"]["char_count"] = sum(
                    len(md) for md in docling_img_mds
                )
                stats["docling_images"]["status"] = "Success"
                print(
                    f"Docling Images completed in {stats['docling_images']['time']:.2f} seconds."
                )
            except Exception as e:
                stats["docling_images"]["status"] = f"Failed: {e}"
                print(f"Error running Docling on images: {e}")

        # Merge stats if stats_docling.json exists
        stats_path = os.path.join(pdf_output_dir, "stats_docling.json")
        existing_stats = load_json_if_exists(stats_path)
        existing_stats.update(stats)
        write_json(stats_path, existing_stats)
        return

    # 5. PaddleOCR Pipeline Subprocess
    if args.pipeline == "paddleocr":
        print("\n--- Running PaddleOCR page images ---")
        # Set PaddlePaddle environment flags before any paddle imports
        os.environ.update(_PADDLE_ENV_FLAGS)

        paddle_dir = os.path.join(pdf_output_dir, "paddleocr_images")
        ensure_dir(paddle_dir)

        stats = {"paddleocr": {"time": 0.0, "char_count": 0, "status": "Not run"}}

        start_time = time.time()
        paddle_texts = []
        try:
            paddleocr_module = importlib.import_module("paddleocr")
            pipeline = paddleocr_module.PPStructureV3(
                text_detection_model_name="PP-OCRv6_medium_det",
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                device=args.device,
            )

            for idx, img_path in enumerate(image_paths):
                print(f"Processing page {idx + 1}/{len(image_paths)} with PaddleOCR...")
                output = pipeline.predict(img_path)

                page_paddle_dir = os.path.join(paddle_dir, f"page_{idx + 1:02d}")
                ensure_dir(page_paddle_dir)

                for res in output:
                    res.save_to_markdown(save_path=page_paddle_dir)
                    res.save_to_json(save_path=page_paddle_dir)

                    md_dict = getattr(res, "markdown", {})
                    if md_dict and isinstance(md_dict, dict):
                        paddle_texts.append(md_dict.get("markdown_texts", ""))

            stats["paddleocr"]["time"] = time.time() - start_time
            stats["paddleocr"]["char_count"] = sum(len(txt) for txt in paddle_texts)
            stats["paddleocr"]["status"] = "Success"
            print(f"PaddleOCR completed in {stats['paddleocr']['time']:.2f} seconds.")
        except Exception as e:
            stats["paddleocr"]["status"] = f"Failed: {e}"
            print(f"Error running PaddleOCR: {e}")

        write_json(os.path.join(pdf_output_dir, "stats_paddleocr.json"), stats)
        return


if __name__ == "__main__":
    main()
