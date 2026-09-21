import json,pathlib,subprocess,time,http.client,importlib.util
spec=importlib.util.spec_from_file_location('smoke','/home/ken/artifacts/live-mcp.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
def fault(mode):
 c=http.client.HTTPConnection('127.0.0.1',33985);c.request('POST','/__fault',json.dumps({'mode':mode,'marker':'WORKER_ORDER_MUST_NOT_EXECUTE'}));c.getresponse().read();c.close()
subprocess.run(['python3','/home/ken/artifacts/restart-live-worker.py'],check=True)
m=mod.MCP();machine='sandbox:live-local'
w=m.call('create_workspace',dict(machine=machine,name='Worker sequence rejection'))['workspace_id'];m.call('switch_workspace',dict(machine=machine,workspace_id=w));pane=m.call('create_pane',dict(machine=machine))['pane_id'];time.sleep(.5)
path='/tmp/WORKER_ORDER_MUST_NOT_EXECUTE-'+str(time.time_ns())
fault('worker-order')
try:m.call('send_input',dict(machine=machine,pane_id=pane,text='echo WRONG > '+path+'\r'))
except RuntimeError:pass
m.close();time.sleep(.5)
c=http.client.HTTPConnection('127.0.0.1',33985);c.request('GET','/__fault');state=json.loads(c.getresponse().read());assert state['held'];c.close()
assert subprocess.run(['incus','exec','muxterm-sandbox-live-worker','--','test','!','-e',path]).returncode==0
print('PASS worker rejected deliberately reordered input (seq+1); shell side-effect file absent:',path)
print('Fault counters:',json.dumps(state));fault('')
