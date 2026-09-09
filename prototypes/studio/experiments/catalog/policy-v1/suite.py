#!/usr/bin/env python3
"""Run policy arms serially against one parsed document; freeze first, never overwrite."""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
STUDIO = HERE.parents[2]
ARMS = {
    'baseline': ['--batch-size', '1'],
    'batch-only': ['--batch-size', '5'],
    'policy-v1': ['--batch-size', '5', '--lexical-links', '--grounding-group', '5', '--field-aware'],
    'policy-v1-b3': ['--batch-size', '3', '--lexical-links', '--grounding-group', '5', '--field-aware'],
    'policy-v1-nuextract': ['--batch-size', '5', '--lexical-links', '--grounding-group', '5', '--field-aware', '--values-model', 'nuextract'],
    # Exploratory arms added after the pre-registered Beier runs, to isolate the
    # supported-field loss of policy-v1 (grouping, field-aware prompt, lexical links).
    'policy-v1-nofield': ['--batch-size', '5', '--lexical-links', '--grounding-group', '5'],
    'policy-v1-g1': ['--batch-size', '5', '--lexical-links', '--grounding-group', '1', '--field-aware'],
    'policy-v1-g1-nofield': ['--batch-size', '5', '--lexical-links', '--grounding-group', '1'],
    'batch-group': ['--batch-size', '5', '--grounding-group', '5'],
    'batch-group-field': ['--batch-size', '5', '--grounding-group', '5', '--field-aware'],
    # Model-route arms on the adopted call structure: Qwen keeps discovery.
    'bgf-nuextract-values': ['--batch-size', '5', '--grounding-group', '5', '--field-aware', '--values-model', 'nuextract'],
    'bgf-nuextract-values-fewshot': ['--batch-size', '5', '--grounding-group', '5', '--field-aware', '--values-model', 'nuextract', '--few-shot'],
    'bgf-nuextract-grounding': ['--batch-size', '5', '--grounding-group', '5', '--field-aware', '--ground-model', 'nuextract'],
    'bgf-nuextract-both-fewshot': ['--batch-size', '5', '--grounding-group', '5', '--field-aware', '--values-model', 'nuextract', '--few-shot', '--ground-model', 'nuextract'],
}


def frozen_files():
    source = (HERE / 'run.ts').read_text(encoding='utf8')
    block = re.search(r'FROZEN_FILES = \[(.*?)\]', source, re.S).group(1)
    return re.findall(r"'([^']+)'", block)


def hashes():
    return {name: hashlib.sha256((STUDIO / name).read_bytes()).hexdigest() for name in frozen_files()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, required=True, help='parsed_document.json')
    parser.add_argument('--root', type=Path, required=True, help='output root; one directory per arm and repetition')
    parser.add_argument('--arms', nargs='+', choices=list(ARMS), required=True)
    parser.add_argument('--repetitions', type=int, default=1)
    parser.add_argument('--start-repetition', type=int, default=1)
    parser.add_argument('--freeze', action='store_true')
    parser.add_argument('--schema', choices=['beier', 'danish'], default='beier')
    parser.add_argument('--model', default='qwen3.8:latest')
    parser.add_argument('--ollama-url', default='http://127.0.0.1:11434')
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    freeze = root / 'freeze.json'
    if args.freeze:
        if freeze.exists():
            raise SystemExit('Already frozen: use a new root for a new revision')
        freeze.write_text(json.dumps({
            'createdAt': datetime.now(timezone.utc).isoformat(), 'codeHashes': hashes(), 'arms': ARMS, 'schema': args.schema,
            'inputSha256': hashlib.sha256(args.input.read_bytes()).hexdigest(),
            'note': 'Arms and gates are pre-registered in PROTOCOL.md before the first run.',
        }, indent=2))
    frozen = json.loads(freeze.read_text()) if freeze.exists() else None
    if frozen is None or frozen['codeHashes'] != hashes():
        raise SystemExit('Freeze absent or code changed: create a new revision')
    if frozen['inputSha256'] != hashlib.sha256(args.input.read_bytes()).hexdigest():
        raise SystemExit('Input document differs from the frozen one: use a new root')
    if frozen.get('schema', 'beier') != args.schema:
        raise SystemExit('Schema differs from the frozen one: use a new root')
    for repetition in range(args.start_repetition, args.start_repetition + args.repetitions):
        offset = (repetition - args.start_repetition) % len(args.arms)
        for arm in args.arms[offset:] + args.arms[:offset]:
            destination = root / f'{arm}-r{repetition}'
            if destination.exists():
                print('SKIP existing', destination)
                continue
            command = ['node', '--import', 'tsx', 'experiments/catalog/policy-v1/run.ts',
                       '--input', str(args.input.resolve()), '--out', str(destination), '--arm', arm, '--schema', args.schema,
                       '--model', args.model, '--ollama-url', args.ollama_url, *ARMS[arm]]
            print('RUN', ' '.join(command))
            code = subprocess.call(command, cwd=STUDIO)
            print('EXIT', arm, repetition, code)


if __name__ == '__main__':
    main()
