import json,os,pathlib,signal,time
assert pathlib.Path('/run/systemd/container').exists()
root=pathlib.Path('/opt/relay/fixture')
pids=json.loads((root/'pids.json').read_text())
for name in ('serve','worker','remote','local'):
 pid=pids[name];p=pathlib.Path(f'/proc/{pid}/cmdline')
 if p.exists():
  cmd=p.read_bytes();assert b'/opt/relay/bin/' in cmd, name
  os.kill(pid,signal.SIGTERM)
time.sleep(2)
for name in ('serve','worker','remote','local'):
 pid=pids[name]
 p=pathlib.Path(f'/proc/{pid}/cmdline')
 if p.exists() and p.read_bytes():
  assert b'/opt/relay/bin/' in p.read_bytes()
  os.kill(pid,signal.SIGKILL)
root.rename('/opt/relay/fixture-initial-browser')
# Kept the compiled relay binary; host broker was never signalled.
print('Only owned DTU fixture reset; initial browser evidence retained.')
