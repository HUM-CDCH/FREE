#!/usr/bin/env python3
"""Score per-record against the candidate on the Danish schema (PROTOCOL revision 2).

Uses Astra's frozen references and adjudications through models-policy-v2's
score.py unchanged; prints one table and the gates, and lists pending items
that still need a decision. Never calls a model."""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / 'models-policy-v2'))
from score import references_for, score_terminal  # noqa: E402
sys.path.insert(0, str(HERE))
from report import policy_calls  # noqa: E402

REPO = HERE.parents[4]
V2 = REPO / 'artifacts/catalog-lab/models-policy-v2'
DOCS = ['Herredsvejen_SBM1694', 'Hojbakkegaard_TAK_1177', 'Hvissinge_Ost_TAK_1728', 'Katrinesminde_SBM1116', 'Brondbylund_3_TAK_1506']
GATED = DOCS[:3]
ARMS = ['baseline', 'batch-group-field']  # overridable with --arms; gates compare each other arm against --against


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def calls(run):
    result = read(run / 'result.json')
    by_phase = {}
    for call in result['calls']:
        by_phase[call['phase']] = by_phase.get(call['phase'], 0) + 1
    return {'total': len(result['calls']), 'discovery': by_phase.get('discovery', 0), 'values': by_phase.get('extraction', 0),
            'grounding': by_phase.get('grounding', 0), 'fallback': sum(1 for c in result['calls'] if c.get('fallback')),
            'batches': sum(1 for c in result['calls'] if (c.get('records') or 1) > 1), 'seconds': round(result['durationMs'] / 1000, 1),
            'outcome': result['outcome'], 'records': len(result['rows']), 'boundaries': len(result['boundaries']),
            'crossRecord': sum(1 for i in result.get('groundingIssues', []) if i.get('code') == 'unknown_anchor_label'),
            'policy': policy_calls({'calls': result['calls'], 'dir': run})}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=REPO / 'artifacts/catalog-lab/policy-v1-danish')
    parser.add_argument('--decisions', type=Path, nargs='*', default=[V2 / 'adjudications-final.json'])
    parser.add_argument('--pending', type=Path, help='write undecided items here')
    parser.add_argument('--reviewed', action='store_true', help='the decisions include the human review; G4 is no longer provisional')
    parser.add_argument('--arms', nargs='*', default=ARMS)
    parser.add_argument('--against', default='baseline', help='the arm the gates compare every other arm with')
    args = parser.parse_args()
    decisions, extensions = {}, []
    for path in args.decisions:
        review = read(path)
        decisions.update(review['decisions'])
        extensions += review.get('extensions', [])
    refs = read(V2 / 'references-v1.json')
    for extension in extensions:
        row = next(r for r in refs['documents'][extension['document']]['records'] if r['id'] == extension['record'])
        if 'unit' in extension:
            row['fields'][extension['field']][extension['unit']]['aliases'].extend(extension['aliases'])
        else:
            row['fields'][extension['field']].append(extension['atom'])
    header = ['document', 'arm', 'outcome', 'records', 'calls', 'disc', 'values', 'batch', 'fallback', 'ground', 'policy calls', 'seconds', 'correct units', 'linked units', 'unsupported', 'wrong record', 'wrong passage', 'cross-record', 'pending']
    lines = ['| ' + ' | '.join(header) + ' |', '|' + '---|' * len(header)]
    pending, scores = {}, {}
    for doc in DOCS:
        reference = references_for(refs, doc, 'danish')
        document = read(V2 / 'inputs' / doc / 'baseline/parsed_document.json')
        for arm in args.arms:
            run = args.root / doc / f'{arm}-r1'
            if not (run / 'result.json').exists():
                lines.append(f'| {doc} | {arm} | NOT_RUN |' + ' – |' * (len(header) - 3))
                continue
            c = calls(run)
            terminal = read(run / 'terminal.json') if (run / 'terminal.json').exists() else {}
            metrics, details, undecided = score_terminal(terminal, document, reference, doc, 'danish', decisions)
            for key in ['correctUnits', 'supportedLinkUnits', 'wrongRecordLinks', 'wrongPassageLinks', 'unsupportedClaims', 'supportedUnits', 'pendingValues', 'pendingLinks']:
                metrics.setdefault(key, 0)
            for key, item in undecided.items():
                pending.setdefault(key, {**item, 'arms': []})['arms'].append(f'{doc}/{arm}')
            scores[(doc, arm)] = {**metrics, **c}
            lines.append('| ' + ' | '.join(str(x) for x in [doc, arm, c['outcome'], f"{c['records']}/{c['boundaries']}", c['total'], c['discovery'], c['values'], c['batches'], c['fallback'], c['grounding'], c['policy'], c['seconds'],
                f"{metrics.get('correctUnits', 0)}/{metrics.get('supportedUnits', 0)}", f"{metrics.get('supportedLinkUnits', 0)}/{metrics.get('supportedUnits', 0)}", metrics.get('unsupportedClaims', 0),
                metrics.get('wrongRecordLinks', 0), metrics.get('wrongPassageLinks', 0), c['crossRecord'], metrics.get('pendingValues', 0) + metrics.get('pendingLinks', 0)]) + ' |')
    gates = []
    wrong_rate = lambda s: (s['wrongRecordLinks'] + s['wrongPassageLinks']) / max(1, s['supportedLinkUnits'] + s['wrongRecordLinks'] + s['wrongPassageLinks'])
    for doc, arm_name in [(doc, arm) for doc in DOCS for arm in args.arms if arm != args.against]:
        b, a = scores.get((doc, args.against)), scores.get((doc, arm_name))
        if not a or not b or a['outcome'] != 'SUCCEEDED' or b['outcome'] != 'SUCCEEDED':
            gates.append(f'- **{doc} / {arm_name}**: not gated (a run did not succeed)'); continue
        tolerance = 0.05 * a['supportedUnits']
        g1 = a['records'] == a['boundaries'] and a['fallback'] <= 0.05 * max(1, a['batches'])
        base_calls, arm_calls = b['policy'], a['policy']
        # G2 (reformulated 2026-09-09): policy-sensitive calls (record values + grounding, every attempt) at most 40% of the per-record arm's.
        g2 = None if base_calls == 0 else arm_calls <= 0.4 * base_calls
        g4 = (a['correctUnits'] >= b['correctUnits'] - tolerance and a['supportedLinkUnits'] >= b['supportedLinkUnits'] - tolerance
              and wrong_rate(a) <= wrong_rate(b)
              and a['unsupportedClaims'] <= b['unsupportedClaims'] and a['crossRecord'] == 0)
        undecided = sum(s.get('pendingValues', 0) + s.get('pendingLinks', 0) for s in (a, b))
        g4_text = (f"G4 {'pass' if g4 else 'FAIL'}{'' if args.reviewed else ', provisional until the human review is applied'} (units {a['correctUnits']} vs {b['correctUnits']}, links {a['supportedLinkUnits']} vs {b['supportedLinkUnits']} of {a['supportedUnits']}, "
                   f"wrong-link rate {wrong_rate(a):.3f} vs {wrong_rate(b):.3f}, unsupported {a['unsupportedClaims']} vs {b['unsupportedClaims']})"
                   if doc in GATED else 'G4 not gated (the reference credits graves the schema excludes)')
        gates.append(f"- **{doc} / {arm_name} vs {args.against}**: G1 {'pass' if g1 else 'FAIL'} (fallbacks {a['fallback']} of {a['batches']} batches); "
                     f"G2 {'not evaluated' if g2 is None else 'pass' if g2 else 'FAIL'} ({arm_calls} policy-sensitive calls vs {base_calls}; all non-discovery calls {a['total'] - a['discovery']} vs {b['total'] - b['discovery']}); "
                     + g4_text + ('' if not undecided else f'; {undecided} pending decisions'))
    report = '\n'.join(['# Catalog policy v1 — revision 2: per-record vs candidate, Danish schema', '',
                        'Generated by score_danish.py from result.json and terminal.json through models-policy-v2/score.py with Astra\'s references and adjudications; no number is typed by hand. Katrinesminde and Brondbylund are shown, not gated.', '',
                        *lines, '', '## Gates', '', *gates, ''])
    (args.root / 'RESULTS.md').write_text(report, encoding='utf8')
    print(report)
    if args.pending:
        args.pending.write_text(json.dumps({'items': [{'key': k, **v} for k, v in sorted(pending.items())]}, ensure_ascii=False, indent=2), encoding='utf8')
    print('PENDING', len(pending))


if __name__ == '__main__':
    main()
