"""Fixed-denominator scoring and arm-blind adjudication. Never calls a model."""
import argparse
import copy
import hashlib
import html
import json
import re
import os
from collections import Counter
from pathlib import Path

from common import ARMS, DEFAULT_ROOT, DOCS, HERE, OCR, anchor_text, check_freeze, combinations, normalize, read, run_path, save, sha


def key(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def nonempty(value):
    return value is not None and value != '' and value != []


def heading_id(text, doc, reference):
    if doc == 'beier':
        match = re.match(r'^\s*(\d{3})\b', text)
        ident = match[1] if match else None
    else:
        # Only an unambiguous source heading; never assume row order.
        matches = re.findall(r'\b(?:[Gg]rav\s+(\d+)|A\s*(\d+))\b', text)
        ids = set('Grav '+a if a else 'A'+b for a,b in matches)
        ident = next(iter(ids)) if len(ids) == 1 else None
    return ident if ident in reference else None


def value_matches(value, atoms):
    return [i for i,a in enumerate(atoms) if normalize(value) in {normalize(x) for x in a['aliases']}]


def blind_item(kind, doc, schema, ident, field, value, **extra):
    item = {'kind':kind,'document':doc,'schema':schema,'record':ident,'field':field,'value':value,**extra}
    return key(item), item


def references_for(refs, doc, schema):
    records = copy.deepcopy(refs['documents'][doc]['records'])
    if doc != 'beier' and schema == 'beier':
        # Literal mismatch: no numbered German parent headings, Fdpl./Mbl./FA or KAK chamber statements.
        for row in records:
            row['fields'] = {name:[] for name in refs['documents']['beier']['records'][0]['fields']}
    return {r['id']:r for r in records}


def score_terminal(terminal, document, reference, doc, schema, decisions=None):
    decisions = decisions or {}
    pending, details = {}, []
    rows = (terminal.get('result') or {}).get('records', [])
    catalog = terminal.get('diagnostics',{}).get('catalog') or {}
    discovered = catalog.get('records',[])
    discovered_ids, output_bindings = [], []
    output_index = 0
    for record in discovered:
        heading = record['boundary']['headingText']
        ident = heading_id(heading,doc,reference)
        row = rows[output_index] if record['outcome']=='succeeded' and output_index<len(rows) else {}
        claimed_id = row.get('grave_id') if schema=='danish' else row.get('catalog_number')
        if ident is None:
            review_key,item = blind_item('record',doc,schema,None,None,claimed_id,heading=heading)
            decision = decisions.get(review_key)
            ident = decision.get('record') if decision else None
            if ident is not None and ident not in reference: raise ValueError('Unknown adjudicated record')
            if not decision: pending[review_key] = item
        first = ident in reference and ident not in discovered_ids
        discovered_ids.append(ident)
        if record['outcome']=='succeeded':
            output_bindings.append((ident,first))
            output_index += 1
    discovered_counts = Counter(i for i in discovered_ids if i)
    anchors = {a['anchor_id']:a for a in document['evidence_index']['anchors']}
    texts = anchor_text(document)
    links = {tuple(link['resultPath']):link['evidenceAnchorId'] for link in terminal.get('evidence',[])}
    denominator = sum(len(atoms) for row in reference.values() for atoms in row['fields'].values())
    correct, supported = set(), set()
    record_counts = Counter()
    metrics = Counter(expectedRecords=len(reference),supportedUnits=denominator,outputRecords=len(rows),
        discoveredRecords=len(discovered),discoveryMatched=len(discovered_counts),
        discoveryDuplicates=sum(n-1 for n in discovered_counts.values()),discoveryUnmatched=sum(i is None for i in discovered_ids))
    for index,row in enumerate(rows):
        ident,first = output_bindings[index] if index<len(output_bindings) else (None,False)
        if ident: record_counts[ident] += 1
        metrics['duplicateRecords'] += ident in reference and not first
        metrics['unmatchedRecords'] += ident not in reference
        expected = reference.get(ident,{}).get('fields',{})
        for field,value in row.items():
            values = enumerate(value) if isinstance(value,list) else [(None,value)]
            for array_index,scalar in values:
                if not nonempty(scalar): continue
                metrics['populatedClaims'] += 1
                path = ('records',index,field) + ((array_index,) if array_index is not None else ())
                atom_indexes = value_matches(scalar,expected.get(field,[]))
                review_key,item = blind_item('value',doc,schema,ident,field,scalar)
                decision = decisions.get(review_key)
                status = 'correct' if atom_indexes else 'pending'
                if decision:
                    status = decision['status']
                    atom_indexes = decision.get('matches',atom_indexes)
                    if status == 'correct' and not atom_indexes:
                        raise ValueError('A correct adjudication must identify a shared reference unit (add an extension first)')
                    if any(i < 0 or i >= len(expected.get(field,[])) for i in atom_indexes):
                        raise ValueError('Adjudicated unit index outside shared reference')
                elif not atom_indexes: pending[review_key] = item
                if status == 'correct':
                    metrics['correctClaims'] += 1
                    if first: correct.update((ident,field,i) for i in atom_indexes)
                elif status == 'unsupported': metrics['unsupportedClaims'] += 1
                else: metrics['pendingValues'] += 1
                anchor_id = links.get(path)
                evidence = anchors.get(anchor_id)
                evidence_status = 'absent'
                if anchor_id:
                    metrics['linkedClaims'] += 1
                    if status == 'unsupported':
                        evidence_status = 'unsupported-value'
                        metrics['linksOnUnsupportedValues'] += 1
                    elif evidence is None:
                        evidence_status = 'invalid-anchor'
                        metrics['wrongPassageLinks'] += 1
                    else:
                        passages = [{'page':o['page_number'],'bbox':o['bbox']} for o in evidence['producer_observations']]
                        link_key,link_item = blind_item('link',doc,schema,ident,field,scalar,
                            text=texts.get(anchor_id,''),passages=passages)
                        link_decision = decisions.get(link_key)
                        # Exact source-reviewed Beier passages can be accepted without a new review.
                        exact = status == 'correct' and all(anchor_id in expected[field][i].get('canonicalAnchorIds',[]) for i in atom_indexes)
                        evidence_status = 'supported' if exact else link_decision['status'] if link_decision else 'pending'
                        if evidence_status == 'pending': pending[link_key] = link_item
                        if evidence_status == 'supported' and status == 'correct':
                            metrics['supportedLinks'] += 1
                            if first: supported.update((ident,field,i) for i in atom_indexes)
                        elif evidence_status == 'wrong-record': metrics['wrongRecordLinks'] += 1
                        elif evidence_status in ['wrong-passage','invalid-anchor']: metrics['wrongPassageLinks'] += 1
                        elif evidence_status == 'pending': metrics['pendingLinks'] += 1
                details.append({'recordIndex':index,'record':ident,'field':field,'value':scalar,'valueStatus':status,
                                'unitIndexes':atom_indexes,'linkStatus':evidence_status,'anchorId':anchor_id,
                                'reviewKey':review_key,'firstRecordOccurrence':first})
    metrics['matchedOutputRecords'] = sum(i in reference for i in record_counts)
    metrics['correctUnits'] = len(correct)
    metrics['supportedLinkUnits'] = len(supported)
    metrics['omittedSupportedUnits'] = denominator - len(correct)
    metrics['missingOutputRecords'] = len(reference) - metrics['matchedOutputRecords']
    return dict(metrics), details, pending


def timings(root, path, result, calls):
    fresh = [c for c in calls if c['origin'] == 'fresh']
    ollama = [m for c in fresh for m in c.get('ollamaRequests',[])]
    baseline_calls = read(Path(result['baseline'])/'calls.json') if result.get('baseline') else []
    if not baseline_calls and any(c['origin'] == 'replay' for c in calls):
        baseline_calls = read(path.parent/f'baseline-r{result["repetition"]}'/'calls.json')
    by_hash = {c['requestHash']:c for c in baseline_calls}
    replay_ms = sum(by_hash.get(c['requestHash'],{}).get('durationMs',0) for c in calls if c['origin'] == 'replay')
    native = result.get('native') or {}
    native_ms = native.get('inferenceSeconds',0)*1000
    reused_image_ms = max(0,native.get('uncachedImageEncodeSeconds',0)-native.get('imageEncodeSeconds',0))*1000
    ocr_manifest = path.parents[3]/'inputs'/result['doc']/result['arm']/'manifest.json'
    ocr = read(ocr_manifest) if result['arm'] in OCR and ocr_manifest.exists() else {}
    return {'executorWallMs':result.get('wallMs'),'freshLlmCalls':len(fresh),'freshHttpRequests':len(ollama),
        'freshLlmMs':sum(c['durationMs'] for c in fresh),'replayedCalls':sum(c['origin']=='replay' for c in calls),
        'replayedBaselineMs':replay_ms,'nativeAdapterCalls':sum(c['origin']=='native' for c in calls),
        'nativeStageMs':native_ms,'reusedImageEncodeMs':reused_image_ms,'nativeLoadSeconds':native.get('loadSeconds'),
        'nativeForwards':sum(native.get(k,0) for k in ['encoderForwards','imageForwards','queryForwards']),
        'nativePeakAllocatedBytes':native.get('peakAllocatedBytes'),
        'sampledPeakDeviceMiB':result.get('peakDeviceMemoryMiB'),
        'ollamaLoadMs':sum(m.get('load_duration',0) for m in ollama)/1e6,
        'ollamaWarmInferenceMs':sum(m.get('prompt_eval_duration',0)+m.get('eval_duration',0) for m in ollama)/1e6,
        'missingOllamaTimings':sum('total_duration' not in m for m in ollama),
        'freshInputTokens':sum((c.get('response') or {}).get('metadata',{}).get('inputTokens') or 0 for c in fresh),
        'freshOutputTokens':sum((c.get('response') or {}).get('metadata',{}).get('outputTokens') or 0 for c in fresh),
        'ocrRecordedMs':ocr.get('ocrSeconds',0)*1000,'ocrPreviouslyReused':ocr.get('reused'),
        'composedStageMs':sum(c['durationMs'] for c in fresh)+replay_ms+native_ms+reused_image_ms+ocr.get('ocrSeconds',0)*1000,
        'timingNote':'Composed stage cost includes recorded OCR and baseline replay; not measured end-to-end latency. OCR generation is shared across schemas/repetitions.'}


def retrieval_metrics(root, path, result, calls, claims, reference):
    name=f'{result["doc"]}-{result["schema"]}-r{result["repetition"]}.json'
    task=read(root/'native-inputs'/result['arm']/name)
    rankings=read(root/'native-outputs'/result['arm']/name)['rankings']
    images={i['id']:i for i in task['images']}
    baseline_calls=read(path.parent/f'baseline-r{result["repetition"]}'/'calls.json')
    metrics=Counter()
    for diagnostic in path.glob('retrieval-*.json'):
        index=int(diagnostic.stem.split('-')[1])
        request=next(c['groundingRequest'] for c in baseline_calls if c['index']==index)
        data=read(diagnostic)
        metrics['retainedUnmappedCandidatesAcrossCalls']+=data['unmappedAnchors']
        for label,allowed in data['allowedAnchorIds'].items():
            field=request['claimFields'][label]
            match=re.fullmatch(r'records\[(\d+)\]',field['record'] or '')
            if not match: continue
            claim=next((c for c in claims if c['recordIndex']==int(match[1]) and c['field']==field['field'] and
                        normalize(c['value'])==normalize(request['claims'][label])),None)
            if not claim or claim['valueStatus']!='correct': continue
            top_pages={images[i]['page'] for i in rankings[f'{index}:{label}'][:3]}
            for unit in claim['unitIndexes']:
                atom=reference[claim['record']]['fields'][claim['field']][unit]
                metrics['sourcePageUnits']+=1
                metrics['top3SourcePageHits']+=bool(top_pages.intersection(atom['pages']))
                if atom.get('canonicalAnchorIds'):
                    metrics['sourcePassageUnits']+=1
                    metrics['permittedPassageHits']+=bool(set(allowed).intersection(atom['canonicalAnchorIds']))
    return {**metrics,'scope':'Actual correct proposed claims only. Top-three page recall is separate from permitted canonical passage recall; page-only references cannot establish passage recall.'}


def report(root, out, adjudications=None):
    check_freeze(root)
    refs = read(root/'references-v1.json')
    review = read(adjudications) if adjudications else {'decisions':{},'extensions':[],'reviewer':None}
    for extension in review.get('extensions',[]):
        row = next(r for r in refs['documents'][extension['document']]['records'] if r['id']==extension['record'])
        if 'unit' in extension:
            row['fields'][extension['field']][extension['unit']]['aliases'].extend(extension['aliases'])
        else:
            row['fields'][extension['field']].append(extension['atom'])
    results, queue, bridge = [], {}, {}
    for doc,schema in combinations():
        reference = references_for(refs,doc,schema)
        for rep in [1,2]:
            for arm in ARMS:
                path = run_path(root,doc,schema,arm,rep)
                summary = {'doc':doc,'schema':schema,'arm':arm,'repetition':rep,'outcome':'NOT_RUN'}
                if (path/'result.json').exists():
                    result = read(path/'result.json')
                    terminal = read(path/'terminal.json') if (path/'terminal.json').exists() else read(path/'checkpoint.json') if (path/'checkpoint.json').exists() else {}
                    document = read(root/'inputs'/doc/(arm if arm in OCR else 'baseline')/'parsed_document.json')
                    metrics,details,pending = score_terminal(terminal,document,reference,doc,schema,review['decisions'])
                    summary.update(result,metrics=metrics,claims=details,timings=timings(root,path,result,read(path/'calls.json')))
                    if arm in ['evie','neomme']:
                        summary['retrieval']=retrieval_metrics(root,path,result,read(path/'calls.json'),details,reference)
                    summary['localizationGranularity'] = 'crop' if arm in OCR else 'canonical-block'
                    summary['sourceArtifactHashes'] = {str(p):sha(p) for p in path.glob('*.json')}
                    for claim in details:
                        anchor = next((a for a in document['evidence_index']['anchors'] if a['anchor_id']==claim['anchorId']),None)
                        claim['passages'] = anchor['producer_observations'] if anchor else []
                    for k,v in pending.items():
                        queue[k]=v
                        bridge.setdefault(k,[]).append({'doc':doc,'schema':schema,'arm':arm,'repetition':rep})
                    if doc == 'beier':
                        old = copy.deepcopy(reference)
                        old['228']['fields']['findspot'][0]['aliases']=['4. Gleinaer Berg']
                        summary['originalReferenceMetrics'] = score_terminal(terminal,document,old,doc,schema)[0]
                results.append(summary)
    ocr_stats=[]
    for arm in OCR:
        for doc in DOCS:
            directory=root/'ocr'/arm/doc
            manifest=read(directory/'manifest.json') if (directory/'manifest.json').exists() else {}
            inventory=read(root/'inputs'/doc/'images.json')
            outputs=[read(directory/f'{i["id"]}.json') for i in inventory if (directory/f'{i["id"]}.json').exists()]
            ocr_stats.append({'arm':arm,'document':doc,'expectedImages':len(inventory),'savedImages':len(outputs),
                'emptyImages':sum(not o.get('text','').strip() for o in outputs),
                'failedImages':sum(bool(o.get('failed')) for o in outputs),
                'truncatedImages':sum(bool(o.get('hitTokenLimit') or o.get('timeLimited')) for o in outputs),
                'reused':manifest.get('reused',False),'recordedSeconds':sum(o.get('seconds',0) for o in outputs),
                'currentInferenceSeconds':0 if manifest.get('reused') else sum(o.get('seconds',0) for o in outputs),
                'loadSeconds':manifest.get('loadSeconds'),
                'modelForwards':None if any('modelForwards' not in o for o in outputs) else sum(o['modelForwards'] for o in outputs),
                'peakAllocatedBytes':max((o.get('peakAllocatedBytes',0) for o in outputs),default=None)})
    for r in results:
        if r['arm']=='baseline' or (r['doc']!='beier' and r['schema']=='beier'): continue
        baseline=next(b for b in results if (b['doc'],b['schema'],b['repetition'],b['arm'])==(r['doc'],r['schema'],r['repetition'],'baseline'))
        m,b=r.get('metrics',{}),baseline.get('metrics',{})
        pending_count=sum(m.get(k,0)+b.get(k,0) for k in ['pendingValues','pendingLinks'])
        regressions=[k for k in ['correctUnits','supportedLinkUnits','discoveryMatched'] if m.get(k,0)<b.get(k,0)]
        regressions += [k for k in ['unsupportedClaims','wrongRecordLinks','wrongPassageLinks','linksOnUnsupportedValues','duplicateRecords','missingOutputRecords'] if m.get(k,0)>b.get(k,0)]
        benefit=any(m.get(k,0)>b.get(k,0) for k in ['correctUnits','supportedLinkUnits']) or r.get('timings',{}).get('composedStageMs',float('inf'))<baseline.get('timings',{}).get('composedStageMs',0)
        r['qualification']={'eligible':not queue and not pending_count and not regressions and benefit and all(x['outcome']!='NOT_RUN' for x in results) and r['outcome']=='SUCCEEDED' and baseline['outcome']=='SUCCEEDED',
                            'regressions':regressions,'pendingClaimsIncludingBaseline':pending_count,'measuredBenefit':benefit,
                            'note':'Runtime benefit uses composed measured stage cost, not an observed end-to-end latency.'}
    save(out/'reference-used.json',refs)
    save(out/'results.json',{'freezeSha256':sha(root/'freeze.json'),'referenceSha256':sha(root/'references-v1.json'),
        'adjudicationsSha256':sha(adjudications) if adjudications else None,'reviewer':review['reviewer'],'runs':results,'ocr':ocr_stats})
    save(out/'blind-review.json',{'instructions':'Review against the original PDF, without opening the arm bridge. Decide values: correct + shared unit indexes, or unsupported. Decide links: supported, wrong-record, wrong-passage. Add supported novel units to shared extensions, then rescore every arm.',
        'items':[{'key':k,**queue[k]} for k in sorted(queue)]})
    save(out/'review-arm-bridge.json',bridge)
    lines = ['# Models on policy v1 — results','',f'Planned: 176. Completed executor artifacts: {sum(r["outcome"] != "NOT_RUN" for r in results)}. Pending blind review items: {len(queue)}.',
        '', 'Agent-reviewed references; no independent human validation. Coverage uses a fixed inventory, including omitted records and fields. Pending claims are neither accepted nor called unsupported. A page match alone does not establish passage support.',
        '', 'Danish inputs with the Beier schema are literal schema-mismatch stress tests. Their grave discovery inventory is diagnostic; populated German catalogue fields require review. These runs do not qualify a deployment.',
        '', '| Document / schema | Arm | Rep | Outcome | Discovery | Correct units | Linked units | Unsupported | Wrong links | Pending | Fresh LLM s | Composed s |',
        '|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|']
    for r in results:
        m,t=r.get('metrics',{}),r.get('timings',{})
        lines.append(f'| {r["doc"]} / {r["schema"]} | {r["arm"]} | {r["repetition"]} | {r["outcome"]} | {m.get("discoveryMatched",0)}/{m.get("expectedRecords",len(references_for(refs,r["doc"],r["schema"])))} | {m.get("correctUnits",0)}/{m.get("supportedUnits",0)} | {m.get("supportedLinkUnits",0)}/{m.get("supportedUnits",0)} | {m.get("unsupportedClaims",0)} | {m.get("wrongRecordLinks",0)+m.get("wrongPassageLinks",0)} | {m.get("pendingValues",0)+m.get("pendingLinks",0)} | {t.get("freshLlmMs",0)/1000:.1f} | {t.get("composedStageMs",0)/1000:.1f} |')
    lines += ['', 'Composed seconds add recorded upstream/OCR work and fresh native/model stages; they are not measured end-to-end latency. Native loads and whole-device GPU samples are separate in results.json. OCR boxes localize source crops; canonical boxes localize parser blocks.',
              '', 'No candidate qualifies while required runs or adjudications are missing. After review, compare each intended-use document and repetition with its matching baseline: no loss of correct units or supported-link units; no added unsupported claims, wrong links, missing/duplicate records; at least one measured quality or runtime improvement.']
    with (out/'RESULTS.md').open('x',encoding='utf8') as f: f.write('\n'.join(lines)+'\n')
    cards=[]
    for r in results:
        for claim in r.get('claims',[]):
            if claim['valueStatus']=='correct' and claim['linkStatus']=='supported': continue
            picture=''
            if claim['passages']:
                passage=claim['passages'][0]
                inventory=read(root/'inputs'/r['doc']/'images.json')
                image=next((i for i in inventory if i['page']==passage['page_number'] and i['bboxPt'][0]<=passage['bbox']['x0']<i['bboxPt'][2]),None)
                if image:
                    relative=os.path.relpath(image['path'],out).replace('\\','/')
                    picture=f'<img loading="lazy" style="max-width:100%;max-height:650px" src="{html.escape(relative,quote=True)}" alt="Original PDF page {image["page"]}, source region {html.escape(image["id"])}">'
            cards.append('<article><h2>'+html.escape(f'{r["doc"]} / {r["schema"]} / {r["arm"]} r{r["repetition"]}')+'</h2>'+picture+'<pre>'+html.escape(json.dumps(claim,ensure_ascii=False,indent=2))+'</pre></article>')
    with (out/'errors.html').open('x',encoding='utf8') as f:
        f.write('<!doctype html><html lang="en"><meta charset="utf-8"><title>Policy model error gallery</title><style>body{font:16px system-ui;max-width:1000px;margin:40px auto;padding:20px}article{border-top:1px solid #bbb;padding:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}h2{font-size:18px}</style><h1>Error and pending-review gallery</h1><p>Unreviewed claims are pending, not established model errors. See blind-review.json before opening model labels.</p>'+''.join(cards)+'</html>')
    print('REPORT',out,'runs',sum(r['outcome']!='NOT_RUN' for r in results),'pending',len(queue))


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--root',type=Path,default=DEFAULT_ROOT)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--adjudications',type=Path)
    args=parser.parse_args()
    report(args.root.resolve(),args.out.resolve(),args.adjudications)
