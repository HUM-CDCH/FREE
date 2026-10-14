import re, sys
sys.argv=['probes.py']
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    import probes
from probes import r, context, Path
src = Path('resolution.py').read_text()
OLD = r'rf"(?<!\w)(?<!\d[.,]){re.escape(needle)}(?!\w|[.,]\d)"'
assert OLD in src
NAIVE = r'rf"(?<![\w.\-\u2212])(?<!\d[eE]){re.escape(needle)}(?!\w|[.,]\d)"'
# sign/dot only when it starts the token (not after a word char); exponent after digit+e
SAFE = (r'rf"(?<!\w)(?<!\d[.,])(?<!(?<!\w)[-\u2212+])(?<!(?<!\S)\.)(?<!\d[eE][-\u2212+])'
        r'{re.escape(needle)}(?!\w|[.,]\d)" if needle[0].isdigit() else rf"(?<!\w){re.escape(needle)}(?!\w)"')
def variant(pattern):
    import ast, json
    g = {k: v for k, v in r.items()}
    exec(compile(src.replace('kei_exp.', 'kei_exp.') , 'x', 'exec'), g) if False else None
    ns = dict(r); code = src.replace(OLD, pattern)
    tree = ast.parse(code); tree.body=[n for n in tree.body if not(isinstance(n,ast.ImportFrom) and (n.module or '').startswith('kei_exp.'))]
    exec(compile(tree,'variant','exec'), ns); return ns['_shown']
cases = {
  'review: -10 not 10': ('A cited value was -10.', False),
  'review: \u221210 not 10': ('A cited value was \u221210.', False),
  'review: 1e-10 not 10': ('A cited value was 1e-10.', False),
  'review: .10 not 10': ('A cited value was .10.', False),
  'range pp. 5-10 has 10': ('See pp. 5-10 of the report.', True),
  'range 1990-10 style 3-10 has 10': ('Graves 3-10 were excavated.', True),
  'p.10 has 10': ('As shown on p.10 of the report.', True),
  'baseline: 0.10 not 10': ('A value of 0.10 was cited.', False),
}
for name, shown in [('632206f4', r['_shown']), ('naive fix', variant(NAIVE)), ('range-safe fix', variant(SAFE))]:
    bad = [c for c,(t,want) in cases.items() if ('not printed verbatim' not in shown(10, context(t))) != want]
    text = ' '.join(f'Reference study {i} had -10 degrees. ' + 'Background. ' * 20 for i in range(3)) + 'Our study had 10 degrees.'
    disp = 'Our study had 10 degrees' in shown(10, context(text))
    other = [shown('Smith', context('By Jones-Smith.')), shown(10, context('Cited: 210, 10.5, 1,100. ' + 'Our study had 10 participants.'))]
    print(f'{name:15} wrong on: {bad or "none"}; displacement fixed: {disp}; "Jones-Smith" match kept: {"not printed" not in other[0]}')
