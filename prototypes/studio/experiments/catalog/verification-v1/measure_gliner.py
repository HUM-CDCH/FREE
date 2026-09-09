"""Audit encoder forwards: GLiNER's inference API bypasses the top-level forward method."""
import sys
from pathlib import Path
import run as experiment

original_load = experiment.load_gliner
original_extract = experiment.gliner
current = [None]
forwards = []


def load(path):
    model = original_load(path)
    model.encoder.register_forward_pre_hook(lambda _model, _args: forwards.append(current[0]))
    return model


def extract(model, claim, out, index):
    current[0] = claim['catalog_number']
    return original_extract(model, claim, out, index)


experiment.load_gliner = load
experiment.gliner = extract
experiment.main()
input_dir = Path(sys.argv[sys.argv.index('--input-dir') + 1])
repetition = sys.argv[sys.argv.index('--repetition') + 1]
if not forwards or None in forwards:
    raise RuntimeError('Encoder forward measurement did not capture each inference')
experiment.save(input_dir / f'gliner-r{repetition}' / 'encoder-forwards.json', {
    'wrapperSha256': experiment.sha(__file__), 'count': len(forwards), 'catalogNumbers': forwards,
    'note': 'Actual encoder forward pre-hooks; supersedes the ineffective top-level counter in decisions.json.'})
