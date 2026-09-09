"""Run with Python; pure adapter/scoring checks, no model loads or inference."""
import tempfile
from pathlib import Path

from common import DEFAULT_ROOT, check_freeze, read, save, sha
from native import select_spans
from prepare import canonical_ocr
from score import blind_item, score_terminal, timings, report


def main():
    document = read(DEFAULT_ROOT/'inputs/beier/baseline/parsed_document.json')
    image = read(DEFAULT_ROOT/'inputs/beier/images.json')[0]
    converted, markdown = canonical_ocr(document,[image],[{'id':image['id'],'text':'Grav 1\nØ-V','failed':False}], 'check')
    assert markdown == 'Grav 1\nØ-V'
    assert converted['content_stream'][1]['text'] == 'Ø-V'
    assert converted['content_stream'][0]['block_id'] != document['content_stream'][0]['block_id']
    box = converted['evidence_index']['anchors'][1]['producer_observations'][0]['bbox']
    assert abs(box['x0']-image['bboxPt'][0]) < .001 and abs(box['x1']-image['bboxPt'][2]) < .001
    assert converted['arbitration']['localizationGranularity']=='crop'
    invalid = {**image,'bboxPt':[0,0,100000,100000]}
    try: canonical_ocr(document,[invalid],[{'id':image['id'],'text':'x'}],'check')
    except ValueError: pass
    else: raise AssertionError('Out-of-PDF geometry was accepted')
    text='bad 123 123'
    spans=[{'start':0,'end':3,'text':'bad'},{'start':4,'end':7,'text':'123'}, {'start':8,'end':11,'text':'123'}, {'start':-1,'end':3,'text':'bad'}]
    assert select_spans(text,spans,{'type':'integer'}) is None  # Existing first-offset-valid selection, then type validation.
    assert select_spans(text,spans[1:],{'type':'integer'})==123
    assert select_spans(text,spans,{'type':'array'})==['bad','123']
    assert select_spans('123',[{'start':0,'end':3,'text':'321'}],{'type':'integer'}) is None
    anchor=document['evidence_index']['anchors'][0]['anchor_id']
    ref={'205':{'id':'205','fields':{'locality':[{'aliases':['Augsdorf'],'pages':[1],'canonicalAnchorIds':[anchor]}]}}}
    def terminal(rows):
        return {'result':{'records':rows},'diagnostics':{'catalog':{'records':[{'outcome':'succeeded','boundary':{'headingText':'205 Augsdorf'}} for _ in rows]}},'evidence':[]}
    metrics,_,_=score_terminal(terminal([]),document,ref,'beier','beier')
    assert metrics['supportedUnits']==1 and metrics['omittedSupportedUnits']==1 and metrics['missingOutputRecords']==1
    metrics,_,_=score_terminal(terminal([{}, {'locality':'Augsdorf'}]),document,ref,'beier','beier')
    assert metrics['duplicateRecords']==1 and metrics['correctUnits']==0  # Never choose the best duplicate.
    run=terminal([{'locality':'Augsdorf'}])
    run['evidence']=[{'resultPath':['records',0,'locality'],'evidenceAnchorId':anchor}]
    metrics,_,_=score_terminal(run,document,ref,'beier','beier')
    assert metrics['correctUnits']==metrics['supportedLinkUnits']==1
    run['result']['records'][0]['locality']='Elsewhere'
    decision_key,_=blind_item('value','beier','beier','205','locality','Elsewhere')
    metrics,_,pending=score_terminal(run,document,ref,'beier','beier')
    assert metrics['pendingValues']==1 and decision_key in pending and metrics.get('unsupportedClaims',0)==0
    metrics,_,_=score_terminal(run,document,ref,'beier','beier',{decision_key:{'status':'unsupported','reason':'Wrong source locality'}})
    assert metrics['unsupportedClaims']==1 and metrics['linksOnUnsupportedValues']==1 and metrics['supportedLinkUnits']==0
    run=terminal([{'catalog_number':205,'locality':'Augsdorf'}])
    run['diagnostics']['catalog']['records'][0]['boundary']['headingText']='broken heading'
    metrics,_,pending=score_terminal(run,document,ref,'beier','beier')
    assert metrics['discoveryMatched']==0 and metrics['correctUnits']==0
    record_key=next(k for k,v in pending.items() if v['kind']=='record')
    metrics,_,_=score_terminal(run,document,ref,'beier','beier',{record_key:{'record':'205'}})
    assert metrics['discoveryMatched']==1 and metrics['discoveryUnmatched']==0 and metrics['correctUnits']==1
    run=terminal([{'locality':'Augsdorf'}])
    run['diagnostics']['catalog']['records'].insert(0,{'outcome':'failed','boundary':{'headingText':'205 Augsdorf'}})
    assert score_terminal(run,document,ref,'beier','beier')[0]['correctUnits']==0
    cost=timings(DEFAULT_ROOT,DEFAULT_ROOT/'runs/beier/beier/evie-r1',{'arm':'evie','doc':'beier','native':{'inferenceSeconds':2,'imageEncodeSeconds':0,'uncachedImageEncodeSeconds':3}},[])
    assert cost['composedStageMs']==5000 and cost['reusedImageEncodeMs']==3000
    with tempfile.TemporaryDirectory(dir=DEFAULT_ROOT) as temp:
        root=Path(temp).resolve()
        assert root.is_relative_to(DEFAULT_ROOT.resolve())
        sample=root/'input.txt'
        sample.write_text('one')
        save(root/'freeze.json',{'codeHashes':{},'inputHashes':{str(sample):sha(sample)}})
        check_freeze(root)
        sample.write_text('two')
        try: check_freeze(root)
        except ValueError: pass
        else: raise AssertionError('Changed frozen input was accepted')
    with tempfile.TemporaryDirectory(dir=DEFAULT_ROOT) as temp:
        root=Path(temp)
        save(root/'freeze.json',{'codeHashes':{},'inputHashes':{}})
        save(root/'references-v1.json',read(DEFAULT_ROOT/'references-v1.json'))
        for doc in read(DEFAULT_ROOT/'references-v1.json')['documents']:
            save(root/'inputs'/doc/'images.json',[])
        report(root,root/'report')
        assert len(read(root/'report/results.json')['runs'])==176
    print('PASS: crop geometry, immutable anchors, invalid spans, scalar/array selection, vanished coverage, duplicates, blind decisions, freeze mismatch')


if __name__=='__main__': main()
