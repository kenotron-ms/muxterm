#!/usr/bin/env python3
"""Destructive faults only against the owned DTU worker, never a host process.
Run after browser verification, with fault-proxy.py between TLS and broker.
"""
import base64, http.client, importlib.util, json, os, pathlib, signal, socket, ssl, subprocess, time, threading
assert pathlib.Path('/run/systemd/container').exists(), 'DTU required'
root=pathlib.Path('/opt/relay/fixture')
spec=importlib.util.spec_from_file_location('smoke','/opt/relay/mcp-smoke.py');smoke=importlib.util.module_from_spec(spec);spec.loader.exec_module(smoke)
MCP=smoke.MCP
cfg=json.loads((root/'client.json').read_text())
def call_http(path,body=None,token=None):
 conn=http.client.HTTPSConnection('127.0.0.1',context=ssl.create_default_context(),timeout=25)
 conn.request('POST' if body is not None else 'GET',path,json.dumps(body) if body is not None else None,{'Authorization':'Bearer '+(token if token is not None else cfg['token']),'Content-Type':'application/json'})
 res=conn.getresponse();raw=res.read();status=res.status;conn.close()
 try:return status,json.loads(raw)
 except json.JSONDecodeError:return status,None
def fault(mode,marker=''):
 c=http.client.HTTPConnection('127.0.0.1',18081,timeout=5);c.request('POST','/__fault',json.dumps(dict(mode=mode,marker=marker)));res=c.getresponse();res.read();c.close()
def state():
 c=http.client.HTTPConnection('127.0.0.1',18081,timeout=5);c.request('GET','/__fault');r=json.loads(c.getresponse().read());c.close();return r
suffix=str(time.time_ns())
uncertain_path='/tmp/relay-uncertain-'+suffix
machine='sandbox:fixture'
m=MCP();w=m.call('create_workspace',dict(machine=machine,name='Relay fault verification'))['workspace_id']
m.call('switch_workspace',dict(machine=machine,workspace_id=w));pane=m.call('create_pane',dict(machine=machine))['pane_id'];time.sleep(1)
def read(path):return m.call('read_file',dict(machine=machine,path=path))['content']
def send(text):return m.call('send_input',dict(machine=machine,pane_id=pane,text=text+'\r'))
def waitfile(path,text):
 for _ in range(50):
  try:
   if read(path)==text:return
  except RuntimeError:pass
  time.sleep(.1)
 raise AssertionError('remote shell file mismatch')
for mode,marker in [('redeliver','WORKER_DEDUP'),('lost-response','BROKER_DEDUP')]:
 path='/tmp/'+marker+'-'+suffix
 fault(mode,marker);send("printf '"+marker+"\\n' >> "+path)
 waitfile(path,marker+'\n');time.sleep(.5)
 assert read(path)==marker+'\n'
 s=state();assert s['held'],s
 if mode=='redeliver':assert s['duplicates']>=2,s
 else:assert s['hits']>=2,s
 print('PASS',mode,{k:s[k] for k in ('hits','held','duplicates')})
fault('sse-cut');send("printf 'SSE_RECONNECTED\\n' > /tmp/relay-sse")
waitfile('/tmp/relay-sse','SSE_RECONNECTED\n');assert state()['sse_cuts']>=1
print('PASS output SSE disconnect/reconnect with same live daemon connection')
fault('uncertain','UNCERTAIN_INPUT')
# The tool wrapper may perform a post-input lookup on the same connection.
# Keep that lookup from delaying the crash injection until the ACK timeout.
def uncertain_send():
 try:send("printf 'UNCERTAIN_INPUT\\n' >> "+uncertain_path)
 except RuntimeError:pass
sender=threading.Thread(target=uncertain_send)
sender.start()
for _ in range(100):
 if state()['held']:break
 time.sleep(.05)
else:raise AssertionError('worker write/ack crash window was not reached')
# Verify the shell side effect has happened before killing this exact owned
# worker. The remote daemon has a private /tmp mount; content is rechecked via a NEW
# remote MCP connection after restart. No sessiond or shell is killed.
pids=json.loads((root/'pids.json').read_text())
for _ in range(50):
 observed=subprocess.run(['nsenter','--target',str(pids['remote']),'--mount','--','cat',uncertain_path],capture_output=True,text=True)
 if observed.returncode==0:break
 time.sleep(.05)
assert observed.stdout=='UNCERTAIN_INPUT\n'
pid=pids['worker']
cmd=pathlib.Path(f'/proc/{pid}/cmdline').read_bytes()
assert b'/opt/relay/bin/relay' in cmd and b'worker' in cmd and str(root/'worker.json').encode() in cmd
os.kill(pid,signal.SIGKILL)
fault('')
p=subprocess.Popen(['ip','netns','exec','relay-worker','/opt/relay/bin/relay','--experimental','--mode','worker','--config',str(root/'worker.json'),'--socket',str(root/'remote/runtime/muxterm/sessiond.sock')],stdin=subprocess.DEVNULL,stdout=(root/'worker-restarted.log').open('wb'),stderr=subprocess.STDOUT,start_new_session=True)
pids['worker']=p.pid;(root/'pids.json').write_text(json.dumps(pids));time.sleep(1)
sender.join(timeout=30);assert not sender.is_alive()
m.close();m=MCP()
waitfile(uncertain_path,'UNCERTAIN_INPUT\n');time.sleep(1)
assert read(uncertain_path)=='UNCERTAIN_INPUT\n'
print('PASS worker crash after Unix write: fresh epoch, no repeated shell side effect')
assert call_http('/discover',token='invalid')[0]==401
worker=json.loads((root/'worker.json').read_text())
assert call_http('/discover',token=worker['token'])[0]==401
assert call_http('/open',dict(id=os.urandom(24).hex(),host='sandbox:other'))[0]==403
print('PASS role and binding authorization rejects invalid/cross-role/cross-host access')
# A raw client verifies ordered/conflicting input and old-epoch fencing using
# real Unix connections, independent of the higher-level tool wrapper.
id=os.urandom(24).hex();assert call_http('/open',dict(id=id,host=machine))[0]==200
pkt=dict(seq=2,data=base64.b64encode(b'x').decode());assert call_http('/channels/'+id+'/input',pkt)[0]==409
assert call_http('/channels/'+id+'/close',{})[0]==200
pkt['seq']=1;assert call_http('/channels/'+id+'/input',pkt)[0]==410
print('PASS out-of-order input rejected; closed connection cannot receive input')
m.close()
# Broker restart intentionally has no durable recovery: new worker registration
# and fresh client connections are required; old queued input stays fenced.
id=os.urandom(24).hex();assert call_http('/open',dict(id=id,host=machine))[0]==200
pids=json.loads((root/'pids.json').read_text())
for name in ('broker','worker'):
 pid=pids[name];cmd=pathlib.Path(f'/proc/{pid}/cmdline').read_bytes()
 assert b'/opt/relay/bin/relay' in cmd and name.encode() in cmd
 os.kill(pid,signal.SIGKILL)
args=['/opt/relay/bin/relay','--experimental','--mode','broker','--config',str(root/'broker.json')]
p=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=(root/'broker-restarted.log').open('wb'),stderr=subprocess.STDOUT,start_new_session=True);pids['broker']=p.pid;time.sleep(.5)
args=['ip','netns','exec','relay-worker','/opt/relay/bin/relay','--experimental','--mode','worker','--config',str(root/'worker.json'),'--socket',str(root/'remote/runtime/muxterm/sessiond.sock')]
p=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=(root/'worker-restarted-again.log').open('wb'),stderr=subprocess.STDOUT,start_new_session=True);pids['worker']=p.pid;(root/'pids.json').write_text(json.dumps(pids));time.sleep(.5)
assert call_http('/channels/'+id+'/input',dict(seq=1,data=base64.b64encode(b'old input').decode()))[0]==410
m=MCP();assert read(uncertain_path)=='UNCERTAIN_INPUT\n';m.close()
print('PASS broker restart fences old connection; new connection reaches surviving PTY files')

(root/'fault-results.json').write_text(json.dumps(dict(worker_dedup=True,lost_ack=True,sse_reconnect=True,uncertain_crash_no_replay=True,authorization=True,ordered_input=True,broker_restart=True)))
