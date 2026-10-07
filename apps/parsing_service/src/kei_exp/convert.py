"""Command line for the pipeline's Markdown output."""
import argparse
from pathlib import Path

from kei_exp.kie.runner import convert
from kei_exp.kie.stages import ocr
from kei_exp.models import MODELS
from kei_exp.transcription.types import DEFAULT_URL, ConversionError, RunParams


def page_range(text: str) -> tuple[int, int]:
    """argparse type for --pages: 'A-B' or 'A', 1-based inclusive."""
    first, _, last = text.partition("-")
    try:
        a, b = int(first), int(last or first)
    except ValueError:
        raise argparse.ArgumentTypeError(f"expected A-B or A, got {text!r}")
    if not 1 <= a <= b:
        raise argparse.ArgumentTypeError(f"pages must satisfy 1 <= A <= B, got {text!r}")
    return a, b


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert a PDF with a selectable Docling model")
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--model", choices=MODELS, default="granite_vision")
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--output-dir", type=Path, help="Markdown directory (default: scratch/MODEL)")
    parser.add_argument("--debug-dir", type=Path, help="Save input images, prompt, predictions and API token usage")
    parser.add_argument("--result-dir", type=Path, help="Write the accepted page files and manifest (result.json)")
    parser.add_argument("--max-image-size", type=int,
                        help="Maximum image edge in pixels; preserves aspect ratio "
                             "(default: 1200, or the largest crop with --cut auto)")
    parser.add_argument("--cut", choices=["auto", "none"], default="auto",
                        help="Split each page into layout regions (pages of a spread, columns, figures) "
                             "and convert the crops (default: auto)")
    parser.add_argument("--crop-dpi", type=int, default=250, help="Render dpi of region crops (default: 250)")
    parser.add_argument("--page-source", choices=["pdf", "ingest"], default="pdf",
                        help="Pages to transcribe: the PDF's own, or the book pages the KIE ingest cuts out of its "
                             "scanned spreads (cached under runs/kie/<pdf stem>; with --cut none, whole pages "
                             "go at --crop-dpi)")
    parser.add_argument("--pages", type=page_range, help="Convert only pages A-B (1-based, inclusive) or page A")
    parser.add_argument("--stream", action="store_true", help="Print live model output with [page N] labels")
    parser.add_argument("--max-output-tokens", type=int, help="Override the selected VLM's output allowance")
    args = parser.parse_args()

    if args.max_image_size is not None and args.max_image_size <= 0:
        parser.error("--max-image-size must be positive")
    if args.crop_dpi <= 0:
        parser.error("--crop-dpi must be positive")
    if args.max_output_tokens is not None and args.max_output_tokens <= 0:
        parser.error("--max-output-tokens must be positive")
    if not args.pdf.is_file():
        parser.error(f"file not found: {args.pdf}")

    out_path = args.output_dir or Path("scratch") / args.model
    params = RunParams(
        pdf=args.pdf, model=args.model, url=args.url, cut=args.cut, crop_dpi=args.crop_dpi,
        max_image_size=args.max_image_size, max_output_tokens=args.max_output_tokens,
        stream=args.stream, pages=args.pages, debug_dir=args.debug_dir, result_dir=args.result_dir,
        page_source=args.page_source,
    )
    try:
        execution = ocr.resolve(params)  # refuses knobs (exit 2) and a page range outside the PDF (exit 1) before any server
        markdown = convert(execution)
    except ValueError as error:
        parser.error(str(error))
    except ConversionError as error:
        parser.exit(1, f"{error}\n")
    out_path.mkdir(parents=True, exist_ok=True)
    out_file = out_path / f"{args.pdf.stem}.md"
    out_file.write_text(markdown, encoding="utf-8")
    print(f"Markdown: {out_file.resolve()}")


if __name__ == "__main__":
    main()
