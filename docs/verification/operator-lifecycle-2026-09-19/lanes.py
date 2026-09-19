import os, subprocess, json, pathlib
root=pathlib.Path(__file__).resolve().parents[3]
binary=str(root/'bin/muxterm-dev')
env=dict(os.environ,XDG_RUNTIME_DIR='/tmp/muxterm-dev-local',XDG_DATA_HOME='/tmp/muxterm-dev-local/data',MUXTERM_COS_SESSION_ID='muxterm-cos-dev')
env.pop('INVOCATION_ID',None)
# Connect only to an existing make dev-local daemon; never start a server here.
assert pathlib.Path(env['XDG_RUNTIME_DIR'], 'muxterm/sessiond.sock').is_socket()
for outcome in ['done', 'stopped']:
 (root/'tmp'/('release-'+outcome)).unlink(missing_ok=True)
def cli(*args):
 return subprocess.check_output([binary,*args],env=env,text=True).strip()
fixtures=[]
for outcome in ['done','failed','stopped']:
 sid='browser-lifecycle-'+outcome
 ws=json.loads(cli('workspace','create',sid,'--json'))['workspaceId']
 report=f'{binary} session report --session-id {sid} --mode autonomous --name {sid} --pid $$'
 script=f'{report} --state working --doing "verifying real PTY lifecycle"; sleep 5; '
 if outcome=='failed':
  script+='echo "Intentional verification crash while working"; kill -TERM $$'
 else:
  script+=f'echo "{outcome} artifact" > {root}/tmp/{sid}.txt; {report} --state {outcome} --doing "{outcome} distinctly"; '
  script+=f'while [ ! -e {root}/tmp/release-{outcome} ]; do sleep 1; done; exit 0'
 pane=json.loads(cli('pane','create','--workspace',ws,'--cmd','bash','--cmd','-c','--cmd',script,'--cmd','muxterm-goal-lane','--cmd',f'Verify {outcome} lifecycle browser delivery','--json'))
 fixtures.append(dict(sid=sid,workspace=ws,pane=pane))
print(json.dumps(fixtures,indent=2))
(root/'tmp/lifecycle-browser-lanes.json').write_text(json.dumps(fixtures,indent=2))
