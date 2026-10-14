import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || join(root, 'extensions/muxterm-browser-assistant-dev.zip'));
const files = ['manifest.json', 'automation.js', 'worker.js', 'popup.html', 'popup.js', 'popup.css', 'README.md'];
const manifest = JSON.parse(readFileSync(join(root, 'extensions/browser-assistant/manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid extension manifest');
const staging = mkdtempSync(join(tmpdir(), 'muxterm-browser-package-'));
try {
  mkdirSync(join(staging, 'browser-assistant'));
  for (const name of [...files.map(name => `extensions/browser-assistant/${name}`), 'LICENSE']) {
    const source = join(root, name);
    if (!lstatSync(source).isFile()) throw new Error(`Expected a regular source file: ${name}`);
    const target = name === 'LICENSE' ? 'LICENSE' : `browser-assistant/${name.split('/').at(-1)}`;
    copyFileSync(source, join(staging, target));
  }
  mkdirSync(dirname(output), {recursive: true});
  if (existsSync(output)) rmSync(output);
  execFileSync('zip', ['-X', '-q', '-r', output, 'browser-assistant', 'LICENSE'], {cwd: staging});
  console.log(`Packaged Browser Assistant ${manifest.version}: ${output}`);
} finally {
  rmSync(staging, {recursive: true, force: true});
}
