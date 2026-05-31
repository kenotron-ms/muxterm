import { html, type TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { IconNode } from 'lucide';

/**
 * SVG attribute map. Values may be strings, numbers, or undefined.
 * We filter out undefined and stringify the rest.
 */
type AttrMap = Record<string, string | number | undefined>;

function buildAttrs(attrs: AttrMap): string {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${String(v)}"`)
    .join(' ');
}

function renderNodes(nodes: IconNode): string {
  return nodes.map(([tag, attrs]) => `<${tag} ${buildAttrs(attrs as AttrMap)} />`).join('');
}

/**
 * Renders a Lucide icon as a Lit TemplateResult containing an inline SVG element.
 *
 * The SVG uses `stroke="currentColor"` so it inherits the surrounding text color.
 * Size defaults to 16×16 to match typical button icon sizes.
 *
 * @example
 * import { Maximize2 } from 'lucide';
 * import { icon } from '../lib/icons.js';
 * // In a template:
 * html`<button>${icon(Maximize2)}</button>`
 */
export function icon(
  iconNodes: IconNode,
  { size = 16, className = '' }: { size?: number; className?: string } = {},
): TemplateResult {
  const cls = className ? `lucide-icon ${className}` : 'lucide-icon';
  const svgStr =
    `<svg xmlns="http://www.w3.org/2000/svg"` +
    ` width="${size}" height="${size}"` +
    ` viewBox="0 0 24 24"` +
    ` fill="none"` +
    ` stroke="currentColor"` +
    ` stroke-width="2"` +
    ` stroke-linecap="round"` +
    ` stroke-linejoin="round"` +
    ` class="${cls}"` +
    ` aria-hidden="true"` +
    `>${renderNodes(iconNodes)}</svg>`;
  return html`${unsafeHTML(svgStr)}`;
}
