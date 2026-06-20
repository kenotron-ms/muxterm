/**
 * mux-browser-pane smoke tests.
 *
 * These verify the component module exports correctly and the element is
 * registered. Full DOM/canvas rendering is not tested here — it requires
 * a real browser environment. The acceptance gate is `npm run check:fast`
 * (typecheck + lint), which ensures type correctness.
 */
import { describe, it, expect } from 'vitest';

describe('mux-browser-pane module', () => {
  it('exports MuxBrowserPane class', async () => {
    const mod = await import('../components/mux-browser-pane.js');
    expect(mod.MuxBrowserPane).toBeDefined();
  });

  it('registers custom element mux-browser-pane', async () => {
    await import('../components/mux-browser-pane.js');
    expect(customElements.get('mux-browser-pane')).toBeDefined();
  });
});

/**
 * _drawLetterboxed letterbox math tests.
 *
 * Verifies that _drawLetterboxed computes and stores the correct letterbox
 * transform (dx, dy, scale, fw, fh) in this._letterbox.
 *
 * The stub from Task 9 does NOT update _letterbox, so these tests fail
 * before the full Task 10 implementation is in place.
 */
describe('_drawLetterboxed letterbox math', () => {
  /** Create a minimal component shell with mocked canvas and context. */
  function makeShell(canvasW: number, canvasH: number) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shell: any = {
      _canvas: { width: canvasW, height: canvasH },
      _ctx: {
        clearRect: () => { /* noop */ },
        drawImage: () => { /* noop */ },
      },
      _letterbox: { dx: 0, dy: 0, scale: 1, fw: 0, fh: 0 },
    };
    return shell;
  }

  /**
   * Helper to call _drawLetterboxed on a shell via the class prototype,
   * binding shell as `this`.
   */
  async function callDrawLetterboxed(
    shell: ReturnType<typeof makeShell>,
    imgW: number,
    imgH: number,
  ) {
    const mod = await import('../components/mux-browser-pane.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = (mod.MuxBrowserPane as any).prototype;
    const fakeImg = { naturalWidth: imgW, naturalHeight: imgH };
    proto._drawLetterboxed.call(shell, fakeImg);
  }

  it('computes letterbox dy bars when frame is wider than canvas', async () => {
    // Canvas 800×600, frame 1280×720 (16:9 frame, 4:3 canvas).
    // scale = min(800/1280, 600/720) = min(0.625, 0.833…) = 0.625
    // dx = (800 - 1280*0.625)/2 = (800 - 800)/2 = 0
    // dy = (600 - 720*0.625)/2  = (600 - 450)/2  = 75
    const shell = makeShell(800, 600);
    await callDrawLetterboxed(shell, 1280, 720);

    expect(shell._letterbox).toEqual({
      dx: 0,
      dy: 75,
      scale: 0.625,
      fw: 1280,
      fh: 720,
    });
  });

  it('computes pillarbox dx bars when frame is taller than canvas', async () => {
    // Canvas 800×600, frame 400×600 (2:3 frame, 4:3 canvas).
    // scale = min(800/400, 600/600) = min(2, 1) = 1
    // dx = (800 - 400*1)/2 = 400/2 = 200
    // dy = (600 - 600*1)/2 = 0/2  = 0
    const shell = makeShell(800, 600);
    await callDrawLetterboxed(shell, 400, 600);

    expect(shell._letterbox).toEqual({
      dx: 200,
      dy: 0,
      scale: 1,
      fw: 400,
      fh: 600,
    });
  });

  it('returns early without touching _letterbox when canvas has zero dimensions', async () => {
    const shell = makeShell(0, 0);
    await callDrawLetterboxed(shell, 1280, 720);

    // _letterbox must not be updated from its initial state.
    expect(shell._letterbox).toEqual({ dx: 0, dy: 0, scale: 1, fw: 0, fh: 0 });
  });
});
