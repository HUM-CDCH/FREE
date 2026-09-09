"""Save pinned public model metadata and Python sources before loading checkpoints."""
import json
import urllib.request
from pathlib import Path

ROOT = Path('artifacts/catalog-lab/beier/models-v1')
MODELS = {
    'hunyuan': ('tencent/HunyuanOCR', '47644ecc4fc854efa4f505155158831f36773ee4'),
    'evie': ('tencent/EVIE-4.5B', '8aecfa955e5e7d56a251291942f6f0717badb238'),
    'nemotron': ('nvidia/NVIDIA-Nemotron-Parse-2.0', 'b6742064f4a8cf22a10383ece5e7fbead355ac04'),
    'nanonets': ('nanonets/Nanonets-OCR-s', '3baad182cc87c65a1861f0c30357d3467e978172'),
    'navidc': ('StarDoc-AI/NaviDC-OCR', None),
    'neomme': ('Hcompany/NeoMME-260M-Retriever', None),
}

def get(url):
    with urllib.request.urlopen(url, timeout=90) as response:
        return response.read()

if __name__ == '__main__':
    for name, (repo, revision) in MODELS.items():
        out = ROOT / 'sources' / name
        out.mkdir(parents=True, exist_ok=True)
        metadata = out / 'metadata.json'
        if not metadata.exists():
            metadata.write_bytes(get(f'https://huggingface.co/api/models/{repo}/revision/{revision or "main"}'))
        info = json.loads(metadata.read_bytes())
        revision = info['sha']
        for file in info['siblings']:
            filename = file['rfilename']
            if '/' not in filename and filename.endswith(('.py', '.json', '.md')):
                target = out / filename
                if not target.exists():
                    target.write_bytes(get(f'https://huggingface.co/{repo}/resolve/{revision}/{filename}'))
        print(name, revision, [f['rfilename'] for f in info['siblings'] if f['rfilename'].endswith('.py')], flush=True)
