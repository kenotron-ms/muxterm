#!/usr/bin/env python3
"""Real MCP -> HTTPS relay -> real remote sessiond verification, in the DTU."""
import json, os, pathlib, subprocess, time
ROOT=pathlib.Path('/home/ken/artifacts/sandbox-live-private')
class MCP:
 def __init__(self):
  self.p=subprocess.Popen(['incus','exec','muxterm-sandbox-live-normal','--','env','MUXTERM_RELAY_CONFIG=/opt/relay/client.json','XDG_RUNTIME_DIR=/opt/relay/runtime','XDG_DATA_HOME=/opt/relay/data','XDG_CONFIG_HOME=/opt/relay/config','/opt/relay/bin/muxterm','mcp'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(ROOT/'mcp.log').open('ab'),text=True)
  self.seq=0
 def call(self,name,args):
  self.seq+=1;self.p.stdin.write(json.dumps(dict(jsonrpc='2.0',id=self.seq,method='tools/call',params=dict(name=name,arguments=args)))+'\n');self.p.stdin.flush()
  raw=json.loads(self.p.stdout.readline());r=raw.get('result',{})
  if 'error' in raw or r.get('isError'):raise RuntimeError(raw)
  text=''.join(v.get('text','') for v in r.get('content',[]))
  try:return json.loads(text)
  except json.JSONDecodeError:return text
 def close(self):self.p.stdin.close();self.p.wait(timeout=5)
if __name__=='__main__':
 assert pathlib.Path('/run/systemd/container').exists()
 m=MCP();machine='sandbox:fixture'
 marker_path='/tmp/relay-remote-marker-'+str(time.time_ns())
 print('machines:',json.dumps(m.call('list_machines',{})))
 w=m.call('create_workspace',dict(machine=machine,name='Relay MCP verification'))['workspace_id']
 m.call('switch_workspace',dict(machine=machine,workspace_id=w))
 pane=m.call('create_pane',dict(machine=machine))['pane_id']
 time.sleep(1)
 m.call('send_input',dict(machine=machine,pane_id=pane,text="printf 'REMOTE_HTTPS_MARKER\\n' > "+marker_path+"\r"))
 for _ in range(50):
  try:
   r=m.call('read_file',dict(machine=machine,path=marker_path))
   if 'REMOTE_HTTPS_MARKER' in r['content']:break
  except RuntimeError:pass
  time.sleep(.1)
 else:raise AssertionError('marker not written by remote shell')
 assert r['machine']==machine
 try:m.call('read_file',dict(machine='local',path=marker_path))
 except RuntimeError:pass
 else:raise AssertionError('remote-only marker leaked into local filesystem')
 entries=m.call('list_dir',dict(machine=machine,path='/tmp'))
 assert entries['machine']==machine
 screen=m.call('get_screen',dict(machine=machine,pane_id=pane))
 (ROOT/'mcp-fixture.json').write_text(json.dumps(dict(workspace=w,pane=pane)))
 print('PASS: real remote workspace, PTY input, file read, directory listing, screen read')
 m.close()
