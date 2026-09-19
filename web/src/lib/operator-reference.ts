import { html, type TemplateResult } from 'lit';
import { store } from '../state.js';

/** Explicit Markdown links only. Ordinary names and code are never scanned. */
export function operatorReference(href: string, fallback: string): TemplateResult | null {
  const match = /^muxterm:(workspace|pane)\/([^/?]+)(?:\/(\d+))?\?(.+)$/.exec(href);
  if (!match) return null;
  const [, kind, uuid, paneID, query] = match;
  if ((kind === 'pane') !== Boolean(paneID)) return null;
  const params = new URLSearchParams(query);
  const machine = params.get('machine');
  if (!machine) return null;
  const workspaces = store.workspaces.filter(w => machine === 'local'
    ? !w.workspaceId.includes('/') : w.workspaceId.startsWith(`${machine}/`));
  const ws = workspaces.find(w => w.workspaceUuid === uuid);
  const pane = ws?.panes?.find(p => p.paneId === Number(paneID));
  const live = kind === 'workspace' ? Boolean(ws) : Boolean(pane);
  const unavailable = !store.referenceInventoryReady || uuid === 'gone' || !workspaces.every(w => w.workspaceUuid) || (ws && kind === 'pane' && !ws.panes);
  const knownClosed = params.get('status') === 'closed';
  // Failed/malformed/old-server references remain readable text. The suffix
  // distinguishes an unverified identity from a known missing target.
  const base = fallback.trim() || (kind === 'workspace' ? 'Unnamed workspace' : 'Unnamed pane');
  if (unavailable && !knownClosed) return html`${base} (unavailable)`;
  let name = kind === 'workspace' ? (ws?.name?.trim() || 'Unnamed workspace')
    : (pane?.title?.trim() || 'Unnamed pane');
  let qualifier = '';
  if (live && ws) {
    if (kind === 'workspace') {
      const duplicates = workspaces.filter(w => (w.name?.trim() || 'Unnamed workspace') === name);
      if (duplicates.length > 1) qualifier = ` · ${duplicates.indexOf(ws) + 1}`;
    } else {
      const duplicates = ws.panes!.filter(p => (p.title?.trim() || 'Unnamed pane') === name);
      if (duplicates.length > 1) qualifier = ` · ${duplicates.indexOf(pane!) + 1}`;
      const wsName = ws.name?.trim() || 'Unnamed workspace';
      const wsDuplicates = workspaces.filter(w => (w.name?.trim() || 'Unnamed workspace') === wsName);
      qualifier += ` · ${wsName}${wsDuplicates.length > 1 ? ` · ${wsDuplicates.indexOf(ws) + 1}` : ''}`;
    }
    if (machine !== 'local') qualifier += ` · ${machine}`;
  } else {
    name = base;
    qualifier = ' · closed';
  }
  const label = name + qualifier;
  return html`<span class="operator-reference" data-kind=${kind} data-status=${live ? 'live' : 'closed'} title=${label} aria-label=${label}><span class="operator-reference-name">${name}</span><span class="operator-reference-qualifier">${qualifier}</span></span>`;
}
