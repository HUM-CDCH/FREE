"""Score and reconcile the corrected-schema comparison. Offline: no model, tokenizer or network request.

Uses the harness's own compare_study/load_cells/score_case for every arm; adds per-group rows, the frozen decision rule,
error categories and the ledger reconciliation. Writes report.json and summary.json (public: counts, field names, ids, no
gold or source text) and errors-private.json (evaluator-side examples with values) to RUN_ROOT.
Run from prototypes/parsing_service: python PATH/analyze.py RUN_ROOT
"""
import json
import statistics
import sys
from collections import Counter
from pathlib import Path

from experiments.extraction.manifest import read, write_new
from experiments.harness.data import canon, load_cases
from experiments.harness.study import Eval, compare_study, expand, load_cells, metrics, pool, verify_output

ARMS = ['base', 'A1', 'A2', 'A3']


def main():
    root = Path(sys.argv[1]).resolve()
    study_path, out = root / 'execution-study.json', root / 'out'
    study = json.loads(study_path.read_text())
    contract = json.loads((root / 'contract.json').read_text())
    configs, cases = expand(study), load_cases(root / 'dataset.json')
    write_new(root / 'report.json', compare_study(study_path, out, 'dev'))
    scored = load_cells(out, configs, cases, Eval(**study['evaluation']), ['dev'], verify_output(study_path, out, study))
    gold = {c.id: c.gold for c in cases}

    rows, private = [], []
    for row in contract['cases']:
        case = row['case']
        cells = {}
        for arm in ARMS:
            directory = out / 'cells' / f'{arm}--{case}'
            attempts = [read(p) for p in sorted(directory.glob('attempt-*.finished.json'))]
            spent = {k: sum(a['spent']['fresh'][k] for a in attempts) for k in ('calls', 'input_tokens', 'output_tokens', 'failed', 'unknown_usage')}
            replayed = sum(a['spent']['replayed']['calls'] for a in attempts)
            doc = scored[arm]['dev']['documents'].get(case)
            cell = {'status': 'sealed' if doc else attempts[-1]['status'] if attempts else 'not_run', 'attempts': len(attempts),
                    'fresh': spent, 'replayed_calls': replayed}
            if doc:
                m, counts = doc['metrics'], doc['counts']
                artifact = read(directory / 'result.json')['artifact']
                cell |= {'raw_f1': m['raw_exact']['field']['f1'], 'canonical_f1': m['field']['f1'],
                         'raw_precision': m['raw_exact']['field']['precision'], 'raw_recall': m['raw_exact']['field']['recall'],
                         'gold_value_fields': m['field']['gold_value_fields'], 'unannotated_fields': m['field']['unannotated_fields'],
                         'records': m['records'] | {'raw_strict_correct': m['raw_exact']['records']['strict_correct']},
                         'evidence': {k: m['evidence'][k] for k in ('annotated_fields', 'predicted_annotated', 'annotated_page_joint', 'page_hit', 'raw_span_hit', 'joint')},
                         'schema_valid_replies': [m['validity']['replies'] and counts.get('replies_valid', 0), m['validity']['replies']],
                         'truncated_calls': sum(c.get('finish') == 'length' for c in artifact['calls']),
                         'coverage': {k: artifact['coverage'][k] for k in ('chunks', 'processed', 'partial', 'failed')},
                         'errors': _errors(counts)}
                private += _examples(arm, case, artifact, scored[arm]['dev']['outcomes'], gold[case])
            cells[arm] = cell
        complete = all(c['status'] == 'sealed' for c in cells.values())
        rows.append({'order': row['order'], 'case': case, 'group': row['group'], 'chunks': row['chunks'],
                     'a1_merge_can_act': row['a1_merge_can_act'], 'arm_order': row['arm_order'], 'complete_pair': complete, 'arms': cells})

    paired = [r for r in rows if r['complete_pair']]
    summary = {'complete_paired_groups': [r['group'] for r in paired],
               'incomplete_groups': {r['group']: {a: c['status'] for a, c in r['arms'].items()} for r in rows
                                     if not r['complete_pair'] and any(c['status'] != 'not_run' for c in r['arms'].values())},
               'unrun_groups': [r['group'] for r in rows if all(c['status'] == 'not_run' for c in r['arms'].values())],
               'arms': {}, 'deltas_vs_base': {}, 'rows': rows,
               'error_categories_paired_groups': {a: dict(sum((Counter(r['arms'][a]['errors']) for r in paired), Counter())) for a in ARMS}}
    for arm in ARMS:
        cells = [r['arms'][arm] for r in paired]
        docs = [scored[arm]['dev']['documents'][r['case']]['counts'] for r in paired]
        total = metrics(pool(docs)) if docs else None
        summary['arms'][arm] = {
            'groups': len(cells), 'mean_group_raw_f1': _mean(c['raw_f1'] for c in cells),
            'mean_group_canonical_f1': _mean(c['canonical_f1'] for c in cells),
            'pooled_raw_f1': total and total['raw_exact']['field']['f1'], 'pooled_canonical_f1': total and total['field']['f1'],
            'gold_value_fields': total and total['field']['gold_value_fields'], 'unannotated_fields': total and total['field']['unannotated_fields'],
            'records': total and total['records'], 'repeated_records': total and total['repeated_records'],
            'canonical_strict_records': sum(d.get('strict_records', 0) for d in docs),
            'raw_strict_records': sum(d.get('raw_strict_records', 0) for d in docs),
            'evidence_annotated_page_joint': total and total['evidence']['annotated_page_joint'],
            'evidence_annotated_fields': total and total['evidence']['annotated_fields'],
            'source_region_failures': sum(c['coverage']['failed'] + c['coverage']['partial'] for c in cells),
            'truncated_calls': sum(c['truncated_calls'] for c in cells),
            'schema_valid_replies': [sum(c['schema_valid_replies'][0] for c in cells), sum(c['schema_valid_replies'][1] for c in cells)],
            'fresh_calls': sum(c['fresh']['calls'] for c in cells), 'input_tokens': sum(c['fresh']['input_tokens'] for c in cells),
            'output_tokens': sum(c['fresh']['output_tokens'] for c in cells)}
        if arm != 'base':
            deltas = {r['group']: r['arms'][arm]['raw_f1'] - r['arms']['base']['raw_f1'] for r in paired}
            summary['deltas_vs_base'][arm] = {'raw_f1_by_group': deltas, 'mean': _mean(deltas.values()),
                                              'wins': sum(d > 0 for d in deltas.values()), 'losses': sum(d < 0 for d in deltas.values())}
    summary['decision'] = _decide(summary)
    summary['ledger'] = _ledger(root, rows)
    write_new(root / 'summary.json', summary)
    write_new(root / 'errors-private.json', private)
    print(json.dumps({k: summary[k] for k in ('complete_paired_groups', 'decision', 'ledger')}, indent=1))


def _mean(values):
    values = [v for v in values if v is not None]
    return statistics.fmean(values) if values else None


def _errors(counts):
    g = counts.get
    found = {'format_only_difference': g('raw_wrong_values', 0) - g('wrong_values', 0), 'wrong_value': g('wrong_values', 0),
             'spurious_value_where_gold_absent': g('hallucinated_fields', 0), 'missing_record': g('missing_records', 0),
             'spurious_record': g('hallucinated_records', 0), 'duplicated_record': g('duplicated_records', 0),
             'value_lost_with_missing_record': g('fn_missing_record', 0), 'omitted_or_unresolved': g('omitted_fields', 0) + g('unresolved_fields', 0),
             'answered_absent_but_gold_has_value': g('missed_as_absent', 0),
             'schema_invalid_replies': g('replies_total', 0) - g('replies_valid', 0)}
    return found


def _examples(arm, case, artifact, outcomes, gold):
    """Wrong values, classified against the gold: format-only (canonical match), another field's value, the same field of
    another record, or otherwise wrong. Evaluator-side only."""
    examples, seen = [], set()
    segments = {'.'.join(map(str, e['path'][1:])): e.get('segment') for e in artifact.get('evidence', [])}
    for o in outcomes:
        if o['doc'] != case or o['correct'] or 'raw' not in o['row'] or (o['record'], o['field']) in seen:
            continue
        seen.add((o['record'], o['field']))
        predicted = canon(o['row'].get('value'))
        elsewhere = [(j, name) for j, rec in enumerate(gold) for name, item in rec['fields'].items()
                     if 'value' in item and canon(item['value']) == predicted]
        kind = ('another_field' if any(name != o['field'] for _, name in elsewhere) else
                'same_field_other_record' if elsewhere else 'wrong_or_unsupported')
        examples.append({'arm': arm, 'case': case, 'record': o['record'], 'field': o['field'], 'kind': kind,
                         'predicted_raw': o['row'].get('raw'), 'evidence_segment': _segment(segments, f"{o['record']}.{o['field']}")})
    return examples


def _segment(segments, path):
    """The segment cited for the value, or for its nearest cited parent (evidence is attached per top-level field)."""
    while path and path not in segments:
        path = path.rpartition('.')[0]
    return segments.get(path)


def _decide(summary):
    base = summary['arms']['base']
    if base['groups'] < 3:
        return {'result': 'evidence insufficient', 'reason': f"{base['groups']} complete paired groups < 3"}
    eligible = []
    for arm in ARMS[1:]:
        s, d = summary['arms'][arm], summary['deltas_vs_base'][arm]
        ok = (s['canonical_strict_records'] >= base['canonical_strict_records'] and s['source_region_failures'] <= base['source_region_failures']
              and d['mean'] > 0 and d['wins'] > s['groups'] / 2)
        eligible.append((ok, s['mean_group_raw_f1'], -s['output_tokens'], arm))
    passing = sorted(e for e in eligible if e[0])
    if not passing:
        return {'result': 'evidence insufficient', 'reason': 'no challenger met the frozen rule', 'checked': eligible}
    return {'result': 'development-supported challenger', 'arm': passing[-1][3], 'checked': eligible}


def _ledger(root, rows):
    journal = root / 'request-journal'
    started, finished = [read(p) for p in sorted(journal.glob('*.started.json'))], [read(p) for p in sorted(journal.glob('*.finished.json'))]
    invocations = [json.loads(line) for line in (root / 'invocations.jsonl').read_text().splitlines()]
    cells_fresh = sum(c['fresh']['calls'] for r in rows for c in r['arms'].values())
    ledger = {'journal_started': len(started), 'journal_finished': len(finished),
              'journal_completed': sum(f['status'] == 'completed' for f in finished), 'journal_failed': sum(f['status'] == 'failed' for f in finished),
              'journal_truncated': sum(f.get('finish') == 'length' for f in finished),
              'journal_input_tokens': sum(f.get('input_tokens') or 0 for f in finished),
              'journal_output_tokens': sum(f.get('output_tokens') or 0 for f in finished),
              'cells_fresh_calls': cells_fresh, 'replayed_calls': sum(c['replayed_calls'] for r in rows for c in r['arms'].values()),
              # the cutoff zeroes `remaining`, so the allowance's own count is what each invocation says it spent
              'runner_fresh_calls': sum(i.get('outcome', {}).get('fresh_calls_spent', 0) for i in invocations), 'invocations': invocations,
              'clock': json.loads((root / 'run-clock.json').read_text())}
    ledger['reconciled'] = (ledger['journal_started'] == ledger['journal_finished'] == ledger['cells_fresh_calls'] == ledger['runner_fresh_calls']
                            and ledger['replayed_calls'] == 0)
    return ledger


if __name__ == '__main__':
    main()
