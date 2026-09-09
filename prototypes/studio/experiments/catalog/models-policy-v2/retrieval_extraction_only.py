"""Explicit user scope amendment; preserve frozen inference and scoring code."""
import argparse
import json
from pathlib import Path

import score
import suite
from common import DEFAULT_ROOT, OCR, check_freeze, combinations, read, sha, verify


def amendment(root):
    change = read(root/'execution-amendment-02.json')
    assert change['activeArms'] == ['baseline', 'evie', 'neomme', 'gliner']
    assert change['originalFreezeSha256'] == sha(root/'freeze.json')
    verify({Path(__file__).resolve(): change['scriptSha256']})
    check_freeze(root)
    return change


def report(root, out, adjudications=None):
    change = amendment(root)
    score.ARMS = change['activeArms']
    score.report(root, out, adjudications)
    result = read(out/'results.json')
    result.update(executionAmendment=change, amendmentSha256=sha(root/'execution-amendment-02.json'),
        originalPlannedExecutorRuns=176, plannedExecutorRuns=88,
        excludedRuns=[{'doc': d, 'schema': s, 'arm': arm, 'repetition': rep, 'outcome': 'SKIPPED_USER'}
                      for d, s in combinations() for arm in OCR for rep in [1, 2]])
    assert len(result['runs']) == 88 and len(result['excludedRuns']) == 88
    for item in result['ocr']:
        item['excludedFromExecutorMatrix'] = True
    (out/'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf8')
    path = out/'RESULTS.md'
    text = path.read_text(encoding='utf8').replace('Planned: 176.',
        'Selected matrix: 88 (22 saved baselines + 66 requested retrieval/extraction runs; originally 176).')
    path.write_text(text+'\nAll OCR executor arms were excluded at the user’s request. Their 88 runs are listed as SKIPPED_USER in excludedRuns. Existing OCR outputs are preserved; no further OCR generation or OCR executor runs are included. Frozen per-run scoring and references are unchanged.\n', encoding='utf8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['run', 'report'])
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--out', type=Path)
    parser.add_argument('--adjudications', type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    amendment(root)
    if args.command == 'run':
        suite.run(root, 'native')
        report(root, root/'report-initial')
    else:
        if args.out is None:
            parser.error('--out is required for report')
        report(root, args.out.resolve(), args.adjudications)
