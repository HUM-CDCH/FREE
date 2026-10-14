"""Isolated probes against hash-verified resolution.py from 632206f4.
External kei_exp imports are replaced with simple fixtures. Not the repo suite.
Run: python probes.py [--baseline]
"""
from __future__ import annotations
import ast
import hashlib
import json
import sys
from pathlib import Path
from copy import deepcopy
from dataclasses import dataclass
from types import SimpleNamespace
import jsonschema
import requests

@dataclass(frozen=True)
class Call:
    stage: str
    record: int | None
    input_tokens: int | None
    output_tokens: int | None
    seconds: float
    finish: str | None
    ok: bool
    error: str | None = None
    counted_input_tokens: int | None = None
    context_tokens: int | None = None
    max_output_tokens: int | None = None
    recovered: bool = False

@dataclass(frozen=True)
class Issue:
    code: str
    detail: str
    record: int | None = None
    path: tuple = ()

@dataclass(frozen=True)
class Passage:
    id: str
    page: int
    index: int
    text: str

@dataclass(frozen=True)
class Context:
    primary: tuple
    overlap: tuple = ()
    heading: object = None
    @property
    def passages(self):
        if self.heading is None:
            return self.overlap + self.primary
        shown={p.id:p for p in (self.heading, *self.overlap, *self.primary)}
        return tuple(sorted(shown.values(),key=lambda p:(p.page,p.index)))

def text_of(passages):
    return '\n\n'.join(p.text.strip() for p in passages)

class Counter:
    context_tokens=100_000
    def request_tokens(self,system,user,schema):
        return 100

class SingleSection(Counter):
    context_tokens=800
    def request_tokens(self,system,user,schema):
        return 100 if len(schema['properties'])==1 else 1000

def complete(chat, **kwargs):
    answer=chat(**kwargs)
    jsonschema.validate(answer,kwargs['schema'])
    return answer,[Call('arbitration',0,None,None,0.,'stop',True)]

BASELINE='--baseline' in sys.argv
p=Path(__file__).with_name('resolution.py')
if BASELINE:
    p=p.parent/'pr267-review'/'resolution.py'
data=p.read_bytes()
blob=hashlib.sha1(f'blob {len(data)}\0'.encode()+data).hexdigest()
assert blob==('e89bb663ca8a313636899afe0aa3ae4efce125d7' if BASELINE else '7dece74fe49c66253e3e01f5f15de41ffcc84908')
tree=ast.parse(data,filename=str(p))
tree.body=[n for n in tree.body if not(isinstance(n,ast.ImportFrom) and (n.module or '').startswith('kei_exp.'))]
r=dict(Call=Call,Issue=Issue,Context=Context,Node=SimpleNamespace,Schema=SimpleNamespace,TokenCounter=Counter,
       complete=complete,text_of=text_of,notes=lambda _:[],
       canonical=lambda x:json.dumps(x,ensure_ascii=False,sort_keys=True,separators=(',',':')))
exec(compile(tree,str(p),'exec'),r)
node=SimpleNamespace(name='items',type='array',children=None)
schema=SimpleNamespace(record_nodes=[node],record_description='One document inventory')
def context(text,page=1):
    return Context((Passage(f'p{page}_s0',page,0,text),))
groups=[context('Document inventory.'),context('More inventory.',2)]

def run_case(values=('urn','urn'), units=(0,1), reply=None, counter=None):
    sources={('items',i):[{'unit':unit,'path':['items',sum(u==unit for u in units[:i])]}] for i,unit in enumerate(units)}
    readings=[{'items':[v for v,u in zip(values,units) if u==unit]} for unit in range(2)]
    root={'items':list(values)}
    repeats=[{'path':['items'],'contexts':[0,1],'indices':[i for i,v in enumerate(values) if v=='urn']}]
    out=r['resolve'](readings,groups,root,[],repeats,[],schema,reply or keep_all,counter or Counter(),item_sources=sources)
    return out,sources

def keep_all(**kw):
    return {key:spec['items']['enum'] for key,spec in kw['schema']['properties'].items()}

def check_numbers():
    shown=r['_shown'](10,context('Cited: 210, 10.5, 1,100. '+'Background. '*50+'Our study had 10 participants.'))
    assert 'Our study had 10 participants' in shown and '210' not in shown

def check_equal_occurrences():
    shown=r['_shown']({'name':'urn'},context('Grave A contained an urn. '+'Background. '*50+'Grave B contained an urn.'))
    assert 'printed 2 times' in shown and 'which one was read is not known' in shown
    assert 'Grave A' in shown and 'Grave B' in shown

def check_null():
    out,sources=run_case(reply=lambda **kw:{key:None for key in kw['schema']['properties']})
    assert out[0]=={'items':['urn','urn']} and out[2] and not out[5] and out[4][0].ok
    assert len(sources)==2

def check_parts(answer,expected_indices):
    values=['urn']+[f'other-{i}' for i in range(1,60)]+['urn']
    seen=[]
    def script(**kw):
        seen.append(kw)
        return {key:answer[key] for key in kw['schema']['properties']}
    out,_=run_case(values,[0]*60+[1],script,SingleSection())
    assert len(seen)==2
    assert ([rpt['indices'] for rpt in out[2]]==[expected_indices] if expected_indices else not out[2])

def check_direct_timeout():
    def timeout(**kw): raise requests.Timeout('SECRET provider detail')
    out,sources=run_case(reply=timeout)
    assert out[0]=={'items':['urn','urn']} and out[2] and len(sources)==2
    assert out[4][0].error=='provider call raised Timeout' and out[4][0].recovered
    assert out[5][0].code=='resolution_failed'

def check_runtime_error():
    class RuntimeChat:
        runtime=object()
        def __call__(self,**kw): raise RuntimeError('save failed')
    try:run_case(reply=RuntimeChat())
    except RuntimeError:pass
    else:raise AssertionError('runtime error swallowed')

def check_boundary():
    class Boundary(BaseException):pass
    def boundary(**kw):raise Boundary()
    try:run_case(reply=boundary)
    except Boundary:pass
    else:raise AssertionError('boundary swallowed')

def check_origin():
    out,sources=run_case(reply=lambda **kw:{'L1':['I2']})
    assert out[0]=={'items':['urn']} and not out[2]
    assert sources=={('items',0):[{'unit':1,'path':['items',0]}]}

tests=[('number boundaries',check_numbers),('ambiguous occurrences',check_equal_occurrences),
       ('schema-valid null abstention',check_null),
       ('cross-part keep all',lambda:check_parts({'L1':[f'I{i}' for i in range(1,61)],'L2':['I1']},[0,60])),
       ('cross-part shift',lambda:check_parts({'L1':['I1']+[f'I{i}' for i in range(3,61)],'L2':['I1']},[0,59])),
       ('cross-part drop later',lambda:check_parts({'L1':[f'I{i}' for i in range(1,61)],'L2':[]},None)),
       ('direct timeout',check_direct_timeout),('runtime exception propagates',check_runtime_error),
       ('control BaseException propagates',check_boundary),('retained occurrence origin',check_origin)]
print('Source blob:',blob)
passed=0
for name,test in tests:
    try:test()
    except Exception as error:print('FAIL:',name,type(error).__name__)
    else:print('PASS:',name);passed+=1
print(f'{passed}/{len(tests)} isolated checks passed')

print('\nAdditional numeric-boundary probes:')
for term in ('-10','−10','1e-10','.10'):
    shown=r['_shown'](10,context('A cited value was '+term+'.'))
    print(repr(term),'->',shown)
print('\nThree sign-mismatched hits preceding the true hit:')
text=' '.join('Reference study '+str(i)+' had -10 degrees. '+'Background. '*20 for i in range(3))+'Our study had 10 degrees.'
shown=r['_shown'](10,context(text))
print(shown)
print('Correct positive occurrence visible:', 'Our study had 10 degrees' in shown)
