import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const directory = new URL('../src/ui/', import.meta.url);
const files = await readdir(directory);
let failed = false;

function styleSource(source) {
  return [
    ...source.matchAll(/\bcss`([\s\S]*?)`/g),
    ...source.matchAll(/\bsurfaceCSS\s*=\s*`([\s\S]*?)`/g),
    ...source.matchAll(/\bvisualizationCSS\s*=\s*`([\s\S]*?)`/g),
    ...source.matchAll(/\bstyle\.textContent\s*=\s*`([\s\S]*?)`/g),
    ...source.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi),
    ...source.matchAll(/\bunsafeCSS\(\s*(['"`])([\s\S]*?)\1\s*\)/g),
  ].map(match => match[2] ?? match[1]).join('\n');
}

function literalScaleCount(styles) {
  // Keep the declaration separator available for the next match.
  return [...styles.matchAll(/(?:(?<=;)|(?<=\{)|^)\s*(?:padding(?:-(?:top|right|bottom|left))?|margin(?:-(?:top|right|bottom|left))?|gap|row-gap|column-gap|border-radius|font-size)\s*:\s*([^;{}]+);/gm)]
    .filter(match => /\b(?:[1-9]\d*(?:\.\d+)?|0?\.\d+)(?:px|rem|em)\b/.test(match[1])).length;
}

function literalColorCount(styles) {
  return [...styles.matchAll(/#[\da-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/gi)].length;
}

for (const file of files.filter(name => name.endsWith('.ts') && !name.endsWith('.stories.ts'))) {
  const source = await readFile(new URL(file, directory), 'utf8');
  const styles = styleSource(source);

  if (source.includes('@customElement(')) {
    const story = file.replace(/\.ts$/, '.stories.ts');
    if (!files.includes(story)) {
      console.error(`${join('src/ui', file)}: shared custom elements need a matching Storybook story`);
      failed = true;
    }
  }
  if (/var\(--(?:chrome|mux)-/.test(source)) {
    console.error(`${join('src/ui', file)}: use --ui-* semantic tokens instead of legacy theme variables`);
    failed = true;
  }
  if (/\bunsafeCSS\s*\(/.test(source)) {
    console.error(`${join('src/ui', file)}: shared styles cannot use unsafeCSS; use a semantic token`);
    failed = true;
  }
  if (/z-index\s*:\s*-?\d/.test(styles)) {
    console.error(`${join('src/ui', file)}: use the shared --ui-z-* layer tokens instead of a literal z-index`);
    failed = true;
  }
  if (literalColorCount(styles) || literalScaleCount(styles)) {
    console.error(`${join('src/ui', file)}: shared control styles must use --ui-* color and scale tokens`);
    failed = true;
  }
}

// Existing feature styles and native controls are being migrated screen by
// screen. Keep current usage as a ceiling so new work cannot add more of it
// without a reviewed baseline change and an inventory explanation.
const componentDirectory = new URL('../src/components/', import.meta.url);
const componentFiles = await readdir(componentDirectory);
const baseline = JSON.parse(await readFile(new URL('./ui-legacy-baseline.json', import.meta.url), 'utf8'));
const featureFiles = [
  ['app.ts', new URL('../src/app.ts', import.meta.url)],
  ...componentFiles
    .filter(name => name.endsWith('.ts') && !name.endsWith('.stories.ts'))
    .map(name => [`components/${name}`, new URL(name, componentDirectory)]),
];

for (const name of Object.keys(baseline)) {
  if (featureFiles.some(([file]) => file === name)) continue;
  console.error(`src/${name}: remove the stale legacy baseline entry`);
  failed = true;
}

for (const [name, url] of featureFiles) {
  const source = await readFile(url, 'utf8');
  if (/<(?:button|a)\b[^>]*\brole\s*=\s*['"]menuitem['"]/i.test(source)) {
    console.error(`src/${name}: use mux-ui-menu-item for feature menu actions`);
    failed = true;
  }
  // Sidebar width bounds share numeric constants with drag behavior. It is the
  // only feature allowed to embed those constants in Lit CSS.
  const unsafeCSSCalls = [...source.matchAll(/\bunsafeCSS\s*\(/g)].length;
  if (unsafeCSSCalls !== (name === 'components/mux-sidebar.ts' ? 2 : 0)) {
    console.error(`src/${name}: review unsafeCSS usage; only the two sidebar width bounds are allowed`);
    failed = true;
  }
  if (name !== 'app.ts' && source.includes('@customElement(') &&
      !componentFiles.includes(name.split('/').at(-1).replace(/\.ts$/, '.stories.ts'))) {
    console.error(`src/${name}: Lit custom elements need a matching Storybook story`);
    failed = true;
  }
  const styles = styleSource(source);
  if (/z-index\s*:\s*-?\d/.test(styles)) {
    console.error(`src/${name}: use the shared --ui-z-* layer tokens instead of a literal z-index`);
    failed = true;
  }
  const counts = {
    legacyTokens: [...styles.matchAll(/var\(--(?:chrome|mux)-[\w-]+/g)].length,
    literalColors: literalColorCount(styles),
    literalScale: literalScaleCount(styles),
    nativeControls: [...source.matchAll(/<(?:button|input|select|textarea)\b/g)].length,
  };
  const allowed = baseline[name] ?? { legacyTokens: 0, literalColors: 0, literalScale: 0, nativeControls: 0 };
  for (const key of Object.keys(counts)) {
    const ceiling = allowed[key] ?? 0;
    if (counts[key] === ceiling) continue;
    if (counts[key] < ceiling) {
      console.error(`src/${name}: ${key} fell from ${ceiling} to ${counts[key]}; lower the checked-in baseline to lock in the migration`);
    } else {
      console.error(`src/${name}: ${key} increased from ${ceiling} to ${counts[key]}; use shared UI components or --ui-* tokens, or document a necessary native control in the inventory`);
    }
    failed = true;
  }
}

if (failed) process.exitCode = 1;
else console.log('UI library stories and token boundaries are in place; feature legacy styles and native controls match the reviewed baseline.');
