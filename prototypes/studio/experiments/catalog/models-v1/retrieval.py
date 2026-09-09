"""Native visual encoders over a fixed inventory; no reference read during encoding."""
import argparse
import hashlib
import importlib.metadata
import json
import os
import sys
import time
import traceback
from pathlib import Path

ROOT = Path('artifacts/catalog-lab/beier/models-v1')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('model', choices=['neomme', 'evie'])
    parser.add_argument('--run', default='r1')
    args = parser.parse_args()
    out = ROOT / f'{args.model}-{args.run}'
    out.mkdir(exist_ok=False)
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['HF_HOME'] = str((ROOT / 'hf-cache').resolve())
    inputs_path = ROOT / 'retrieval-input.json'
    data = json.loads(inputs_path.read_bytes())
    metadata = json.loads((ROOT / 'sources' / args.model / 'metadata.json').read_bytes())
    checkpoint = str(ROOT / 'checkpoints' / args.model)
    manifest = {'model': metadata['id'], 'revision': metadata['sha'],
                'inputSha256': hashlib.sha256(inputs_path.read_bytes()).hexdigest(),
                'codeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'torch': importlib.metadata.version('torch'), 'transformers': importlib.metadata.version('transformers'),
                'attention': 'sdpa', 'precision': 'bfloat16', 'forwards': []}
    try:
        import torch
        from PIL import Image
        torch.manual_seed(0)
        started = time.perf_counter()
        if args.model == 'neomme':
            from transformers import NeoMMEForRetrieval, NeoMMEProcessor
            processor = NeoMMEProcessor.from_pretrained(checkpoint, local_files_only=True)
            model = NeoMMEForRetrieval.from_pretrained(checkpoint, dtype=torch.bfloat16, attn_implementation='sdpa', local_files_only=True).to('cuda').eval()
        else:
            sys.path.insert(0, str((ROOT / 'checkpoints/evie/colpali').resolve()))
            from colpali_engine.models import ColQwen3_5, ColQwen3_5Processor
            model = ColQwen3_5.from_pretrained(checkpoint, dtype=torch.bfloat16, attn_implementation='sdpa', local_files_only=True).to('cuda').eval()
            model.enable_bidirectional_attention()
            model.set_active_head(2048)
            processor = ColQwen3_5Processor.from_pretrained(checkpoint, local_files_only=True)
        torch.cuda.synchronize()
        manifest['loadSeconds'] = time.perf_counter() - started
        embeddings, dense = {}, {}
        for task, items in [('document', data['candidates']), ('query', data['queries'])]:
            embeddings[task], dense[task] = [], []
            for item in items:
                started = time.perf_counter()
                content = Image.open(item['path']).convert('RGB') if task == 'document' else item['text']
                if args.model == 'neomme':
                    message = [{'role': 'user', 'content': [{'type': 'image', 'image': content}] if task == 'document' else content}]
                    batch = processor.apply_chat_template([message], task=task, tokenize=True, return_dict=True, return_tensors='pt', processor_kwargs={'padding': 'longest'}).to('cuda')
                else:
                    batch = (processor.process_images([content]) if task == 'document' else processor.process_queries([content])).to('cuda')
                    model.rope_deltas = None
                with torch.inference_mode():
                    result = model(**batch)
                if args.model == 'neomme':
                    vector = result.embeddings[0][batch['attention_mask'][0].bool()]
                    dense[task].append(result.dense_embeddings[0].cpu().float())
                else:
                    vector = result[0]
                embeddings[task].append(vector.detach().cpu().float())
                torch.cuda.synchronize()
                manifest['forwards'].append({'id': item['id'], 'task': task, 'seconds': time.perf_counter()-started, 'tokens': len(vector)})
                if task == 'document' or len(embeddings[task]) % 25 == 0:
                    print(args.model, task, len(embeddings[task]), flush=True)
        torch.save({'multiVector': embeddings, 'dense': dense}, out / 'embeddings.pt')
        started = time.perf_counter()
        if args.model == 'evie':
            scores = {'late': processor.score(embeddings['query'], embeddings['document'], device='cuda', batch_size=8).tolist()}
        else:
            # Native MeanMaxSim formula on unpadded embeddings; no extra scoring dependency.
            scores = {'late': [[float((q @ d.T).max(dim=-1).values.mean()) for d in embeddings['document']] for q in embeddings['query']]}
            q = torch.nn.functional.normalize(torch.stack(dense['query']), dim=-1)
            d = torch.nn.functional.normalize(torch.stack(dense['document']), dim=-1)
            scores['dense'] = (q @ d.T).tolist()
        manifest['scoreSeconds'] = time.perf_counter() - started
        (out / 'scores.json').write_text(json.dumps(scores), encoding='utf-8')
        manifest['status'] = 'completed'
    except Exception:
        manifest['status'] = 'failed'
        manifest['failure'] = traceback.format_exc()
        raise
    finally:
        (out / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')

if __name__ == '__main__':
    main()
