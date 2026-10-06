"""Real DBOS methods against a scripted HTTP model and guarded app controls."""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer

import psycopg
import pytest
import requests
from dbos import DBOSClient,WorkflowSerializationFormat

from kei_exp.kie.passages import load
from tests.helpers import catalogue
from tests.helpers.postgres import checked_conninfo
from tests.test_durable_workflow_recovery import CHILD,until
from tests.test_extract_grounded import honest
from tests.test_unified_catalog import Model

FIXTURE=os.environ.get('DURABLE_LIFECYCLE_FIXTURE')
pytestmark=[pytest.mark.postgres,pytest.mark.slow,pytest.mark.skipif(not FIXTURE,reason='run durable-lifecycle.postgres.check.ts')]


@pytest.mark.parametrize('index',range(12))
def test_four_methods_pause_and_continue_at_saved_boundaries(tmp_path,index):
    fixture=json.loads(Path(FIXTURE).read_text())
    fields=checked_conninfo(fixture['admin'])
    case=fixture['cases'][index]
    source=tmp_path/'runs'/case['source']['runId']
    texts=['31. Eichdorf. Mbl. 1827. FA: G.','32. Birkenau. Mbl. 1828. FA: EF.','33. Coast. Mbl. 1829. FA: G.'] if case['method']=='recipe' else [
        '1. Hill. Material: gold. Gilded. Find: bead (2)','2. Valley. Material: flint.','3. Coast. Material: copper.']
    catalogue.write({'transcriber':'native','pages':[{'page':1,'units':[{'index':0,'segments':texts}]}]},source,generation=case['source']['generation'])
    (source/'params.json').write_text('{}')
    unified=Model(load(source))
    calls=[];blocked=threading.Event();release=threading.Event()
    failed_at=None
    threshold=2 if case['method'] in {'generic','unified'} else 1
    class Provider(BaseHTTPRequestHandler):
        def log_message(self,*_):pass
        def do_POST(self):
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            messages=body['messages'];counted=sum(len(message['content'].split()) for message in messages)+5
            if self.path=='/tokenize':output={'count':counted,'max_model_len':32768}
            else:
                calls.append(body);number=len(calls)
                if number>=threshold and not release.is_set():
                    blocked.set()
                    assert release.wait(45),'fixture provider was never released'
                system,user=messages[0]['content'],messages[-1]['content']
                schema=body['response_format']['json_schema']['schema']
                if case['method']=='recipe':parsed=honest(system,user,schema)
                elif case['method']=='unified':parsed=unified(system,user,schema)
                elif 'record boundaries' in system:parsed={'starts':['B1','B2','B3'],'end':None}
                elif '### Claims' in user:parsed={key:{'label':'NONE','attribution':False} for key in schema['properties']}
                else:parsed={'name':'Valley' if 'Valley' in user else 'Hill'}
                output={'choices':[{'message':{'content':'{' if number==failed_at else json.dumps(parsed)},'finish_reason':'stop'}],
                    'usage':{'prompt_tokens':counted,'completion_tokens':10}}
            raw=json.dumps(output).encode();self.send_response(200);self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    server=ThreadingHTTPServer(('127.0.0.1',0),Provider)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    log=open(tmp_path/'worker.log','w+')
    serving=tmp_path/'serving'
    env={**os.environ,'PYTHONPATH':'/test/src','KEI_RUNS':str(tmp_path/'runs'),'MODEL_URL':f'http://127.0.0.1:{server.server_port}/v1/chat/completions',
        'FAULT':'','CRASHED':str(tmp_path/'crashed'),'SERVING':str(serving),'DURABLE_RECOVERY_FIXTURE':FIXTURE}
    process=subprocess.Popen([sys.executable,'-c',CHILD],env=env,stdout=log,stderr=log)
    client=None
    def control(action=None):
        response=requests.post(fixture['bridge'],json={'id':case['id'],**({'action':action} if action else {})},
            headers={'Authorization':f"Bearer {fixture['token']}"},timeout=15)
        assert response.ok,response.text
        return response.json()
    def enqueue(attempt,workflow):
        client.enqueue({'workflow_name':'extractDurableV1','queue_name':'kei-extract','application_name':'kei',
            'workflow_id':workflow,'serialization_type':WorkflowSerializationFormat.PORTABLE},
            {'protocol':1,'extraction_id':case['id'],'attempt_id':attempt})
    try:
        until(lambda:serving.exists() or process.poll() is not None)
        if process.poll() is not None:log.seek(0);raise AssertionError(log.read())
        client=DBOSClient(system_database_url=fixture['worker'],dbos_system_schema='kei_dbos',application_name='kei')
        enqueue(case['attempt'],case['workflow'])
        assert blocked.wait(45),'no provider call reached the controlled boundary'
        pausing=control('pause')
        assert pausing['state']['status']=='PAUSING'
        assert pausing['state']['counts']['inFlight']>0
        assert control('resume')['state']['pendingResume'] is True
        assert control('editing')['state']['pendingResume'] is False
        release.set()
        ended=until(lambda:(status:=client.retrieve_workflow(case['workflow']).get_status()).status in {'SUCCESS','ERROR'} and status)
        assert ended.status=='SUCCESS',ended.error
        paused=control()
        assert paused['state']['status']=='PAUSED',paused
        assert paused['state']['counts']['inFlight']==0
        assert paused['state']['counts']['saved']>=threshold
        captured={capture['id']:capture['request'] for capture in paused['history']['captures'] if capture['request'] is not None}
        assert control('discard')['state']['pendingSelection'] is None
        resumed=control('resume')
        assert resumed['state']['extractionId']==case['id']
        assert resumed['attempt']['id']!=case['attempt']
        if case['terminal'] in {'stop','failure'}:
            threshold=len(calls)+1;blocked.clear();release.clear()
            if case['terminal']=='failure':failed_at=threshold
        enqueue(resumed['attempt']['id'],resumed['attempt']['workflowId'])
        if case['terminal']=='stop':
            assert blocked.wait(45),'resumed provider call did not reach the Stop boundary'
            stopping=control('stop')
            assert stopping['state']['status']=='STOPPING'
            assert stopping['state']['counts']['inFlight']>0
            release.set()
        elif case['terminal']=='failure':
            assert blocked.wait(45),'resumed provider call did not reach the failure boundary'
            release.set()
        ended=until(lambda:(status:=client.retrieve_workflow(resumed['attempt']['workflowId']).get_status()).status in {'SUCCESS','ERROR'} and status,timeout=60)
        assert ended.status=='SUCCESS',ended.error
        completed=control()
        expected={'stop':'STOPPED','failure':'FAILED','complete':'COMPLETED'}[case['terminal']]
        assert completed['state']['status']==expected,completed
        if case['terminal']=='failure':
            assert completed['history']['failedCalls']
            assert completed['state']['counts']['inFlight']==0
            retry=control('retry')
            enqueue(retry['attempt']['id'],retry['attempt']['workflowId'])
            ended=until(lambda:(status:=client.retrieve_workflow(retry['attempt']['workflowId']).get_status()).status in {'SUCCESS','ERROR'} and status,timeout=60)
            assert ended.status=='SUCCESS',ended.error
            completed=control()
            assert completed['state']['status']=='COMPLETED',completed
            assert completed['history']['failedCalls']
            assert sum(body==calls[failed_at-1] for body in calls)==2
        assert completed['page']['total']>0
        assert completed['state']['counts']['saved']==len(calls)-(1 if failed_at else 0)
        assert all(capture['request']==captured[capture['id']] for capture in completed['history']['captures'] if capture['id'] in captured)
        assert len({capture['id'] for capture in completed['history']['captures']})==len(calls)-(1 if failed_at else 0)
        if case['terminal']=='stop':
            refused=requests.post(fixture['bridge'],json={'id':case['id'],'action':'resume'},
                headers={'Authorization':f"Bearer {fixture['token']}"},timeout=15)
            assert not refused.ok and 'Stopped Extractions cannot resume' in refused.text
        with psycopg.connect(**fields) as admin:
            assert admin.execute('SELECT outcome FROM public.extraction WHERE id=%s',[case['id']]).fetchone()[0] is None
    finally:
        release.set()
        if process.poll() is None:process.terminate()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        log.close()
        if client:client.destroy()
        server.shutdown();server.server_close();thread.join(timeout=5)


@pytest.mark.parametrize('max_width',[2,0])
def test_truncated_discovery_is_saved_and_split_until_complete_or_exhausted(tmp_path,max_width):
    fixture=json.loads(Path(FIXTURE).read_text())
    fields=checked_conninfo(fixture['admin'])
    terminal='truncation' if max_width else 'truncation-exhausted'
    case=next(case for case in fixture['cases'] if case['terminal']==terminal)
    source=tmp_path/'runs'/case['source']['runId']
    texts=[f'{number}. Site{number}. Material: M{number}.' for number in range(1,9)]
    catalogue.write({'transcriber':'native','pages':[{'page':1,'units':[{'index':0,'segments':texts}]}]},
                    source,generation=case['source']['generation'])
    (source/'params.json').write_text('{}')
    model=Model(load(source))
    widths=[];truncated=[]
    class Provider(BaseHTTPRequestHandler):
        def log_message(self,*_):pass
        def do_POST(self):
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            messages=body['messages'];counted=sum(len(message['content'].split()) for message in messages)+5
            if self.path=='/tokenize':output={'count':counted,'max_model_len':32768}
            else:
                system,user=messages[0]['content'],messages[-1]['content']
                schema=body['response_format']['json_schema']['schema']
                discovery=system.startswith('You find where records begin')
                width=len(schema['properties']['places']['items']['prefixItems'][0]['enum']) if discovery else 0
                if discovery:widths.append(width)
                cut=width>max_width
                if cut:truncated.append(body)
                output={'choices':[{'message':{'content':'{' if cut else json.dumps(model(system,user,schema))},
                                   'finish_reason':'length' if cut else 'stop'}],
                        'usage':{'prompt_tokens':counted,'completion_tokens':4096 if cut else 10}}
            raw=json.dumps(output).encode();self.send_response(200);self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    server=ThreadingHTTPServer(('127.0.0.1',0),Provider)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    log=open(tmp_path/'worker.log','w+')
    serving=tmp_path/'serving'
    env={**os.environ,'PYTHONPATH':'/test/src','KEI_RUNS':str(tmp_path/'runs'),
         'MODEL_URL':f'http://127.0.0.1:{server.server_port}/v1/chat/completions','FAULT':'',
         'CRASHED':str(tmp_path/'crashed'),'SERVING':str(serving),'DURABLE_RECOVERY_FIXTURE':FIXTURE}
    process=subprocess.Popen([sys.executable,'-c',CHILD],env=env,stdout=log,stderr=log)
    client=None
    try:
        until(lambda:serving.exists() or process.poll() is not None)
        if process.poll() is not None:log.seek(0);raise AssertionError(log.read())
        client=DBOSClient(system_database_url=fixture['worker'],dbos_system_schema='kei_dbos',application_name='kei')
        client.enqueue({'workflow_name':'extractDurableV1','queue_name':'kei-extract','application_name':'kei',
                        'workflow_id':case['workflow'],'serialization_type':WorkflowSerializationFormat.PORTABLE},
                       {'protocol':1,'extraction_id':case['id'],'attempt_id':case['attempt']})
        ended=until(lambda:(status:=client.retrieve_workflow(case['workflow']).get_status()).status in {'SUCCESS','ERROR'} and status,timeout=90)
        assert ended.status=='SUCCESS',ended.error
        response=requests.post(fixture['bridge'],json={'id':case['id']},
                               headers={'Authorization':f"Bearer {fixture['token']}"},timeout=15)
        assert response.ok,response.text
        completed=response.json()
        assert completed['state']['status']==('COMPLETED' if max_width else 'FAILED'),{
            'failure':completed['history']['attempts'][-1]['failure'],
            'recoverable':[failure.get('recoverable') for failure in completed['history']['failedCalls']],
            'unified':[effective['configuration']['options'].get('unified') for effective in completed['history']['effective']],
            'widths':widths}
        assert widths[0]==8 and max(widths)>2 and 2 in widths
        failures=completed['history']['failedCalls']
        assert len(failures)==len(truncated)>0
        assert all(failure['recoverable'] and failure['attemptId']==case['attempt'] for failure in failures)
        assert len({json.dumps(body,sort_keys=True) for body in truncated})==len(truncated)
        if max_width:
            materials=[value['modelValue'] for value in completed['page']['values'] if value['node']['name']=='material']
            assert sorted(materials)==[f'M{number}' for number in range(1,9)]
        else:
            assert widths.count(1)==8 and len(widths)==15
            assert completed['history']['attempts'][-1]['failure']=={'code':'incomplete_processing'}
            assert completed['state']['counts']['inFlight']==0
        with psycopg.connect(**fields) as admin:
            assert admin.execute('SELECT count(*) FROM extraction_runtime.checkpoint o JOIN extraction_runtime.capture c ON c.id=o.id WHERE c."extractionId"=%s AND EXISTS (SELECT FROM jsonb_array_elements(o.output->\'calls\') call WHERE call->>\'finish\'=\'length\')',[case['id']]).fetchone()[0]==0
            assert admin.execute('SELECT outcome FROM public.extraction WHERE id=%s',[case['id']]).fetchone()[0] is None
    finally:
        if process.poll() is None:process.terminate()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        log.close()
        if client:client.destroy()
        server.shutdown();server.server_close();thread.join(timeout=5)


def test_queued_pause_starts_no_provider_call_and_releases_the_attempt_lane(tmp_path):
    fixture=json.loads(Path(FIXTURE).read_text())
    fields=checked_conninfo(fixture['admin'])
    paused,next_case=fixture['cases'][12:14]
    source=tmp_path/'runs'/next_case['source']['runId']
    catalogue.write({'transcriber':'native','pages':[{'page':1,'units':[{'index':0,'segments':['Hill. Material: gold.']}]}]},source,
        generation=next_case['source']['generation'])
    (source/'params.json').write_text('{}')
    calls=[]
    class Provider(BaseHTTPRequestHandler):
        def log_message(self,*_):pass
        def do_POST(self):
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if self.path=='/tokenize':output={'count':100,'max_model_len':32768}
            else:
                calls.append(body)
                user=body['messages'][-1]['content'];schema=body['response_format']['json_schema']['schema']
                parsed={key:{'label':'NONE','attribution':False} for key in schema['properties']} if '### Claims' in user else {'name':'Hill'}
                output={'choices':[{'message':{'content':json.dumps(parsed)},'finish_reason':'stop'}],
                    'usage':{'prompt_tokens':100,'completion_tokens':10}}
            raw=json.dumps(output).encode();self.send_response(200);self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    server=ThreadingHTTPServer(('127.0.0.1',0),Provider)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    gate=tmp_path/'gates';gate.mkdir()
    hold=r'''
@DBOS.step(name="holdDisposableLaneStep")
def hold_lane_step(number):
    gate=Path(os.environ['TEST_QUEUE_GATES'])
    (gate/f'started-{number}').touch()
    deadline=time.monotonic()+90
    while not (gate/f'release-{number}').exists():
        if time.monotonic()>deadline:raise RuntimeError('disposable lane gate timed out')
        time.sleep(.05)
@DBOS.workflow(name="holdDisposableLane",serialization_type=__import__('dbos').WorkflowSerializationFormat.PORTABLE)
def hold_lane(number):
    hold_lane_step(number)
'''
    child=CHILD.replace("DBOS(config=config.dbos_config",hold+"\nDBOS(config=config.dbos_config")
    serving=tmp_path/'serving';log=open(tmp_path/'worker.log','w+')
    env={**os.environ,'PYTHONPATH':'/test/src','KEI_RUNS':str(tmp_path/'runs'),
        'MODEL_URL':f'http://127.0.0.1:{server.server_port}/v1/chat/completions','TEST_QUEUE_GATES':str(gate),
        'FAULT':'','CRASHED':str(tmp_path/'crashed'),'SERVING':str(serving),'DURABLE_RECOVERY_FIXTURE':FIXTURE}
    process=subprocess.Popen([sys.executable,'-c',child],env=env,stdout=log,stderr=log)
    client=None
    def control(case,action=None):
        response=requests.post(fixture['bridge'],json={'id':case['id'],**({'action':action} if action else {})},
            headers={'Authorization':f"Bearer {fixture['token']}"},timeout=15)
        assert response.ok,response.text
        return response.json()
    def enqueue(name,identity,*args):
        client.enqueue({'workflow_name':name,'queue_name':'kei-extract','application_name':'kei',
            'workflow_id':identity,'serialization_type':WorkflowSerializationFormat.PORTABLE},*args)
    try:
        until(lambda:serving.exists() or process.poll() is not None)
        if process.poll() is not None:log.seek(0);raise AssertionError(log.read())
        client=DBOSClient(system_database_url=fixture['worker'],dbos_system_schema='kei_dbos',application_name='kei')
        # Occupy both real attempt slots. Release only one, so the following
        # Extraction can run only if the paused attempt returns its own slot.
        hold_ids=[f"test-hold:{paused['id']}:{number}" for number in range(2)]
        for number,identity in enumerate(hold_ids):enqueue('holdDisposableLane',identity,number)
        until(lambda:all((gate/f'started-{number}').exists() for number in range(2)))
        enqueue('extractDurableV1',paused['workflow'],{'protocol':1,'extraction_id':paused['id'],'attempt_id':paused['attempt']})
        until(lambda:client.retrieve_workflow(paused['workflow']).get_status().status=='ENQUEUED')
        control(paused,'pause')
        enqueue('extractDurableV1',next_case['workflow'],{'protocol':1,'extraction_id':next_case['id'],'attempt_id':next_case['attempt']})
        assert not calls
        (gate/'release-0').touch()
        ended=until(lambda:(status:=client.retrieve_workflow(paused['workflow']).get_status()).status in {'SUCCESS','ERROR'} and status)
        assert ended.status=='SUCCESS',ended.error
        saved=control(paused)
        assert saved['state']['status']=='PAUSED'
        assert saved['history']['captures']==[]
        ended=until(lambda:(status:=client.retrieve_workflow(next_case['workflow']).get_status()).status in {'SUCCESS','ERROR'} and status)
        assert ended.status=='SUCCESS',ended.error
        assert control(next_case)['state']['status']=='COMPLETED'
        assert calls
        assert client.retrieve_workflow(hold_ids[1]).get_status().status=='PENDING'
        resumed=control(paused,'resume')
        assert resumed['state']['extractionId']==paused['id']
        assert resumed['attempt']['id']!=paused['attempt']
        with psycopg.connect(**fields) as admin:
            assert admin.execute('SELECT count(*) FROM extraction_runtime.capture WHERE "extractionId"=%s',[paused['id']]).fetchone()[0]==0
    finally:
        for number in range(2):(gate/f'release-{number}').touch()
        if process.poll() is None:process.terminate()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        log.close()
        if client:client.destroy()
        server.shutdown();server.server_close();thread.join(timeout=5)
