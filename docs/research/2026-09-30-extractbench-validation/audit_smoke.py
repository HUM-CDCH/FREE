"""Study-specific integrity audit; reads saved artifacts and makes no model requests.

Run from prototypes/parsing_service: python PATH/audit_smoke.py SMOKE_ROOT NEW_AUDIT_DIR
The frozen study has three cases, four arms, and at most one unknown interrupted call.
"""
import dataclasses
import hashlib
import json
import re
import sys
from pathlib import Path

from experiments.extraction.manifest import differences, write_new
from experiments.harness.data import InferenceCase, load_cases
from experiments.harness.evaluate import Eval, check_invariants, metrics, score_case
from experiments.harness.study import compare_study, expand
from kei_exp.canonical import canonical_json
from kei_exp.kie.extract.llm import THINKING_OFF, _messages, _plain

root = Path(sys.argv[1])
dest = Path(sys.argv[2])
study = json.loads((root / 'study.json').read_text())
configs = expand(study)
cases = load_cases(root / study['dataset'])
report = compare_study(root / 'study.json', root / 'out', 'dev')
sha = lambda value: hashlib.sha256(value if isinstance(value, bytes) else canonical_json(value)).hexdigest()
assert not {'gold', 'annotations', 'split', 'group'} & {f.name for f in dataclasses.fields(InferenceCase)}
assert configs['A2'].evidence.alignment == configs['A3'].evidence.alignment
delta = {name: sorted(differences(configs['base'].model_dump(mode='json'), cfg.model_dump(mode='json'))) for name, cfg in configs.items() if name != 'base'}
assert set(delta['A1']) == {'merge.continuation'}
assert set(delta['A2']) == set(delta['A3']) == {'evidence.mode'}

roundtrips = []
for case in cases:
    rows = [{'record': 0, 'field': k, 'status': 'value' if 'value' in v else 'absent', 'raw': v.get('value'), 'value': v.get('value'), 'evidence': []} for k, v in case.gold[0]['fields'].items()]
    prediction = {'records': [{r['field']: r['value'] for r in rows}], 'fields': rows}
    counts, _ = score_case(case, prediction, Eval(**study['evaluation']))
    shown = metrics(counts)
    assert shown['field']['f1'] == shown['raw_exact']['field']['f1'] == 1
    assert not check_invariants(counts)
    roundtrips.append({'case': case.id, 'gold_value_fields': counts['gold_value_fields'], 'raw_f1': 1, 'canonical_f1': 1})

requests, integrity, by_input = [], [], {}
for result_path in sorted((root / 'out/cells').glob('*/result.json')):
    result = json.loads(result_path.read_text())
    artifact = result['artifact']
    name = result_path.parent.name.split('--')[0]
    cfg = configs[name]
    assert artifact['config_sha256'] == cfg.sha256()
    assert artifact['cost']['fresh']['unknown_usage'] == 0
    entries = [e for f in artifact['fields'] for e in f.get('evidence', [])]
    if name in ('A2', 'A3'):
        assert all(e.get('evidence_protocol') == 2 and 'raw_spans' in e and e.get('semantic_support') is None for e in entries)
    else:
        assert not entries
    row = {'cell': result_path.parent.name, 'files': {f.name: sha(f.read_bytes()) for f in sorted(result_path.parent.glob('*.json'))}, 'artifact_sha256': result['execution']['artifact_sha256'], 'code_sha256': result['execution']['code_sha256'], 'evidence_entries': len(entries), 'refined_evidence_entries': sum(bool(e.get('refined')) for e in entries)}
    integrity.append(row)
    for key in artifact['requests']:
        cached = json.loads((root / 'out/cache' / key[:2] / (key + '.json')).read_text())
        req = cached['request']
        assert (req['max_tokens'], req['temperature'], req['seed'], req['top_logprobs'], req['attempt'], req['sample']) == (4096, 0, 20260930, 0, 0, 0)
        schema = req['schema']
        assert ('begins_inside_record' in schema['properties']) == (name == 'A1')
        assert ('ends_inside_record' in schema['properties']) == (name == 'A1')
        fields = schema['properties']['records']['items']['properties']
        if name in ('A2', 'A3'):
            evidence_key = 'quotes' if name == 'A2' else 'ids'
            assert all(set(f['properties']) == {'value', evidence_key} for f in fields.values())
            if name == 'A3':
                offered = set(re.findall(r'<block\s+id="([^"]+)"', req['user']))
                assert offered
                assert all(set(f['properties']['ids']['items']['enum']) == offered for f in fields.values())
        else:
            assert 'For every field give "value" and ' not in req['system']
        body = {'model': study['provider']['model'], 'temperature': req['temperature'], 'max_tokens': req['max_tokens'], 'messages': _messages(req['system'], req['user']), 'chat_template_kwargs': dict(THINKING_OFF), 'seed': req['seed'], 'response_format': {'type': 'json_schema', 'json_schema': {'name': 'reply', 'schema': _plain(schema), 'strict': True}}}
        by_input.setdefault(artifact['case'], {}).setdefault(name, []).append(sha(req['user']))
        requests.append({'cell': result_path.parent.name, 'cache_key': key, 'effective_body_sha256': sha(body), 'schema_sha256': sha(schema), 'system_sha256': sha(req['system']), 'source_prompt_sha256': sha(req['user']), 'max_output_tokens': req['max_tokens'], 'temperature': req['temperature'], 'seed': req['seed'], 'thinking': THINKING_OFF, 'completion_tokens': cached['reply']['output_tokens'], 'input_tokens': cached['reply']['input_tokens'], 'finish': cached['reply']['finish']})

all_same_inputs = {case: len({tuple(sorted(keys)) for keys in arms.values()}) == 1 for case, arms in by_input.items()}
attempts = [json.loads(f.read_text()) for f in (root / 'out/cells').glob('*/attempt-*.finished.json')]
charged_calls = sum(a['spent']['fresh']['calls'] for a in attempts)
known_input = sum(a['spent']['fresh']['input_tokens'] for a in attempts)
known_output = sum(a['spent']['fresh']['output_tokens'] for a in attempts)
unknown = sum(a['spent']['fresh']['unknown_usage'] for a in attempts)
unfinished = [f for f in (root / 'out/cells').glob('*/attempt-*.started.json') if not f.with_name(f.name.replace('.started.', '.finished.')).exists()]
audit = {'implementation_commit': '2a2b6d4586179919accbae7800d5071a7df6cb00', 'config_deltas': delta, 'quote_id_alignment_equal': True, 'gold_excluded_from_inference_type': True, 'gold_roundtrips': roundtrips, 'effective_requests_reconstructed_from': 'Complete request caches plus the pinned ResearchChat payload adapter; not packet capture.', 'requests': requests, 'same_source_prompts_across_completed_arms': all_same_inputs, 'cells': integrity, 'operational_spend': {'fresh_calls_charged_upper_bound': charged_calls, 'observed_complete_responses': len(list((root / 'out/cache').glob('*/*.json'))), 'known_input_tokens': known_input, 'known_output_tokens': known_output, 'unknown_usage_requests': unknown, 'unknown_request_tokens_upper_bound': 36864 * unknown, 'replayed_calls': sum(a['spent']['replayed']['calls'] for a in attempts), 'known_fresh_seconds': sum(a['spent']['fresh']['seconds'] for a in attempts)}, 'gates': {'ingestion': True, 'scoring': all(not v['invariant_violations'] for v in report['variants'].values()), 'configuration': True, 'call_budget': charged_calls <= 100, 'all_twelve_smoke_cells_sealed': len(integrity) == 12, 'no_unfinished_attempts': not unfinished, 'complete_usage_accounting': unknown == 0}, 'heldout_documents_ingested': 0, 'heldout_documents_extracted': 0}
audit['cell_budget_checks'] = []
for directory in sorted((root / 'out/cells').iterdir()):
    if not directory.is_dir():
        continue
    records = [json.loads(f.read_text()) for f in directory.glob('attempt-*.finished.json')]
    calls = sum(a['spent']['fresh']['calls'] for a in records)
    tokens = sum(a['spent']['fresh']['input_tokens'] + a['spent']['fresh']['output_tokens'] + a.get('reconciliation', {}).get('unknown_request_token_upper_bound', 0) for a in records)
    audit['cell_budget_checks'].append({'cell': directory.name, 'fresh_calls_charged_upper_bound': calls, 'fresh_tokens_upper_bound': tokens, 'call_cap': 60, 'token_cap': 250000})
audit['gates']['cell_budgets'] = all(c['fresh_calls_charged_upper_bound'] <= c['call_cap'] and c['fresh_tokens_upper_bound'] <= c['token_cap'] for c in audit['cell_budget_checks'])
if len(integrity) == 12 and not unfinished:
    cached = [json.loads(f.read_text())['reply'] for f in (root / 'out/cache').glob('*/*.json')]
    assert known_input == sum(c['input_tokens'] for c in cached)
    assert known_output == sum(c['output_tokens'] for c in cached)
    assert charged_calls == len(cached) + unknown
    assert len({c['code_sha256'] for c in integrity}) == 1
    assert all(all_same_inputs.values())
dest.mkdir(parents=True, exist_ok=True)
write_new(dest / 'report-v2.json', report)
write_new(dest / 'audit.json', audit)
print(json.dumps({'cells': len(integrity), 'gates': audit['gates'], 'operational_spend': audit['operational_spend'], 'variants': {name: {'documents': v['cases'], 'raw_f1': v['metrics']['raw_exact']['field']['f1'], 'canonical_f1': v['metrics']['field']['f1']} for name, v in report['variants'].items()}}, indent=2))
