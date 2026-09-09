"""Audit frozen transfer inputs, Discovery boundaries and unchanged extraction requests."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path('artifacts/catalog-lab/examples-transfer-v1')
SENTINELS = ['Musterdorf', 'Nebenort', 'Westdorf', 'Sandgrube', '9999', '9998', '901', '902']


def read(path):
    return json.loads(path.read_bytes())


def report():
    freeze = read(ROOT/'freeze.json')
    assert all(hashlib.sha256(Path(p).read_bytes()).hexdigest() == h for p, h in freeze['hashes'].items())
    template = read(ROOT.parent/'beier/desktop-b3-r3/call-001-actual-ollama-request.json')
    rows, details = [], []
    for ref in read(ROOT/'reference.json')['cases']:
        directory = ROOT/ref['name']
        doc = read(directory/'parsed_document.json')
        baseline = read(directory/'pipeline-r1/result.json')
        assert not baseline['rows'] and not baseline['calls'] and not baseline['boundaries']
        discovery = read(directory/'discovery-r1/result.json')
        raw = read(directory/'discovery-r1/response.json')
        assert raw['done'] and raw['done_reason'] != 'length'
        boundaries = discovery['boundaries']
        matched = sum(any(b['startBlockId'] in group for b in boundaries) for group in ref['acceptedStartGroups'])
        intact = 0
        for i, group in enumerate(ref['acceptedStartGroups']):
            ends = ref['acceptedStartGroups'][i+1] if i+1 < len(ref['acceptedStartGroups']) else [ref['terminalEndBlockId']]
            intact += any(b['startBlockId'] in group and b['endContentIndex'] < len(doc['content_stream'])
                          and doc['content_stream'][b['endContentIndex']]['block_id'] in ends for b in boundaries)
        result_path = directory/'discovered-pipeline-r1/result.json'
        calls, returned, linked, violations, copied = 0, [], 0, [], []
        input_tokens, output_tokens = raw['prompt_eval_count'], raw['eval_count']
        extraction_ms = 0
        if result_path.exists():
            run = read(result_path)
            assert run['failure'] is None and run['executionStatus'] == 'complete'
            assert run['boundaries'] == boundaries
            returned, calls = run['rows'], len(run['calls'])
            extraction_ms = sum(c['durationMs'] for c in run['calls'])
            for path in result_path.parent.glob('call-*-actual-ollama-request.json'):
                request = read(path)
                assert all(request[k] == template[k] for k in template if k != 'prompt')
                prefix = request['prompt'].split('【document_start】')[0]
                assert any(prefix == template['prompt'].split('【document_start】')[0].replace('each of the 3 source records', f'each of the {n} source records') for n in (1, 2, 3))
                assert request['prompt'].split('【document_end】')[1] == template['prompt'].split('【document_end】')[1]
            responses = list(result_path.parent.glob('call-*-response.json'))
            assert len(responses) == calls
            for path in responses:
                metadata = read(path)['metadata']
                assert metadata['finishReason'] == 'stop'
                input_tokens += metadata['inputTokens']
                output_tokens += metadata['outputTokens']
            source = '\n'.join(b.get('text', '') for b in doc['content_stream'])
            assert not any(re.search(pattern, source) for pattern in [r'\bFdpl\.', r'\bMbl\.', r'\bFA\s*:'])
            for index, row in enumerate(returned):
                linked += sum(bool(links) for links in row['evidence'].values())
                for field in ref['absentFields']:
                    if row['values'].get(field) is not None:
                        violations.append({'row': index, 'field': field, 'value': row['values'][field]})
                for field, value in row['values'].items():
                    for token in SENTINELS:
                        if str(value) == token and not re.search(r'(?<!\w)'+re.escape(token)+r'(?!\w)', source):
                            copied.append({'row': index, 'field': field, 'value': value})
        item = {'document': ref['name'], 'pages': doc['page_count'], 'ruleStarts': 0,
                'discoveryStatus': discovery['failure'] or 'valid labels', 'selected': len(boundaries),
                'matched': matched, 'expected': len(ref['acceptedStartGroups']), 'extra': len(boundaries)-matched,
                'intactSlices': intact, 'rows': len(returned), 'linkedFields': linked, 'extractionCalls': calls,
                'discoveryMs': discovery['calls'][0]['durationMs'], 'extractionMs': extraction_ms,
                'inputTokens': input_tokens, 'outputTokens': output_tokens,
                'absentFieldViolations': violations, 'literalExampleCopies': copied}
        rows.append(item)
        details.append({'document': ref['name'], 'boundaries': boundaries, 'returnedRows': returned})
    summary = {'rows': rows, 'newCalls': sum(1+r['extractionCalls'] for r in rows),
               'inputTokens': sum(r['inputTokens'] for r in rows), 'outputTokens': sum(r['outputTokens'] for r in rows),
               'validation': 'Frozen files match. All extraction requests preserve original model, options, template, examples and instruction; only source and normal final-batch cardinality vary. No truncated responses.'}
    (ROOT/'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding='utf-8')
    (ROOT/'details.json').write_text(json.dumps(details, indent=2, ensure_ascii=False), encoding='utf-8')
    lines = ['# Transfer to examples/graves — 2026-09-08', '',
             'Completed. All five PDFs were parsed afresh with the available local Docling service. The unchanged Beier rule pipeline finds zero records in every document. A separately authorized single NuExtract Discovery call per document selects generic grave-record openings; the original grouped extraction prompt and examples remain unchanged.', '',
             '| Document | Pages | Discovery openings | Reference openings found | Extra openings | Intact reference slices | Extracted rows | Extraction calls |',
             '|---|---:|---:|---:|---:|---:|---:|---:|']
    for r in rows:
        selected = 'invalid labels' if r['discoveryStatus'] != 'valid labels' else str(r['selected'])
        lines.append(f'| {r["document"]} | {r["pages"]} | {selected} | {r["matched"]}/{r["expected"]} | {r["extra"]} | {r["intactSlices"]} | {r["rows"]} | {r["extractionCalls"]} |')
    lines += ['', 'Discovery references were fixed before inference from source inspection: 20 opening groups, with joint descriptions counted once. Brøndbylund has no individual numbered grave records; Katrinesminde describes A18/A22 jointly and the later cemetery collectively. This is not a count of every grave mentioned. Starts at either the Katrinesminde section heading or its opening paragraph are accepted. Extra subdivisions still count as errors. Labels are validated against real Docling blocks; valid labels do not establish valid semantic boundaries.', '',
              'Only Herredsvejen returns values: IDs 38, 240 and 225. The emitted find_type values Urnegraven and Brandpletgraven do not satisfy the unchanged FA-code definition. The axis SV-NØ belongs to the pyre-support structure K5, not an explicitly identified main KAK grave axis. No emitted field has an evidence link. The unchanged linker also assumes headings start with an integer followed by a period, so Danish Grav/A headings cannot establish its value-to-record binding.', '',
              'No literal copy of the eight tracked distinctive example values was found. With only three emitted rows, this is weak negative evidence, not proof that examples cause no bias. There is no no-example ablation because the user required the prompt to remain unchanged. Discovery errors, Danish language, the Beier-specific schema and the linker assumptions confound any causal claim about examples. No overall extraction accuracy is calculated for this out-of-schema corpus.', '',
              f'Execution: 5 Discovery calls + {sum(r["extractionCalls"] for r in rows)} extraction calls = {summary["newCalls"]} new local NuExtract requests; {summary["inputTokens"]} input and {summary["outputTokens"]} output tokens. No Luna or new OCR model calls. Discovery timing includes first model load; parsing and extraction timing are separate in saved artifacts.', '',
              summary['validation'], '',
              'The fresh parser reports Docling 2.120.3 and parsed_document.v2. Source renderings and parser snapshots are retained. Hvissinge contains corrupted text in some blocks; this test does not separate parser errors from model errors. No production code, original benchmark prompt, examples or source PDF was modified.']
    (ROOT/'report.md').write_text('\n'.join(lines)+'\n', encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    report()
