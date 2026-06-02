package web

import "embed"

// Dist embeds the built web frontend assets from web/dist/.
//
//go:embed dist/*
var Dist embed.FS
