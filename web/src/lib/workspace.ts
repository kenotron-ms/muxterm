export type PresentationMode = 'docked' | 'single';

export interface SurfaceRef {
  sessionName: string;
  windowId: number;
}

export interface Surface extends SurfaceRef {
  id: string;
}

export interface Region {
  id: string;
  surface: Surface;
  weight: number;
}

let _surfaceCounter = 0;
let _regionCounter = 0;

export class Workspace {
  regions: Region[] = [];
  maximizedRegionId: string | null = null;

  get mode(): PresentationMode {
    if (this.maximizedRegionId !== null || this.regions.length <= 1) {
      return 'single';
    }
    return 'docked';
  }

  get visibleRegions(): Region[] {
    if (this.maximizedRegionId !== null) {
      return this.regions.filter((r) => r.id === this.maximizedRegionId);
    }
    return [...this.regions];
  }

  openRegion(ref: SurfaceRef): Region {
    const duplicate = this.regions.find(
      (r) =>
        r.surface.sessionName === ref.sessionName &&
        r.surface.windowId === ref.windowId,
    );
    if (duplicate !== undefined) {
      throw new Error(
        `one-window-one-surface: session "${ref.sessionName}" window ${ref.windowId} is already mounted`,
      );
    }

    const surface: Surface = {
      id: `surf-${++_surfaceCounter}`,
      sessionName: ref.sessionName,
      windowId: ref.windowId,
    };

    const region: Region = {
      id: `region-${++_regionCounter}`,
      surface,
      weight: 1,
    };

    this.regions.push(region);
    return region;
  }

  closeRegion(regionId: string): void {
    this.regions = this.regions.filter((r) => r.id !== regionId);
    if (this.maximizedRegionId === regionId) {
      this.maximizedRegionId = null;
    }
  }

  maximize(regionId: string): void {
    const region = this.regions.find((r) => r.id === regionId);
    if (region === undefined) {
      throw new Error(`no such region: "${regionId}"`);
    }
    this.maximizedRegionId = regionId;
  }

  restore(): void {
    this.maximizedRegionId = null;
  }
}
