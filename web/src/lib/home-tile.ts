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
 * DEFAULT tile geometry, in cells. Both functions below take the real
 * geometry as parameters; these are what they fall back to.
 *
 * TILE_COLS is a default, not the width. Under D7 the caller measures its own
 * track and passes the columns that track can carry at PREVIEW_CELL.w, so a
 * wider tile shows MORE CHARACTERS rather than bigger pixels. 40 remains the
 * value for a caller that has not measured anything yet: 40x9 at PREVIEW_CELL
 * (5x8 CSS px) is 200x72 px, the geometry every tile had before D7.
 *
 * TILE_ROWS is genuinely fixed at 9 — it is what the fields below actually
 * produce, and D7 keeps rows content-derived rather than aspect-locked.
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
 * The lines a session's thumbnail shows, exactly `rows` of them, wrapped to
 * `cols`.
 *
 * Both are parameters because the tile's width is measured from its own track
 * (D7) and a wrap width that disagreed with the canvas would either truncate
 * text the tile had room for or overrun the cells it has.
 *
 * Padded at the BOTTOM (not the top, which is what tileFromLines would do on
 * its own) so content reads from the top edge, matching the mockup. A real
 * per-pane tile will bottom-anchor instead, like a shell — that difference is
 * the tell that this is still the stand-in.
 */
export function tileLinesFor(
  s: SessionState,
  cols: number = TILE_COLS,
  rows: number = TILE_ROWS,
): string[] {
  const out: string[] = [];
  const group = groupFor(s);

  switch (group) {
    case 'Needs input':
      out.push(`? ${s.waitingFor ?? 'input needed'}`);
      out.push('');
      out.push(...wrap(s.doing ?? 'waiting for a decision', cols, IND));
      out.push('');
      out.push(`${IND}> waiting for you...`);
      break;

    case 'Running':
      out.push('* running');
      out.push('');
      out.push(...wrap(s.doing ?? '', cols, IND));
      if (s.doneMeans) {
        out.push('');
        out.push(...wrap(`done means: ${s.doneMeans}`, cols, IND));
      }
      break;

    case 'Completed': {
      const head = s.state === 'failed' ? 'x failed' : `. ${s.state}`;
      // A PR is a property of a finished session, not a group of its own.
      out.push(s.pr && s.pr > 0 ? `${head} - PR #${s.pr}` : head);
      out.push('');
      out.push(...wrap(s.doing ?? '', cols, IND));
      break;
    }
  }

  const trimmed = out.slice(0, rows);
  while (trimmed.length < rows) trimmed.push('');
  return trimmed;
}

/**
 * A session's thumbnail at `cols` x `rows`, ready for
 * preview-canvas.renderTile().
 */
export function tileForSession(
  s: SessionState,
  cols: number = TILE_COLS,
  rows: number = TILE_ROWS,
): PreviewTile {
  return tileFromLines(tileLinesFor(s, cols, rows), cols, rows);
}
