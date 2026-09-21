import subprocess,os,pathlib,json,base64
r=pathlib.Path('/home/ken/artifacts/sandbox-live-private')
source='/home/ken/work/sandbox-broker-live'
path=r/'no-entra.json';path.write_text((r/'broker.json').read_text());path.chmod(0o600)
env=dict(os.environ,SANDBOX_BROKER_DATA_DIR=str(r/".amplifier-sandbox-broker"),SANDBOX_BROKER_RELAY_CONFIG=str(path))
for k in ('AMPLIFIER_SANDBOX_BROKER_ENTRA_TENANT_ID','AMPLIFIER_SANDBOX_BROKER_ENTRA_AUDIENCE','SANDBOX_BROKER_LOCAL_RELAY_CONFIG'):env.pop(k,None)
cmd=['/home/ken/workspace/sandboxes/.venv/bin/python','-m','uvicorn','broker.app:default_app','--host','127.0.0.1','--port','18088']
p=subprocess.run(cmd,cwd=source,env=env,capture_output=True,text=True,timeout=15)
assert p.returncode and 'requires Entra; development auth forbidden' in p.stderr
print('PASS live broker startup rejected missing Entra configuration (exit 1)')
env['SANDBOX_BROKER_RELAY_CONFIG']=str(r/'broker.json')
p=subprocess.run(cmd,cwd=source,env=env,capture_output=True,text=True,timeout=15)
assert p.returncode and 'relay binding already served; use one ASGI worker' in p.stderr
print('PASS second broker process rejected the active binding lock (exit 1)')
p=subprocess.run(['incus','exec','muxterm-sandbox-live-normal','--','env','MUXTERM_RELAY_CONFIG=/opt/relay/client.json','XDG_RUNTIME_DIR=/opt/relay/runtime','XDG_CONFIG_HOME=/opt/relay/config','XDG_DATA_HOME=/opt/relay/data','/opt/relay/bin/muxterm','serve','--addr','0.0.0.0:19091'],capture_output=True,text=True,timeout=15)
assert p.returncode and 'owner-enrolled relay requires a loopback muxterm server' in p.stderr
print('PASS normal muxterm rejected owner relay on a non-loopback listener (exit 1)')
