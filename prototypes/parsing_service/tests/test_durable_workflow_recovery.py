"""Real DBOS and native process kills, using the guarded Node-owned fixture.

No application tests connect unless the fixture's administrative target passes
the repository disposable guard. The worker connects as the restricted role.
"""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psycopg
import pytest
from dbos import DBOSClient, WorkflowSerializationFormat

from tests.helpers import catalogue
from tests.helpers.postgres import checked_conninfo

FIXTURE=os.environ.get('DURABLE_RECOVERY_FIXTURE')
pytestmark=[pytest.mark.postgres,pytest.mark.slow,pytest.mark.skipif(not FIXTURE,reason='run durable-recovery.postgres.check.ts')]

CHILD=r'''
import json,os,signal,time
from dataclasses import replace
from pathlib import Path
from dbos import DBOS
from kei_exp.kie.extract.models import EXTRACT_MODELS,DEFAULTS
from kei_exp.workflows import boot,config,durable_extract
from kei_exp.workflows.cli import _redact_dbos_logs
from kei_exp.workflows.cli import redacted
from kei_exp.workflows.coordination import CoordinationPool
key=next(key for key,model in EXTRACT_MODELS.items() if model.adapter=='instruct')
EXTRACT_MODELS[key]=replace(EXTRACT_MODELS[key],url=os.environ['MODEL_URL'])
DEFAULTS.update(fields=key,reasoning=key)
url=json.loads(Path(os.environ['DURABLE_RECOVERY_FIXTURE']).read_text())['worker']
_redact_dbos_logs(url)
original=CoordinationPool.call
counts={}
def fault(pool,routine,*args):
    result=original(pool,routine,*args)
    counts[routine]=counts.get(routine,0)+1
    wanted=os.environ.get('FAULT')
    boundary='publish_snapshot' if wanted=='saved_result' else wanted
    occurrence=1 if wanted in ('saved_result','acknowledge') else 2
    if routine==boundary and counts[routine]==occurrence:
        Path(os.environ['CRASHED']).write_text(wanted)
        os.kill(os.getpid(),signal.SIGKILL)
    return result
CoordinationPool.call=fault
durable_extract.configure(url)
original_plan=durable_extract.plan_next
def diagnosed_plan(*args):
    try:return original_plan(*args)
    except Exception:
        import traceback
        print(redacted(traceback.format_exc(),url),flush=True)
        raise
durable_extract.plan_next=diagnosed_plan
DBOS(config=config.dbos_config(url,'durable-proof',log_level='WARNING'))
boot.set_timestamp(boot.database_clock_ms(url))
DBOS.launch();config.register_queues(polling_interval_sec=.1)
Path(os.environ['SERVING']).touch()
while True:time.sleep(.1)
'''


def until(predicate,timeout=45):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        if result:=predicate():return result
        time.sleep(.05)
    raise AssertionError('durable recovery condition timed out')


@pytest.mark.parametrize('index',range(5))
def test_checkpoint_recovery_across_native_process_death(tmp_path,index):
    fixture=json.loads(Path(FIXTURE).read_text())
    fields=checked_conninfo(fixture['admin'])  # before opening an admin connection
    case=fixture['cases'][index]
    source=tmp_path/'runs'/case['source']['runId']
    catalogue.write({'transcriber':'native','pages':[{'page':1,'units':[{'index':0,
      'segments':['1. Hill.','2. Valley.']}]}]},source,generation=case['source']['generation'])
    (source/'params.json').write_text('{}')
    requests=[]
    class Model(BaseHTTPRequestHandler):
        def log_message(self,*_):pass
        def do_POST(self):
            body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            messages=body['messages']
            counted=sum(len(message['content'].split()) for message in messages)+5
            if self.path=='/tokenize':
                output={'count':counted,'max_model_len':32768}
            else:
                requests.append(body)
                system,user=messages[0]['content'],messages[-1]['content']
                if 'record boundaries' in system:
                    parsed={'starts':['B1','B2'],'end':None}
                elif '### Claims' in user:
                    shape=body['response_format']['json_schema']['schema']
                    parsed={key:{'label':'NONE','attribution':False} for key in shape['properties']}
                else:parsed={'name':'Valley' if 'Valley' in user else 'Hill'}
                output={'choices':[{'message':{'content':json.dumps(parsed)},'finish_reason':'stop'}],
                        'usage':{'prompt_tokens':counted,'completion_tokens':10}}
            raw=json.dumps(output).encode();self.send_response(200);self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    server=ThreadingHTTPServer(('127.0.0.1',0),Model)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    workers=[];logs=[]
    def start(fault):
        serving=tmp_path/f'serving-{len(workers)}'
        log=open(tmp_path/f'worker-{len(workers)}.log','w+');logs.append(log)
        env={**os.environ,'PYTHONPATH':str(Path('/test/src')),'KEI_RUNS':str(tmp_path/'runs'),
             'MODEL_URL':f'http://127.0.0.1:{server.server_port}/v1/chat/completions',
             'FAULT':fault,'CRASHED':str(tmp_path/'crashed'),'SERVING':str(serving)}
        process=subprocess.Popen([sys.executable,'-c',CHILD],env=env,stdout=log,stderr=log)
        workers.append(process)
        until(lambda:serving.exists() or process.poll() is not None)
        if process.poll() is not None:
            log.seek(0);raise AssertionError(log.read())
        return process
    client=None
    try:
        first=start(case['fault'])
        client=DBOSClient(system_database_url=fixture['worker'],dbos_system_schema='kei_dbos',application_name='kei')
        client.enqueue({'workflow_name':'extractDurableV1','queue_name':'kei-extract','application_name':'kei',
          'workflow_id':case['workflow'],'serialization_type':WorkflowSerializationFormat.PORTABLE},
          {'protocol':1,'extraction_id':case['id'],'attempt_id':case['attempt']})
        def crashed_or_ended():
            if first.poll() is not None:return True
            status=client.retrieve_workflow(case['workflow']).get_status()
            if status.status in {'SUCCESS','ERROR'}:
                logs[0].flush();logs[0].seek(0)
                raise AssertionError(f'workflow ended before fault: {status.status} {status.output}\n{logs[0].read()}')
            return False
        until(crashed_or_ended)
        assert first.returncode==-signal.SIGKILL
        assert (tmp_path/'crashed').read_text()==case['fault']
        before=len(requests)
        with psycopg.connect(**fields) as admin:
            saved=admin.execute('SELECT count(*) FROM extraction_runtime.checkpoint WHERE id IN (SELECT id FROM extraction_runtime.capture WHERE "extractionId"=%s)',[case['id']]).fetchone()[0]
            # Exercise a real restart while the crashed process's lease still
            # owns the committed-output/DBOS-ack gap. Other fault cases shorten
            # the lease only to keep the rest of the matrix fast.
            if case['fault']!='commit_output':
                admin.execute('UPDATE extraction_runtime.head SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=%s',[case['id']])
        start('')
        status=until(lambda:(s:=client.retrieve_workflow(case['workflow']).get_status()).status in {'SUCCESS','ERROR'} and s)
        assert status.status=='SUCCESS',status.error
        with psycopg.connect(**fields) as admin:
            head=admin.execute('SELECT acknowledgement,"leaseEpoch","snapshotVersion" FROM extraction_runtime.head WHERE id=%s',[case['id']]).fetchone()
            captures=admin.execute('SELECT count(*),count(o.id) FROM extraction_runtime.capture c LEFT JOIN extraction_runtime.checkpoint o ON o.id=c.id WHERE c."extractionId"=%s',[case['id']]).fetchone()
            snapshot=admin.execute('SELECT values FROM extraction_runtime.snapshot WHERE "extractionId"=%s ORDER BY version DESC LIMIT 1',[case['id']]).fetchone()[0]
        assert head[0]=='COMPLETED' and head[1]>=(1 if case['fault']=='acknowledge' else 2) and head[2]>0
        assert captures[0]==captures[1]==len(requests)
        assert saved<=before and sorted(value['modelValue'] for value in snapshot)==['Hill','Valley']
        if index==4:
            # Execute the new worker-owned cleanup against real DBOS history.
            # The app graph and source references stay until the worker proves
            # all linked native workflows quiescent and deletes their history.
            with psycopg.connect(**fields) as admin:
                admin.execute('DELETE FROM public.extraction WHERE id=%s',[case['id']])
                fence=admin.execute('SELECT fence FROM extraction_runtime.head WHERE id=%s',[case['id']]).fetchone()[0]
            gc_id=f"kei-gc:durable:{case['id']}:{fence}:proof"
            client.enqueue({'workflow_name':'deleteDurableHistoryV1','queue_name':'kei-gc','application_name':'kei',
                'workflow_id':gc_id,'serialization_type':WorkflowSerializationFormat.PORTABLE},
                {'protocol':1,'extraction_id':case['id'],'fence':fence})
            status=until(lambda:(s:=client.retrieve_workflow(gc_id).get_status()).status in {'SUCCESS','ERROR'} and s)
            assert status.status=='SUCCESS',status.error
            assert status.output=={'removed':True}
            assert client.list_workflows(workflow_ids=[case['workflow']],load_input=False,load_output=False)==[]
            with psycopg.connect(**fields) as admin:
                assert admin.execute('SELECT count(*) FROM extraction_runtime.head WHERE id=%s AND deleted',[case['id']]).fetchone()[0]==1
    finally:
        for process in workers:
            if process.poll() is None:process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        for log in logs:log.close()
        if client:client.destroy()
        server.shutdown();server.server_close();thread.join(timeout=5)
