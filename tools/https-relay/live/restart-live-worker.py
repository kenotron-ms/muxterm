import pathlib,json,subprocess,urllib.request,os,time
root=pathlib.Path('/home/ken/artifacts/sandbox-live-private')
client=json.loads((root/'client.json').read_text())
req=urllib.request.Request('http://127.0.0.1:8088/enroll',data=b'{}',headers={'Authorization':'Bearer '+client['token'],'Content-Type':'application/json'})
with urllib.request.urlopen(req) as r:e=json.load(r)
w={'url':'https://10.9.113.136','host':client['host'],'enrollmentToken':e['enrollmentToken']}
fd=os.open(root/'worker.json',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:json.dump(w,f)
subprocess.run(['incus','file','push','-q',str(root/'worker.json'),'muxterm-sandbox-live-worker/opt/relay/worker.json'],check=True)
code='''import json,pathlib,subprocess,os,signal
r=pathlib.Path('/opt/relay');pids=json.loads((r/'pids.json').read_text());pid=pids['agent']
p=pathlib.Path(f'/proc/{pid}/cmdline')
if p.exists() and p.read_bytes():
 assert b'/opt/relay/bin/agent' in p.read_bytes()
 os.kill(pid,signal.SIGTERM)
p=subprocess.Popen([str(r/'bin/agent'),'--config',str(r/'worker.json'),'--socket',str(r/'runtime/muxterm/sessiond.sock')],stdin=subprocess.DEVNULL,stdout=(r/'agent.log').open('ab'),stderr=subprocess.STDOUT,start_new_session=True)
pids['agent']=p.pid;(r/'pids.json').write_text(json.dumps(pids))
print('Fresh worker enrollment and process:',p.pid)
'''
subprocess.run(['incus','exec','muxterm-sandbox-live-worker','--','python3','-c',code],check=True)
time.sleep(.8)
