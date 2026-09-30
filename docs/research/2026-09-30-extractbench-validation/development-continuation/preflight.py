"""Frozen-study admission audit. Builds inference requests, calls /tokenize only, never generates.

Run from prototypes/parsing_service: python PATH/preflight.py DATA_ROOT
"""
import hashlib
import json
import sys
from pathlib import Path

from experiments.extraction.manifest import differences, write_new
from experiments.harness.data import load_cases
from experiments.harness.extract import chunks_of, groups_of, reply_schema, retrieve, system_prompt, user_prompt
from experiments.harness.study import expand, make_provider, project
from kei_exp.canonical import canonical_json

root = Path(sys.argv[1])
study = json.loads((root / 'study.json').read_text())
configs = expand(study)
provider = make_provider(study['provider'], root / 'unused-preflight-cache')
assert provider.counter is not None
assert provider.identity['served']['id'] == study['provider']['model']
assert provider.identity['context_tokens'] == 32768
assert configs['A2'].evidence.alignment == configs['A3'].evidence.alignment
deltas = {name: sorted(differences(configs['base'].model_dump(mode='json'), cfg.model_dump(mode='json')))
          for name, cfg in configs.items() if name != 'base'}
assert deltas == {'A1': ['merge.continuation'], 'A2': ['evidence.mode'], 'A3': ['evidence.mode']}
roundtrips = {r['case']: r for r in json.loads((root / 'gold-roundtrips.json').read_text())}
adapter = json.loads((root / 'adapter-manifest.json').read_text())
report = {'provider': provider.identity, 'config_deltas': deltas,
          'quote_id_alignment_equal': True, 'fresh_completion_calls': 0, 'requests': [],
          'ingestion_failures': adapter['failures'], 'cases': [], 'holdout_documents_ingested': 0}
cases = load_cases(root / 'dataset.json')
eligible = []
sha = lambda value: hashlib.sha256(canonical_json(value)).hexdigest()
for case in cases:
    assert case.split == 'dev'
    checks = roundtrips[case.id]
    scoring_ok = checks.get('raw_f1') == checks.get('canonical_f1') == 1 and not checks.get('invariants')
    row = {'case': case.id, 'group': case.group, 'scoring_ok': scoring_ok, 'arms': {}, 'reasons': []}
    if not scoring_ok:
        row['reasons'].append('gold_roundtrip_failed')
    inference = case.inference()
    assert not any(hasattr(inference, key) for key in ('gold', 'annotations', 'split', 'group'))
    for name, cfg in configs.items():
        assert not cfg.verification.model and not cfg.merge.resolver
        projection = project(case, cfg)
        arm = {**projection, 'call_cap': cfg.budget.calls, 'token_cap': cfg.budget.tokens}
        row['arms'][name] = arm
        if projection['calls'] > cfg.budget.calls:
            row['reasons'].append(name + ':nominal_calls_exceed_cell_cap')
            continue
        tokens = []
        chunks = chunks_of(list(inference.evidence.passages), cfg)
        for nodes in groups_of(inference, cfg):
            for chunk in retrieve(chunks, nodes, inference.schema.record_description, cfg):
                assert chunk.retrieval != 'skipped'
                primary = chunk.context.primary
                shown = [p.id for p in (*chunk.context.overlap, *primary)]
                schema = reply_schema(nodes, cfg, shown)
                system, user = system_prompt(inference, nodes, cfg, schema), user_prompt(chunk, cfg, primary)
                count = provider.counter.request_tokens(system, user, schema)
                tokens.append(count)
                report['requests'].append({'case': case.id, 'arm': name, 'chunk': chunk.id,
                    'source_prompt_sha256': sha(user), 'system_sha256': sha(system), 'schema_sha256': sha(schema),
                    'input_token_reservation': count, 'output_token_reservation': cfg.output.max_tokens})
        assert len(tokens) == projection['calls']
        arm.update({'maximum_input_tokens': max(tokens), 'input_token_reservation': sum(tokens),
                    'nominal_tokens_with_maximum_outputs': sum(tokens) + len(tokens) * cfg.output.max_tokens})
        if max(tokens) + cfg.output.max_tokens > provider.identity['context_tokens']:
            row['reasons'].append(name + ':request_context_exceeded')
        if arm['nominal_tokens_with_maximum_outputs'] > cfg.budget.tokens:
            row['reasons'].append(name + ':nominal_tokens_exceed_cell_cap')
    row['admitted'] = not row['reasons']
    if row['admitted']:
        eligible.append(case.id)
    report['cases'].append(row)
    print(json.dumps(row), flush=True)
report['admitted_source_groups'] = len(eligible)
report['admitted_documents'] = len(eligible)
report['nominal_calls'] = sum(a['calls'] for r in report['cases'] if r['admitted'] for a in r['arms'].values())
report['recovery_call_bound_before_runtime_caps'] = sum(a['upper_bound_with_recovery']
    for r in report['cases'] if r['admitted'] for a in r['arms'].values())
report['study_call_cap'] = study['budget']['max_calls']
report['study_nominal_calls_fit'] = report['nominal_calls'] <= report['study_call_cap']
assert report['study_nominal_calls_fit'], 'No outcome-based sub-selection: whole eligible matrix must fit.'
write_new(root / 'preflight.json', report)
dataset = json.loads((root / 'dataset.json').read_text())
write_new(root / 'admitted-dataset.json', {**dataset, 'cases': [c for c in dataset['cases'] if c['id'] in eligible]})
print(json.dumps({k: report[k] for k in ('admitted_documents', 'nominal_calls',
      'recovery_call_bound_before_runtime_caps', 'study_call_cap', 'study_nominal_calls_fit')}, indent=2))
