#!/usr/bin/env python3
"""Real MCP/sessiond fixture; run only via make operator-reference-fixture."""
import json
import os
from pathlib import Path
import subprocess
import time

runtime = Path(os.environ.get('XDG_RUNTIME_DIR', ''))
assert runtime == Path('/tmp/muxterm-dev-local'), 'requires isolated dev-local target'
assert (runtime / 'muxterm/sessiond.sock').is_socket(), 'start make dev-local first'
env = dict(os.environ)
for key in list(env):
    if key.startswith('MUXTERM_') and key != 'MUXTERM_COS_SESSION_ID':
        del env[key]
p = subprocess.Popen(['./bin/muxterm-dev', 'mcp'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open('tmp/reference-mcp.log', 'w'), text=True, env=env)
seq = 0
responses = []
def rpc(method, params):
    global seq
    seq += 1
    p.stdin.write(json.dumps(dict(jsonrpc='2.0', id=seq, method=method, params=params)) + '\n')
    p.stdin.flush()
    while True:
        line = p.stdout.readline()
        assert line, 'MCP exited'
        reply = json.loads(line)
        if reply.get('id') == seq:
            assert 'error' not in reply, reply
            return reply['result']
def call(tool, **args):
    result = rpc('tools/call', {'name': tool, 'arguments': args})
    assert not result.get('isError'), result
    data = json.loads(result['content'][0]['text'])
    responses.append(dict(tool=tool, arguments=args, result=data))
    return data
try:
    rpc('initialize', {'protocolVersion': '2024-11-05', 'clientInfo': {'name':'reference-verification', 'version':'1'}, 'capabilities':{}})
    named = call('create_workspace', name='Lifecycle fix')
    unnamed = next(row for row in call('list_workspaces') if not row['name'].strip())
    first = call('create_workspace', name='Fleet row progress followups')
    second = call('create_workspace', name='Fleet row progress followups')
    closed = call('create_workspace', name='Completed release')
    call('switch_workspace', workspace_id=named['workspace_id'])
    pane = call('create_pane')
    call('rename_pane', pane_id=pane['pane_id'], name='Lifecycle implementation')
    panes = call('list_panes')
    call('get_layout')
    call('send_input', pane_id=pane['pane_id'], text='')
    call('list_workspaces')
    # Publish from the real shell so sessiond attributes the row, then steer it.
    report = str(Path('bin/muxterm-dev').resolve()) + ' session report --session-id reference-verification --mode interactive --state working --name verification'
    call('send_input', pane_id=pane['pane_id'], text=report + '\n')
    time.sleep(2)
    fleet = call('fleet_status')
    assert any(r['session_id'] == 'reference-verification' for r in fleet['sessions']), fleet
    call('session_send', session_id='reference-verification', text='printf reference-steered')
    call('list_triggers')
    spawned = call('spawn_lane', workspace='Spawn badge verification', harness='claude', prompt='Reply only Ready. This is an isolated UI fixture. Do not use tools or change files.')
    assert spawned['workspace_name'] == 'Spawn badge verification' and spawned['pane_name'] != 'Unavailable pane', spawned
    call('close_workspace', workspace_id=spawned['workspace_id'])
    def check_names(value):
        if isinstance(value, list):
            for row in value: check_names(row)
        if isinstance(value, dict):
            for kind in ('workspace', 'pane'):
                if kind + '_id' in value:
                    assert value.get(kind + '_name'), value
                    assert value.get(kind + '_ref'), value
            for child in value.values(): check_names(child)
    for response in responses: check_names(response['result'])
    call('close_workspace', workspace_id=closed['workspace_id'])
    fixture = dict(named=named, unnamed=unnamed, first=first, second=second, closed=closed, pane=panes[0])
    Path('tmp/reference-fixture.json').write_text(json.dumps(fixture, indent=2))
    out = Path('docs/verification/operator-references')
    out.mkdir(parents=True, exist_ok=True)
    (out / 'mcp-responses.json').write_text(json.dumps(responses, indent=2) + '\n')
    browser = Path('tools/verify-operator-references-browser.cjs').read_text().replace('const fixture = FIXTURE;', 'const fixture = ' + json.dumps(fixture) + ';')
    Path('tmp/reference-browser.cjs').write_text(browser)
    print('Captured real MCP responses and generated tmp/reference-browser.cjs')
finally:
    p.stdin.close()
    p.wait(timeout=10)
