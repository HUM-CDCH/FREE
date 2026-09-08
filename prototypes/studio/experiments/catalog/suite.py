#!/usr/bin/env python3
"""Run named experiments serially; preserve failures and never overwrite a prior run."""
import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
STUDIO = HERE.parents[1]
PRESETS = {
    'baseline-luna': ['--strategy','baseline','--model','luna'],
    'baseline-nuextract': ['--strategy','baseline','--model','nuextract'],
    'separate-nuextract': ['--strategy','separate','--model','nuextract','--few-shot'],
    'joint-nuextract': ['--strategy','joint','--model','nuextract','--few-shot'],
    'grouped-joint-nuextract': ['--strategy','grouped-joint','--model','nuextract','--few-shot'],
    'grouped-joint-luna': ['--strategy','grouped-joint','--model','luna'],
    'chunk-joint-nuextract': ['--strategy','chunk-joint','--model','nuextract','--few-shot'],
    'chunk-joint-luna': ['--strategy','chunk-joint','--model','luna'],
    'grouped-lexical-fallback': ['--strategy','grouped-lexical','--model','nuextract','--few-shot','--field-aware','--fallback-model','luna'],
    'rule-lexical': ['--strategy','rule-grouped-lexical','--model','nuextract','--few-shot','--field-aware'],
    'rule-lexical-fallback': ['--strategy','rule-grouped-lexical','--model','nuextract','--few-shot','--field-aware','--fallback-model','luna'],
    'rule-lexical-fallback-b1': ['--strategy','rule-grouped-lexical','--model','nuextract','--batch-size','1','--few-shot','--field-aware','--fallback-model','luna'],
    'rule-lexical-fallback-b3': ['--strategy','rule-grouped-lexical','--model','nuextract','--batch-size','3','--few-shot','--field-aware','--fallback-model','luna'],
    'rule-lexical-fallback-b10': ['--strategy','rule-grouped-lexical','--model','nuextract','--batch-size','10','--few-shot','--field-aware','--fallback-model','luna'],
}


def hashes():
    return {name: hashlib.sha256((HERE/name).read_bytes()).hexdigest()
            for name in ['run.ts','schema.ts','link.ts','examples.ts','beier.reference.json','evaluate.py']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input-dir', type=Path, required=True)
    parser.add_argument('--discovery-from', type=Path)
    parser.add_argument('--presets', nargs='+', choices=list(PRESETS), required=True)
    parser.add_argument('--repetitions', type=int, default=1)
    parser.add_argument('--start-repetition', type=int, default=1)
    parser.add_argument('--freeze', action='store_true')
    args = parser.parse_args()
    root = args.input_dir.resolve()
    freeze_path = root/'freeze.json'
    if args.freeze:
        if freeze_path.exists():
            raise ValueError('Already frozen: use a new input directory for a new experiment revision')
        freeze_path.write_text(json.dumps({'createdAt':datetime.now(timezone.utc).isoformat(), 'codeHashes':hashes(),
            'developmentIds':list(range(205,215)), 'evaluationIds':list(range(215,234)),
            'note':'Candidate strategies were developed on IDs 205–214. The whole PDF and initial full-baseline results were visible before the freeze. IDs 215–233 are an additional reported subset, not a blind holdout.'}, indent=2))
    if not freeze_path.exists() or json.loads(freeze_path.read_text())['codeHashes'] != hashes():
        raise ValueError('Freeze absent or code/reference changed: create a new explicit experiment revision')
    outcomes = []
    for repetition in range(args.start_repetition, args.start_repetition + args.repetitions):
        # Rotate order on repetitions, while keeping model requests serial.
        offset = (repetition - args.start_repetition) % len(args.presets)
        names = args.presets[offset:] + args.presets[:offset]
        for name in names:
            destination = root/f'eval-{name}-r{repetition}'
            if destination.exists():
                raise ValueError(f'Refusing to overwrite {destination}')
            command = ['node', 'node_modules/tsx/dist/cli.mjs', 'experiments/catalog/run.ts',
                       '--input', str(root/'parsed_document.json'), '--out', str(destination), *PRESETS[name]]
            if args.discovery_from:
                command += ['--discovery-from', str(args.discovery_from.resolve())]
            print('EXPERIMENT', name, 'repeat', repetition, flush=True)
            result = subprocess.run(command, cwd=STUDIO)
            outcomes.append({'preset':name,'repetition':repetition,'exitCode':result.returncode,'path':str(destination)})
            print('EXPERIMENT_DONE', json.dumps(outcomes[-1]), flush=True)
    print(json.dumps(outcomes, indent=2))


if __name__ == '__main__':
    main()
