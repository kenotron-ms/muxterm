package web

import "embed"

// Dist embeds the built web frontend assets from web/dist/.
//
//go:embed dist/*
var Dist embed.FS

// PublicDist embeds the ONE asset served without authentication: the renderer
// that turns a published markdown file into a page at /p/{id}.
//
// It is a separate embed because it is a separate build with a separate output
// directory -- see web/vite.public-doc.config.ts for why, and
// internal/server/publish_api.go for what reads it. Keeping it out of dist/
// also means the anonymous route cannot accidentally reach the application
// bundle: the two directories have no file in common.
//
//go:embed dist-public/*
var PublicDist embed.FS
