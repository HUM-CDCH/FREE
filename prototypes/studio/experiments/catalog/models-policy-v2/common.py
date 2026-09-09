"""Small shared artifact primitives; no model or reference loading on import."""
import hashlib
import json
import re
import unicodedata
import importlib.metadata
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[4]
OLD = REPO / 'artifacts/catalog-lab/beier/models-v1'
DEFAULT_ROOT = REPO / 'artifacts/catalog-lab/models-policy-v2'
DOCS = ['beier', 'Herredsvejen_SBM1694', 'Hojbakkegaard_TAK_1177',
        'Hvissinge_Ost_TAK_1728', 'Brondbylund_3_TAK_1506', 'Katrinesminde_SBM1116']
OCR = ['hunyuan', 'nanonets', 'navidc', 'nemotron']
ARMS = ['baseline', *OCR, 'evie', 'neomme', 'gliner']
REVISIONS = {
    'hunyuan': '47644ecc4fc854efa4f505155158831f36773ee4',
    'evie': '8aecfa955e5e7d56a251291942f6f0717badb238',
    'nemotron': 'b6742064f4a8cf22a10383ece5e7fbead355ac04',
    'nanonets': '3baad182cc87c65a1861f0c30357d3467e978172',
    'gliner': 'aaecfe45db1d828c963717054ccb868e8ad1f1d5',
    'navidc': '710ea2e26d794fe89cbf3ece0402707c332a8671',
    'neomme': '0dcb6c924435bd0bf5d504dba9ba2bb63acd8595',
}


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf8') as out:
        json.dump(value, out, ensure_ascii=False, indent=2)


def sha(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def verify(hashes):
    for path, expected in hashes.items():
        if sha(path) != expected:
            raise ValueError(f'Frozen file changed: {path}')


def check_freeze(root):
    frozen = read(Path(root) / 'freeze.json')
    verify({REPO / p: h for p, h in frozen['codeHashes'].items()})
    verify(frozen['inputHashes'])
    return frozen


def current_runtime():
    return {'python': sys.version, 'packages': dict(sorted((d.metadata['Name'].lower(), d.version) for d in importlib.metadata.distributions())),
            'transformersSource': importlib.metadata.distribution('transformers').read_text('direct_url.json')}


def original(doc):
    return (REPO / 'artifacts/catalog-lab/beier' if doc == 'beier' else
            REPO / 'artifacts/catalog-lab/examples-transfer-v1' / doc)


def combinations():
    return [(doc, schema) for doc in DOCS for schema in (['beier'] if doc == 'beier' else ['beier', 'danish'])]


def run_path(root, doc, schema, arm, rep):
    return Path(root) / 'runs' / doc / schema / f'{arm}-r{rep}'


def normalize(value):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', str(value))).casefold().strip()


def bounded_contains(text, value):
    return re.search(r'(?<!\w)' + re.escape(normalize(value)) + r'(?!\w)', normalize(text)) is not None


def overlaps(left, right):
    return left[0] < right[2] and right[0] < left[2] and left[1] < right[3] and right[1] < left[3]


def anchor_text(document):
    blocks = {b['block_id']: b for b in document['content_stream']}
    cells = {c['evidence_anchor_id']: c['text'] for t in document['tables'] for c in t['cells']}
    return {a['anchor_id']: (blocks[a['block_id']].get('text', '\n'.join(blocks[a['block_id']].get('items', [])))
                             if a['kind'] == 'text' else cells.get(a['anchor_id'], ''))
            for a in document['evidence_index']['anchors']}


def checkpoint_path(model):
    return (REPO / 'artifacts/catalog-lab/beier/verification-v1/gliner-checkpoint'
            if model == 'gliner' else OLD / 'checkpoints' / model)
