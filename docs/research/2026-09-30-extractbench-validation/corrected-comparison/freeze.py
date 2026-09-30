"""Freeze the corrected-schema A0-A3 development comparison. Offline: no completion, tokenizer or model request.

Copies the nine eligible dataset-v2 cases into a new run root in the predeclared order, checks every pin, fingerprints
every nominal request per arm and writes contract.json. Run from prototypes/parsing_service:
python PATH/freeze.py DATASET_V2 RUN_ROOT
"""
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

from experiments.extraction.manifest import differences, write_new
from experiments.harness.study import Eval
from experiments.harness.data import load_cases
from experiments.harness.extract import chunks_of, groups_of, reply_schema, retrieve, system_prompt, user_prompt
from experiments.harness.study import case_pin, expand, harness_pin, project
from kei_exp.canonical import canonical_json

HERE = Path(__file__).resolve().parent
PARENT_REVISION = 'c394bc97'
ADAPTER_MANIFEST_SHA256 = 'dd765fcd181426f03ee995ba5ca77c09bb925178f61db7d3b491f5b3b61d99f4'
# Registered smoke groups first (grafton, the one-call-per-arm case, is the smoke), then the continuation selection order.
ORDER = ['short--grafton_isotrope_invoice_19503', 'short--dc-pepco-residential-bill', 'short--mission-tx-tyler-invoice',
         'short--caterpillar_spec_sheet_312c_excavator', 'short--lancaster_county_ne_requisition_po_husker_steel',
         'short--uillinois_rate_card_carpool_2024', 'short--viega_price_list_propress_2026',
         'medium--1G1PC5SB6E7111015_professional_valuation', 'medium--erie_county_2017_single_audit']
EXCLUDED = {'long--dd1155_schedule_continuation_0011': 'nominal 68 calls per arm exceed the unchanged 60-call cell cap'}
ARMS = ['base', 'A1', 'A2', 'A3']
sha = lambda value: hashlib.sha256(canonical_json(value)).hexdigest()
file_sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    source, root = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    top = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    dirty = subprocess.check_output(['git', 'status', '--porcelain', '--', 'prototypes'], cwd=top, text=True)
    assert not dirty, 'harness/service sources must be committed before freezing'
    assert file_sha(source / 'adapter-manifest.json') == ADAPTER_MANIFEST_SHA256
    adapter = json.loads((source / 'adapter-manifest.json').read_text())
    assert adapter['schema_policy_version'] == 'structural-string-enums-v2' and adapter['holdout_documents_ingested'] == 0
    original = {c.id: c for c in load_cases(source / 'dataset.json')}
    assert set(original) == set(ORDER) | set(EXCLUDED)

    root.mkdir()
    entries = {c['id']: c for c in json.loads((source / 'dataset.json').read_text())['cases']}
    files = {}
    for case_id in ORDER:
        for key in ('inference_file', 'annotations_file'):
            rel = entries[case_id][key]
            (root / rel).parent.mkdir(exist_ok=True)
            shutil.copyfile(source / rel, root / rel)
            files[rel] = file_sha(root / rel)
            assert files[rel] == file_sha(source / rel)
    write_new(root / 'dataset.json', {'version': 1, 'cases': [entries[i] for i in ORDER]})
    shutil.copyfile(HERE / 'study.json', root / 'execution-study.json')
    study = json.loads((root / 'execution-study.json').read_text())
    configs = expand(study)
    cases = load_cases(root / 'dataset.json')
    assert [c.id for c in cases] == ORDER and len({c.group for c in cases}) == len(cases)
    assert all(c.split == 'dev' and case_pin(c) == case_pin(original[c.id]) for c in cases)

    deltas = {n: sorted(differences(configs['base'].model_dump(mode='json'), cfg.model_dump(mode='json'))) for n, cfg in configs.items() if n != 'base'}
    assert deltas == {'A1': ['merge.continuation'], 'A2': ['evidence.mode'], 'A3': ['evidence.mode']}
    assert configs['A2'].evidence.alignment == configs['A3'].evidence.alignment
    assert all(cfg.budget.workers == 1 and not cfg.verification.model and not cfg.merge.resolver for cfg in configs.values())

    rows, schedule = [], []
    for index, case in enumerate(cases):
        inference = case.inference()
        assert not any(hasattr(inference, k) for k in ('gold', 'annotations', 'split', 'group')), 'gold reachable from inference'
        arms = {}
        for name, cfg in configs.items():
            requests, enums, lists = [], set(), set()
            chunks = chunks_of(list(inference.evidence.passages), cfg)
            for nodes in groups_of(inference, cfg):
                for chunk in retrieve(chunks, nodes, inference.schema.record_description, cfg):
                    primary = chunk.context.primary
                    shown = [p.id for p in (*chunk.context.overlap, *primary)]
                    schema = reply_schema(nodes, cfg, shown)
                    system, user = system_prompt(inference, nodes, cfg, schema), user_prompt(chunk, cfg, primary)
                    requests.append(sha([system, user, schema]))
                    values = [v for v in _enums(schema) if not set(v) <= {*shown, None}]   # A3's passage-ID choices are evidence, not values
                    enums.add(sha(sorted(json.dumps(v, sort_keys=True) for v in values)))
                    lists.add(len(values))
            projection = project(case, cfg)
            assert len(requests) == projection['calls'] <= cfg.budget.calls
            assert len(enums) == 1, 'reply schemas of one arm disagree on allowed values'
            arms[name] = {**projection, 'reply_enum_lists': sorted(lists), 'chunks': len(chunks), 'request_fingerprints': requests, 'allowed_values_sha256': enums.pop()}
        assert len({a['allowed_values_sha256'] for a in arms.values()}) == 1, 'arms disagree on allowed values'
        allowed = sum(1 for _ in _declared(case.schema.model_dump(mode='json', by_alias=True)))
        enum_lists = sorted(lists)
        assert (allowed > 0) == (max(enum_lists) > 0), f'{case.id}: declared allowed values {allowed} vs reply enum lists {enum_lists}'
        noop = [n for n in ARMS[1:] if arms[n]['request_fingerprints'] == arms['base']['request_fingerprints']]
        assert not noop, f'{case.id}: requests identical to base for {noop}'
        order = ARMS[index % 4:] + ARMS[:index % 4]
        schedule += [{'group_index': index, 'case': case.id, 'arm': n} for n in order]
        rows.append({'order': index, 'case': case.id, 'group': case.group, 'case_sha256': case_pin(case),
                     'length': case.id.split('--')[0], 'arm_order': order, 'chunks': arms['base']['chunks'],
                     'a1_merge_can_act': arms['base']['chunks'] > 1, 'arms': arms,
                     'allowed_value_lists': allowed, 'reply_enum_lists': enum_lists})

    runner = HERE / 'run_paired.py'
    contract = {
        'identity': {'run_id': study['id'], 'closed_parent_run_id': 'extractbench-v2-development',
                     'parent_revision': PARENT_REVISION, 'code_revision': head,
                     'harness_source_sha256': sha(harness_pin(Path.cwd())), 'runner_sha256': file_sha(runner),
                     'freeze_sha256': file_sha(__file__), 'study_file_sha256': file_sha(root / 'execution-study.json'),
                     'dataset_file_sha256': file_sha(root / 'dataset.json'), 'dataset_revision': adapter['dataset_revision'],
                     'adapter_manifest_sha256': ADAPTER_MANIFEST_SHA256, 'schema_policy_version': adapter['schema_policy_version'],
                     'copied_files_sha256': files,
                     'development_membership': {'selected_groups': 12, 'native_text_failures': [f['source_id'] for f in adapter['failures']],
                                                'excluded': EXCLUDED, 'eligible_cases': len(cases), 'eligible_groups': len(cases),
                                                'cells': len(cases) * 4, 'heldout_groups_opened': 0},
                     'case_order_rule': 'registered smoke groups (grafton first as the one-call-per-arm smoke), then the '
                                        'continuation selection order; metadata only, fixed before any output'},
        'treatments': {'arms': {n: {'config_sha256': cfg.sha256(), 'config': cfg.model_dump(mode='json')} for n, cfg in configs.items()},
                       'deltas_from_base': deltas, 'intended': {'A1': 'continuation flags merge records split across chunks',
                                                               'A2': 'quote evidence per value', 'A3': 'passage-ID evidence per value'},
                       'provider': study['provider'], 'decoding': 'temperature 0, seed 20260930, thinking off, strict json_schema',
                       'a1_note': 'on one-chunk documents A1 differs only in prompt/schema; its merge cannot act there'},
        'evaluation': {'evaluator_version': 2, 'evaluation_sha256': Eval(**study['evaluation']).sha256(), 'rules': study['evaluation'],
                       'scorer': 'experiments.harness.study.compare_study (same for every arm); canonical and raw both reported',
                       'masks': 'fields whose gold is unannotated are counted as unannotated_fields, never as empty, correct or wrong; '
                                'identical across arms because gold is per case',
                       'failure': 'a cell whose attempt did not seal a result is failed/unsealed and stays in the denominator of its group'},
        'budget': {'elapsed_minutes': 120, 'provider_attempts': 240, 'workers': 1,
                   'admission_cutoff_minutes': 105, 'request_timeout_seconds': study['provider']['timeout'],
                   'provider_attempt_definition': 'one chat-completion HTTP request, including recovery halves and failed requests; '
                                                  '/tokenize and /models requests are auxiliary, journalled separately, not counted',
                   'hidden_retries': 'none: recovery.retries 0, requests has no retry adapter; every subdivision half is one counted attempt',
                   'stopping': 'no new request at or after start+105 min, at 240 attempts, or on STOP_REQUESTS; an admitted request '
                               'may drain until its 900 s timeout (<= start+120 min); unsealed cells stay unsealed',
                   'projected_nominal_calls': sum(a['calls'] for r in rows for a in r['arms'].values()),
                   'projected_upper_bound_with_recovery': sum(a['upper_bound_with_recovery'] for r in rows for a in r['arms'].values()),
                   'fit': 'the full matrix does not fit: 240 < nominal calls, and at ~7.8 decode tokens/s with one worker prior '
                          'short-document groups took ~8-30 min each; expect roughly 3-6 complete short groups, no medium/long'},
        'schedule': schedule,
        'decision_rule': 'final-protocol-proposal.md: among A1-A3, the highest mean per-group raw exact value F1 over complete '
                         'paired groups, provided its canonical complete repeated-record count >= A0 and source-region failures '
                         '<= A0; ties by fewer completion tokens. Additionally frozen here: it must beat A0 on mean paired raw F1 and in a '
                         'majority of complete paired groups, with >= 3 complete paired groups; otherwise "evidence insufficient".',
        'cases': rows,
    }
    write_new(root / 'contract.json', contract)
    shutil.copyfile(root / 'contract.json', HERE / 'contract.json')
    print(json.dumps({k: contract['budget'][k] for k in ('projected_nominal_calls', 'projected_upper_bound_with_recovery')}),
          [(r['case'], r['chunks'], r['arms']['base']['calls']) for r in rows])


def _enums(node):
    if isinstance(node, dict):
        if 'enum' in node:
            yield node['enum']
        for value in node.values():
            yield from _enums(value)
    elif isinstance(node, list):
        for value in node:
            yield from _enums(value)


def _declared(node):
    if isinstance(node, dict):
        if node.get('allowedValues'):
            yield node['allowedValues']
        for value in node.values():
            yield from _declared(value)
    elif isinstance(node, list):
        for value in node:
            yield from _declared(value)


if __name__ == '__main__':
    main()
