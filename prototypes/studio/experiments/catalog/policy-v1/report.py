#!/usr/bin/env python3
"""Tabulate policy arms under one root and check the pre-registered gates.

Beier runs (input hash equals the frozen Beier snapshot) are scored with the
existing evaluate.py; other documents report counts only. The table is
generated, never typed."""
import argparse
import json
import statistics
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load(root):
    runs = []
    for result in sorted(root.glob('*/result.json')):
        run = json.loads(result.read_text(encoding='utf8'))
        run['dir'] = result.parent
        run['rep'] = int(result.parent.name.rsplit('-r', 1)[1]) if '-r' in result.parent.name else 0
        metrics = result.with_name('metrics-all.json')
        run['metrics'] = json.loads(metrics.read_text(encoding='utf8')) if metrics.exists() else None
        runs.append(run)
    return runs


def counts(run):
    calls = run['calls']
    by_phase = defaultdict(int)
    for call in calls:
        by_phase[call['phase']] += 1
    extraction = [c for c in calls if c['phase'] == 'extraction']
    return {
        'calls': len(calls), 'discovery': by_phase['discovery'], 'values': by_phase['extraction'], 'grounding': by_phase['grounding'],
        'batchValues': sum(1 for c in extraction if (c.get('records') or 1) > 1),
        'singleValues': sum(1 for c in extraction if (c.get('records') or 1) == 1),
        'failedCalls': sum(1 for c in calls if c['status'] != 'succeeded'),
        'seconds': round(run['durationMs'] / 1000, 1),
        'records': len(run['rows']), 'boundaries': len(run['boundaries']),
        'crossRecord': sum(1 for issue in run.get('groundingIssues', []) if issue.get('code') == 'unknown_anchor_label'),
        'issues': len(run.get('groundingIssues', [])),
        'ungrounded': len(run.get('ungroundedPaths', [])),
        **(run.get('claims') or {}),
    }


def score_beier(root, document, runs):
    beier = [run for run in runs if run['metrics'] is None and run['outcome'] != 'THREW']
    if not beier:
        return
    reference = json.loads((HERE.parent / 'beier.reference.json').read_text(encoding='utf8'))
    snapshot = json.loads(document.read_text(encoding='utf8'))
    if snapshot['document']['content_sha256'] != reference['sourceSha256']:
        return
    subprocess.check_call([sys.executable, '-X', 'utf8', str(HERE.parent / 'evaluate.py'), '--document', str(document),
                           *[str(run['dir'] / 'result.json') for run in beier]])
    for run in beier:
        run['metrics'] = json.loads((run['dir'] / 'metrics-all.json').read_text(encoding='utf8'))


def table(runs):
    header = ['arm', 'rep', 'outcome', 'records', 'calls', 'disc', 'values', 'batch', 'single', 'ground', 'seconds', 'values/203', 'supported/164', 'evidence precision', 'claims', 'to model', 'lexical', 'ungrounded', 'cross-record', 'issues']
    lines = ['| ' + ' | '.join(header) + ' |', '|' + '---|' * len(header)]
    for run in runs:
        c = counts(run)
        m = run['metrics'] or {}
        lines.append('| ' + ' | '.join(str(x) for x in [
            run['arm'], run['rep'], run['outcome'], f"{c['records']}/{c['boundaries']}", c['calls'], c['discovery'], c['values'], c['batchValues'], c['singleValues'], c['grounding'], c['seconds'],
            m.get('correctFields', '–'), m.get('supportedCorrectFields', '–'), f"{m['evidencePrecision']:.3f}" if m else '–',
            c.get('populated', '–'), c.get('sentToModel', '–'), c.get('lexicalLinks', '–'), c['ungrounded'], c['crossRecord'], c['issues'],
        ]) + ' |')
    return '\n'.join(lines)


def gates(runs):
    by_arm = defaultdict(list)
    for run in runs:
        if run['outcome'] != 'THREW':
            by_arm[run['arm']].append(run)
    base = by_arm.get('baseline')
    if not base:
        return ['No baseline arm: gates not evaluated.']
    mean = lambda rs, f: statistics.mean(f(r) for r in rs)
    base_calls = mean(base, lambda r: counts(r)['calls'] - counts(r)['discovery'])
    out = []
    for arm, arm_runs in by_arm.items():
        if arm == 'baseline':
            continue
        c = [counts(r) for r in arm_runs]
        g1 = all(x['records'] == x['boundaries'] for x in c) and all(x['singleValues'] <= 0.05 * max(1, x['batchValues'] + x['singleValues']) or x['batchValues'] == 0 for x in c)
        g2 = mean(arm_runs, lambda r: counts(r)['calls'] - counts(r)['discovery']) <= 0.4 * base_calls
        scored = [r for r in arm_runs if r['metrics']] and [r for r in base if r['metrics']]
        if scored:
            bm = lambda k: mean([r for r in base if r['metrics']], lambda r: r['metrics'][k])
            am = lambda k: mean([r for r in arm_runs if r['metrics']], lambda r: r['metrics'][k])
            g3 = am('correctFields') >= bm('correctFields') - 1 and am('supportedCorrectFields') >= bm('supportedCorrectFields') and am('evidencePrecision') >= bm('evidencePrecision') and all(r['metrics']['returnedRecords'] == 29 and not r['metrics']['missingRecords'] for r in arm_runs if r['metrics'])
            g3_text = f"G3 {'pass' if g3 else 'FAIL'} (values {am('correctFields'):.1f} vs {bm('correctFields'):.1f}, supported {am('supportedCorrectFields'):.1f} vs {bm('supportedCorrectFields'):.1f}, precision {am('evidencePrecision'):.3f} vs {bm('evidencePrecision'):.3f})"
        else:
            g3_text = 'G3 not scored (no reference for this document)'
        g4 = all(x['crossRecord'] == 0 for x in c)
        out.append(f"- **{arm}** ({len(arm_runs)} runs): G1 {'pass' if g1 else 'FAIL'} (identity and fallbacks); G2 {'pass' if g2 else 'FAIL'} ({mean(arm_runs, lambda r: counts(r)['calls'] - counts(r)['discovery']):.1f} non-discovery calls vs baseline {base_calls:.1f}); {g3_text}; G4 cross-record links {'pass' if g4 else 'FAIL'}; G5 needs blind labels.")
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--document', type=Path, required=True, help='the parsed_document.json the runs used')
    parser.add_argument('--title', default='Catalog policy v1')
    args = parser.parse_args()
    runs = load(args.root)
    score_beier(args.root, args.document, runs)
    report = '\n'.join([f'# {args.title} — {args.root.name}', '', 'Generated by report.py; counts come from each run\'s result.json, scores from evaluate.py.', '', table(runs), '', '## Gates', '', *gates(runs), ''])
    (args.root / 'RESULTS.md').write_text(report, encoding='utf8')
    print(report)


if __name__ == '__main__':
    main()
