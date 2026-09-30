"""Offline assembly/evaluator comparison on the saved responses of extractbench-v3-corrected-development.

No model, tokenizer or network request: replies come only from the run's reply cache through a stub chat that raises on
any miss, behind a zero study allowance. Run from a harness tree's prototypes/parsing_service with PYTHONPATH=src:. :

  offline.py replay RUN_ROOT OUT_DIR SCOPE   rebuild every cell's artifact from cached replies (SCOPE records|document)
  offline.py score RUN_ROOT ARTIFACTS OUT    score sealed cells (ARTIFACTS=sealed) or a replay directory with this tree
  offline.py summarize RUN_ROOT OUT_DIR      the four assembly/evaluator combinations, record reconciliation and gates

Replay and score refuse to overwrite. Every result is an offline replay or re-scoring: no new model observation.
"""
import hashlib
import importlib.util
import json
import statistics
import sys
from dataclasses import replace
from pathlib import Path

from experiments.extraction.manifest import read, write_new
from experiments.harness.data import load_cases
from experiments.harness.evaluate import Eval, metrics, pool, score_case
from experiments.harness.study import expand, harness_pin
from kei_exp.canonical import canonical_json

ARMS = ['base', 'A1', 'A2', 'A3']
COHORT = ['short--grafton_isotrope_invoice_19503', 'short--dc-pepco-residential-bill', 'short--mission-tx-tyler-invoice']
SEPARATE = 'short--caterpillar_spec_sheet_312c_excavator'
COMBINATIONS = {'original-assembly--original-evaluator': ('sealed', 'original'), 'original-assembly--revised-evaluator': ('sealed', 'revised'),
                'repaired-assembly--original-evaluator': ('repaired', 'original'), 'repaired-assembly--revised-evaluator': ('repaired', 'revised')}
sha = lambda value: hashlib.sha256(canonical_json(value)).hexdigest()


class ResearchChat:
    """Network-free stand-in. The cache key names the chat adapter, so the class borrows the research adapter's name;
    any request the cache cannot answer raises instead of being sent."""
    accepts_sampling = True

    def __init__(self, model):
        self.model = model

    def complete(self, **_):
        raise RuntimeError('offline replay: a request missed the reply cache')


def cells(root):
    return sorted(p for p in (root / 'out/cells').iterdir() if p.is_dir())


def replay(root, out, scope):
    from experiments.harness.model import Allowance, Provider
    from experiments.harness.run import run_case
    study = json.loads((root / 'execution-study.json').read_text())
    configs, cases = expand(study), {c.id: c for c in load_cases(root / 'dataset.json')}
    sealed = {p.name: read(p / 'result.json')['artifact'] for p in cells(root) if (p / 'result.json').exists()}
    identities = {sha(a['provider']['identity']) for a in sealed.values()}
    assert len(identities) == 1, 'sealed cells disagree on the provider identity'
    identity = next(iter(sealed.values()))['provider']['identity']
    out.mkdir(parents=True)
    ledger = {}
    for cell in cells(root):
        arm, case_id = cell.name.split('--', 1)
        case = cases[case_id]
        if scope == 'document':   # extractbench-v1 inference_schema admits only an object root: one record per document
            case = replace(case, record_scope='document')
        provider = Provider(ResearchChat(study['provider']['model']), root / 'out/cache', None, identity)
        provider.allowance = Allowance(0)
        artifact = run_case(case, configs[arm], provider.view(configs[arm].budget.calls, configs[arm].budget.tokens))
        missed = len(artifact['requests']) - artifact['cost']['replayed']['calls']   # refused by the meter or the allowance
        row = {'replayed_calls': artifact['cost']['replayed']['calls'], 'fresh_calls': artifact['cost']['fresh']['calls'],
               'uncached_requests_refused': missed, 'original_sealed': cell.name in sealed}
        if cell.name in sealed:
            row['requests_identical'] = artifact['requests'] == sealed[cell.name]['requests']
            row['artifact_identical_to_sealed'] = all(artifact[k] == sealed[cell.name][k] for k in ('records', 'fields', 'evidence', 'ledger', 'requests'))
        if missed:
            row['status'] = 'incomplete: needs uncached requests; not completed offline'
        else:
            row['status'] = 'replayed'
            write_new(out / f'{cell.name}.json', artifact)
        assert row['fresh_calls'] == 0
        ledger[cell.name] = row
    write_new(out / 'replay-ledger.json', {'scope': scope, 'harness_source_sha256': sha(harness_pin(Path.cwd())), 'cells': ledger})
    print(json.dumps(ledger, indent=1))


def score(root, artifacts, out):
    study = json.loads((root / 'execution-study.json').read_text())
    rules, cases = Eval(**study['evaluation']), {c.id: c for c in load_cases(root / 'dataset.json')}
    found = ({p.name: p / 'result.json' for p in cells(root) if (p / 'result.json').exists()} if artifacts == 'sealed'
             else {p.stem: p for p in sorted(Path(artifacts).glob('*--*.json'))})
    scored = {}
    for name, path in found.items():
        artifact = read(path)['artifact'] if artifacts == 'sealed' else read(path)
        counts, _ = score_case(cases[name.split('--', 1)[1]], artifact, rules)
        scored[name] = {'counts': counts, 'coverage': {k: artifact['coverage'][k] for k in ('chunks', 'processed', 'partial', 'failed')},
                        'output_tokens': artifact['tokens']['output'], 'artifact_sha256': sha(artifact)}
    write_new(Path(out), {'evaluator_version': rules.evaluator_version, 'evaluation_sha256': rules.sha256(),
                          'harness_source_sha256': sha(harness_pin(Path.cwd())), 'artifacts': str(artifacts), 'cells': scored})


def scopes(c):
    """Record counts by scope: the document root (one gold record) and nested collection items. Each scope partitions:
    predicted = matched + duplicated + spurious + unadjudicated; gold = matched + missing; unscored items are apart."""
    g = lambda k: c.get(k, 0)
    keys = ('gold_records', 'pred_records', 'matched_records', 'missing_records', 'duplicated_records', 'hallucinated_records', 'unadjudicated_records', 'strict_records')
    nested = {k: g('repeated_' + k) for k in keys} | {'unscored_records': g('unscored_records')}
    root = {k: g(k) - g('repeated_' + k) for k in keys}
    for s in (root, nested):
        assert s['pred_records'] == s['matched_records'] + s['duplicated_records'] + s['hallucinated_records'] + s['unadjudicated_records']
        assert s['gold_records'] == s['matched_records'] + s['missing_records']
    return {'document_root': root, 'nested': nested}


def cell_row(entry):
    m, c = metrics(entry['counts']), entry['counts']
    return {'raw_f1': m['raw_exact']['field']['f1'], 'canonical_f1': m['field']['f1'], 'raw_precision': m['raw_exact']['field']['precision'],
            'raw_recall': m['raw_exact']['field']['recall'], 'gold_value_fields': m['field']['gold_value_fields'],
            'unannotated_fields': m['field']['unannotated_fields'], 'tp_raw': c.get('raw_tp', 0), 'tp_canonical': c.get('tp', 0),
            'predicted_values_raw': m['raw_exact']['field']['predicted_values'], 'records': scopes(c),
            'canonical_strict_records_all_scopes': c.get('strict_records', 0),
            'region_failures': entry['coverage']['failed'] + entry['coverage']['partial'], 'output_tokens': entry['output_tokens']}


def old_gate(rows, analyze):
    """The frozen v1 rule exactly as analyze._decide applies it (all-scope canonical strict records as its completeness guard)."""
    summary = {'arms': {}, 'deltas_vs_base': {}}
    for arm in ARMS:
        cs = [rows[f'{arm}--{c}'] for c in COHORT]
        summary['arms'][arm] = {'groups': len(cs), 'canonical_strict_records': sum(r['canonical_strict_records_all_scopes'] for r in cs),
                                'source_region_failures': sum(r['region_failures'] for r in cs),
                                'mean_group_raw_f1': statistics.fmean(r['raw_f1'] for r in cs), 'output_tokens': sum(r['output_tokens'] for r in cs)}
        if arm != 'base':
            d = [rows[f'{arm}--{c}']['raw_f1'] - rows[f'base--{c}']['raw_f1'] for c in COHORT]
            summary['deltas_vs_base'][arm] = {'mean': statistics.fmean(d), 'wins': sum(x > 0 for x in d), 'losses': sum(x < 0 for x in d)}
    return analyze._decide(summary)


GATE_V2 = 'completeness-gate-v2 (proposed for a future study; not applied to any past verdict)'


def gate_v2(reference, challenger):
    """Proposed rule for a FUTURE study. `reference`/`challenger`: {group: cell row} over the same complete paired groups.
    A challenger is supported only if it gains mean raw F1 and wins most groups AND, in every group, loses no nested record
    (missing not higher, matched not lower) and adds no excess (duplicated + spurious not higher), at both scopes. A guard
    the cohort cannot inform (no annotated nested records, fewer than 3 groups, unequal membership) is "not established",
    never a pass. Strict fully-correct records are reported beside it, not used as the safeguard."""
    groups = sorted(reference)
    if sorted(challenger) != groups or len(groups) < 3:
        return {'rule': GATE_V2, 'result': 'not established', 'reason': 'fewer than 3 complete paired groups or unequal membership'}
    guards = {}
    for scope in ('document_root', 'nested'):
        if not sum(reference[g]['records'][scope]['gold_records'] for g in groups):
            guards[scope] = None
            continue
        per = {}
        for g in groups:
            r, c = reference[g]['records'][scope], challenger[g]['records'][scope]
            per[g] = {'missing': c['missing_records'] - r['missing_records'], 'matched': c['matched_records'] - r['matched_records'],
                      'excess': (c['duplicated_records'] + c['hallucinated_records']) - (r['duplicated_records'] + r['hallucinated_records'])}
        guards[scope] = {'per_group_change': per, 'no_loss': all(p['missing'] <= 0 and p['matched'] >= 0 for p in per.values()),
                         'no_excess': all(p['excess'] <= 0 for p in per.values())}
    deltas = {g: challenger[g]['raw_f1'] - reference[g]['raw_f1'] for g in groups}
    f1 = {'mean_raw_f1_delta': statistics.fmean(deltas.values()), 'wins': sum(d > 0 for d in deltas.values()), 'groups': len(groups)}
    strict = {'reference': sum(reference[g]['records']['nested']['strict_records'] for g in groups),
              'challenger': sum(challenger[g]['records']['nested']['strict_records'] for g in groups)}
    out = {'rule': GATE_V2, 'guards': guards, 'f1': f1, 'supplementary_strict_nested_records': strict}
    if any(v is None for v in guards.values()):
        return out | {'result': 'not established', 'reason': 'a completeness guard has no annotated records to test'}
    failed = [f'{s}.{k}' for s, v in guards.items() for k in ('no_loss', 'no_excess') if not v[k]]
    if failed:
        return out | {'result': 'rejected', 'reason': f'record guards failed: {failed}'}
    if f1['mean_raw_f1_delta'] > 0 and f1['wins'] * 2 > len(groups):
        return out | {'result': 'development-supported challenger'}
    return out | {'result': 'evidence insufficient', 'reason': 'no mean raw F1 gain with a majority of wins'}


def summarize(root, out):
    spec = importlib.util.spec_from_file_location('analyze', Path(__file__).parent.parent / 'corrected-comparison/analyze.py')
    analyze = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(analyze)
    result = {'label': 'offline replay and re-scoring of saved responses; no new model observation, cost or timing',
              'cohort': {'paired_groups': COHORT, 'arms': ARMS, 'separate': SEPARATE}, 'combinations': {}}
    for combo in COMBINATIONS:
        data = read(out / 'scores' / f'{combo}.json')
        rows = {name: cell_row(e) for name, e in data['cells'].items()}
        per_arm = {}
        for arm in ARMS:
            cs = {c: rows[f'{arm}--{c}'] for c in COHORT}
            total = metrics(pool([data['cells'][f'{arm}--{c}']['counts'] for c in COHORT]))
            per_arm[arm] = {'mean_group_raw_f1': statistics.fmean(r['raw_f1'] for r in cs.values()),
                            'mean_group_canonical_f1': statistics.fmean(r['canonical_f1'] for r in cs.values()),
                            'pooled_raw_f1': total['raw_exact']['field']['f1'], 'pooled_canonical_f1': total['field']['f1'],
                            'records': {s: {k: sum(r['records'][s][k] for r in cs.values()) for k in r0} for s, r0 in cs[COHORT[0]]['records'].items()},
                            'by_group': cs}
        result['combinations'][combo] = {
            'evaluator_version': data['evaluator_version'], 'harness_source_sha256': data['harness_source_sha256'], 'arms': per_arm,
            'caterpillar_separate': {arm: rows.get(f'{arm}--{SEPARATE}', 'not sealed') for arm in ARMS},
            'v1_frozen_gate': old_gate(rows, analyze),
            'v2_proposed_gate_vs_base': {arm: gate_v2({c: rows[f'base--{c}'] for c in COHORT}, {c: rows[f'{arm}--{c}'] for c in COHORT})
                                         for arm in ARMS[1:]}}
    write_new(out / 'summary.json', result)
    file_sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
    contract = json.loads((root / 'contract.json').read_text())
    scores = {c: read(out / 'scores' / f'{c}.json') for c in COMBINATIONS}
    original = scores['original-assembly--original-evaluator']['harness_source_sha256']
    assert original == contract['identity']['harness_source_sha256'], 'the original tree is not the frozen harness'
    write_new(out / 'manifest.json', {
        'label': result['label'], 'original_run_root': str(root), 'original_run_id': contract['identity']['run_id'],
        'contract_sha256': file_sha(root / 'contract.json'), 'contract_commit': 'a24b87e7', 'results_commits': ['e2542d20', '2024b85c'],
        'inputs_sha256': {'dataset.json': file_sha(root / 'dataset.json'), 'execution-study.json': file_sha(root / 'execution-study.json'),
                          'sealed_results': {p.name: file_sha(p / 'result.json') for p in cells(root) if (p / 'result.json').exists()},
                          'reply_cache': sha(sorted(file_sha(p) for p in (root / 'out/cache').rglob('*.json')))},
        'revisions': {'original_assembly_and_evaluator': {'commit': '2024b85c', 'harness_source_sha256': original, 'evaluator_version': 2},
                      'repaired_assembly_and_revised_evaluator': {'commit': 'e4c9c906', 'evaluator_version': 3,
                          'harness_source_sha256': scores['repaired-assembly--revised-evaluator']['harness_source_sha256']}},
        'replays': {s: read(out / f'replay-{s}' / 'replay-ledger.json') for s in ('original', 'repaired')},
        'membership': {'paired_cohort': COHORT, 'arms': ARMS, 'reported_separately': SEPARATE,
                       'incomplete': {'A2--' + SEPARATE: 'first reply truncated; 3 recovery halves were never requested; not completed offline'},
                       'not_run': [c['case'] for c in contract['cases'] if c['case'] not in (*COHORT, SEPARATE)], 'heldout_groups_opened': 0},
        'score_files_sha256': {c: file_sha(out / 'scores' / f'{c}.json') for c in COMBINATIONS}})
    print(json.dumps({k: {a: round(v['arms'][a]['mean_group_raw_f1'], 3) for a in ARMS} for k, v in result['combinations'].items()}, indent=1))


if __name__ == '__main__':
    command, root = sys.argv[1], Path(sys.argv[2]).resolve()
    if command == 'replay':
        replay(root, Path(sys.argv[3]).resolve(), sys.argv[4])
    elif command == 'score':
        score(root, sys.argv[3] if sys.argv[3] == 'sealed' else Path(sys.argv[3]).resolve(), Path(sys.argv[4]).resolve())
    else:
        summarize(root, Path(sys.argv[3]).resolve())
