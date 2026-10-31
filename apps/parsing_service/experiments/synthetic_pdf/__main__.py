"""python -m experiments.synthetic_pdf --help"""
import argparse
from pathlib import Path

from . import run


def main():
    parser = argparse.ArgumentParser(description="Deterministic PDF benchmark using FREE's production pipeline")
    commands = parser.add_subparsers(dest="command", required=True)
    generate = commands.add_parser("generate", help="create new, validated inputs")
    generate.add_argument("config", type=Path)
    generate.add_argument("dataset", type=Path)
    for name in ("validate", "parse"):
        command = commands.add_parser(name)
        command.add_argument("dataset", type=Path)
    execute = commands.add_parser("run", help="fresh inference; new output directory required")
    execute.add_argument("dataset", type=Path)
    execute.add_argument("output", type=Path)
    for name in ("replay", "evaluate"):
        command = commands.add_parser(name)
        command.add_argument("dataset", type=Path)
        command.add_argument("output", type=Path)
        command.add_argument("report", type=Path)
    report = commands.add_parser("report")
    report.add_argument("output", type=Path)
    compare = commands.add_parser("compare", help="paired method differences and live-repeat prediction agreement")
    compare.add_argument("dataset", type=Path)
    compare.add_argument("output", type=Path)
    compare.add_argument("baseline")
    compare.add_argument("variant")
    compare.add_argument("report", type=Path)
    args = parser.parse_args()
    if args.command == "generate":
        run.create(args.config, args.dataset)
    elif args.command == "validate":
        run.check_inputs(args.dataset)
        print("PDF hashes, schemas and all rendered ground-truth locations validated")
    elif args.command == "parse":
        run.parse(args.dataset)
    elif args.command == "run":
        run.run(args.dataset, args.output)
    elif args.command == "replay":
        run.replay(args.dataset, args.output, args.report)
    elif args.command == "evaluate":
        run.score(args.dataset, args.output, args.report)
    elif args.command == "compare":
        from .compare import compare
        compare(args.dataset, args.output, args.baseline, args.variant, args.report)
    else:
        run.summarize(args.output)


if __name__ == "__main__":
    main()
