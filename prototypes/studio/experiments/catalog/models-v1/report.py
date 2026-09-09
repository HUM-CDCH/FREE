"""Standalone experiment report with original image/OCR comparison."""
import base64
import html
import hashlib
import json
from pathlib import Path

ROOT = Path('artifacts/catalog-lab/beier/models-v1')

def read(path):
    return json.loads(path.read_bytes())

def table(headers, rows):
    return '<table><thead><tr>' + ''.join('<th>'+html.escape(h)+'</th>' for h in headers) + '</tr></thead><tbody>' + ''.join('<tr>'+''.join('<td>'+html.escape(str(c))+'</td>' for c in row)+'</tr>' for row in rows) + '</tbody></table>'

if __name__ == '__main__':
    ocr_rows, extraction_rows, retrieval_rows, failures = [], [], [], []
    issue_sections, accounting = [], {}
    outputs = {}
    for directory in sorted(ROOT.iterdir()):
        if not directory.is_dir() or directory.name.startswith('.'):
            continue
        manifest = read(directory/'manifest.json') if (directory/'manifest.json').exists() else {}
        if manifest.get('status') == 'failed':
            failures.append([directory.name, manifest.get('failure', '')])
        if (directory/'result.json').exists():
            failure = read(directory/'result.json').get('failure')
            if failure:
                failures.append([directory.name, failure])
            if '-downstream-' in directory.name:
                responses = [read(p) for p in directory.glob('call-*-response.json')]
                accounting[directory.name] = {
                    'batchSize': 3, 'fewShot': True, 'fieldAware': True,
                    'grounder': 'Frozen lexicalCandidates; no separate grounding LLM calls.',
                    'responseCount': len(responses),
                    'inputTokens': sum(r['prompt_eval_count'] for r in responses),
                    'outputTokens': sum(r['eval_count'] for r in responses),
                    'ollamaLoadSeconds': sum(r.get('load_duration', 0) for r in responses)/1e9,
                    'scriptSha256': hashlib.sha256(Path(__file__).with_name('downstream.ts').read_bytes()).hexdigest(),
                    'note': 'Derived from saved execution. Generic scorer metadata defaults are not execution measurements.',
                }
        items = {p.stem: read(p) for p in directory.glob('p[123]-*.json')}
        if items:
            outputs[directory.name] = items
            metrics_path = directory/'plain-v2/ocr-metrics.json'
            if not metrics_path.exists():
                metrics_path = directory/'plain/ocr-metrics.json'
            if not metrics_path.exists():
                metrics_path = directory/'ocr-metrics.json'
            if metrics_path.exists():
                for mode, metric in read(metrics_path).items():
                    if not metric['images']:
                        continue
                    chars = sum(s['characters'] for s in metric['samples'])
                    edits = sum(s['edits'] for s in metric['samples'])
                    protocol = read(directory/'desktop-protocol.json') if (directory/'desktop-protocol.json').exists() else {}
                    limited = [manifest['images'][i]['id'] for i in protocol.get('timeLimitedImageIndexes', [])]
                    limited = [i for i in limited if ('-full' in i) == (mode == 'full')]
                    ocr_rows.append([directory.name, mode, metric['images'], len(metric['parentStartsFound']), ', '.join(map(str, metric['duplicateStarts'])) or '—',
                                     f'{100*edits/chars:.2f}%' if chars else '—', len(metric['samples']),
                                     f'{metric["seconds"]:.1f}', ', '.join(metric['tokenLimitImages']) or '—', ', '.join(limited) or '—'])
        for filename, granularity in [('metrics-all.json', 'anchor originale'), ('metrics-reviewed.json', 'colonna/pagina')]:
            if (directory/filename).exists():
                metric = read(directory/filename)
                corrected_path = ROOT/'reference-corrected'/(directory.name+'.json')
                corrected = read(corrected_path) if corrected_path.exists() else None
                extraction_rows.append([directory.name, f'{metric["correctFields"]}/203', f'{corrected["correctFields"]}/203' if corrected else '—',
                                        f'{metric["supportedCorrectFields"]}/164', f'{corrected["supportedCorrectFields"]}/164' if corrected else '—', granularity,
                                        f'{metric["correctUniqueRecords"]}/{metric["returnedRecords"]}', metric['executedCalls'], f'{metric["measuredWallMs"]/1000:.2f}'])
                issues = (corrected or metric).get('issues', [])
                issue_sections.append('<details><summary>'+html.escape(directory.name)+f' · {len(issues)} differenze</summary><section>'+table(
                    ['Voce','Campo','Atteso','Restituito','Valore corretto','Localizzazione corretta','Evidenza restituita','Evidenza attesa'],
                    [[i['catalog_number'],i['field'],i['expected'],i['actual'],'sì' if i['valueCorrect'] else 'no',
                      'sì' if i['evidenceCorrect'] else 'no',', '.join(i['evidence']),', '.join(i['expectedEvidence'])] for i in issues])+'</section></details>')
        if (directory/'retrieval-metrics-reviewed.json').exists():
            for mode, metric in read(directory/'retrieval-metrics-reviewed.json').items():
                retrieval_rows.append([directory.name, mode, metric['queries'], f'{metric["hitAt1"]:.1%}', f'{metric["hitAt3"]:.1%}', f'{metric["mrr"]:.3f}',
                                       f'{sum(f["seconds"] for f in manifest["forwards"] if f["task"] == "document"):.2f}',
                                       f'{sum(f["seconds"] for f in manifest["forwards"] if f["task"] == "query"):.2f}',
                                       f'{manifest["scoreSeconds"]:.2f}', f'{manifest["loadSeconds"]:.2f}'])
    images = {item['id']: {**item, 'data': 'data:image/png;base64,'+base64.b64encode(Path(item['path']).read_bytes()).decode()}
              for item in read(ROOT/'images.json')}
    data = json.dumps({'outputs': outputs, 'images': images, 'samples': read(Path(__file__).with_name('ocr-samples.json'))}, ensure_ascii=False).replace('<', '\\u003c')
    summary = {'ocr': ocr_rows, 'extraction': extraction_rows, 'retrieval': retrieval_rows, 'failures': failures}
    (ROOT/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    (ROOT/'execution-accounting.json').write_text(json.dumps(accounting, ensure_ascii=False, indent=2), encoding='utf-8')
    correction_note = ''
    if (ROOT/'reference-corrected/local-baseline.json').exists():
        correction_note = '<h2>Correzione del riferimento dopo i run</h2><p class="note">Il controllo sul PDF della voce 228 conferma «Fdpl. 1. Gleinaer Berg». Il riferimento congelato riportava «4.». Sono conservati entrambi i punteggi: la colonna “corretto” applica soltanto questa correzione, senza nuova inferenza. Il riferimento locale storico passa da 202 a 201 valori corretti e da 161 a 160 campi localizzati.</p>'
        if (ROOT/'reference-228-detail.png').exists():
            correction_note += '<details><summary>Controlla il dettaglio originale della voce 228</summary><img alt="PDF: Fdpl. 1. Gleinaer Berg; sotto, W 4,6, con la diversa forma del quattro" src="data:image/png;base64,'+base64.b64encode((ROOT/'reference-228-detail.png').read_bytes()).decode()+'"></details>'
    page = '''<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Beier · Confronto locale dei modelli</title><style>
*{box-sizing:border-box}body{font:16px/1.5 system-ui,sans-serif;color:#182632;background:#f5f3ef;margin:0}main{max-width:1440px;margin:auto;padding:32px}h1{font-size:32px;margin-bottom:8px}h2{margin-top:36px}p{max-width:105ch}table{border-collapse:collapse;background:white;width:100%;font-size:14px}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #ddd}th{background:#e6ecea}section{overflow:auto}.note{background:#fff0ce;padding:16px;border-left:4px solid #ac7200}label{display:inline-block;margin:8px 16px 16px 0}select{font:inherit;padding:8px;max-width:100%}.compare{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start}.compare>div{background:white;padding:12px;min-width:0;max-height:85vh;overflow:auto}img{width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.55 ui-monospace,monospace;margin:0}details{background:white;padding:12px;margin:12px 0}summary{cursor:pointer}small{color:#52606a}@media(max-width:850px){main{padding:16px}.compare{grid-template-columns:1fr}h1{font-size:26px}}
</style><main><h1>Beier · Confronto locale dei modelli</h1>
<p>RTX 4090 · 8 settembre 2026 · 29 voci · 7 campi. Prova diagnostica su un catalogo già noto: nessun holdout cieco e nessuna generalizzazione alla produzione.</p>
<p class="note">Le tre misure hanno ruoli diversi: trascrizione OCR, estrazione dei valori, localizzazione visiva. Un buon ranking non dimostra che una risposta sia semanticamente supportata. Gli anchor originali e le nuove colonne/pagine hanno granularità diverse.</p>
<h2>OCR: pagine intere e colonne</h2><p>Protocollo desktop: lato massimo 2.000 pixel prima del processore nativo, prompt ufficiali, BF16 e generazione deterministica. CER sui soli quattro campioni trascritti dal PDF, con spazi e sillabazione a fine riga normalizzati; rimossi i marcatori Markdown di titoli e corsivo/grassetto. Non è il CER dell'intero documento. Una suite completa ha 3 pagine intere o 12 colonne; 29 inizi attesi.</p><section>''' + table(['Esecuzione','Input','Immagini','Inizi / 29','Inizi duplicati','CER campioni','Campioni / 4','Secondi OCR','Limite token','Limite 600 s'], ocr_rows) + '''</section>
''' + correction_note + '''<h2>Estrazione a sette campi</h2><p>GLiNER conserva gli span nativi. Gli altri risultati usano NuExtract dopo il nuovo OCR, in gruppi di tre e con il linker originale. I tempi qui escludono OCR. NuExtract è stato caricato prima dei run cronometrati; GLiNER registra il caricamento separatamente. GLiNER usa 29 forward dell'encoder per esecuzione, senza chiamate LLM. Nessuna chiamata a Luna.</p><p>Riferimento storico locale: 202/203 valori corretti, 161/164 campi con evidenza, 29 voci, 10 chiamate e 11,045 secondi di estrazione. È il replay locale salvato in verification-v1, non una nuova esecuzione; usa il parser e gli anchor originali. I punteggi corretti per la voce 228 sono indicati sopra.</p><section>''' + table(['Esecuzione','Valori congelato','Valori corretto','Localizzati congelato','Localizzati corretto','Granularità evidenza','Voci uniche / rese','Chiamate LLM','Secondi estrazione'], extraction_rows) + '''</section>
<h2>Differenze dei valori e delle evidenze</h2><p>Le differenze seguenti usano il riferimento corretto, quando disponibile. Una localizzazione corretta può accompagnare un valore errato. La voce 225 conserva un falso asse di sepoltura in tutti i nuovi run che la restituiscono. Un'identità duplicata non conta come voce unica corretta.</p>''' + ''.join(issue_sections) + '''
<h2>Retrieval visivo</h2><p>164 query con numero della voce e descrizione del campo, su 12 colonne candidate fisse. Non contengono altri valori di risposta; le 29 query sul numero di catalogo contengono quindi già il valore come identificatore. È un test di localizzazione. Target controllati sulle immagini prima dell'inferenza. Ogni esecuzione codifica 12 immagini e 164 query; Hit@k richiede almeno una colonna pertinente nei primi k risultati. Tutte le query hanno un target: non è misurata l'astensione. Per NeoMME le due modalità condividono codifica e tempo totale di scoring.</p><section>''' + table(['Esecuzione','Punteggio','Query','Hit@1','Hit@3','MRR','Secondi 12 immagini','Secondi 164 query','Secondi scoring','Secondi caricamento'], retrieval_rows) + '''</section>
<h2>Confronta immagine e trascrizione</h2><label>Modello <select id="run"></select></label><label>Immagine <select id="image"></select></label><p id="timing"></p><div class="compare"><div><img id="source" alt="Ritaglio del PDF originale"></div><div><pre id="ocr"></pre></div></div>
<h2>Campioni controllati sul PDF</h2><div id="samples"></div>
<h2>Tentativi falliti o interrotti</h2><p>Il tentativo Nanonets a 200 DPI ha completato solo la prima pagina intera: 563,7 secondi. Il resto è stato interrotto prima della variante desktop. Non è un'esecuzione completa confrontabile con le suite da 15 immagini.</p>''' + ''.join('<details><summary>'+html.escape(name)+'</summary><pre>'+html.escape(failure)+'</pre></details>' for name, failure in failures) + '''
<p><small>Prompt, checkpoint, versioni, hash, risposte integrali, errori e tempi per immagine rimangono nelle cartelle delle esecuzioni. I download possono avvenire durante l'inferenza: GPU seriale, host non isolato; tempi di caricamento e singole misure non sono benchmark controllati.</small></p>
</main><script>const DATA='''+data+''';
const run=document.getElementById('run'), image=document.getElementById('image');
for(const name of Object.keys(DATA.outputs))run.add(new Option(name,name));
function refreshImages(){const old=image.value;image.replaceChildren();for(const id of Object.keys(DATA.outputs[run.value]).sort())image.add(new Option(id,id));if([...image.options].some(o=>o.value===old))image.value=old;show()}
function show(){const item=DATA.outputs[run.value]?.[image.value];if(!item)return;document.getElementById('source').src=DATA.images[image.value].data;document.getElementById('ocr').textContent=item.text;document.getElementById('timing').textContent=`${item.seconds.toFixed(1)} s · ${item.outputTokens} token · ${(item.peakAllocatedBytes/1e9).toFixed(2)} GB allocati${item.hitTokenLimit?' · LIMITE TOKEN':''}`}
run.addEventListener('change',refreshImages);image.addEventListener('change',show);if(run.options.length)refreshImages();
for(const sample of DATA.samples){const d=document.createElement('details'),s=document.createElement('summary'),p=document.createElement('pre');s.textContent=sample.id+' · '+sample.image;p.textContent=sample.text;d.append(s,p);document.getElementById('samples').append(d)}
</script></html>'''
    (ROOT/'report.html').write_text(page, encoding='utf-8')
    print('Report:', ROOT/'report.html')
