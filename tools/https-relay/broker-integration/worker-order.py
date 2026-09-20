import json,pathlib,subprocess,os,signal,time,sys,http.client
sys.path.insert(0,'/opt/relay')
from importlib.machinery import SourceFileLoader
MCP=SourceFileLoader('smoke','/opt/relay/mcp-smoke.py').load_module().MCP
root=pathlib.Path('/opt/relay/fixture');pids=json.loads((root/'pids.json').read_text())
pid=pids['worker'];cmd=pathlib.Path(f'/proc/{pid}/cmdline')
if cmd.exists() and cmd.read_bytes():
 assert b'/opt/relay/bin/relay' in cmd.read_bytes() and b'worker' in cmd.read_bytes()
 os.kill(pid,signal.SIGTERM)
p=subprocess.Popen(['ip','netns','exec','relay-worker','/opt/relay/bin/relay','--experimental','--mode','worker','--config',str(root/'worker.json'),'--socket',str(root/'remote/runtime/muxterm/sessiond.sock')],stdin=subprocess.DEVNULL,stdout=(root/'worker-order.log').open('wb'),stderr=subprocess.STDOUT,start_new_session=True)
pids['worker']=p.pid;(root/'pids.json').write_text(json.dumps(pids));time.sleep(.5)
m=MCP();machine='sandbox:local-broker'
w=m.call('create_workspace',dict(machine=machine,name='Worker sequence rejection'))['workspace_id'];m.call('switch_workspace',dict(machine=machine,workspace_id=w));pane=m.call('create_pane',dict(machine=machine))['pane_id'];time.sleep(.5)
path='/tmp/WORKER_ORDER_MUST_NOT_EXECUTE'
c=http.client.HTTPConnection('127.0.0.1',18081);c.request('POST','/__fault',json.dumps(dict(mode='worker-order',marker='WORKER_ORDER_MUST_NOT_EXECUTE')));c.getresponse().read();c.close()
try:m.call('send_input',dict(machine=machine,pane_id=pane,text='echo WRONG > '+path+'\r'))
except RuntimeError:pass
m.close();time.sleep(.5)
c=http.client.HTTPConnection('127.0.0.1',18081);c.request('GET','/__fault');state=json.loads(c.getresponse().read());assert state['held'];c.close()
observed=subprocess.run(['nsenter','-t',str(pids['remote']),'-m','--','test','!','-e',path]);assert observed.returncode==0
print('PASS worker rejected deliberately reordered input (seq+1); shell side-effect file absent:',path)
print('Fault counters:',json.dumps(state))
