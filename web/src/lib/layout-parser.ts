import type { LayoutNode, LayoutLeaf, LayoutSplit, SplitDirection } from '../types';

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/**
 * Parse dimensions from layout string at given position.
 * Format: WxH,X,Y
 * Returns [width, height, x, y, nextPos]
 */
function parseDimensions(s: string, pos: number): [number, number, number, number, number] {
  // Parse width (digits before 'x')
  let i = pos;
  while (i < s.length && isDigit(s[i])) i++;
  const width = parseInt(s.substring(pos, i), 10);

  // Skip 'x'
  i++;

  // Parse height (digits before ',')
  const hStart = i;
  while (i < s.length && isDigit(s[i])) i++;
  const height = parseInt(s.substring(hStart, i), 10);

  // Skip ','
  i++;

  // Parse x
  const xStart = i;
  while (i < s.length && isDigit(s[i])) i++;
  const x = parseInt(s.substring(xStart, i), 10);

  // Skip ','
  i++;

  // Parse y
  const yStart = i;
  while (i < s.length && isDigit(s[i])) i++;
  const y = parseInt(s.substring(yStart, i), 10);

  return [width, height, x, y, i];
}

function parseNode(s: string, pos: number): [LayoutNode, number] {
  const [width, height, x, y, afterDims] = parseDimensions(s, pos);

  // Check what follows dimensions
  const ch = s[afterDims];

  if (ch === '{' || ch === '[') {
    // Split node
    const direction: SplitDirection = ch === '{' ? 'horizontal' : 'vertical';
    const closeBracket = ch === '{' ? '}' : ']';
    const children: LayoutNode[] = [];
    let i = afterDims + 1; // skip opening bracket

    while (i < s.length && s[i] !== closeBracket) {
      const [child, nextPos] = parseNode(s, i);
      children.push(child);
      i = nextPos;
      // Skip comma separator between children
      if (i < s.length && s[i] === ',') {
        i++;
      }
    }

    // Skip closing bracket
    if (i < s.length && s[i] === closeBracket) {
      i++;
    }

    const node: LayoutSplit = { type: 'split', direction, width, height, x, y, children };
    return [node, i];
  }

  // Leaf node: comma followed by pane ID
  // afterDims should be at ',' before pane ID
  let i = afterDims;
  if (i < s.length && s[i] === ',') {
    i++; // skip comma
  }
  const idStart = i;
  while (i < s.length && isDigit(s[i])) i++;
  const paneId = parseInt(s.substring(idStart, i), 10);

  const node: LayoutLeaf = { type: 'leaf', paneId, width, height, x, y };
  return [node, i];
}

/**
 * Parse a tmux layout string into a tree of LayoutNode objects.
 */
export function parseLayout(layout: string): LayoutNode {
  if (!layout) {
    throw new Error('Empty layout string');
  }

  // Strip checksum prefix (everything before the first comma)
  const firstComma = layout.indexOf(',');
  if (firstComma === -1) {
    throw new Error('Invalid layout format: no comma found');
  }

  const [node] = parseNode(layout, firstComma + 1);
  return node;
}