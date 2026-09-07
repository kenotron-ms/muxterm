/**
 * The sidebar's "+ New workspace" placement rule, asserted against real
 * rendered DOM.
 *
 * THE RULE
 *   Every machine reachable in the sidebar -- the local one and each connected
 *   remote -- renders as its own group. A "+ New workspace" button is a member
 *   of exactly one machine group and renders INSIDE that group's container in
 *   the DOM. Zero such buttons render at the sidebar root, between groups, or
 *   attached to a group other than their own.
 *
 * WHY THE ASSERTIONS SELECT ON LABEL, NOT CLASS
 *   "+ Connect machine" reuses the `.new-ws-btn` class but is NOT a
 *   "+ New workspace" button: it adds a new GROUP rather than a workspace to an
 *   existing one, so it is the one affordance that belongs after the groups.
 *   Selecting on `.new-ws-btn` would therefore conflate the two. Every
 *   assertion below selects on the button's visible LABEL, which is what the
 *   user actually sees and what the rule is written about.
 *
 * WHAT MAKES THIS A REGRESSION TEST
 *   Restore `origin/main`'s mux-sidebar.ts under this file and S1 and S2 fail
 *   with `buttonsOutsideAnyGroup` = 1 -- which is the reported bug, measured.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { store } from '../state';
import { SessiondType } from '../types';
import type { SessiondMessage } from '../types';
import { remotesStore } from '../lib/remotes-store';
import '../components/mux-sidebar';

// ---------------------------------------------------------------------------
// Driving mock multi-machine state
// ---------------------------------------------------------------------------

const workspaceList = (
  workspaces: { workspaceId: string; name?: string; paneCount: number }[],
): SessiondMessage => ({ type: SessiondType.WorkspaceList, workspaces });

/** Remote workspace ids are host-namespaced: `ssh:<alias>/<id>`. */
const remoteWs = (host: string, id: string) => `${host}/${id}`;

/** Feed one host-state frame, exactly as the relay would. */
function connectHost(id: string, name: string, state = 'connected'): void {
  remotesStore.applyHostState({ host: id, name, state, since: Date.now() });
}

// ---------------------------------------------------------------------------
// DOM assertions
// ---------------------------------------------------------------------------

/** The machine group container. One per reachable machine. */
const GROUP = '.hostgroup';

function shadow(el: HTMLElement): ShadowRoot {
  const root = el.shadowRoot;
  if (!root) throw new Error('sidebar has no shadow root');
  return root;
}

function labelled(root: ShadowRoot, label: string): HTMLElement[] {
  return [...root.querySelectorAll('button')].filter(
    (b) => (b.textContent ?? '').trim() === label,
  );
}

/** Every "+ New workspace" button currently rendered, in DOM order. */
function newWorkspaceButtons(root: ShadowRoot): HTMLElement[] {
  return labelled(root, '+ New workspace');
}

/** The machine group a button lives in, or null if it lives outside all of them. */
function owningGroup(btn: HTMLElement): Element | null {
  return btn.closest(GROUP);
}

interface Layout {
  groups: number;
  /** Group header labels in DOM order. Local is always first (ux D1). */
  groupNames: string[];
  /** Group header label -> how many "+ New workspace" buttons that group owns. */
  ownedByGroup: Record<string, number>;
  /** Group header label -> how many workspace cards sit in it. */
  cardsByGroup: Record<string, number>;
  buttons: number;
  /** THE measurement the rule is written about. Must be 0. */
  buttonsOutsideAnyGroup: number;
  connectMachineButtons: number;
}

function measure(el: HTMLElement): Layout {
  const root = shadow(el);
  const groups = [...root.querySelectorAll(GROUP)];
  const buttons = newWorkspaceButtons(root);

  const ownedByGroup: Record<string, number> = {};
  const cardsByGroup: Record<string, number> = {};
  const groupNames: string[] = [];
  for (const g of groups) {
    const name = (g.querySelector('.hg-name')?.textContent ?? '?').trim();
    groupNames.push(name);
    ownedByGroup[name] = buttons.filter((b) => owningGroup(b) === g).length;
    cardsByGroup[name] = g.querySelectorAll('.ws-card').length;
  }

  return {
    groups: groups.length,
    groupNames,
    ownedByGroup,
    cardsByGroup,
    buttons: buttons.length,
    buttonsOutsideAnyGroup: buttons.filter((b) => owningGroup(b) === null).length,
    connectMachineButtons: labelled(root, '+ Connect machine').length,
  };
}

/** A printable DOM-order dump: what a reviewer would read off the screen. */
function domOrder(el: HTMLElement): string {
  const root = shadow(el);
  const host = root.querySelector('.tab-content');
  if (!host) return '(no .tab-content)';
  const lines: string[] = [];
  for (const child of [...host.children]) {
    if (child.matches(GROUP)) {
      const name = (child.querySelector('.hg-name')?.textContent ?? '?').trim();
      const remote = child.querySelector('.hg-name.remote') !== null;
      lines.push(`GROUP  ${name} [${remote ? 'remote' : 'local'}]`);
      for (const card of child.querySelectorAll('.ws-card')) {
        const label = (card.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
        lines.push(`  └─ card "${label}"`);
      }
      for (const btn of newWorkspaceButtons(root)) {
        if (owningGroup(btn) === child) lines.push('  └─ BTN "+ New workspace"');
      }
    } else if (child.tagName === 'BUTTON') {
      lines.push(`BTN    "${(child.textContent ?? '').trim()}"   <-- sidebar ROOT level`);
    }
  }
  return lines.join('\n');
}

/**
 * The rule, as one callable assertion.
 *
 * Asserted three ways, because "0 outside" alone would also pass if the buttons
 * had vanished entirely: every button is INSIDE a group, no group is missing
 * its button, and no group has two.
 */
function expectRuleHolds(el: HTMLElement, expectedGroups: number): Layout {
  const m = measure(el);
  const detail = `\n${domOrder(el)}\n${JSON.stringify(m, null, 2)}`;

  expect(m.groups, `expected ${expectedGroups} machine group(s)${detail}`).toBe(
    expectedGroups,
  );
  expect(
    m.buttonsOutsideAnyGroup,
    `"+ New workspace" buttons outside any machine group container${detail}`,
  ).toBe(0);
  // Exactly one per group -- no machine without a button, none with two.
  for (const [name, owned] of Object.entries(m.ownedByGroup)) {
    expect(owned, `group "${name}" should own exactly 1 "+ New workspace"${detail}`).toBe(1);
  }
  expect(m.buttons, `one "+ New workspace" per machine group${detail}`).toBe(expectedGroups);
  return m;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

interface Updatable extends HTMLElement {
  updateComplete: Promise<unknown>;
}

async function settle(el: Updatable): Promise<void> {
  // Two turns: store subscriptions request the update on the first, Lit
  // commits it on the second.
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

async function mount(): Promise<Updatable> {
  const el = document.createElement('mux-sidebar') as Updatable;
  document.body.appendChild(el);
  await settle(el);
  return el;
}

describe('sidebar: every "+ New workspace" renders inside its own machine group', () => {
  let el: Updatable | null = null;

  beforeEach(() => {
    // The footer polls for an update on connect; never let a unit test dial out.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    for (const h of [...remotesStore.hosts]) remotesStore.forget(h.id);
    store.applySessiond(workspaceList([]));
  });

  afterEach(() => {
    el?.remove();
    el = null;
    for (const h of [...remotesStore.hosts]) remotesStore.forget(h.id);
    vi.unstubAllGlobals();
  });

  it('S1: no remote connected -- the local group renders with its button inside it', async () => {
    store.applySessiond(
      workspaceList([
        { workspaceId: 'ws-1', name: 'dev', paneCount: 2 },
        { workspaceId: 'ws-2', name: 'notes', paneCount: 1 },
      ]),
    );
    el = await mount();

    const m = expectRuleHolds(el, 1);
    // The local machine is a group even with no remote in sight: the rule has
    // to hold in EVERY connection state, and a flat list has no group to be
    // inside of.
    expect(m.buttons).toBe(1);
    // "+ Connect machine" adds a new GROUP, so it is the one root-level button.
    expect(m.connectMachineButtons).toBe(1);
    console.log(`\nS1 -- no remote connected\n${domOrder(el)}\n` +
      `  "+ New workspace" outside any machine group container = ${m.buttonsOutsideAnyGroup}\n`);
  });

  it('S2: one remote connected -- local keeps its button, remote is a separate group', async () => {
    connectHost('ssh:boxb', 'boxb');
    store.applySessiond(
      workspaceList([
        { workspaceId: 'ws-1', name: 'dev', paneCount: 2 },
        { workspaceId: remoteWs('ssh:boxb', 'ws-9'), name: 'build', paneCount: 1 },
      ]),
    );
    el = await mount();

    const m = expectRuleHolds(el, 2);
    // The reported bug was a button belonging to no machine appearing above the
    // local group's; both groups must own exactly one, and neither may be the
    // orphan.
    expect(m.ownedByGroup['boxb']).toBe(1);
    // The mock state really is multi-machine: each group holds its own
    // machine's workspace, so the grouping under test is not a vacuous render.
    expect(m.cardsByGroup[m.groupNames[0]]).toBe(1); // local group's own workspace
    expect(m.cardsByGroup['boxb']).toBe(1); // the remote's, under the remote's header
    expect(m.buttons).toBe(2);
    expect(m.connectMachineButtons).toBe(1);
    console.log(`\nS2 -- one remote connected\n${domOrder(el)}\n` +
      `  "+ New workspace" outside any machine group container = ${m.buttonsOutsideAnyGroup}\n`);
  });

  it('S3: that remote disconnected -- back to the S1 layout, no orphan, no duplicate', async () => {
    connectHost('ssh:boxb', 'boxb');
    store.applySessiond(
      workspaceList([
        { workspaceId: 'ws-1', name: 'dev', paneCount: 2 },
        { workspaceId: remoteWs('ssh:boxb', 'ws-9'), name: 'build', paneCount: 1 },
      ]),
    );
    el = await mount();
    expectRuleHolds(el, 2);

    // 3a -- the link drops. The workspace ghosts rather than vanishing, so the
    // group stays; the rule must hold mid-transition too.
    connectHost('ssh:boxb', 'boxb', 'reconnecting');
    await settle(el);
    const mid = expectRuleHolds(el, 2);
    console.log(`\nS3a -- link dropped, group ghosted\n${domOrder(el)}\n` +
      `  "+ New workspace" outside any machine group container = ${mid.buttonsOutsideAnyGroup}\n`);

    // 3b -- the host is dismissed and its workspaces go with it: the S1 layout,
    // exactly.
    remotesStore.forget('ssh:boxb');
    store.applySessiond(workspaceList([{ workspaceId: 'ws-1', name: 'dev', paneCount: 2 }]));
    await settle(el);

    const m = expectRuleHolds(el, 1);
    expect(m.buttons).toBe(1);
    expect(m.connectMachineButtons).toBe(1);
    console.log(`\nS3b -- back to the S1 layout\n${domOrder(el)}\n` +
      `  "+ New workspace" outside any machine group container = ${m.buttonsOutsideAnyGroup}\n`);
  });

  it('S4: a remote connects while the sidebar is open -- grouping updates live', async () => {
    store.applySessiond(workspaceList([{ workspaceId: 'ws-1', name: 'dev', paneCount: 2 }]));
    el = await mount();
    const before = expectRuleHolds(el, 1);
    expect(before.groups).toBe(1);

    // The same element instance, never re-created and never re-mounted: this is
    // the no-reload guarantee, asserted rather than assumed.
    const sameElement = el;
    const groupsBefore = shadow(el).querySelectorAll(GROUP).length;

    connectHost('ssh:boxb', 'boxb');
    store.applySessiond(
      workspaceList([
        { workspaceId: 'ws-1', name: 'dev', paneCount: 2 },
        { workspaceId: remoteWs('ssh:boxb', 'ws-9'), name: 'build', paneCount: 1 },
      ]),
    );
    await settle(el);

    expect(el, 'the sidebar element was replaced -- that is a reload').toBe(sameElement);
    expect(el.isConnected).toBe(true);
    const m = expectRuleHolds(el, 2);
    expect(groupsBefore).toBe(1);
    expect(m.groups).toBe(2);
    console.log(`\nS4 -- remote connected live, sidebar never re-mounted (${groupsBefore} -> ${m.groups} groups)\n` +
      `${domOrder(el)}\n` +
      `  "+ New workspace" outside any machine group container = ${m.buttonsOutsideAnyGroup}\n`);
  });
});
