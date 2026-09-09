"""Audit and summarize the production-executor comparison; run from repository root."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path('artifacts/catalog-lab/examples-transfer-v1')
CODE = Path('prototypes/studio/experiments/catalog')


def read(path):
    return json.loads(path.read_bytes())


def main():
    template = read(ROOT.parent/'beier/desktop-b3-r3/call-001-actual-ollama-request.json')
    summary = []
    for model in ('qwen', 'gemma12'):
        for ref in read(ROOT/'reference.json')['cases']:
            directory = ROOT/ref['name']
            prod_dir = directory/f'prod-{model}-r2'
            batch_dir = directory/f'batch3-{model}-r2'
            prod, batch = read(prod_dir/'result.json'), read(batch_dir/'result.json')
            manifest = read(prod_dir/'manifest.json')
            assert all(hashlib.sha256((CODE/p).read_bytes()).hexdigest() == h for p, h in manifest['hashes'].items())
            assert prod['inputSha256'] == batch['inputSha256'] == hashlib.sha256((directory/'parsed_document.json').read_bytes()).hexdigest()
            assert prod['boundaries'] == batch['boundaries']
            for run_dir in (prod_dir, batch_dir):
                for path in run_dir.glob('call-[0-9][0-9][0-9]-response.json'):
                    assert read(path)['metadata']['finishReason'] != 'length'
            for path in prod_dir.glob('call-*-raw-response.json'):
                raw = read(path)
                assert raw['done'] and raw['done_reason'] != 'length'
            for path in batch_dir.glob('call-*-actual-ollama-request.json'):
                request = read(path)
                assert all(request[k] == template[k] for k in template if k != 'prompt')
                prefix = request['prompt'].split('【document_start】')[0]
                assert any(prefix == template['prompt'].split('【document_start】')[0].replace('each of the 3 source records', f'each of the {n} source records') for n in (1, 2, 3))
                assert request['prompt'].split('【document_end】')[1] == template['prompt'].split('【document_end】')[1]
            for path in prod_dir.glob('call-*-actual-request.json'):
                request = read(path)
                if request['model'].startswith(('qwen', 'gemma')):
                    assert request['options']['temperature'] == 0 and isinstance(request['format'], dict)
                    assert '\nSOURCE DOCUMENT:\n' in request['prompt'] and '\nEND SOURCE DOCUMENT\n' in request['prompt']
            blocks = read(directory/'parsed_document.json')['content_stream']
            source = '\n'.join(b.get('text', '') for b in blocks)
            item = {'model': model, 'document': ref['name'], 'boundaries': len(prod['boundaries']), 'failure': prod.get('failure'),
                    'genericReferenceOverlap': sum(any(b['startBlockId'] in g for b in prod['boundaries']) for g in ref['acceptedStartGroups'])}
            item['genericIntactSlices'] = sum(any(b['startBlockId'] in g and b['endContentIndex'] < len(blocks)
                and blocks[b['endContentIndex']]['block_id'] in (ref['acceptedStartGroups'][i+1] if i+1 < len(ref['acceptedStartGroups']) else [ref['terminalEndBlockId']])
                for b in prod['boundaries']) for i, g in enumerate(ref['acceptedStartGroups']))
            for label, run in [('prod', prod), ('batch', batch)]:
                calls = run['calls']
                item[label] = {'rows': len(run['rows']), 'calls': len(calls),
                               'discoveryCalls': sum(c['phase'] == 'discovery' for c in calls),
                               'seconds': round(sum(c['durationMs'] for c in calls)/1000, 2),
                               'discoverySeconds': round(sum(c['durationMs'] for c in calls if c['phase'] == 'discovery')/1000, 2),
                               'inputTokens': sum((c.get('metadata') or {}).get('inputTokens', 0) or 0 for c in calls),
                               'outputTokens': sum((c.get('metadata') or {}).get('outputTokens', 0) or 0 for c in calls),
                               'populated': sum(v is not None for r in run['rows'] for v in r['values'].values()),
                               'linked': sum(bool(v) for r in run['rows'] for v in r['evidence'].values()),
                               'boundaryRowCountMismatch': bool(run['boundaries']) and len(run['rows']) != len(run['boundaries']),
                               'absentFieldViolations': [{'row': i, 'field': f, 'value': row['values'][f]}
                                                         for i, row in enumerate(run['rows']) for f in ref['absentFields'] if row['values'].get(f) is not None],
                               'literalExampleCopies': [{'row': i, 'field': f, 'value': v} for i, row in enumerate(run['rows']) for f, v in row['values'].items()
                                                        if str(v) in ['Musterdorf', 'Nebenort', 'Westdorf', 'Sandgrube', '9999', '9998', '901', '902']
                                                        and not re.search(r'(?<!\w)'+re.escape(str(v))+r'(?!\w)', source)],
                               'returnedRows': run['rows']}
            summary.append(item)
    (ROOT/'comparison.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    lines = ['# Production Catalog versus frozen batch 3 — 2026-09-08', '',
             'Completed. On this corpus, Qwen is the more selective Discovery option: both models match 17/20 generic reference openings, but Gemma adds 12 extra starts. Gemma Discovery is about 29% faster. The frozen batch implementation loses most returned rows (Qwen 17 to 1; Gemma 29 to 3), so it should not replace production on this evidence. Production itself still returns schema-invalid values and can link semantically unsupported claims. No overall accuracy is inferred from the returned-row counts.', '',
             'The actual createExtractionJobExecutor executes Discovery, extraction and grounding without database writes. Qwen 3.8 27B Q4_K_M and Gemma 4 12B IT QAT Q4_0 run Discovery/grounding on Spark; NuExtract3 Q4_K_M extracts values locally. Each experimental run reuses its paired production boundaries and runs the original run.ts grouped-lexical, batch 3, few-shot, field-aware command.', '',
             '| Model | Document | Starts | Production rows | Batch rows | Discovery calls | Other prod calls | Batch calls | Prod seconds | Batch seconds |',
             '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|']
    for r in summary:
        p, b = r['prod'], r['batch']
        lines.append(f'| {r["model"]} | {r["document"]} | {r["boundaries"]} | {p["rows"]} | {b["rows"]} | {p["discoveryCalls"]} | {p["calls"]-p["discoveryCalls"]} | {b["calls"]} | {p["seconds"]} | {b["seconds"]} |')
    lines += ['', '| Model | Generic openings found / 20 | Extra openings | Intact generic slices | Discovery seconds | Prod populated / linked | Batch populated / linked | Absent-field violations prod / batch |',
              '|---|---:|---:|---:|---:|---:|---:|---:|']
    for model in ('qwen', 'gemma12'):
        selected = [r for r in summary if r['model'] == model]
        overlap = sum(r['genericReferenceOverlap'] for r in selected)
        lines.append(f'| {model} | {overlap}/20 | {sum(r["boundaries"] for r in selected)-overlap} | {sum(r["genericIntactSlices"] for r in selected)} | {sum(r["prod"]["discoverySeconds"] for r in selected):.2f} | '
                     + ' | '.join(f'{sum(r[mode]["populated"] for r in selected)} / {sum(r[mode]["linked"] for r in selected)}' for mode in ('prod','batch'))
                     + f' | {sum(len(r["prod"]["absentFieldViolations"]) for r in selected)} / {sum(len(r["batch"]["absentFieldViolations"]) for r in selected)} |')
    lines += ['', 'These Danish reports do not implement the frozen German Beier schema. Generic grave-heading references are retained only as diagnostic overlap, not as schema-qualified recall. Zero boundaries prevent a downstream Catalog comparison; they do not establish extraction quality or absence of example bias.', '',
              'Transport adaptation: Spark tags have passthrough templates. The harness supplies native role tokens, the production generic wrapper and temperature 0, and Ollama JSON Schema formatting. Production module chunking, schema-derived Discovery instruction, context, labels, validation and correction are used directly. NuExtract production values use the real Studio adapter and its temperature 0.2. This is a comparison of Catalog implementations with pinned models, not a measurement of the currently configured deployment route.', '',
              'Gemma formatting follows [Google documentation](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4) and its [non-thinking prefix](https://ai.google.dev/gemma/docs/capabilities/thinking).', '',
              'The paired Catalog implementations also differ in few-shot examples and lexical versus model grounding: this is not a batch-size-only ablation. Request audits verify the experimental prompt, examples, options and schema are unchanged from the original Beier run, apart from source text and final-batch cardinality. Times are summed request wall times, include model loading, and exclude parsing; reused Discovery is charged only once.', '',
              'Source-reviewed diagnostic: in Herredsvejen, SV-NØ describes the four-post pyre support K5, not the A225 burial pit. The Qwen production run nevertheless gives burial_axis=SV-NØ an evidence link. Its grounding request supplies only anonymous claim values (C1, C2, etc.), without field names or their schema definitions; locating the string cannot validate the field meaning. Brandpletgraven is a grave-type description, not a locality. Danish grave-type strings also violate the frozen FA-code definition. The original batch linker additionally assumes an integer followed by a period at each opening, so Grav/A headings cannot bind returned rows to source records.', '',
              'Revision r1 was a preliminary transport run and is excluded: its generic wrapper omitted source delimiters and used temperature 0.2. Brondbylund completed with no records; Herredsvejen was interrupted. All comparison results above use r2.']
    if not any(r['boundaries'] for r in summary):
        lines += ['', 'Result: both generalists abstain on all five documents with this schema. No downstream extraction or grounding call runs. The experiment cannot rank the two Catalog modes or measure example contamination on these inputs.']
    (ROOT/'comparison.md').write_text('\n'.join(lines)+'\n', encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
