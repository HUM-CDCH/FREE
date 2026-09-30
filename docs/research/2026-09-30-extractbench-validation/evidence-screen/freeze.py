"""Freeze the A0-versus-A3 passage-ID evidence screen. Offline: no completion, tokenizer or model request.

Copies the six predeclared development cases of dataset-v3 into a new run root in the predeclared order, proves that
dataset-v3 differs from dataset-v2 only by the adapter's record_scope, fingerprints every nominal request per arm, records
document lengths and per-path annotation availability and writes contract.json. Run from prototypes/parsing_service:
python PATH/freeze.py DATASET_V3 DATASET_V2 RUN_ROOT
"""
import hashlib
import json
import shutil
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

from experiments.extraction.manifest import differences, write_new
from experiments.harness.data import load_cases
from experiments.harness.evaluate import score_case
from experiments.harness.extract import chunks_of, groups_of, reply_schema, retrieve, system_prompt, user_prompt
from experiments.harness.study import Eval, case_pin, expand, harness_pin, project
from kei_exp.canonical import canonical_json

HERE = Path(__file__).resolve().parent
PRIOR = HERE.parent / 'corrected-comparison'
ORDER = ['short--grafton_isotrope_invoice_19503', 'medium--1G1PC5SB6E7111015_professional_valuation',
         'short--mission-tx-tyler-invoice', 'short--dc-pepco-residential-bill',
         'short--caterpillar_spec_sheet_312c_excavator', 'short--lancaster_county_ne_requisition_po_husker_steel']
ARMS = ['base', 'A3']
ELAPSED_MINUTES, ATTEMPTS, TIMEOUT_SECONDS = 180, 180, 900
# From the closed corrected-comparison run (sealed cells, 1 worker): seconds per call and output tokens per call.
PRIOR_SECONDS_PER_CALL = {'base': 116, 'A3': 167}
sha = lambda value: hashlib.sha256(canonical_json(value)).hexdigest()
file_sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    source, v2, root = (Path(a).resolve() for a in sys.argv[1:4])
    top = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    dirty = subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=top, text=True)
    assert not [l for l in dirty.splitlines() if 'prototypes/' in l], 'harness/service sources must be committed before freezing'
    assert file_sha(source / 'adapter-manifest.json') == file_sha(v2 / 'adapter-manifest.json')
    adapter = json.loads((source / 'adapter-manifest.json').read_text())
    assert adapter['schema_policy_version'] == 'structural-string-enums-v2' and adapter['holdout_documents_ingested'] == 0

    # Dataset delta: dataset.json and every annotation byte-identical; every input is v2's plus the adapter's record_scope.
    delta = {'dataset.json': file_sha(source / 'dataset.json') == file_sha(v2 / 'dataset.json'), 'inputs': {}}
    assert delta['dataset.json']
    entries = {c['id']: c for c in json.loads((source / 'dataset.json').read_text())['cases']}
    for entry in entries.values():
        assert file_sha(source / entry['annotations_file']) == file_sha(v2 / entry['annotations_file'])
        new, old = (json.loads((d / entry['inference_file']).read_text()) for d in (source, v2))
        added = {k: new[k] for k in new.keys() - old.keys()}
        assert added == {'record_scope': 'document'} and all(new[k] == old[k] for k in old), entry['id']
        delta['inputs'][entry['id']] = {'added': added, 'v2_sha256': file_sha(v2 / entry['inference_file']),
                                        'v3_sha256': file_sha(source / entry['inference_file'])}
    old_cases = {c.id: c for c in load_cases(v2 / 'dataset.json')}

    root.mkdir()
    files = {}
    for case_id in ORDER:
        for key in ('inference_file', 'annotations_file'):
            rel = entries[case_id][key]
            (root / rel).parent.mkdir(exist_ok=True)
            shutil.copyfile(source / rel, root / rel)
            files[rel] = file_sha(root / rel)
    write_new(root / 'dataset.json', {'version': 1, 'cases': [entries[i] for i in ORDER]})
    shutil.copyfile(HERE / 'study.json', root / 'execution-study.json')
    study = json.loads((root / 'execution-study.json').read_text())
    configs = expand(study)
    cases = load_cases(root / 'dataset.json')
    assert [c.id for c in cases] == ORDER and len({c.group for c in cases}) == len(cases)
    for c in cases:     # the scope is active, and it is the only thing the case pin gained
        assert c.split == 'dev' and c.record_scope == 'document' and case_pin(c) != case_pin(old_cases[c.id])
        assert case_pin(replace(c, record_scope='records')) == case_pin(old_cases[c.id])

    deltas = {n: sorted(differences(configs['base'].model_dump(mode='json'), cfg.model_dump(mode='json'))) for n, cfg in configs.items() if n != 'base'}
    assert list(configs) == ARMS and deltas == {'A3': ['evidence.mode']}
    assert all(cfg.sampling.n == 1 and cfg.budget.workers == 1 and cfg.recovery.retries == 0 and not cfg.verification.model
               and not cfg.merge.resolver and cfg.merge.continuation == 'off' and cfg.chunking.overlap == 0 for cfg in configs.values())
    prior = {r['case']: r['arms'] for r in json.loads((PRIOR / 'contract.json').read_text())['cases']}
    rules = Eval(**study['evaluation'])

    rows, schedule = [], []
    for index, case in enumerate(cases):
        inference = case.inference()
        assert not any(hasattr(inference, k) for k in ('gold', 'annotations', 'split', 'group')), 'gold reachable from inference'
        arms = {}
        for name, cfg in configs.items():
            requests = []
            chunks = chunks_of(list(inference.evidence.passages), cfg)
            for nodes in groups_of(inference, cfg):
                for chunk in retrieve(chunks, nodes, inference.schema.record_description, cfg):
                    primary = chunk.context.primary
                    schema = reply_schema(nodes, cfg, [p.id for p in (*chunk.context.overlap, *primary)])
                    requests.append(sha([system_prompt(inference, nodes, cfg, schema), user_prompt(chunk, cfg, primary), schema]))
            projection = project(case, cfg)
            assert len(requests) == projection['calls'] and projection['upper_bound_with_recovery'] <= cfg.budget.calls
            arms[name] = {**projection, 'chunks': len(chunks), 'request_fingerprints': requests, 'config_sha256': cfg.sha256(),
                          'requests_identical_to_prior_run': case.id in prior and prior[case.id][name]['request_fingerprints'] == requests}
        assert arms['A3']['request_fingerprints'] != arms['base']['request_fingerprints'], case.id
        order = ARMS[index % 2:] + ARMS[:index % 2]
        schedule += [{'group_index': index, 'case': case.id, 'arm': n} for n in order]
        passages = case.evidence.passages
        rows.append({'order': index, 'case': case.id, 'group': case.group, 'case_sha256': case_pin(case), 'arm_order': order,
                     'length_category': case.id.split('--')[0], 'characters': sum(len(p.text) for p in passages),
                     'passages': len(passages), 'pages': len({p.page for p in passages}), 'chunks': arms['base']['chunks'],
                     'arms': arms, 'annotation_availability': availability(case, rules),
                     'projected_minutes': round(sum(arms[n]['calls'] * PRIOR_SECONDS_PER_CALL[n] for n in ARMS) / 60, 1)})

    nominal = sum(a['calls'] for r in rows for a in r['arms'].values())
    upper = sum(a['upper_bound_with_recovery'] for r in rows for a in r['arms'].values())
    cumulative, fit = 0.0, []
    for r in rows:
        cumulative += r['projected_minutes']
        fit.append({'group': r['group'], 'cumulative_projected_minutes': round(cumulative, 1)})
    contract = {
        'identity': {'run_id': study['id'], 'prior_runs': {
                         'closed_execution': {'run_id': 'extractbench-v3-corrected-development', 'contract_commit': 'a24b87e7',
                                              'results_commits': ['e2542d20', '2024b85c']},
                         'offline_replay': {'report': 'assembly-repair/README.md', 'repair_commit': 'e4c9c906',
                                            'analysis_commits': ['5c62481a', '9c38ab92']}},
                     'code_revision': head, 'dirty_tree_porcelain_sha256': hashlib.sha256(dirty.encode()).hexdigest(),
                     'dirty_tree_paths': [l[3:] for l in dirty.splitlines()],
                     'harness_source_sha256': sha(harness_pin(Path.cwd())), 'runner_sha256': file_sha(HERE / 'run.py'),
                     'prior_runner_helpers_sha256': file_sha(PRIOR / 'run_paired.py'),
                     'analyze_sha256': file_sha(HERE / 'analyze.py'), 'freeze_sha256': file_sha(__file__),
                     'study_file_sha256': file_sha(root / 'execution-study.json'), 'dataset_file_sha256': file_sha(root / 'dataset.json'),
                     'dataset_revision': {'name': 'dataset-v3', 'extractbench_revision': adapter['dataset_revision'],
                                          'adapter_manifest_sha256': file_sha(source / 'adapter-manifest.json'),
                                          'built_by': 'experiments.harness extractbench (adapter at e4c9c906+) re-prepared offline '
                                                      'under unshare -rn from dataset-v2 PDFs and the pinned JSONLs',
                                          'delta_from_dataset_v2': delta},
                     'schema_policy_version': adapter['schema_policy_version'], 'copied_files_sha256': files,
                     'development_membership': {'cases': ORDER, 'registered_development_groups': 12,
                                                'not_selected_here': sorted(set(entries) - set(ORDER)), 'heldout_groups_opened': 0},
                     'case_order_rule': 'predeclared: grafton (smoke pair) then mitchell (medium) then mission, pepco, caterpillar, '
                                        'lancaster; both arms of a group before the next; first arm alternates base/A3 by group index'},
        'treatments': {'arms': {n: {'config_sha256': cfg.sha256(), 'config': cfg.model_dump(mode='json')} for n, cfg in configs.items()},
                       'deltas_from_base': deltas,
                       'intended': {'base': 'A0: repaired assembly, record_scope document, no evidence, bounded recovery (subdivide depth 1)',
                                    'A3': 'A0 plus passage-ID evidence: the reply wraps each top-level field as {value, ids} with ids '
                                          'constrained to the chunk\'s shown block ids'},
                       'effective_request_difference': 'system prompt gains one evidence instruction line; reply schema wraps each '
                                                       'top-level field in {value, ids}; output tokens grow accordingly. Nothing else.',
                       'provider': study['provider'], 'decoding': 'temperature 0, seed 20260930, thinking off, strict json_schema, n=1',
                       'recovery': 'retries 0; a failed or truncated task is halved once (fields after a cut-off, else passages); each '
                                   'half is one counted attempt',
                       'parser_artifacts': 'pdfium-native-lines-v1 passages pinned by copied_files_sha256; no re-parse at run time'},
        'evaluation': {'evaluator_version': rules.evaluator_version, 'evaluation_sha256': rules.sha256(), 'rules': study['evaluation'],
                       'scorer': 'experiments.harness.evaluate.score_case (score_structured) for both arms; raw and canonical',
                       'annotation_semantics': 'missing collection = unannotated (unscored); explicit null or [] = annotated empty; '
                                               'an unpaired parent\'s collection is scored only where its availability is known, else '
                                               'unscored/unknown; the parent stays spurious or duplicated',
                       'root_alignment': 'the single document root is paired structurally (fixed_document_root); its matched count is '
                                         'an alignment, not a correctness credit; strict (fully correct) records are reported apart',
                       'grounding': 'A3 only, on page-annotated gold; reported separately for top-level scalar leaves and for leaves '
                                    'inside objects/collections, which inherit the whole top-level field\'s citation (coarse); with '
                                    'citation specificity (distinct cited pages per cited value over document pages). Semantic '
                                    'support and word localization are unmeasured (native-line input, no labels). Invalid ids are '
                                    'impossible under the enum constraint, so validity is reported as uninformative.',
                       'decision_rule': decision_rule()},
        'budget': {'elapsed_minutes': ELAPSED_MINUTES, 'provider_attempts': ATTEMPTS, 'workers': 1, 'request_timeout_seconds': TIMEOUT_SECONDS,
                   'admission_cutoff_minutes': ELAPSED_MINUTES - TIMEOUT_SECONDS // 60, 'cell_calls': 60, 'cell_tokens': 250000,
                   'provider_attempt_definition': 'one chat-completion HTTP request, including recovery halves and failed requests; '
                                                  '/tokenize and /models requests are auxiliary, journalled separately, not counted',
                   'hidden_retries': 'none: recovery.retries 0, requests has no retry adapter',
                   'admission': 'no new completion at or after start+165 min (deadline minus the 900 s request timeout), at 180 '
                                'attempts, or once STOP_REQUESTS exists; the process runs under a hard kill at the deadline; the '
                                'allowance is 180 minus every journalled attempt, so a restart never replenishes it',
                   'clock': 'run-clock.json is written before the first model-service contact (including /models and /tokenize) '
                            'and never moved',
                   'projected_nominal_calls': nominal, 'projected_upper_bound_with_recovery': upper,
                   'projected_minutes_by_prior_seconds_per_call': fit,
                   'fit': 'nominal calls fit the attempt allowance; time is the binding limit. At the prior run\'s mean seconds per '
                          'call the full schedule is close to the 165-minute admission cutoff; medium-document output density is '
                          'unmeasured, so later groups (lancaster first) may not complete. No substitution of cases.'},
        'schedule': schedule,
        'cases': rows,
    }
    write_new(root / 'contract.json', contract)
    shutil.copyfile(root / 'contract.json', HERE / 'contract.json')
    print(json.dumps({k: contract['budget'][k] for k in ('projected_nominal_calls', 'projected_upper_bound_with_recovery',
                                                         'projected_minutes_by_prior_seconds_per_call')}),
          [(r['group'], r['characters'], r['pages'], r['chunks']) for r in rows])


def availability(case, rules):
    """Annotated gold per path, read by the evaluator itself from an empty prediction: values, explicit absences,
    unannotated fields and collections, and page-annotated values. Counts only."""
    counts, _ = score_case(case, {'records': [], 'fields': []}, rules)
    keep = ('gold_records', 'gold_value_fields', 'gold_absent_fields', 'unannotated_fields', 'unannotated_collections', 'ev_gold_fields')
    by_path = {}
    for key, value in counts.items():
        if key.startswith('path|') and key.rsplit('|', 1)[1] in keep:
            _, path, name = key.split('|')
            by_path.setdefault(path, {})[name] = value
    return by_path


def decision_rule():
    return ('screen-gate-v3, applied by analyze.py to complete paired groups only (fewer than 2: "not established"). '
            'COMPLETENESS: in EVERY complete group and EVERY annotated nested collection path separately, A3 matched >= A0 and '
            'A3 duplicated+spurious <= A0, and each arm has exactly one root record; any failure is "loss observed" naming '
            'group/path (paths never offset each other; a path with no annotated records is listed "not established" and the '
            'result then reads "no material loss on tested paths", never a plain pass). '
            'VALUE QUALITY: per-group raw F1 of A3 not lower than A0 by more than 0.05 in any group, reported with precision, '
            'recall, and abstentions (unresolved/omitted) so that a gain from withholding is visible. '
            'EVIDENCE USEFULNESS (A3 only, top-level scalar leaves, page-annotated gold): the share of correct values whose '
            'citation includes an annotated page; "useful page evidence" on a multi-page document needs >= 0.8; a single-page '
            'document is "uninformative". Descriptive only: whether the cited lines print the value (checks.literal, a lower '
            'bound), ids per value, fraction of pages cited, and the inherited citations of object/collection leaves. Semantic '
            'support is unmeasured. COST: extra attempts, tokens and seconds of A3 over A0. '
            'No winner is declared; production defaults stay.')


if __name__ == '__main__':
    main()
