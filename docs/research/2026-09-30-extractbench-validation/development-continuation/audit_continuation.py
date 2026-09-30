"""Read-only audit of this frozen continuation; reuse the harness scorer, never infer.

Run from prototypes/parsing_service: python PATH/audit_continuation.py DATA_ROOT NEW_OUTPUT
The destination contains hashes, usage and scores, never source text or gold values.
"""
import argparse
import csv
import dataclasses
import hashlib
import json
from collections import Counter
from datetime import datetime
from pathlib import Path

from experiments.extraction.manifest import differences, write_new
from experiments.harness.data import InferenceCase, load_cases
from experiments.harness.extract import Task, chunks_of, groups_of, reply_schema, split_task, system_prompt, user_prompt
from experiments.harness.study import compare_study, expand
from kei_exp.canonical import canonical_json
from kei_exp.kie.extract.llm import THINKING_OFF, _messages, _plain


def read(path):
    return json.loads(path.read_text())


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else canonical_json(value)).hexdigest()


def population_tables(report, audit, preflight, dest):
    """Include all 48 registered development cells; do not pool unequal completed subsets."""
    public = Path(__file__).resolve().parents[1]
    selection = read(public.parent / '2026-09-30-extractbench-selection.json')
    adapter = read(public / 'development-continuation/adapter-manifest.json')
    pages = {r['source_id']: r['parser']['page_count'] for r in adapter['documents']}
    failures = {r['source_id']: r['reason'] for r in adapter['failures']}
    admitted = {r['case'] for r in preflight['cases'] if r['admitted']}
    budget = {r['cell']: r for r in audit['cell_budget_checks']}
    smoke_requests = read(public / 'development-smoke-audit.json')['requests']
    with (public / 'per-document.csv').open(newline='') as handle:
        reader = csv.DictReader(handle)
        columns = ['phase', 'status', 'coverage_complete', 'gold_annotation_state',
            'cached_response_count', 'length_limited_responses', 'cached_recovery_responses', *reader.fieldnames]
        rows = [{'phase': 'smoke', 'status': 'completed', 'coverage_complete': True,
            'gold_annotation_state': 'decoded; roundtrip passed', **row} for row in reader]
    assert len(rows) == 12
    for row in rows:
        cell = ('base' if row['arm'] == 'A0' else row['arm']) + '--' + row['case']
        responses = [r for r in smoke_requests if r['cell'] == cell]
        row.update({'cached_response_count': len(responses),
            'length_limited_responses': sum(r['finish'] == 'length' for r in responses),
            'cached_recovery_responses': 0})  # The original smoke audit observed no subdivision.
    for group in selection['groups']:
        if group['split'] != 'development' or group['smoke']:
            continue
        source, case = group['selected_representative_id'], group['selected_representative_id'].replace('/', '--')
        for arm in ('base', 'A1', 'A2', 'A3'):
            cell = arm + '--' + case
            scored = report['variants'][arm]['documents'].get(case)
            spending = budget.get(cell, {})
            responses = [r for r in audit['requests'] if r['case'] == case and r['arm'] == arm]
            status = ('completed' if scored else failures[source] if source in failures else
                'nominal_calls_exceed_cell_cap' if case not in admitted else spending.get('status', 'not_run'))
            row = {k: None for k in columns}
            row.update({'phase': 'continuation', 'status': status, 'arm': 'A0' if arm == 'base' else arm,
                'case': case, 'group': group['group_id'], 'pages': pages[source],
                'cached_response_count': len(responses),
                'length_limited_responses': sum(r['finish'] == 'length' for r in responses),
                'cached_recovery_responses': sum(not r['nominal'] for r in responses),
                'gold_annotation_state': 'not decoded: ingestion failed' if source in failures else 'decoded; roundtrip passed',
                'operational_fresh_calls_charged_upper_bound': spending.get('fresh_calls', 0),
                'operational_known_input_tokens': spending.get('input_tokens', 0),
                'operational_known_output_tokens': spending.get('output_tokens', 0),
                'operational_unknown_usage_requests': spending.get('unknown_usage_requests', 0),
                'unknown_token_upper_bound': spending.get('unknown_additional_tokens_upper_bound', 0),
                'replayed_calls': 0, 'replayed_input_tokens': 0, 'replayed_output_tokens': 0})
            if scored:
                counts, metrics = scored['counts'], scored['metrics']
                row.update({k: counts.get(k, 0) for k in columns if k in (
                    'gold_value_fields', 'gold_records', 'pred_records', 'matched_records', 'missing_records',
                    'duplicated_records', 'hallucinated_records', 'raw_strict_records', 'strict_records',
                    'cross_page_fragments', 'raw_tp', 'tp', 'raw_wrong_values', 'wrong_values', 'missed_as_absent',
                    'fn_missing_record', 'hallucinated_fields', 'extra_record_values', 'duplicate_values',
                    'ev_gold_fields', 'ev_page_joint', 'raw_ev_page_joint', 'ev_page_hit', 'ev_page_annotated')
                    or k.startswith('repeated_')})
                for policy, field in [('raw', metrics['raw_exact']['field']), ('canonical', metrics['field'])]:
                    row.update({policy + '_' + k: field[k] for k in ('precision', 'recall', 'f1')})
                for policy, numerator in [('canonical', 'ev_page_joint'), ('raw', 'raw_ev_page_joint')]:
                    denominator = counts.get('ev_gold_fields', 0)
                    row['annotated_page_joint_' + policy] = counts.get(numerator, 0) / denominator if denominator else None
                coverage = scored['coverage']
                row['coverage_complete'] = coverage['complete']
                row['region_failures'] = sum(coverage[k] for k in ('partial', 'failed', 'refused'))
                if not coverage['complete']:
                    row['status'] = 'sealed_with_region_failures'
            rows.append(row)
    assert len(rows) == 48 and len({r['group'] for r in rows}) == 12
    assert not audit['replayed_spend'].get('calls', 0), 'This fresh continuation must not hide replays'
    for column, key in [('operational_known_input_tokens', 'input_tokens'),
                        ('operational_known_output_tokens', 'output_tokens'),
                        ('operational_fresh_calls_charged_upper_bound', 'fresh_calls')]:
        assert sum(r[column] for r in rows if r['phase'] == 'continuation') == audit['operational_spend'].get(key, 0)
    with (dest / 'per-document-all-development.csv').open('x', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)
    executed = {r['case'] for r in rows if int(r['operational_fresh_calls_charged_upper_bound']) > 0}
    sealed_statuses = {'completed', 'sealed_with_region_failures'}
    complete = {r['case'] for r in rows if r['status'] in sealed_statuses}
    all_arms = {case for case in complete if sum(r['case'] == case and r['status'] in sealed_statuses for r in rows) == 4}
    covered = {r['case'] for r in rows if r['status'] == 'completed'}
    covered_all_arms = {case for case in covered if sum(r['case'] == case and r['status'] == 'completed' for r in rows) == 4}
    write_new(dest / 'population.json', {'selected_source_groups': 20, 'selected_documents': 20,
        'development_source_groups': 12, 'development_documents': 12, 'heldout_source_groups': 8,
        'heldout_documents': 8, 'related_source_documents_reserved': selection['counts']['related_members_reserved'],
        'development_related_source_documents_reserved': selection['counts']['development_related_members_reserved'],
        'heldout_related_source_documents_reserved': selection['counts']['holdout_related_members_reserved'],
        'development_representatives_downloaded': 12,
        'development_native_text_ingestion_passed': 10, 'development_ingestion_failed': 2,
        'development_nominal_budget_rejected': 1, 'development_inference_eligible': 9,
        'development_documents_with_fresh_inference': len(executed),
        'development_documents_with_a_completed_arm': len(complete),
        'development_documents_with_all_four_arms_completed': len(all_arms),
        'development_documents_with_an_arm_covering_all_source_regions': len(covered),
        'development_documents_with_all_arms_covering_all_source_regions': len(covered_all_arms),
        'executed_documents_by_benchmark_length_category': dict(Counter(c.split('--', 1)[0] for c in executed)),
        'cell_statuses': dict(Counter(r['status'] for r in rows)),
        'heldout_pdfs_downloaded': 0, 'heldout_annotations_decoded': 0, 'heldout_inference_calls': 0,
        'original_smoke_csv_sha256': sha((public / 'per-document.csv').read_bytes()),
        'selection_sha256': sha((public.parent / '2026-09-30-extractbench-selection.json').read_bytes()),
        'comparison_rule': 'No pooled ranking of unequal completed subsets; no challenger selected',
        'missing_score_policy': 'Unsealed, blocked and unrun cells have no quality score, not a zero or an omitted row'})


def expected_requests(cases, configs, preflight):
    """Enumerate the already-declared requests and one-level recovery using source only."""
    expected = {}
    nominal = {(r['case'], r['arm'], r['chunk']): r for r in preflight['requests']}
    for case in cases:
        inference = case.inference()
        assert not any(hasattr(inference, k) for k in ('gold', 'annotations', 'group', 'split'))
        assert not inference.record_key  # This fixed dataset uses passage subdivision only.
        for arm, cfg in configs.items():
            assert cfg.retrieval.mode == 'exhaustive' and cfg.decompose.mode == 'whole'
            assert cfg.recovery.retries == 0 and cfg.recovery.depth == 1 and cfg.sampling.n == 1
            for index, nodes in enumerate(groups_of(inference, cfg)):
                for chunk in chunks_of(list(inference.evidence.passages), cfg):
                    task = Task(chunk.id, index)
                    parts = [(task, chunk.context.primary, nodes)]
                    parts += split_task(task, chunk.context.primary, nodes, False, inference)
                    for part, passages, fields in parts:
                        schema = reply_schema(fields, cfg, [p.id for p in (*chunk.context.overlap, *passages)])
                        request = {'system': system_prompt(inference, fields, cfg, schema),
                            'user': user_prompt(chunk, cfg, passages), 'schema': schema,
                            'max_tokens': cfg.output.max_tokens, 'temperature': cfg.sampling.temperature,
                            'seed': cfg.sampling.seed, 'top_logprobs': cfg.signals.top_logprobs}
                        row = {'case': case.id, 'arm': arm, 'chunk': chunk.id,
                            'source_part': list(part.source_part), 'nominal': part.depth == 0,
                            'source_prompt_sha256': sha(request['user']),
                            'system_sha256': sha(request['system']), 'schema_sha256': sha(schema)}
                        if row['nominal']:
                            planned = nominal[case.id, arm, chunk.id]
                            assert all(row[k] == planned[k] for k in ('source_prompt_sha256', 'system_sha256', 'schema_sha256'))
                        key = sha(request)
                        assert key not in expected, 'Ambiguous request ownership in this fixed matrix'
                        expected[key] = row
    return expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    root, dest = args.root.resolve(), args.output.resolve()
    assert not dest.exists(), 'Audit outputs are write-once'
    cap_end = read(root / 'runtime-cap-finished.json') if (root / 'runtime-cap-finished.json').exists() else {}
    # The watcher's pidfd poll proves exit; sending SIGTERM alone does not.
    exit_record = read(root / 'runner-exit-confirmed.json') if (root / 'runner-exit-confirmed.json').exists() else {}
    stopped = ((root / 'runner-finished.json').exists() or cap_end.get('status') == 'runner_exited'
        or (cap_end.get('status') == 'terminated_at_wall_cap' and exit_record.get('runner_exited') is True))
    assert stopped, 'Study may still be running; confirm process exit before auditing a forced termination'
    study_path = root / 'execution-study.json'
    study, preflight, manifest = read(study_path), read(root / 'preflight.json'), read(root / 'out/manifest.json')
    configs = expand(study)
    cases = load_cases(root / study['dataset'])
    assert all(c.split == 'dev' for c in cases) and len(cases) == 6
    assert not {'gold', 'annotations', 'split', 'group'} & {f.name for f in dataclasses.fields(InferenceCase)}
    delta = {name: sorted(differences(configs['base'].model_dump(mode='json'), cfg.model_dump(mode='json')))
        for name, cfg in configs.items() if name != 'base'}
    assert delta == {'A1': ['merge.continuation'], 'A2': ['evidence.mode'], 'A3': ['evidence.mode']}
    assert configs['A2'].evidence.alignment == configs['A3'].evidence.alignment
    assert study['final'] is None and study['budget']['max_calls'] == 400
    expected = expected_requests(cases, configs, preflight)
    report = compare_study(study_path, root / 'out', 'dev')
    assert all(not v['invariant_violations'] for v in report['variants'].values())
    assert report['provenance']['run_code_matches_current'] and report['provenance']['manifest_code_matches_current']

    cached, requests = {}, []
    for path in sorted((root / 'out/cache').glob('*/*.json')):
        item = read(path)
        request, reply = item['request'], item['reply']
        assert request['attempt'] == request['sample'] == 0
        key = sha({'identity': manifest['provider'], 'model': study['provider']['model'],
            'adapter': 'ResearchChat', **request})
        assert key == path.stem
        sent = {k: v for k, v in request.items() if k not in ('attempt', 'sample')}
        input_hash = sha(sent)
        assert input_hash in expected, 'Saved request differs from registered source-only construction'
        assert input_hash not in cached
        cached[input_hash] = reply
        body = {'model': study['provider']['model'], 'temperature': sent['temperature'],
            'max_tokens': sent['max_tokens'], 'messages': _messages(sent['system'], sent['user']),
            'chat_template_kwargs': dict(THINKING_OFF), 'seed': sent['seed'],
            'response_format': {'type': 'json_schema', 'json_schema': {'name': 'reply', 'schema': _plain(sent['schema']), 'strict': True}}}
        requests.append({**expected[input_hash], 'cache_key': key, 'cache_file_sha256': sha(path.read_bytes()),
            'adapter_input_sha256': input_hash, 'effective_body_sha256': sha(body),
            'max_output_tokens': sent['max_tokens'], 'temperature': sent['temperature'], 'seed': sent['seed'],
            'input_tokens': reply['input_tokens'], 'output_tokens': reply['output_tokens'],
            'finish': reply['finish'], 'seconds': reply['seconds']})

    journal, spend_by_cell = [], {}
    seen = set()
    cap = read(root / 'runtime-cap-amendment.json')
    for path in sorted((root / 'request-journal').glob('*.started.json')):
        start = read(path)
        key = start['adapter_input_sha256']
        assert key in expected and key not in seen
        seen.add(key)
        row = expected[key]
        assert datetime.fromisoformat(start['at']) < datetime.fromisoformat(cap['admission_deadline_utc'])
        done_path = path.with_name(path.name.replace('.started.', '.finished.'))
        done = read(done_path) if done_path.exists() else {}
        reply = cached.get(key)
        if done.get('status') == 'completed' and reply is not None:
            assert all(done[k] == reply[k] for k in ('input_tokens', 'output_tokens', 'finish', 'seconds'))
        known = reply if reply is not None else done
        unknown = int(known.get('input_tokens') is None or known.get('output_tokens') is None)
        usage = {'fresh_calls': 1, 'input_tokens': known.get('input_tokens') or 0,
            'output_tokens': known.get('output_tokens') or 0, 'unknown_usage_requests': unknown,
            'unknown_additional_tokens_upper_bound': start['unknown_token_upper_bound'] * unknown,
            'known_response_seconds': known.get('seconds') or 0}
        cell = row['arm'] + '--' + row['case']
        target = spend_by_cell.setdefault(cell, Counter())
        target.update(usage)
        journal.append({'request': path.name.removesuffix('.started.json'), 'cell': cell, 'at': start['at'],
            'finished_at': done.get('at'), 'journal_status': done.get('status', 'unfinished'),
            'response_cache_available': reply is not None,
            'usage_recovered_from_cache': bool(reply and not done), **usage})
    assert set(cached) <= seen
    total_spend = Counter()
    for spending in spend_by_cell.values():
        total_spend.update(spending)
    totals = dict(total_spend)
    assert totals.get('fresh_calls', 0) <= 400
    assert totals.get('fresh_calls', 0) + 37 <= 500
    checks, artifacts = [], []
    replayed = Counter()
    for directory in sorted((root / 'out/cells').iterdir()):
        if not directory.is_dir():
            continue
        arm = directory.name.split('--', 1)[0]
        finished = [read(p) for p in directory.glob('attempt-*.finished.json')]
        charged = sum(r['spent']['fresh']['calls'] for r in finished)
        own = spend_by_cell.get(directory.name, {})
        if finished:
            assert charged == own.get('fresh_calls', 0)
        for attempt in finished:
            replayed.update(attempt['spent']['replayed'])
        token_bound = own.get('input_tokens', 0) + own.get('output_tokens', 0) + own.get('unknown_additional_tokens_upper_bound', 0)
        assert own.get('fresh_calls', 0) <= configs[arm].budget.calls and token_bound <= configs[arm].budget.tokens
        checks.append({'cell': directory.name, 'sealed': (directory / 'result.json').exists(),
            'finished_attempts': len(finished), 'status': finished[-1]['status'] if finished else 'unfinished',
            'fresh_token_upper_bound': token_bound, **own})
        if not (directory / 'result.json').exists():
            continue
        result = read(directory / 'result.json')
        artifact = result['artifact']
        assert sha(artifact) == result['execution']['artifact_sha256']
        entries = [e for f in artifact['fields'] for e in f.get('evidence', [])]
        if arm in ('A2', 'A3'):
            assert all(e.get('evidence_protocol') == 2 and 'raw_spans' in e and e.get('semantic_support') is None for e in entries)
        else:
            assert not entries
        artifacts.append({'cell': directory.name, 'artifact_sha256': sha(artifact),
            'code_sha256': result['execution']['code_sha256'], 'evidence_entries': len(entries),
            'raw_evidence_entries_with_spans': sum(bool(e['raw_spans']) for e in entries),
            'refined_evidence_entries': sum(bool(e.get('refined')) for e in entries),
            'coverage': artifact['coverage'], 'issue_codes': dict(Counter(i['code'] for i in artifact['issues']))})

    # Keep raw reports privately; public evidence drops free-text errors that can quote source/model text.
    raw_report_sha = sha(report)
    for variant in report['variants'].values():
        for document in variant['documents'].values():
            document['issues'] = [{k: v for k, v in issue.items() if k != 'detail'} for issue in document['issues']]
        for failure in variant['failed_cells']:
            if 'error' in failure:
                failure['error_sha256'] = sha(failure.pop('error'))
    audit = {'study': study['id'], 'config_deltas': delta, 'quote_id_alignment_equal': True,
        'gold_excluded_from_inference_type': True, 'all_cached_requests_match_source_only_nominal_or_declared_recovery': True,
        'effective_requests_reconstructed_from': 'Saved request cache and pinned ResearchChat adapter; not packet capture',
        'requests': requests, 'request_journal': journal, 'operational_spend': totals,
        'replayed_spend': dict(replayed), 'cell_budget_checks': checks, 'sealed_artifacts': artifacts,
        'historical_smoke_calls_charged': 37, 'historical_smoke_unknown_tokens_upper_bound': 36864,
        'runtime_cap': cap, 'runtime_cap_result': cap_end,
        'raw_comparison_report_canonical_sha256': raw_report_sha,
        'holdout_documents_ingested': 0, 'holdout_documents_extracted': 0,
        'comparison_complete': len(artifacts) == 24, 'new_inference_calls_for_audit': 0}
    dest.mkdir(parents=True)
    write_new(dest / 'report-v2-sanitized.json', report)
    write_new(dest / 'audit.json', audit)
    population_tables(report, audit, preflight, dest)
    print(json.dumps({'sealed_cells': len(artifacts), 'operational_spend': totals,
        'replayed_spend': dict(replayed), 'comparison_complete': audit['comparison_complete']}, indent=2))


if __name__ == '__main__':
    main()
