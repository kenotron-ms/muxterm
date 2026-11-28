import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { posix as path } from 'node:path';
import { Marked } from 'marked';

const root = new URL('../../', import.meta.url);
const repository = 'https://github.com/kenotron-ms/muxterm';
const pages = new Map([
  ['docs/user/README.md', 'docs/index.html'],
  ['docs/user/installation.md', 'docs/installation.html'],
  ['docs/user/remote-projects.md', 'docs/remote-projects.html'],
  ['docs/user/first-chat.md', 'docs/first-chat.html'],
  ['docs/user/work.md', 'docs/work.html'],
]);

const images = new Map([
  ['docs/marketing/work-digest.png', 'assets/work-digest.png'],
  ['site/assets/workspace-phone.webp', 'assets/workspace-phone.webp'],
]);

for (const [source, output] of pages) {
  const markdown = await readFile(new URL(source, root), 'utf8');
  const title = markdown.match(/^# (.+)$/m)?.[1];
  if (!title || /[<>&"]/.test(title)) {
    throw new Error(`Expected a plain-text title in ${source}`);
  }

  const parser = new Marked({
    renderer: {
      image(token) {
        const asset = images.get(path.join(path.dirname(source), token.href));
        if (asset) {
          token.href = path.relative(path.dirname(output), asset);
        }
        return false;
      },
      link(token) {
        if (!/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(token.href)) {
          const [pathname, fragment = ''] = token.href.split(/(?=#)/, 2);
          const target = path.join(path.dirname(source), pathname);
          const published = pages.get(target);
          const kind = pathname.endsWith('/') ? 'tree' : 'blob';
          token.href = (published
            ? path.relative(path.dirname(output), published)
            : `${repository}/${kind}/main/${target}`) + fragment;
        }
        return false;
      },
    },
  });
  const body = parser.parse(markdown);
  const destination = new URL(`pages-dist/${output}`, root);
  await mkdir(new URL('./', destination), { recursive: true });
  await writeFile(destination, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} | Muxterm</title>
  <link rel="icon" href="../assets/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="../styles.css">
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="site-header docs-header">
    <a class="brand" href="../"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>muxterm</a>
    <nav aria-label="Main navigation">
      <a href="./"${output === 'docs/index.html' ? ' aria-current="page"' : ''}>User guide</a>
      <a href="installation.html">Setup</a>
    </nav>
  </header>
  <main class="docs-content shell" id="main">
${body}
  </main>
</body>
</html>
`);
}
