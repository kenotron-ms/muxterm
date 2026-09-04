/**
 * home-tile.ts — the text a home-view thumbnail shows, in tiles mode.
 *
 * ⚠ WHAT THIS IS, EXACTLY
 *
 * The real preview pipeline (VTBuffer.PreviewTile → the sanitiser → the hash
 * gate → preview-canvas.renderTile) is keyed PER WORKSPACE today, not per pane
 * (server.go emits one tile for the attached workspace). The home view wants
 * one tile per pane, which is daemon-side work this lane does not own.
 *
 * So this module is the stand-in for the missing emit path — and it is
 * deliberately NOT invented terminal output. It renders the session's own
 * DECLARED fields (waitingFor, doing, doneMeans) through the SAME renderer the
 * sidebar uses. A tile therefore says nothing the card doesn't; it just says it
 * in the preview's shape, so the layout, geometry and font contract are all
 * real and the swap to per-pane tiles is a one-line source change in
 * `mux-home`.
 *
 * ASCII only. The 5x8 bitmap font folds anything it can't draw to '·', so a
 * decorative arrow or check mark would come out as a smudge.
 */

import { tileFromLines, type PreviewTile } from './preview-tile.js';
import { groupFor, type SessionState } from './session-state.js';

/**
 * Tile geometry, in cells. 40x9 at PREVIEW_CELL (5x8 CSS px) is 200x72 px,
 * which fits four across at the width the mockup uses and matches its 76px
 * body block.
 */
export const TILE_COLS = 40;
export const TILE_ROWS = 9;

/** Body indent, mirroring how a terminal transcript reads. */
const IND = '  ';

/** Greedy word wrap to `width`, prefixed with `indent`. Never returns ''. */
function wrap(text: string, width: number, indent: string): string[] {
  const budget = Math.max(1, width - indent.length);
  const words = text.split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return [];

  const out: string[] = [];
  let line = '';
  for (const word of words) {
    // A single word longer than the budget is hard-split rather than allowed
    // to shear the row: tileFromLines truncates, and a silent truncation reads
    // as data loss.
    if (word.length > budget) {
      if (line !== '') {
        out.push(indent + line);
        line = '';
      }
      let rest = word;
      while (rest.length > budget) {
        out.push(indent + rest.slice(0, budget));
        rest = rest.slice(budget);
      }
      line = rest;
      continue;
    }
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length <= budget) {
      line += ` ${word}`;
    } else {
      out.push(indent + line);
      line = word;
    }
  }
  if (line !== '') out.push(indent + line);
  return out;
}

/**
 * The lines a session's thumbnail shows, exactly TILE_ROWS of them.
 *
 * Padded at the BOTTOM (not the top, which is what tileFromLines would do on
 * its own) so content reads from the top edge, matching the mockup. A real
 * per-pane tile will bottom-anchor instead, like a shell — that difference is
 * the tell that this is still the stand-in.
 */
export function tileLinesFor(s: SessionState): string[] {
  const out: string[] = [];
  const group = groupFor(s);

  switch (group) {
    case 'Needs input':
      out.push(`? ${s.waitingFor ?? 'input needed'}`);
      out.push('');
      out.push(...wrap(s.doing ?? 'waiting for a decision', TILE_COLS, IND));
      out.push('');
      out.push(`${IND}> waiting for you...`);
      break;

    case 'Working':
      out.push('* working');
      out.push('');
      out.push(...wrap(s.doing ?? '', TILE_COLS, IND));
      if (s.doneMeans) {
        out.push('');
        out.push(...wrap(`done means: ${s.doneMeans}`, TILE_COLS, IND));
      }
      break;

    case 'Ready for review':
      out.push(`+ PR #${s.pr ?? 0}`);
      out.push('');
      out.push(...wrap(s.doing ?? 'ready for review', TILE_COLS, IND));
      break;

    case 'Completed':
      out.push(s.state === 'failed' ? 'x failed' : `. ${s.state}`);
      out.push('');
      out.push(...wrap(s.doing ?? '', TILE_COLS, IND));
      break;
  }

  const trimmed = out.slice(0, TILE_ROWS);
  while (trimmed.length < TILE_ROWS) trimmed.push('');
  return trimmed;
}

/** A session's thumbnail, ready for preview-canvas.renderTile(). */
export function tileForSession(s: SessionState): PreviewTile {
  return tileFromLines(tileLinesFor(s), TILE_COLS, TILE_ROWS);
}
