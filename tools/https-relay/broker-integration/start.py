#!/usr/bin/env python3
"""Start only in a fresh relay DTU; never on the host. No Azure operations."""
import json, os, pathlib, secrets, subprocess, sys, time
assert pathlib.Path('/run/systemd/container').exists(), 'DTU required'
root=pathlib.Path('/opt/relay/fixture')
root.mkdir(mode=0o700, exist_ok="--launch" in sys.argv)  # Refuse reuse: each verification needs fresh daemons.
client,worker=secrets.token_hex(32),secrets.token_hex(32)
if "--launch" in sys.argv:
 saved=json.loads((root/"broker.json").read_text());client,worker=saved["clientToken"],saved["workerToken"]
for name,content in {
 'broker':dict(host='sandbox:local-broker',clientToken=client,workerToken=worker),
 'client':dict(host='sandbox:local-broker',url='https://127.0.0.1',token=client),
 'worker':dict(host='sandbox:local-broker',url='https://10.222.0.1',token=worker),
}.items():
 p=root/(name+'.json');p.write_text(json.dumps(content));p.chmod(0o600)
if "--prepare" in sys.argv: sys.exit(0)
pids={}
def launch(name,args,env=None):
 log=(root/(name+'.log')).open('wb')
 p=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=log,stderr=log,env=env,start_new_session=True)
 pids[name]=p.pid
 (root/'pids.json').write_text(json.dumps(pids))
for role in ('local','remote'):
 base=root/role
 for sub in ('runtime','config','data'): (base/sub).mkdir(parents=True,mode=0o700)
 env=dict(os.environ,XDG_RUNTIME_DIR=str(base/'runtime'),XDG_CONFIG_HOME=str(base/'config'),XDG_DATA_HOME=str(base/'data'))
 args=['/opt/relay/bin/muxterm','sessiond']
 if role=='remote':args=['unshare','--mount','--propagation','private','--','sh','-c','mount -t tmpfs tmpfs /tmp && exec ip netns exec relay-worker /opt/relay/bin/muxterm sessiond']
 launch(role,args,env)
for _ in range(100):
 if all((root/role/'runtime/muxterm/sessiond.sock').exists() for role in ('local','remote')): break
 time.sleep(.1)
else:raise RuntimeError('private daemons not ready')
# Broker runs from the real source tree on host port 8089.
time.sleep(.3)
launch('worker',['ip','netns','exec','relay-worker','/opt/relay/bin/relay','--experimental','--mode','worker','--config',str(root/'worker.json'),'--socket',str(root/'remote/runtime/muxterm/sessiond.sock')])
time.sleep(.5)
launch('serve',['/opt/relay/bin/relay','--experimental','--mode','serve','--config',str(root/'client.json'),'--socket',str(root/'local/runtime/muxterm/sessiond.sock'),'--addr','127.0.0.1:8313'],dict(os.environ,XDG_RUNTIME_DIR=str(root/'local/runtime'),XDG_CONFIG_HOME=str(root/'local/config'),XDG_DATA_HOME=str(root/'local/data')))
(root/'pids.json').write_text(json.dumps(pids))
print('Fixture started in DTU; secrets retained only in private config files.')
