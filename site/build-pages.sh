#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

test -f web/storybook-static/index.html || { echo 'Build Storybook first: cd web && npm run build:storybook' >&2; exit 1; }
test -f site/assets/workspace-desktop.webp || { echo 'Missing desktop product capture' >&2; exit 1; }
test -f site/assets/workspace-phone.webp || { echo 'Missing phone product capture' >&2; exit 1; }

rm -rf pages-dist
mkdir -p pages-dist/storybook
cp -R site/index.html site/styles.css site/assets pages-dist/
cp -R web/storybook-static/. pages-dist/storybook/
node web/scripts/build-pages-docs.mjs
touch pages-dist/.nojekyll

test -f pages-dist/index.html
test -f pages-dist/storybook/index.html
echo 'Pages artifact ready: landing root + /docs/ + /storybook/'
