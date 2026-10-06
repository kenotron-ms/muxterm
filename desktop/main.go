package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"log"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed assets/*
var assets embed.FS

func main() {
	companion := newCompanion()
	var tokenBytes [32]byte
	if _, err := rand.Read(tokenBytes[:]); err != nil {
		log.Fatal(err)
	}
	companion.token = hex.EncodeToString(tokenBytes[:])
	app := application.New(application.Options{
		Name:              "Muxterm",
		Description:       "Muxterm for Mac with browser previews and local port forwarding",
		Services:          []application.Service{application.NewService(companion)},
		Assets:            application.AssetOptions{Handler: application.BundledAssetFileServer(assets)},
		RawMessageHandler: companion.browserMessage,
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})
	companion.app = app
	app.OnShutdown(companion.close)
	menu := app.NewMenu()
	if runtime.GOOS == "darwin" {
		menu.AddRole(application.AppMenu)
	}
	muxMenu := menu.AddSubmenu("Muxterm")
	muxMenu.Add("Show muxterm").OnClick(func(*application.Context) {
		_ = companion.openMuxtermWindow()
	})
	muxMenu.Add("Connection and ports…").OnClick(func(*application.Context) {
		companion.showSettings()
	})
	menu.AddRole(application.WindowMenu)
	app.Menu.Set(menu)
	settings := companion.settings
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name: "companion", Title: "Muxterm Settings", URL: "/",
		Width: 640, Height: 690, MinWidth: 520, MinHeight: 570,
		JS:     "globalThis.muxtermCompanionToken = '" + companion.token + "'",
		Hidden: settings.ServerURL != "",
	})
	if settings.ServerURL != "" {
		if err := companion.openMuxtermWindow(); err != nil {
			log.Printf("could not open saved muxterm URL: %v", err)
			companion.showSettings()
		}
	}
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
