"""Blind development packets and descriptive comparisons; never fits a policy."""
import json
import random
import re
import shutil
import sys
from pathlib import Path
from .holdout_evaluation import read, write, checked_labels, adjudicate
from .raw_claims import labeling_sheet
from .evaluation_labels import evidence_sets, evidence_correct
from .holdout_report import summarize, quantiles


def unquote(value):
    if isinstance(value, list):
        return [unquote(v) for v in value]
    if isinstance(value, dict):
        if set(value) == {'value', 'evidenceQuote'}:
            return value['value']
        return {k: unquote(v) for k, v in value.items()}
    return value


def emitted_values(attempt, arm):
    output = attempt / arm / 'raw_extracted.json'
    if output.exists():
        return read(output), False
    # Only completed, typed model responses; never parse an incomplete JSON prefix.
    calls = [c for c in read(attempt / 'workflow.json')['calls'] if c['name'].startswith(arm + '-') and c['complete']]
    result = {'records': []}
    for call in calls:
        response = read(attempt / (call['name'] + '.response.txt'))
        value = json.loads(response['message']['content'])
        if arm == 'quote':
            value = unquote(value)
        if call['name'].endswith('-metadata'):
            result.update(value)
        else:
            result['records'].extend(row['record'] for row in value['records'])
    return result, True


def prepare(root, source):
    existing = read(root / 'blind-map.json') if (root / 'blind-map.json').exists() else []
    processed = {m['attempt'] for m in existing}
    selected = [a for a in sorted(root.glob('conrad-attempt-*')) if a.name not in processed and (a / 'workflow.json').exists() and ('finishedAt' in read(a / 'workflow.json') or (a / 'ABORTED.md').exists())]
    if not selected:
        raise ValueError('No newly finished attempts; existing blind packets remain immutable')
    round_name = f'round-{len(list((root / "blind").glob("round-*"))) + 1}'
    blind = root / 'blind' / round_name
    blind.mkdir(parents=True)
    for name in ('parsed_document.json', 'document.md', 'anchors.json', 'schema.json'):
        shutil.copyfile(source / name, blind / name)
    unique, mappings = {}, []
    for attempt in selected:
        if not (attempt / 'workflow.json').exists():
            continue
        for arm in ('baseline', 'quote'):
            result, partial = emitted_values(attempt, arm)
            for claim in labeling_sheet(result):
                path = claim['resultPath']
                if len(path) >= 3 and path[0] == 'records':
                    claim['recordContext'] = {k: v for k, v in result['records'][path[1]].items() if isinstance(v, (str, int, float, bool))}
                key = json.dumps([path, claim['value'], claim['context'], claim.get('recordContext')], ensure_ascii=False)
                unique.setdefault(key, claim)
                mappings.append({'attempt': attempt.name, 'arm': arm, 'key': key, 'partialDiagnostic': partial, 'path': path})
    keys = list(unique)
    random.Random(20260905).shuffle(keys)
    ids = {key: f'{round_name}-c{i+1:04d}' for i, key in enumerate(keys)}
    write(blind / 'claims.json', [{'claimId': ids[key], **unique[key]} for key in keys])
    write(root / 'blind-map.json', existing + [{**{k: v for k, v in row.items() if k != 'key'}, 'claimId': ids[row['key']], 'round': round_name} for row in mappings])
    print(f'{len(keys)} blind claims cover {len(mappings)} emitted values')


def report(root):
    claims, labels = [], {}
    for packet in sorted((root / 'blind').glob('round-*')):
        packet_claims = read(packet / 'claims.json')
        anchor_ids = {a['anchorId'] for a in read(packet / 'anchors.json')}
        labels.update(checked_labels(packet / 'final.json', {c['claimId'] for c in packet_claims}, anchor_ids))
        claims.extend(packet_claims)
    mapping = read(root / 'blind-map.json')
    all_rows, latency, attempts = [], [], []
    expected = read(root / 'conrad-scope-independent.json')['records']
    for attempt in sorted(root.glob('conrad-attempt-*')):
        workflow = read(attempt / 'workflow.json')
        requests = list(attempt.glob('*.request.json'))
        responses = list(attempt.glob('*.response.txt'))
        attempts.append({'attempt': attempt.name, 'workflow': workflow,
                         'recordedRequestCount': len(requests), 'recordedResponseCount': len(responses),
                         'requestsWithoutResponse': [p.name for p in requests if not p.with_name(p.name.replace('.request.json', '.response.txt')).exists()],
                         'aborted': (attempt / 'ABORTED.md').exists()})
        if (attempt / 'record-manifest.json').exists():
            manifest = read(attempt / 'record-manifest.json')
            checks = []
            for index, record in enumerate(manifest):
                wanted = expected[index] if index < len(expected) else None
                included = set(range(record['start'], record['end'])) | set(record.get('contextBlocks', []))
                required = set(range(wanted['mandatoryRecordBlockRange']['start'], wanted['mandatoryRecordBlockRange']['end'])) | set(wanted['mandatoryContextBlocks']) if wanted else set()
                bounds = wanted['record_block_range'] if wanted else {}
                checks.append({'sourceKey': record['sourceKey'], 'expectedSite': wanted['site'] if wanted else None,
                    'expectedGrave': wanted['literal_grave_identity'] if wanted else None,
                    'identityInExpectedRecord': bounds.get('start', 0) <= record.get('identityBlock', -1) < bounds.get('end', 0),
                    'missingIndependentContextBlocks': sorted(required - included)})
            attempts[-1]['sourceScope'] = {'expectedRecords': len(expected), 'discoveredRecords': len(manifest), 'checks': checks,
                'allIdentitiesMatch': len(manifest) == len(expected) and all(c['identityInExpectedRecord'] for c in checks),
                'allIndependentContextRetained': len(manifest) == len(expected) and all(not c['missingIndependentContextBlocks'] for c in checks)}
        scope = attempts[-1].get('sourceScope', {})
        attempts[-1]['status'] = 'aborted' if attempts[-1]['aborted'] else 'generation_failed' if not workflow['complete'] else 'scope_failed' if not (scope.get('allIdentitiesMatch') and scope.get('allIndependentContextRetained')) else 'complete'
        for arm in ('baseline', 'quote'):
            run = attempt / arm
            if (run / 'raw_extracted.json').exists():
                returned = read(run / 'raw_extracted.json')['records']
                identity_checks = []
                for i, row in enumerate(returned):
                    wanted = expected[i] if i < len(expected) else None
                    normalize_id = lambda value: re.sub(r'^Grab\s*', '', str(value).strip()) if value is not None else None
                    expected_id = None if wanted and wanted['literal_grave_identity'] == 'Einzelgrab' else normalize_id(wanted['literal_grave_identity']) if wanted else None
                    identity_checks.append({'ordinal': i + 1, 'site': row.get('site'), 'graveId': row.get('grave_id'),
                        'matchesIndependentIdentity': wanted is not None and str(row.get('site', '')).split(',')[0].strip() == wanted['site'] and normalize_id(row.get('grave_id')) == expected_id})
                attempts[-1].setdefault('returnedRecordIdentityChecks', {})[arm] = identity_checks
            if not (run / 'e-proposals.jsonl').exists():
                continue
            predictions = [json.loads(line) for line in (run / 'e-proposals.jsonl').read_text(encoding='utf8').splitlines()]
            elapsed = workflow['arms'][arm]
            latency.append({'arm': f'{attempt.name}/{arm}/E', 'seconds': elapsed['durationSeconds'], 'scope': 'arm including full E replay; shared discovery excluded', 'eClaimLatencyMs': quantiles([p['latencyMs'] for p in predictions if 'latencyMs' in p])})
            if arm == 'quote':
                latency.append({'arm': f'{attempt.name}/{arm}/quote-only', 'seconds': elapsed['extractionAndMappingSeconds'], 'scope': 'arm through full-source quote mapping/output; shared discovery excluded'})
            quotes = {tuple(q['resultPath']): q for q in read(run / 'quote_mappings.json')} if arm == 'quote' else {}
            ids = {tuple(m['path']): m['claimId'] for m in mapping if m['attempt'] == attempt.name and m['arm'] == arm}
            for raw in predictions:
                path = tuple(raw['path'])
                label = labels[ids[path]]
                gold = evidence_sets(label)
                for policy in (['E'] if arm == 'baseline' else ['E', 'quote-only', 'hybrid']):
                    quote = quotes.get(path)
                    proposed = [raw['bestCandidateAnchorId']] if raw['bestCandidateAnchorId'] else []
                    risk = {k: raw[k] for k in ('valueRiskScore', 'evidenceRiskScore', 'reviewRiskScore')} if policy == 'E' else {}
                    if policy != 'E':
                        if quote['status'] == 'mapped':
                            proposed = quote['proposedAnchorSets'][0]
                        elif policy == 'quote-only':
                            proposed = []
                        risk = {'quoteReviewPriority': {'mapped': 2, 'ambiguous': 1}.get(quote['status'], 0)}
                    all_rows.append({'family': 'conrad', 'arm': f'{attempt.name}/{arm}/{policy}', 'path': list(path),
                        'supported': label['valueSupported'], 'resolved': label['status'] == 'resolved',
                        'proposed': proposed, 'correctEvidence': evidence_correct(proposed, gold),
                        'supportedWithoutCanonicalEvidence': label['valueSupported'] is True and not gold,
                        'diagnosticOnly': attempts[-1]['status'] != 'complete', **risk})
    result = summarize(all_rows, latency)
    result['attempts'] = attempts
    result['attemptStatusCounts'] = {status: sum(a['status'] == status for a in attempts) for status in ('complete', 'scope_failed', 'generation_failed', 'aborted')}
    result['observedWorkflowSeconds'] = quantiles([a['workflow']['durationThroughOutputWriteSeconds'] for a in attempts if 'durationThroughOutputWriteSeconds' in a['workflow']])
    result['physicalCalls'] = {'requests': sum(a['recordedRequestCount'] for a in attempts),
        'responses': sum(a['recordedResponseCount'] for a in attempts),
        'reportedInputTokens': sum(c.get('inputTokens', 0) for a in attempts for c in a['workflow']['calls']),
        'reportedOutputTokens': sum(c.get('outputTokens', 0) for a in attempts for c in a['workflow']['calls']),
        'usageIncomplete': any(a['requestsWithoutResponse'] for a in attempts)}
    result['labelCounts'] = {'distinct': len(claims), 'emitted': len(mapping), 'unresolved': sum(l['status'] != 'resolved' for l in labels.values())}
    result['unscoredEmittedValues'] = sum(not (root / m['attempt'] / m['arm'] / 'e-proposals.jsonl').exists() for m in mapping)
    result['limitations'] = 'One development source, which belongs to the frozen risk model training families; risk diagnostics are descriptive development results. All attempts retained, including partial completed batches. No fitted holdout parameters, automatic acceptance, standalone hybrid timing, or production calibration claim.'
    write(root / 'evaluation.json', result)
    lines = ['# Bounded development comparison', '', result['limitations'], '', '| Attempt / arm / policy | Supported | Correct evidence | Unsupported proposals | Wrong supported anchors | Missing supported evidence |', '|---|---:|---:|---:|---:|---:|']
    for row in result['pooled']:
        lines.append(f"| {row['arm']} | {row['supported']} | {row['correctEvidence']} | {row['unsupportedProposals']} | {row['wrongEvidenceSupported']} | {row['missingEvidenceSupported']} |")
    lines += ['', f"Attempt status: {result['attemptStatusCounts']}.", f"Labels: {result['labelCounts']}. Emitted values without grounding replay: {result['unscoredEmittedValues']}.", '', 'Review at 1/3/5, frozen E risk diagnostics and risk/coverage are in evaluation.json. Quote and hybrid ranks are ordinal status priorities, not probabilities. Scope and failure counts must be read alongside these descriptive evidence metrics.']
    (root / 'EVALUATION.md').write_text('\n'.join(lines) + '\n', encoding='utf8')


def finalize(root, round_name):
    packet = root / 'blind' / round_name
    if (packet / 'final.json').exists():
        raise ValueError('Final labels already exist')
    adjudicate(root, False, round_name)
    claims = read(packet / 'claims.json')
    anchors = {a['anchorId'] for a in read(packet / 'anchors.json')}
    labels = checked_labels(packet / 'labels-a.json', {c['claimId'] for c in claims}, anchors)
    disputed = {d['claim']['claimId'] for d in read(packet / 'disagreements.json')}
    if disputed:
        labels.update(checked_labels(packet / 'adjudicated.json', disputed, anchors))
    write(packet / 'final.json', [labels[c['claimId']] for c in claims])


if __name__ == '__main__':
    if sys.argv[1] == 'prepare':
        prepare(Path(sys.argv[2]), Path(sys.argv[3]))
    elif sys.argv[1] == 'disagreements':
        adjudicate(Path(sys.argv[2]), False, sys.argv[3])
    elif sys.argv[1] == 'finalize':
        finalize(Path(sys.argv[2]), sys.argv[3])
    else:
        report(Path(sys.argv[2]))
