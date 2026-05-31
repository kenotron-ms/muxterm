import { describe, it, expect } from 'vitest';
import { Workspace } from './workspace';

describe('Workspace', () => {
  it('starts empty in single mode', () => {
    const ws = new Workspace();
    expect(ws.regions).toHaveLength(0);
    expect(ws.maximizedRegionId).toBeNull();
    expect(ws.mode).toBe('single');
    expect(ws.visibleRegions).toHaveLength(0);
  });

  it('openRegion mounts a tmux window as a new region', () => {
    const ws = new Workspace();
    const region = ws.openRegion({ sessionName: 'main', windowId: 1 });
    expect(region.id).toMatch(/^region-/);
    expect(region.surface.id).toMatch(/^surf-/);
    expect(region.surface.sessionName).toBe('main');
    expect(region.surface.windowId).toBe(1);
    expect(typeof region.weight).toBe('number');
    expect(ws.regions).toHaveLength(1);
    expect(ws.regions[0]).toBe(region);
  });

  it('mode transitions to docked when 2+ regions exist', () => {
    const ws = new Workspace();
    expect(ws.mode).toBe('single');
    ws.openRegion({ sessionName: 'main', windowId: 1 });
    expect(ws.mode).toBe('single');
    ws.openRegion({ sessionName: 'main', windowId: 2 });
    expect(ws.mode).toBe('docked');
  });

  it('enforces one-window-one-surface invariant', () => {
    const ws = new Workspace();
    ws.openRegion({ sessionName: 'main', windowId: 1 });
    expect(() => ws.openRegion({ sessionName: 'main', windowId: 1 })).toThrow(
      /one-window-one-surface/,
    );
  });

  it('allows same windowId in different sessions', () => {
    const ws = new Workspace();
    ws.openRegion({ sessionName: 'session-a', windowId: 1 });
    expect(() => ws.openRegion({ sessionName: 'session-b', windowId: 1 })).not.toThrow();
    expect(ws.regions).toHaveLength(2);
  });

  it('closeRegion removes the region', () => {
    const ws = new Workspace();
    const r1 = ws.openRegion({ sessionName: 'main', windowId: 1 });
    const r2 = ws.openRegion({ sessionName: 'main', windowId: 2 });
    ws.closeRegion(r1.id);
    expect(ws.regions).toHaveLength(1);
    expect(ws.regions[0]).toBe(r2);
  });

  it('maximize sets maximizedRegionId and switches to single mode', () => {
    const ws = new Workspace();
    const r1 = ws.openRegion({ sessionName: 'main', windowId: 1 });
    const r2 = ws.openRegion({ sessionName: 'main', windowId: 2 });
    expect(ws.mode).toBe('docked');
    ws.maximize(r1.id);
    expect(ws.maximizedRegionId).toBe(r1.id);
    expect(ws.mode).toBe('single');
    expect(ws.visibleRegions).toHaveLength(1);
    expect(ws.visibleRegions[0]).toBe(r1);
    // r2 still exists in regions
    expect(ws.regions).toHaveLength(2);
    // r2 is not visible
    expect(ws.visibleRegions.some((r) => r.id === r2.id)).toBe(false);
  });

  it('restore clears maximizedRegionId', () => {
    const ws = new Workspace();
    const r1 = ws.openRegion({ sessionName: 'main', windowId: 1 });
    ws.openRegion({ sessionName: 'main', windowId: 2 });
    ws.maximize(r1.id);
    expect(ws.maximizedRegionId).toBe(r1.id);
    ws.restore();
    expect(ws.maximizedRegionId).toBeNull();
    expect(ws.mode).toBe('docked');
    expect(ws.visibleRegions).toHaveLength(2);
  });

  it('maximize throws /no such region/ for unknown regionId', () => {
    const ws = new Workspace();
    ws.openRegion({ sessionName: 'main', windowId: 1 });
    expect(() => ws.maximize('region-999')).toThrow(/no such region/);
  });

  it('closing the maximized region clears maximizedRegionId', () => {
    const ws = new Workspace();
    const r1 = ws.openRegion({ sessionName: 'main', windowId: 1 });
    ws.openRegion({ sessionName: 'main', windowId: 2 });
    ws.maximize(r1.id);
    expect(ws.maximizedRegionId).toBe(r1.id);
    ws.closeRegion(r1.id);
    expect(ws.maximizedRegionId).toBeNull();
    expect(ws.regions).toHaveLength(1);
  });
});
