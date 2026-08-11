"""Benchmark-only parser comparison CLI.

Production ingestion no longer calls this script. Use it manually to compare
Docling/PaddleOCR behavior while the service worker uses the canonical Docling
DocTags runner.
"""

import argparse
import importlib
import json
import multiprocessing
import os
import re
import stat
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from app.parsing.render import convert_pdf_to_images

_SHARED_PAGE_IMAGE_RE = re.compile(r"page_(\d+)\.png", re.ASCII)
# Paddle 3.x flag names are case-sensitive and must precede PaddleOCR import.
_PADDLE_ENV_FLAGS = {
    "FLAGS_fraction_of_gpu_memory_to_use": "0.85",
    "FLAGS_allocator_strategy": "auto_growth",
    "FLAGS_eager_delete_tensor_gb": "0.0",
    "FLAGS_use_onednn": "0",
}
_IMAGE_PIPELINES = frozenset(
    {"all", "docling", "docling_images", "paddleocr"}
)
_DOCLING_PDF_PIPELINES = frozenset({"docling", "docling_pdf"})
_DOCLING_IMAGE_PIPELINES = frozenset({"docling", "docling_images"})
_ISOLATED_PIPELINES = frozenset({"docling", "paddleocr"})
_CHILD_OPTION_ORDER = (
    "--source",
    "--output-dir",
    "--dpi",
    "--device",
    "--pipeline",
    "--images-dir",
)
_STATUS_FAILED_TO_RUN = "Failed to run"
_STATUS_NOT_RUN = "Not run"
_STATUS_SUCCESS = "Success"


def _validated_child_args(
    command: Sequence[str],
    *,
    check: bool,
) -> tuple[str, ...]:
    expected_length = 2 + (2 * len(_CHILD_OPTION_ORDER))
    if check is not True or len(command) != expected_length:
        raise ValueError("Isolated pipeline commands must use the fixed checked form.")
    if tuple(command[:2]) != (sys.executable, __file__):
        raise ValueError("Only this script may be launched in an isolated process.")

    child_args = tuple(command[2:])
    if child_args[::2] != _CHILD_OPTION_ORDER:
        raise ValueError("Isolated pipeline command options have an invalid shape.")
    pipeline_position = (_CHILD_OPTION_ORDER.index("--pipeline") * 2) + 1
    if child_args[pipeline_position] not in _ISOLATED_PIPELINES:
        raise ValueError("The requested pipeline cannot be launched in isolation.")
    return child_args


def _run_pipeline_child(child_args: tuple[str, ...]) -> None:
    sys.argv = [__file__, *child_args]
    main()


class _PipelineProcessRunner:
    """Run only this CLI's fixed child pipelines in a fresh interpreter."""

    def run(self, command: Sequence[str], *, check: bool) -> None:
        child_args = _validated_child_args(command, check=check)
        process = multiprocessing.get_context("spawn").Process(
            target=_run_pipeline_child,
            args=(child_args,),
        )
        process.start()
        process.join()
        exit_code = process.exitcode
        process.close()
        if exit_code != 0:
            raise RuntimeError(
                f"Isolated pipeline exited with status {exit_code}."
            )


_PIPELINE_PROCESS_RUNNER = _PipelineProcessRunner()
# Keep the module attribute stable for callers that replace the runner in benchmarks.
subprocess = _PIPELINE_PROCESS_RUNNER


def _list_shared_page_images(images_dir: str) -> list[str]:
    try:
        return os.listdir(images_dir)
    except OSError as exc:
        raise RuntimeError(
            "Could not read the shared benchmark image directory."
        ) from exc


def _shared_page_number(name: str) -> int | None:
    match = _SHARED_PAGE_IMAGE_RE.fullmatch(name)
    if match is None:
        if name.startswith("page_"):
            raise RuntimeError(f"Invalid shared page image filename: {name!r}.")
        return None

    page_number = int(match.group(1))
    if page_number < 1:
        raise RuntimeError(
            f"Invalid shared page image filename: {name!r}; page numbers start at 1."
        )
    return page_number


def _regular_page_image_path(images_dir: str, name: str) -> str:
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
    return path


def _add_shared_page_image(
    pages: dict[int, str],
    images_dir: str,
    name: str,
    page_number: int,
) -> None:
    path = _regular_page_image_path(images_dir, name)
    if page_number in pages:
        raise RuntimeError(
            f"Duplicate shared page image number {page_number}: "
            f"{os.path.basename(pages[page_number])!r} and {name!r}."
        )
    pages[page_number] = path


def _ordered_page_images(pages: dict[int, str]) -> list[str]:
    if not pages:
        raise RuntimeError(
            "The shared benchmark image directory contains no valid page images."
        )

    last_page = max(pages)
    if last_page != len(pages):
        first_gap = min(set(range(1, last_page + 1)).difference(pages))
        raise RuntimeError(
            "Shared benchmark page images must be contiguous from page 1; "
            f"missing page {first_gap}."
        )
    return [pages[page_number] for page_number in range(1, last_page + 1)]


def _discover_shared_page_images(images_dir: str) -> list[str]:
    pages: dict[int, str] = {}
    for name in _list_shared_page_images(images_dir):
        page_number = _shared_page_number(name)
        if page_number is not None:
            _add_shared_page_image(pages, images_dir, name, page_number)
    return _ordered_page_images(pages)


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


@dataclass(frozen=True, slots=True)
class _BenchmarkPaths:
    local_pdf_path: str
    pdf_name: str
    pdf_output_dir: str
    images_dir: str


def _resolve_benchmark_paths(
    args: argparse.Namespace,
) -> _BenchmarkPaths | None:
    ensure_dir(args.output_dir)
    local_pdf_path = os.path.abspath(args.source)
    pdf_name = os.path.basename(local_pdf_path)
    if not os.path.exists(local_pdf_path):
        print(f"Error: PDF file does not exist at {local_pdf_path}")
        return None

    pdf_base = os.path.splitext(pdf_name)[0]
    pdf_output_dir = os.path.join(args.output_dir, pdf_base)
    ensure_dir(pdf_output_dir)
    return _BenchmarkPaths(
        local_pdf_path=local_pdf_path,
        pdf_name=pdf_name,
        pdf_output_dir=pdf_output_dir,
        images_dir=os.path.join(pdf_output_dir, "images"),
    )


def _load_page_images(
    args: argparse.Namespace,
    paths: _BenchmarkPaths,
) -> list[str]:
    if args.pipeline not in _IMAGE_PIPELINES:
        return []

    reusable_images = getattr(args, "images_dir", None)
    if reusable_images:
        return _discover_shared_page_images(reusable_images)

    print(f"\n--- Converting PDF to images ({args.dpi} DPI) ---")
    start_time = time.time()
    image_paths = convert_pdf_to_images(
        paths.local_pdf_path,
        paths.images_dir,
        dpi=args.dpi,
    )
    duration = time.time() - start_time
    print(f"Converted {len(image_paths)} pages in {duration:.2f} seconds.")
    return image_paths


def _child_pipeline_command(
    args: argparse.Namespace,
    paths: _BenchmarkPaths,
    pipeline: str,
) -> list[str]:
    return [
        sys.executable,
        __file__,
        "--source",
        paths.local_pdf_path,
        "--output-dir",
        args.output_dir,
        "--dpi",
        str(args.dpi),
        "--device",
        args.device,
        "--pipeline",
        pipeline,
        "--images-dir",
        paths.images_dir,
    ]


def _spawn_pipeline(
    args: argparse.Namespace,
    paths: _BenchmarkPaths,
    pipeline: str,
    display_name: str,
) -> None:
    command = _child_pipeline_command(args, paths, pipeline)
    print(f"\nSpawning {display_name} process: {' '.join(command)}")
    _PIPELINE_PROCESS_RUNNER.run(command, check=True)


def _empty_pipeline_stats(status: str) -> dict:
    return {"time": 0.0, "char_count": 0, "status": status}


def _collect_comparison_stats(
    paths: _BenchmarkPaths,
    page_count: int,
) -> dict:
    stats_docling = load_json_if_exists(
        os.path.join(paths.pdf_output_dir, "stats_docling.json")
    )
    stats_paddle = load_json_if_exists(
        os.path.join(paths.pdf_output_dir, "stats_paddleocr.json")
    )
    return {
        "pages": page_count,
        "docling_pdf": stats_docling.get(
            "docling_pdf",
            _empty_pipeline_stats(_STATUS_FAILED_TO_RUN),
        ),
        "docling_images": stats_docling.get(
            "docling_images",
            _empty_pipeline_stats(_STATUS_FAILED_TO_RUN),
        ),
        "paddleocr": stats_paddle.get(
            "paddleocr",
            _empty_pipeline_stats(_STATUS_FAILED_TO_RUN),
        ),
    }


def _metric_row(label: str, stats: dict, page_count: int) -> str:
    total_time = stats["time"]
    average_time = average_time_per_page(total_time, page_count)
    return (
        f"| **{label}** | {stats['status']} | {total_time:.2f} | "
        f"{average_time:.2f} | {stats['char_count']} |"
    )


def _build_comparison_report(
    args: argparse.Namespace,
    paths: _BenchmarkPaths,
    comparison_stats: dict,
) -> str:
    page_count = comparison_stats["pages"]
    docling_pdf_row = _metric_row(
        "Docling (PDF Direct)",
        comparison_stats["docling_pdf"],
        page_count,
    )
    docling_images_row = _metric_row(
        "Docling (Images)",
        comparison_stats["docling_images"],
        page_count,
    )
    paddleocr_row = _metric_row(
        "PaddleOCR (Images)",
        comparison_stats["paddleocr"],
        page_count,
    )
    def report_path(path: str) -> str:
        try:
            return os.path.relpath(path, os.getcwd())
        except ValueError:
            # Windows cannot make paths relative across drive letters.
            return str(path)

    relative_output_dir = report_path(paths.pdf_output_dir)
    relative_images_dir = report_path(paths.images_dir)
    relative_docling_pdf_dir = report_path(
        os.path.join(paths.pdf_output_dir, "docling_pdf")
    )
    relative_docling_images_dir = report_path(
        os.path.join(paths.pdf_output_dir, "docling_images")
    )
    relative_paddle_dir = report_path(
        os.path.join(paths.pdf_output_dir, "paddleocr_images")
    )
    return f"""# Extraction Comparison Report

- **Document**: `{paths.pdf_name}`
- **Total Pages**: {page_count}
- **DPI for Images**: {args.dpi}
- **PaddleOCR Device**: {args.device}

## Performance & Extraction Metrics

| Pipeline | Status | Total Time (s) | Avg Time/Page (s) | Extracted Characters |
|---|---|---|---|---|
{docling_pdf_row}
{docling_images_row}
{paddleocr_row}

## Directory Structure of Outputs

All generated comparison files are structured under: `{relative_output_dir}/`

- **Images**: `{relative_images_dir}/` (rendered PNG files per page)
- **Docling (PDF Direct)**: `{relative_docling_pdf_dir}/document.md`
- **Docling (Images)**: `{relative_docling_images_dir}/` (extracted Markdown files per page)
- **PaddleOCR (Images)**: `{relative_paddle_dir}/` (extracted Markdown and structure JSON files per page)

## Pipeline Observations

1. **Docling (PDF Direct)**:
   - Reads digital PDF elements natively. Fast and doesn't suffer from pixelation artifacts. Good structure representation.
2. **Docling (Images)**:
   - Processes the visual page render. Leverages OCR (like EasyOCR/Tesseract) inside Docling's pipeline.
3. **PaddleOCR (Images)**:
   - Uses Paddle's deep learning PPStructure pipeline to identify layouts (texts, tables, images) and run OCR on individual components.
"""


def _run_all(
    args: argparse.Namespace,
    paths: _BenchmarkPaths,
    image_paths: list[str],
) -> None:
    print("\n==================================================")
    print("Starting isolated pipeline runs to prevent CUDA OOM conflicts")
    print("==================================================")
    _spawn_pipeline(args, paths, "docling", "Docling")
    _spawn_pipeline(args, paths, "paddleocr", "PaddleOCR")

    comparison_stats = _collect_comparison_stats(paths, len(image_paths))
    report_content = _build_comparison_report(args, paths, comparison_stats)
    report_path = os.path.join(paths.pdf_output_dir, "comparison_report.md")
    write_text(report_path, report_content)
    print(report_content)
    print(f"\nReport successfully saved to {report_path}")


def _new_docling_converter():
    module = importlib.import_module("docling.document_converter")
    return module.DocumentConverter()


def _extract_docling_pdf(paths: _BenchmarkPaths) -> int:
    document = _new_docling_converter().convert(paths.local_pdf_path).document
    markdown = document.export_to_markdown()
    write_text(
        os.path.join(paths.pdf_output_dir, "docling_pdf", "document.md"),
        markdown,
    )
    return len(markdown)


def _extract_docling_images(
    paths: _BenchmarkPaths,
    image_paths: list[str],
) -> int:
    converter = _new_docling_converter()
    output_dir = os.path.join(paths.pdf_output_dir, "docling_images")
    total_characters = 0
    for index, image_path in enumerate(image_paths, start=1):
        print(
            f"Processing page {index}/{len(image_paths)} with Docling..."
        )
        page = converter.convert(image_path).document
        markdown = page.export_to_markdown()
        write_text(
            os.path.join(output_dir, f"page_{index:02d}.md"),
            markdown,
        )
        total_characters += len(markdown)
    return total_characters


def _execute_pipeline(
    extract: Callable[[], int],
    completed_name: str,
    error_name: str,
) -> dict:
    stats = _empty_pipeline_stats(_STATUS_NOT_RUN)
    start_time = time.time()
    try:
        char_count = extract()
    except Exception as exc:
        stats["status"] = f"Failed: {exc}"
        print(f"Error running {error_name}: {exc}")
    else:
        stats["time"] = time.time() - start_time
        stats["char_count"] = char_count
        stats["status"] = _STATUS_SUCCESS
        print(f"{completed_name} completed in {stats['time']:.2f} seconds.")
    return stats


def _run_docling(
    args: argparse.Namespace,
    paths: _BenchmarkPaths,
    image_paths: list[str],
) -> None:
    print(f"\n--- Running Docling pipelines: {args.pipeline} ---")
    stats = {}
    if args.pipeline in _DOCLING_PDF_PIPELINES:
        ensure_dir(os.path.join(paths.pdf_output_dir, "docling_pdf"))
        stats["docling_pdf"] = _execute_pipeline(
            lambda: _extract_docling_pdf(paths),
            "Docling PDF direct",
            "Docling on PDF",
        )
    if args.pipeline in _DOCLING_IMAGE_PIPELINES:
        ensure_dir(os.path.join(paths.pdf_output_dir, "docling_images"))
        stats["docling_images"] = _execute_pipeline(
            lambda: _extract_docling_images(paths, image_paths),
            "Docling Images",
            "Docling on images",
        )

    stats_path = os.path.join(paths.pdf_output_dir, "stats_docling.json")
    existing_stats = load_json_if_exists(stats_path)
    existing_stats.update(stats)
    write_json(stats_path, existing_stats)


def _paddle_result_char_count(result) -> int:
    markdown = getattr(result, "markdown", {})
    if not isinstance(markdown, dict):
        return 0
    return len(markdown.get("markdown_texts", ""))


def _save_paddle_results(results, page_output_dir: str) -> int:
    ensure_dir(page_output_dir)
    char_count = 0
    for result in results:
        result.save_to_markdown(save_path=page_output_dir)
        result.save_to_json(save_path=page_output_dir)
        char_count += _paddle_result_char_count(result)
    return char_count


def _extract_paddleocr(
    args: argparse.Namespace,
    paths: _BenchmarkPaths,
    image_paths: list[str],
) -> int:
    paddleocr_module = importlib.import_module("paddleocr")
    pipeline = paddleocr_module.PPStructureV3(
        text_detection_model_name="PP-OCRv6_medium_det",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device=args.device,
    )
    output_dir = os.path.join(paths.pdf_output_dir, "paddleocr_images")
    total_characters = 0
    for index, image_path in enumerate(image_paths, start=1):
        print(
            f"Processing page {index}/{len(image_paths)} with PaddleOCR..."
        )
        page_output_dir = os.path.join(output_dir, f"page_{index:02d}")
        total_characters += _save_paddle_results(
            pipeline.predict(image_path),
            page_output_dir,
        )
    return total_characters


def _run_paddleocr(
    args: argparse.Namespace,
    paths: _BenchmarkPaths,
    image_paths: list[str],
) -> None:
    print("\n--- Running PaddleOCR page images ---")
    os.environ.update(_PADDLE_ENV_FLAGS)
    ensure_dir(os.path.join(paths.pdf_output_dir, "paddleocr_images"))
    stats = {
        "paddleocr": _execute_pipeline(
            lambda: _extract_paddleocr(args, paths, image_paths),
            "PaddleOCR",
            "PaddleOCR",
        )
    }
    write_json(
        os.path.join(paths.pdf_output_dir, "stats_paddleocr.json"),
        stats,
    )


def main():
    args = parse_args()
    paths = _resolve_benchmark_paths(args)
    if paths is None:
        return

    image_paths = _load_page_images(args, paths)
    if args.pipeline == "all":
        _run_all(args, paths, image_paths)
    elif args.pipeline == "paddleocr":
        _run_paddleocr(args, paths, image_paths)
    else:
        _run_docling(args, paths, image_paths)


if __name__ == "__main__":
    main()
