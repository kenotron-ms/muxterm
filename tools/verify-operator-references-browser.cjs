// Run with playwright-cli run-code --filename after generating tmp/reference-browser.cjs.
// The fixture generator substitutes FIXTURE. Only Operator transcript frames are
// supplied here; workspace/pane inventory and mutations go to the real dev daemon.
async (page) => {
  const fixture = FIXTURE;
  const text = `The lifecycle work is running in ${fixture.named.workspace_ref}, in ${fixture.pane.pane_ref}.\n\n${fixture.unnamed.workspace_ref} is available.\n\n${fixture.first.workspace_ref} and ${fixture.second.workspace_ref} are separate workspaces.\n\n${fixture.closed.workspace_ref} has closed.\n\nStatus and Release are ordinary words. [Missing reference](muxterm:broken) stays readable.`;
  let daemonSocket;
  await page.routeWebSocket('**/ws', ws => {
    const server = ws.connectToServer();
    daemonSocket = server;
    ws.onMessage(message => {
      let frame;
      try { frame = JSON.parse(message.toString()); } catch { server.send(message); return; }
      if (frame.type?.startsWith('cos-')) {
        if (frame.type === 'cos-subscribe') {
          ws.send(JSON.stringify({type:'cos-subscribe-result', ok:true, ready:true, session_id:'badge-verification'}));
          ws.send(JSON.stringify({type:'cos-history', reason:'prune', turns:[{id:'badge-verification', prompt:'Where is the work running?', status:'done', blocks:[{kind:'text', text}]}]}));
        }
        return;
      }
      server.send(message);
    });
    server.onMessage(message => ws.send(message));
  });
  await page.goto('http://127.0.0.1:8313');
  const badges = page.locator('mux-cos .operator-reference');
  await badges.first().waitFor();
  const expected = ['Lifecycle fix', 'Lifecycle implementation · Lifecycle fix', 'Unnamed workspace', 'Fleet row progress followups · 1', 'Fleet row progress followups · 2', 'Completed release · closed'];
  const actual = await badges.allTextContents();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify(actual));
  const checkBounds = async () => {
    const bounds = await badges.evaluateAll(nodes => nodes.map(n => {
      const r = n.getBoundingClientRect();
      return {label:n.textContent, left:r.left, right:r.right, width:r.width};
    }));
    const width = page.viewportSize().width;
    if (bounds.some(r => r.left < 0 || r.right > width)) throw new Error(JSON.stringify(bounds));
    return bounds;
  };
  const evidence = {};
  for (const [label, width, height] of [['desktop',1280,900], ['mobile',390,844], ['narrow',320,740]]) {
    await page.setViewportSize({width,height});
    await page.waitForTimeout(200);
    evidence[label] = await checkBounds();
    await page.screenshot({path:`docs/verification/operator-references/${label}.png`});
  }
  daemonSocket.send(JSON.stringify({type:'rename-workspace',workspaceId:fixture.named.workspace_id,name:'Lifecycle renamed'}));
  await page.waitForFunction(() => document.querySelector('mux-app').shadowRoot.querySelector('mux-cos').shadowRoot.querySelector('.operator-reference').textContent === 'Lifecycle renamed');
  daemonSocket.send(JSON.stringify({type:'attach',workspaceId:fixture.named.workspace_id,breakpoint:'wide',clientKind:'browser'}));
  await page.waitForTimeout(200);
  daemonSocket.send(JSON.stringify({type:'rename-pane',paneId:fixture.pane.pane_id,name:'A very long implementation pane title that must fit a narrow mobile chat message without overflowing'}));
  await page.waitForFunction(() => [...document.querySelector('mux-app').shadowRoot.querySelector('mux-cos').shadowRoot.querySelectorAll('.operator-reference')].some(n => n.textContent.startsWith('A very long')));
  evidence.renamed = await checkBounds();
  await page.screenshot({path:'docs/verification/operator-references/renamed-narrow.png'});
  daemonSocket.send(JSON.stringify({type:'close-pane',paneId:fixture.pane.pane_id}));
  await page.waitForFunction(() => document.querySelector('mux-app').shadowRoot.querySelector('mux-cos').shadowRoot.querySelector('[data-kind="pane"]').dataset.status === 'closed');
  evidence.closedPane = await badges.allTextContents();
  return evidence;
}
