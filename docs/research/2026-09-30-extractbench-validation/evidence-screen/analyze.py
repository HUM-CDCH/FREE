"""Score and reconcile the A0/A3 evidence screen. Offline: no model, tokenizer or network request.

Scores every sealed cell with the harness's score_case, per group and per collection path, splits A3's page grounding
into top-level scalar leaves and inherited (object/collection) leaves, applies the frozen screen-gate-v3 and reconciles
the ledgers. Writes summary.json (public: counts, field names, ids; no gold or source text) and errors-private.json to
RUN_ROOT; both refuse to overwrite. Run from prototypes/parsing_service: python PATH/analyze.py RUN_ROOT
"""
import importlib.util
import json
import statistics
import sys
from collections import Counter
from pathlib import Path

from experiments.extraction.manifest import read, write_new
from experiments.harness.data import canon, load_cases
from experiments.harness.evaluate import Eval, check_invariants, metrics, pool, score_case

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('prior_analyze', HERE.parent / 'corrected-comparison/analyze.py')
prior = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prior)
ARMS = ['base', 'A3']
RECORD_KEYS = ('gold_records', 'pred_records', 'matched_records', 'missing_records', 'duplicated_records', 'hallucinated_records',
               'unadjudicated_records', 'strict_records', 'raw_strict_records', 'unscored_records', 'unknown_availability_records')
F1_TOLERANCE, PAGE_HIT = 0.05, 0.8


def main():
    root = Path(sys.argv[1]).resolve()
    contract = read(root / 'contract.json')
    study = json.loads((root / 'execution-study.json').read_text())
    rules = Eval(**study['evaluation'])
    assert rules.sha256() == contract['evaluation']['evaluation_sha256'], 'evaluator changed after freeze'
    cases = {c.id: c for c in load_cases(root / 'dataset.json')}
    rows, private = [], []
    for row in contract['cases']:
        case, cells = cases[row['case']], {}
        for arm in ARMS:
            cell, examples = score_cell(root / 'out/cells' / f"{arm}--{case.id}", case, rules, arm)
            cells[arm] = cell
            private += examples
        complete = all(c['status'] == 'sealed' and c['layers']['coverage']['complete'] for c in cells.values())
        rows.append({k: row[k] for k in ('order', 'case', 'group', 'length_category', 'characters', 'pages', 'passages', 'chunks', 'arm_order')}
                    | {'complete_pair': complete, 'arms': cells})
    paired = [r for r in rows if r['complete_pair']]
    summary = {'label': 'new development observations of run ' + contract['identity']['run_id'] + '; one execution per cell',
               'complete_paired_groups': [r['group'] for r in paired],
               'incomplete_groups': {r['group']: {a: c['status'] for a, c in r['arms'].items()} for r in rows
                                     if not r['complete_pair'] and any(c['status'] != 'not_run' for c in r['arms'].values())},
               'unrun_groups': [r['group'] for r in rows if all(c['status'] == 'not_run' for c in r['arms'].values())],
               'medium_document_completed': any(r['length_category'] == 'medium' for r in paired),
               'rows': rows, 'aggregates_over_complete_pairs': aggregates(paired), 'gate': gate(paired),
               'ledger': ledger(root, rows)}
    write_new(root / 'summary.json', summary)
    write_new(root / 'errors-private.json', private)
    print(json.dumps({k: summary[k] for k in ('complete_paired_groups', 'incomplete_groups', 'unrun_groups', 'gate')}, indent=1))
    print(json.dumps({k: v for k, v in summary['ledger'].items() if k != 'invocations'}, indent=1))


def score_cell(directory, case, rules, arm):
    attempts = [read(p) for p in sorted(directory.glob('attempt-*.finished.json'))]
    spent = {k: sum(a['spent']['fresh'][k] for a in attempts) for k in ('calls', 'input_tokens', 'output_tokens', 'seconds', 'failed', 'unknown_usage')}
    cell = {'status': 'not_run', 'attempts': len(attempts), 'fresh': spent,
            'replayed_calls': sum(a['spent']['replayed']['calls'] for a in attempts)}
    if not (directory / 'result.json').exists():
        started = len(list(directory.glob('attempt-*.started.json')))
        cell['status'] = attempts[-1]['status'] if attempts else 'started_unfinished' if started else 'not_run'
        return cell, []
    artifact = read(directory / 'result.json')['artifact']
    counts, outcomes = score_case(case, artifact, rules)
    assert not check_invariants(counts), check_invariants(counts)
    m = metrics(counts)
    calls = artifact['calls']
    cell |= {'status': 'sealed',    # a sealed cell may still hold failed regions; a complete pair needs full coverage in both arms
             'layers': {'http_completed': sum(c.get('finish') is not None for c in calls), 'calls': len(calls),
                        'truncated': sum(c.get('finish') == 'length' for c in calls),
                        'schema_valid_replies': [artifact['validity']['valid'], artifact['validity']['total']],
                        'coverage': {k: artifact['coverage'][k] for k in ('complete', 'chunks', 'processed', 'partial', 'failed')}},
             'values': {side: {k: m[key]['field'][k] for k in ('precision', 'recall', 'f1', 'predicted_values', 'gold_value_fields')}
                        for side, key in (('raw', 'raw_exact'), ('canonical', 'canonicalized'))}
                       | {'abstained': m['field']['abstained'], 'unannotated_fields': m['field']['unannotated_fields'],
                          'errors': prior._errors(counts)},
             'records_by_path': by_path(counts),
             'unresolved_top_level_fields': sorted(r['field'] for r in artifact['fields'] if r['status'] == 'unresolved'),
             'possible_repeats': repeats(artifact),
             'grounding': grounding(case, artifact, outcomes, counts, m) if arm == 'A3' else 'no evidence by design'}
    return cell, prior._examples(arm, case.id, artifact, outcomes, case.gold)


def by_path(counts):
    paths = {}
    for key, value in counts.items():
        if key.startswith('path|'):
            _, path, name = key.split('|')
            if name in RECORD_KEYS or name in ('tp', 'raw_tp', 'gold_value_fields', 'wrong_values', 'raw_wrong_values'):
                paths.setdefault(path, dict.fromkeys(RECORD_KEYS, 0))[name] = value
    return paths


def repeats(artifact):
    """Collection fields holding an item that more than one chunk gave (kept, flagged), and how many such items."""
    found = {}
    for r in artifact['fields']:
        if 'possible_repeated_items' in r['flags']:
            given = Counter(c for who in r['contributors'] if isinstance(who['value'], list) for c in {canon(i) for i in who['value']})
            found[r['field']] = sum(given[canon(i)] > 1 for i in r['value'] or [])
    return found


def grounding(case, artifact, outcomes, counts, m):
    """Page grounding on annotated content. Top-level scalar leaves carry their own citation; every leaf inside an object or
    collection inherits its top-level field's whole citation, so its page hit is coarse. Specificity is the fraction of the
    document's pages one cited value names; ids are enum-constrained, so an unresolvable id cannot occur."""
    pages = {p.id: p.page for p in case.evidence.passages}
    n_pages = len(set(pages.values()))
    rules = case.annotations['field_rules']
    nodes = {n.name: n for n in case.schema.record_nodes}
    scalar = [n for n, node in nodes.items() if node.type not in ('array', 'object')]
    expected = case.annotations['expected_output']

    def gold_pages(name):
        return {e['page'] for e in rules.get(name, {}).get('evidence', []) if e.get('page') is not None}
    annotated = [n for n in scalar if expected.get(n) is not None and gold_pages(n)]
    top = {'page_annotated_gold_values': len(annotated), 'predicted': 0, 'correct': 0, 'correct_page_hit': 0, 'wrong_page_hit': 0,
           'correct_page_hit_not_citing_every_page': 0}
    for o in outcomes:
        if o['collection'] == 'document' and o['field'] in annotated:
            cited = {pages[i] for e in o['row'].get('evidence', []) for i in e.get('ids', []) if i in pages}
            hit = bool(cited & gold_pages(o['field']))
            top['predicted'] += 1
            top['correct'] += o['correct']
            top['correct_page_hit'] += o['correct'] and hit
            top['wrong_page_hit'] += (not o['correct']) and hit
            top['correct_page_hit_not_citing_every_page'] += o['correct'] and hit and len(cited) < n_pages
    top['page_hit_given_correct'] = top['correct_page_hit'] / top['correct'] if top['correct'] else None
    top['joint_over_annotated'] = top['correct_page_hit'] / len(annotated) if annotated else None
    specificity = {}
    for r in artifact['fields']:
        if r['status'] != 'value':
            continue
        kind = 'scalar' if nodes[r['field']].type not in ('array', 'object') else nodes[r['field']].type
        ids = [i for e in r['evidence'] for i in e.get('ids', [])]
        cited = {pages[i] for i in ids if i in pages}
        entry = specificity.setdefault(kind, {'values': 0, 'uncited': 0, 'ids': 0, 'page_fraction': []})
        entry['values'] += 1
        entry['uncited'] += not ids
        entry['ids'] += len(ids)
        if cited:
            entry['page_fraction'].append(len(cited) / n_pages)
    for entry in specificity.values():
        fractions = entry.pop('page_fraction')
        entry['mean_cited_page_fraction'] = statistics.fmean(fractions) if fractions else None
    missing_ids = sum(len(e.get('missing_ids', [])) for r in artifact['fields'] for e in r['evidence'])
    # Whether the cited lines print the value (checks.literal: lexical, not a semantic-support verdict; descriptive only).
    right = {o['field']: o['correct'] for o in outcomes if o['collection'] == 'document' and o['field'] in scalar}
    checked = [(r['field'], r['checks']['literal']) for r in artifact['fields']
               if r['field'] in scalar and r['status'] == 'value' and (r.get('checks') or {}).get('literal') is not None]
    literal = {'checked': len(checked), 'literal': sum(ok for _, ok in checked),
               'correct_checked': sum(right.get(f) is True for f, _ in checked),
               'correct_literal': sum(right.get(f) is True and ok for f, ok in checked)}
    literal['literal_given_correct'] = literal['correct_literal'] / literal['correct_checked'] if literal['correct_checked'] else None
    literal['note'] = ("lower bound: the service's value forms miss thousands separators, reformatted dates and text split "
                       "over lines, so a correct citation can read as not literal")
    page = top['page_hit_given_correct']
    useful = ('uninformative (single page)' if n_pages == 1 else 'not established' if page is None else
              'useful page evidence' if page >= PAGE_HIT else 'not useful at the frozen threshold')
    return {'document_pages': n_pages, 'top_level_scalars': top, 'top_level_scalar_literal': literal,
            'specificity_by_top_level_kind': specificity,
            'unresolvable_ids': missing_ids, 'unresolvable_ids_note': 'enum-constrained: 0 by construction, uninformative',
            'all_leaves_evaluator': {k: m['evidence'][k] for k in ('annotated_fields', 'predicted_annotated', 'page_hit', 'annotated_page_joint')},
            'semantic_support': None, 'verdict': useful}


def aggregates(paired):
    """Labelled aggregates over complete pairs: pooled counts are dominated by long record lists, so the per-group mean is
    beside them and neither replaces the per-group rows."""
    out = {}
    for arm in ARMS:
        cells = [r['arms'][arm] for r in paired]
        if not cells:
            continue
        out[arm] = {'groups': len(cells),
                    'mean_group_raw_f1': statistics.fmean(c['values']['raw']['f1'] or 0 for c in cells),
                    'mean_group_canonical_f1': statistics.fmean(c['values']['canonical']['f1'] or 0 for c in cells),
                    'abstained': dict(sum((Counter({k: v for k, v in c['values']['abstained'].items()}) for c in cells), Counter())),
                    'fresh': {k: sum(c['fresh'][k] for c in cells) for k in ('calls', 'input_tokens', 'output_tokens', 'seconds')},
                    'truncated_calls': sum(c['layers']['truncated'] for c in cells)}
    return out


def gate(paired):
    """screen-gate-v3 as frozen in the contract."""
    if len(paired) < 2:
        return {'rule': 'screen-gate-v3', 'result': 'not established', 'reason': f'{len(paired)} complete paired groups < 2'}
    losses, untested, f1 = [], [], {}
    for r in paired:
        a0, a3 = r['arms']['base'], r['arms']['A3']
        for arm, cell in (('base', a0), ('A3', a3)):
            if cell['records_by_path'].get('document', {}).get('pred_records') != 1:
                losses.append(f"{r['group']}: {arm} has {cell['records_by_path'].get('document', {}).get('pred_records')} root records")
        for path in sorted(set(a0['records_by_path']) | set(a3['records_by_path'])):
            if path == 'document':
                continue
            p0, p3 = (c['records_by_path'].get(path, dict.fromkeys(RECORD_KEYS, 0)) for c in (a0, a3))
            if not p0['gold_records']:
                untested.append(f"{r['group']}:{path}")
                continue
            if p3['matched_records'] < p0['matched_records']:
                losses.append(f"{r['group']}:{path} matched {p0['matched_records']}->{p3['matched_records']}")
            if p3['duplicated_records'] + p3['hallucinated_records'] > p0['duplicated_records'] + p0['hallucinated_records']:
                losses.append(f"{r['group']}:{path} excess {p0['duplicated_records'] + p0['hallucinated_records']}->"
                              f"{p3['duplicated_records'] + p3['hallucinated_records']}")
        f1[r['group']] = (a3['values']['raw']['f1'] or 0) - (a0['values']['raw']['f1'] or 0)
        if f1[r['group']] < -F1_TOLERANCE:
            losses.append(f"{r['group']}: raw F1 {f1[r['group']]:+.3f}")
    result = 'loss observed' if losses else 'no material loss on tested paths' if untested else 'no material loss'
    return {'rule': 'screen-gate-v3', 'result': result, 'losses': losses,
            'untested_paths': untested, 'raw_f1_delta_by_group': f1, 'groups': len(paired)}


def ledger(root, rows):
    ledger = prior._ledger(root, [{'arms': {a: c for a, c in r['arms'].items()}} for r in rows])
    auxiliary = [read(p) for p in sorted((root / 'auxiliary-journal').glob('*.json'))]
    ledger['auxiliary'] = dict(Counter(f"{a['method']} /{a['endpoint']}" for a in auxiliary))
    clock = ledger['clock']
    invocations = ledger['invocations']
    if invocations:
        from datetime import datetime
        last = max(datetime.fromisoformat(i['finished_at']) for i in invocations)
        ledger['elapsed_minutes_to_last_invocation_end'] = round((last - datetime.fromisoformat(clock['started_at'])).total_seconds() / 60, 1)
    return ledger


if __name__ == '__main__':
    main()
