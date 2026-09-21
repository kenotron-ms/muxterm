import pathlib,json,subprocess,os,signal,time,base64
root=pathlib.Path('/home/ken/artifacts/sandbox-live-private');pid=int((root/'broker.pid').read_text())
proc=pathlib.Path(f'/proc/{pid}/cmdline')
if proc.exists() and proc.read_bytes():
 assert pathlib.Path(f'/proc/{pid}/cwd').resolve()==pathlib.Path('/home/ken/work/sandbox-broker-live')
 assert b'uvicorn' in proc.read_bytes()
 os.kill(pid,signal.SIGTERM)
 deadline=time.monotonic()+45
 while proc.exists() and proc.read_bytes():
  if time.monotonic()>deadline:raise RuntimeError('owned broker did not exit; refusing concurrent launch')
  time.sleep(.1)
token=json.loads((root/'client.json').read_text())['token'];s=token.split('.')[1];c=json.loads(base64.urlsafe_b64decode(s+'='*(-len(s)%4)))
env=dict(os.environ,SANDBOX_BROKER_DATA_DIR=str(root/".amplifier-sandbox-broker"),SANDBOX_BROKER_RELAY_CONFIG=str(root/'broker.json'),AMPLIFIER_SANDBOX_BROKER_ENTRA_TENANT_ID=c['tid'],AMPLIFIER_SANDBOX_BROKER_ENTRA_AUDIENCE=c['aud'])
env.pop('SANDBOX_BROKER_LOCAL_RELAY_CONFIG',None)
p=subprocess.Popen(['/home/ken/workspace/sandboxes/.venv/bin/python','-m','uvicorn','broker.app:default_app','--host','127.0.0.1','--port','8088','--timeout-graceful-shutdown','5','--app-dir','.'],cwd='/home/ken/work/sandbox-broker-live',env=env,stdout=(root/'broker.log').open('ab'),stderr=subprocess.STDOUT,start_new_session=True)
(root/'broker.pid').write_text(str(p.pid));time.sleep(1)
assert p.poll() is None
print('Restarted owned broker PID',pid,'->',p.pid,'port 8088')
