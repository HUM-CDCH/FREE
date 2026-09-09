"""Validate saved experiment contracts independently of model quality."""
import hashlib
import json
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path('artifacts/catalog-lab/beier/models-v1')
CODE = Path(__file__).parent

def read(path):
    return json.loads(path.read_bytes())

class Tables(HTMLParser):
    def __init__(self):
        super().__init__()
        self.width = self.cells = self.tables = 0

    def handle_starttag(self, tag, attrs):
        if tag == 'table':
            self.width = 0
            self.tables += 1
        if tag == 'tr':
            self.cells = 0
        if tag in ('td', 'th'):
            self.cells += 1

    def handle_endtag(self, tag):
        if tag == 'tr':
            self.width = self.width or self.cells
            assert self.cells == self.width, (self.tables, self.cells, self.width)

if __name__ == '__main__':
    for name, digest in read(ROOT.parent/'freeze.json')['codeHashes'].items():
        assert hashlib.sha256((CODE.parent/name).read_bytes().replace(b'\r\n', b'\n')).hexdigest() == digest
    inventory = read(ROOT/'images.json')
    for item in inventory:
        assert hashlib.sha256(Path(item['path']).read_bytes()).hexdigest() == item['sha256']
    for model in ['nanonets', 'navidc', 'hunyuan', 'nemotron']:
        directory = ROOT/f'{model}-desktop2000-r1'
        assert read(directory/'manifest.json')['status'] == 'completed'
        assert len(list(directory.glob('p[123]-*.json'))) == 15
        for item in inventory:
            raw = directory/(item['id']+'.json')
            plain = read(directory/'plain-v2'/raw.name)
            assert plain['rawSha256'] == hashlib.sha256(raw.read_bytes()).hexdigest()
            if model == 'nemotron':
                assert plain['nativeLayout']
    template = read(ROOT.parent/'desktop-b3-r3/call-001-actual-ollama-request.json')
    total = 0
    for directory in sorted(ROOT.glob('*-downstream-*')):
        if not directory.is_dir():
            continue
        run = read(directory/'result.json')
        assert run['failure'] is None
        requests = list(directory.glob('call-*-request.json'))
        responses = list(directory.glob('call-*-response.json'))
        assert len(requests) == len(responses) == len(run['calls'])
        for path in requests:
            request = read(path)
            assert all(request[key] == template[key] for key in ['model', 'raw', 'stream', 'options'])
            prefix = request['prompt'].split('【document_start】')[0]
            assert any(prefix == template['prompt'].split('【document_start】')[0].replace('each of the 3 source records', f'each of the {n} source records') for n in [1, 2, 3])
            assert request['prompt'].split('【document_end】')[1] == template['prompt'].split('【document_end】')[1]
        for path in responses:
            response = read(path)
            assert response['done'] and response['done_reason'] != 'length'
            assert isinstance(json.loads(response['response'])['records'], list)
        total += len(requests)
    assert total == 71
    for model in ['neomme', 'evie']:
        manifest = read(ROOT/f'{model}-r1/manifest.json')
        assert manifest['status'] == 'completed' and len(manifest['forwards']) == 176
        assert manifest['inputSha256'] == hashlib.sha256((ROOT/'retrieval-input.json').read_bytes()).hexdigest()
    summary = read(ROOT/'summary.json')
    assert [len(summary[k]) for k in ['ocr', 'extraction', 'retrieval']] == [9, 10, 3]
    parser = Tables()
    parser.feed((ROOT/'report.html').read_text(encoding='utf-8'))
    result = {'status': 'passed', 'ocrImages': 60, 'downstreamRequests': total,
              'retrievalForwards': 352, 'reportTables': parser.tables,
              'originalFreeze': 'Matches after Windows CRLF normalization.',
              'reportCheck': 'HTML table structure; separate Node check compiles embedded JavaScript.'}
    (ROOT/'validation.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))
