"""Serial native inference using the handoff's pinned loaders and checkpoints."""
import argparse
import importlib.metadata
import os
import sys
import time
import traceback
from pathlib import Path

from common import DEFAULT_ROOT, DOCS, HERE, OCR, OLD, REVISIONS, check_freeze, checkpoint_path, current_runtime, read, save, sha, verify


def setup(root, name):
    freeze = check_freeze(root)
    verify(freeze['nativeHashes'][name])
    if current_runtime() != freeze['runtimes'][name]:
        raise ValueError('Native runtime differs from the frozen environment')
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ['HF_HOME'] = str(OLD / 'hf-cache')
    os.environ['HF_MODULES_CACHE'] = str(OLD / 'hf-cache/modules')
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError('The frozen desktop experiment requires CUDA')
    torch.manual_seed(0)
    return torch, {'model': name, 'revision': REVISIONS[name], 'gpu': torch.cuda.get_device_name(),
                   'runtime': {p: importlib.metadata.version(p) for p in ['torch', 'transformers', 'Pillow']}}


def run_ocr(root, name):
    torch, shared = setup(root, name)
    from PIL import Image
    from transformers import AutoModel, AutoModelForImageTextToText, AutoProcessor
    sys.path.insert(0, str(HERE.parent / 'models-v1'))
    from ocr import PROMPTS
    checkpoint = str(checkpoint_path(name))
    started = time.perf_counter()
    processor = AutoProcessor.from_pretrained(checkpoint, trust_remote_code=name in ('navidc', 'nemotron'), local_files_only=True)
    cls = AutoModel if name in ('navidc', 'nemotron') else AutoModelForImageTextToText
    options = {'torch_dtype': torch.bfloat16, 'trust_remote_code': name in ('navidc', 'nemotron'), 'local_files_only': True}
    if name != 'nemotron':
        options['attn_implementation'] = 'sdpa'
    model = cls.from_pretrained(checkpoint, **options).to('cuda').eval()
    torch.cuda.synchronize()
    shared['loadSeconds'] = time.perf_counter() - started
    shared.update(prompt=PROMPTS[name], longestEdgePixels=2000, maxGenerationSeconds=600,
                  precision='bfloat16', attention='native' if name == 'nemotron' else 'sdpa', reused=False)
    forwards = [0]
    model.register_forward_pre_hook(lambda *_: forwards.__setitem__(0, forwards[0] + 1))
    encoder_forwards = [0]
    if model.config.is_encoder_decoder:
        model.get_encoder().register_forward_pre_hook(lambda *_: encoder_forwards.__setitem__(0, encoder_forwards[0] + 1))
    for doc in DOCS[1:]:
        out = root / 'ocr' / name / doc
        if (out / 'manifest.json').exists():
            verify(read(out / 'manifest.json').get('outputHashes', read(out / 'manifest.json').get('reusedHashes', {})))
            print('EXISTS', name, doc, flush=True)
            continue
        out.mkdir(parents=True, exist_ok=True)
        images = read(root / 'inputs' / doc / 'images.json')
        # A process interruption may leave complete image outputs; immutable inputs are checked before resuming.
        input_hash = sha(root / 'inputs' / doc / 'images.json')
        if (out / 'input.json').exists():
            if read(out / 'input.json')['sha256'] != input_hash:
                raise ValueError('Cannot resume OCR on changed input')
        else:
            save(out / 'input.json', {'sha256': input_hash, 'model': name, 'revision': REVISIONS[name]})
        failures = 0
        for image_info in images:
            output = out / f'{image_info["id"]}.json'
            if sha(image_info['path']) != image_info['sha256']:
                raise ValueError('OCR source image changed')
            if output.exists():
                if read(output).get('imageSha256') != image_info['sha256']:
                    raise ValueError('Saved OCR belongs to a different image')
                failures += bool(read(output).get('failed'))
                continue
            started = time.perf_counter()
            before = forwards[0]
            encoder_before = encoder_forwards[0]
            result = {'id': image_info['id'], 'imageSha256': image_info['sha256'], 'text': '', 'failed': False}
            try:
                torch.cuda.reset_peak_memory_stats()
                image = Image.open(image_info['path']).convert('RGB')
                image.thumbnail((2000, 2000), Image.Resampling.LANCZOS)
                if name == 'nemotron':
                    inputs = processor(images=[image], text=PROMPTS[name], return_tensors='pt', add_special_tokens=False)
                else:
                    messages = [{'role': 'user', 'content': [{'type': 'image'}, {'type': 'text', 'text': PROMPTS[name]}]}]
                    if name in ('nanonets', 'navidc'):
                        messages.insert(0, {'role': 'system', 'content': 'You are a helpful assistant.'})
                    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
                    inputs = processor(text=[text], images=[image], return_tensors='pt', padding=True)
                inputs = inputs.to(model.device)
                generation = {'max_new_tokens': 9000 if name == 'nemotron' else 15000, 'do_sample': False, 'max_time': 600}
                if name == 'hunyuan':
                    generation['repetition_penalty'] = 1.08
                print('OCR START', name, doc, image_info['id'], flush=True)
                begin = time.perf_counter()
                with torch.inference_mode():
                    tokens = model.generate(**inputs, **generation)
                generated = tokens if name == 'nemotron' else tokens[:, inputs['input_ids'].shape[1]:]
                torch.cuda.synchronize()
                generation_seconds = time.perf_counter() - begin
                result.update(text=processor.batch_decode(generated, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0],
                              outputTokens=generated.shape[1], tokenLimit=generation['max_new_tokens'],
                              hitTokenLimit=generated.shape[1] >= generation['max_new_tokens'],
                              timeLimited=generation_seconds >= 600, generationSeconds=generation_seconds)
            except Exception:
                result.update(failed=True, error=traceback.format_exc())
                failures += 1
                torch.cuda.empty_cache()
            result.update(seconds=time.perf_counter() - started, modelForwards=forwards[0] - before,
                          encoderForwards=encoder_forwards[0] - encoder_before,
                          generationCalls=1, peakAllocatedBytes=torch.cuda.max_memory_allocated(), peakReservedBytes=torch.cuda.max_memory_reserved())
            save(output, result)
            print('OCR END', name, doc, image_info['id'], round(result['seconds'], 2), 'FAILED' if result['failed'] else 'saved', flush=True)
        save(out / 'manifest.json', {**shared, 'images': images, 'inputSha256': input_hash,
                                     'status': 'completed_with_failures' if failures else 'completed', 'failedImages': failures,
                                     'outputHashes': {str(out / f'{i["id"]}.json'):sha(out / f'{i["id"]}.json') for i in images}})


def valid_spans(text, spans):
    return sorted([s for s in spans if type(s.get('start')) is int and type(s.get('end')) is int
                   and 0 <= s['start'] < s['end'] <= len(text) and text[s['start']:s['end']] == s.get('text')], key=lambda s: s['start'])


def select_spans(text, spans, node):
    import re
    valid = valid_spans(text, spans)
    if node['type'] == 'array':
        return list(dict.fromkeys(s['text'].strip() for s in valid if s['text'].strip()))
    if not valid:
        return None
    value = valid[0]['text'].strip()
    if node['type'] == 'integer':
        return int(value.rstrip('.')) if re.fullmatch(r'\d+\.?', value) else None
    return value if value and (not node.get('allowedValues') or value in node['allowedValues']) else None


def run_gliner(root, repetition):
    torch, shared = setup(root, 'gliner')
    from gliner2 import AutoExtractor
    sys.path.insert(0, str(HERE.parent / 'models-v1'))
    from gliner import DESCRIPTIONS
    started = time.perf_counter()
    model = AutoExtractor.from_pretrained(str(checkpoint_path('gliner')), map_location='cuda').eval()
    torch.cuda.synchronize()
    shared.update(loadSeconds=time.perf_counter() - started, precision='float32', gliner2=importlib.metadata.version('gliner2'))
    forwards = [0]
    model.encoder.register_forward_pre_hook(lambda *_: forwards.__setitem__(0, forwards[0] + 1))
    for path in sorted((root / 'native-inputs/gliner').glob(f'*-r{repetition}.json'),reverse=repetition==2):
        output = root / 'native-outputs/gliner' / path.name
        if output.exists():
            if read(output)['inputHash'] != sha(path):
                raise ValueError('Native input changed')
            continue
        task = read(path)
        descriptions = {n['name']: n.get('description') or DESCRIPTIONS.get(n['name'], n['name']) for n in task['fields']}
        schema = model.create_schema().entities(descriptions)
        records, spans = {}, {}
        started = time.perf_counter()
        before = forwards[0]
        torch.cuda.reset_peak_memory_stats()
        for record in task['records']:
            text = record['text']
            try:
                tokens = len(model.processor.tokenizer.encode(text, add_special_tokens=False))
                overhead = len(model.processor.tokenizer.encode(str(descriptions), add_special_tokens=False))
                if tokens + overhead + 128 > model.config.max_len:
                    raise ValueError(f'Context exceeds model limit: {tokens}+{overhead}+128 > {model.config.max_len}')
                with torch.inference_mode():
                    raw = model.extract(text, schema, include_spans=True, include_confidence=True)
                torch.cuda.synchronize()
                spans[record['id']] = raw
                records[record['id']] = {'values': {n['name']: select_spans(text, raw.get('entities', {}).get(n['name'], []), n) for n in task['fields']}}
            except Exception:
                records[record['id']] = {'values': {}, 'error': traceback.format_exc()}
        save(output, {'inputHash': sha(path), 'records': records, 'nativeSpans': spans,
                      'measurements': {**shared, 'inferenceSeconds': time.perf_counter() - started,
                                       'encoderForwards': forwards[0] - before, 'peakAllocatedBytes': torch.cuda.max_memory_allocated(),
                                       'failedRecords': sum('error' in r for r in records.values())}})
        print('GLINER', task['id'], len(records), 'records', forwards[0] - before, 'forwards', flush=True)


def run_retrieval(root, name, repetition):
    torch, shared = setup(root, name)
    from PIL import Image
    from transformers import NeoMMEForRetrieval, NeoMMEProcessor
    checkpoint = str(checkpoint_path(name))
    started = time.perf_counter()
    if name == 'neomme':
        processor = NeoMMEProcessor.from_pretrained(checkpoint, local_files_only=True)
        model = NeoMMEForRetrieval.from_pretrained(checkpoint, dtype=torch.bfloat16, attn_implementation='sdpa', local_files_only=True).to('cuda').eval()
    else:
        sys.path.insert(0, str(checkpoint_path(name) / 'colpali'))
        from colpali_engine.models import ColQwen3_5, ColQwen3_5Processor
        model = ColQwen3_5.from_pretrained(checkpoint, dtype=torch.bfloat16, attn_implementation='sdpa', local_files_only=True).to('cuda').eval()
        model.enable_bidirectional_attention()
        model.set_active_head(2048)
        processor = ColQwen3_5Processor.from_pretrained(checkpoint, local_files_only=True)
    torch.cuda.synchronize()
    shared.update(loadSeconds=time.perf_counter() - started, precision='bfloat16', ranking='multi-vector', attention='sdpa')
    image_cache = {}

    def encode(content, task):
        if name == 'neomme':
            message = [{'role': 'user', 'content': [{'type': 'image', 'image': content}] if task == 'document' else content}]
            batch = processor.apply_chat_template([message], task=task, tokenize=True, return_dict=True, return_tensors='pt', processor_kwargs={'padding': 'longest'}).to('cuda')
        else:
            batch = (processor.process_images([content]) if task == 'document' else processor.process_queries([content])).to('cuda')
            model.rope_deltas = None
        with torch.inference_mode():
            result = model(**batch)
        vector = result.embeddings[0][batch['attention_mask'][0].bool()] if name == 'neomme' else result[0]
        dense = result.dense_embeddings[0].detach().cpu().float() if name == 'neomme' else None
        torch.cuda.synchronize()
        return vector.detach().cpu().float(), dense

    for path in sorted((root / 'native-inputs' / name).glob(f'*-r{repetition}.json'),reverse=repetition==2):
        output = root / 'native-outputs' / name / path.name
        if output.exists():
            if read(output)['inputHash'] != sha(path):
                raise ValueError('Native input changed')
            continue
        task = read(path)
        if not task['queries']:
            save(output, {'inputHash':sha(path), 'rankings':{}, 'scores':{}, 'denseScores':{},
                          'measurements':{**shared, 'inferenceSeconds':0, 'imageForwards':0, 'queryForwards':0,
                                          'status':'not_required_no_populated_claims'}})
            continue
        started = time.perf_counter()
        torch.cuda.reset_peak_memory_stats()
        image_seconds, image_forwards = 0, 0
        inventory_hash = tuple((i['id'], i['sha256']) for i in task['images'])
        if inventory_hash not in image_cache:
            begin = time.perf_counter()
            vectors, dense = [], []
            for image in task['images']:
                if sha(image['path']) != image['sha256']:
                    raise ValueError('Retrieval image changed')
                vector, dense_vector = encode(Image.open(image['path']).convert('RGB'), 'document')
                vectors.append(vector)
                dense.append(dense_vector)
                image_forwards += 1
            image_seconds = time.perf_counter() - begin
            image_cache[inventory_hash] = (vectors, dense, image_seconds)
            embedding_path = root / 'native-outputs' / name / f'{task["document"]}-images.pt'
            embedding_path.parent.mkdir(parents=True, exist_ok=True)
            if not embedding_path.exists():
                torch.save({'vectors': vectors, 'dense': dense, 'inventory': inventory_hash}, embedding_path)
        vectors, dense, uncached_seconds = image_cache[inventory_hash]
        rankings, scores, dense_scores = {}, {}, {}
        query_seconds, score_seconds = 0, 0
        for query in task['queries']:
            begin = time.perf_counter()
            vector, dense_vector = encode(query['text'], 'query')
            query_seconds += time.perf_counter() - begin
            begin = time.perf_counter()
            if name == 'evie':
                values = processor.score([vector], vectors, device='cuda', batch_size=8).tolist()[0]
            else:
                values = [float((vector @ v.T).max(dim=-1).values.mean()) for v in vectors]
                dense_scores[query['id']] = (torch.nn.functional.normalize(dense_vector, dim=0) @ torch.nn.functional.normalize(torch.stack(dense), dim=-1).T).tolist()
            scores[query['id']] = values
            rankings[query['id']] = [task['images'][i]['id'] for i in sorted(range(len(values)), key=lambda i: (-values[i], task['images'][i]['id']))]
            score_seconds += time.perf_counter() - begin
        save(output, {'inputHash': sha(path), 'rankings': rankings, 'scores': scores, 'denseScores': dense_scores,
                      'measurements': {**shared, 'inferenceSeconds': time.perf_counter() - started,
                                       'imageEncodeSeconds': image_seconds, 'uncachedImageEncodeSeconds': uncached_seconds,
                                       'queryEncodeSeconds': query_seconds, 'scoreSeconds': score_seconds,
                                       'imageForwards': image_forwards, 'queryForwards': len(task['queries']),
                                       'peakAllocatedBytes': torch.cuda.max_memory_allocated()}})
        print('RETRIEVAL', name, task['id'], len(task['queries']), 'queries', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--model', choices=[*OCR, 'evie', 'neomme', 'gliner'], required=True)
    parser.add_argument('--repetition', type=int, choices=[1,2])
    args = parser.parse_args()
    if args.model in OCR:
        run_ocr(args.root.resolve(), args.model)
    elif args.model == 'gliner':
        if args.repetition is None: parser.error('--repetition is required for native extraction')
        run_gliner(args.root.resolve(), args.repetition)
    else:
        if args.repetition is None: parser.error('--repetition is required for retrieval')
        run_retrieval(args.root.resolve(), args.model, args.repetition)
