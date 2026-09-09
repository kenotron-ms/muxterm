package server

// publicDocCSS styles the public markdown page.
//
// It is inlined into the page rather than served as a second asset because it
// is small, because one fewer public route is one fewer thing to reason about,
// and because the page must render legibly even if the script never arrives.
//
// Deliberately plain: this page is somebody's document, seen by somebody who
// has never heard of muxterm. It carries no app chrome, no branding beyond one
// grey footer line, and no controls -- there is nothing here to click.
const publicDocCSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2.5rem 1.25rem 4rem;
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: #1c1f23;
  background: #ffffff;
}
.doc { max-width: 46rem; margin: 0 auto; overflow-wrap: break-word; }
.loading { color: #6b7280; }
.doc h1, .doc h2, .doc h3, .doc h4, .doc h5, .doc h6 {
  line-height: 1.25; margin: 2rem 0 0.75rem; font-weight: 650;
}
.doc h1 { font-size: 1.9rem; margin-top: 0; }
.doc h2 { font-size: 1.45rem; }
.doc h3 { font-size: 1.2rem; }
.doc p, .doc ul, .doc ol, .doc blockquote, .doc table { margin: 0 0 1rem; }
.doc ul, .doc ol { padding-left: 1.5rem; }
.doc li { margin: 0.25rem 0; }
.doc a { color: #0b57d0; text-decoration: underline; text-underline-offset: 2px; }
.doc blockquote {
  margin-left: 0; padding-left: 1rem; border-left: 3px solid #d5d8dd; color: #4b5058;
}
.doc code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.9em; background: #f2f3f5; padding: 0.12em 0.35em; border-radius: 3px;
}
.doc pre {
  background: #f6f7f9; padding: 0.9rem 1rem; overflow-x: auto; border-radius: 4px;
  margin: 0 0 1rem;
}
.doc pre code { background: none; padding: 0; font-size: 0.875rem; }
.doc table { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
.doc th, .doc td { border: 1px solid #dcdfe4; padding: 0.4rem 0.6rem; text-align: left; }
.doc th { background: #f6f7f9; font-weight: 600; }
.doc img { max-width: 100%; height: auto; }
.doc hr { border: 0; border-top: 1px solid #dcdfe4; margin: 2rem 0; }
.pub-footer {
  max-width: 46rem; margin: 3rem auto 0; padding-top: 1rem;
  border-top: 1px solid #e5e7eb;
  font-size: 0.78rem; color: #8a9099; letter-spacing: 0.01em;
}
@media (prefers-color-scheme: dark) {
  body { color: #dfe3e8; background: #14171a; }
  .loading { color: #8a9099; }
  .doc a { color: #7cb0ff; }
  .doc blockquote { border-left-color: #333a42; color: #a8afb8; }
  .doc code { background: #1f2429; }
  .doc pre { background: #1b1f24; }
  .doc th, .doc td { border-color: #2c3238; }
  .doc th { background: #1b1f24; }
  .doc hr { border-top-color: #2c3238; }
  .pub-footer { border-top-color: #24292f; color: #6f767e; }
}
`

// publicTreeCSS is appended to publicDocCSS on the pages of a published
// FOLDER, and only there. It styles the two things a single published file
// does not have: a breadcrumb trail and a directory listing.
//
// Deliberately typographic. No card, no rounded container, and no bolded
// side border used as a status signal -- indentation, weight and ink carry
// the structure, which is what a reader who has never heard of muxterm
// actually needs from somebody's docs folder.
const publicTreeCSS = `
.pub-crumbs {
  max-width: 46rem; margin: 0 auto 1.75rem; font-size: 0.82rem;
  color: #6b7280; letter-spacing: 0.01em; overflow-wrap: anywhere;
}
.pub-crumbs a { color: #6b7280; text-decoration: none; }
.pub-crumbs a:hover { color: #0b57d0; text-decoration: underline; }
.pub-crumbs .sep { padding: 0 0.4em; color: #b9bec6; }
.pub-crumbs .here { color: #1c1f23; font-weight: 600; }
.pub-index { max-width: 46rem; margin: 2.5rem auto 0; }
.pub-index-h {
  font-size: 0.78rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.08em; color: #8a9099; margin: 0 0 0.6rem;
}
.pub-list { list-style: none; margin: 0; padding: 0; }
.pub-list li { margin: 0; padding: 0.22rem 0; line-height: 1.5; }
.pub-list a { color: #0b57d0; text-decoration: none; }
.pub-list a:hover { text-decoration: underline; }
.pub-list .dir a { font-weight: 600; }
.pub-list .file a { color: #4b5058; }
.pub-list .up a { color: #8a9099; font-size: 0.85rem; }
.pub-list .empty { color: #8a9099; font-style: italic; }
@media (prefers-color-scheme: dark) {
  .pub-crumbs, .pub-crumbs a { color: #8a9099; }
  .pub-crumbs .sep { color: #4b5058; }
  .pub-crumbs .here { color: #dfe3e8; }
  .pub-crumbs a:hover { color: #7cb0ff; }
  .pub-index-h { color: #6f767e; }
  .pub-list a { color: #7cb0ff; }
  .pub-list .file a { color: #a8afb8; }
  .pub-list .up a, .pub-list .empty { color: #6f767e; }
}
`
