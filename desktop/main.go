package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"log"
	"runtime"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/updater"
)

//go:embed assets/*
var assets embed.FS

func main() {
	// The updater's detached helper must enter swap mode before this process
	// starts a bundled server or opens any windows.
	updater.HandleHelperMode()
	companion := newCompanion()
	if err := companion.startBrowserAutomation(); err != nil {
		log.Printf("native browser automation unavailable: %v", err)
	}
	// Wait for the local server before opening WebKit so the first window always
	// contains muxterm instead of a transient connection or error page.
	_, localErr := companion.startLocalMuxterm()
	if localErr != nil {
		log.Printf("could not start local muxterm: %v", localErr)
	}
	var tokenBytes [32]byte
	if _, err := rand.Read(tokenBytes[:]); err != nil {
		log.Fatal(err)
	}
	companion.token = hex.EncodeToString(tokenBytes[:])
	app := application.New(application.Options{
		Name:              "Muxterm",
		Description:       "Muxterm for Mac",
		Services:          []application.Service{application.NewService(companion)},
		Assets:            application.AssetOptions{Handler: application.BundledAssetFileServer(assets)},
		RawMessageHandler: companion.browserMessage,
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})
	companion.app = app
	if err := companion.initMacUpdater(); err != nil {
		log.Printf("Mac updater unavailable: %v", err)
	}
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
	if runtime.GOOS == "darwin" {
		// WebKit routes Command editing shortcuts through the native responder
		// chain. Keep bare Backspace out of the menu so terminal input receives it.
		editMenu := menu.AddSubmenu("Edit")
		editMenu.AddRole(application.Undo)
		editMenu.AddRole(application.Redo)
		editMenu.AddSeparator()
		editMenu.AddRole(application.Cut)
		editMenu.AddRole(application.Copy)
		editMenu.AddRole(application.Paste)
		editMenu.AddRole(application.SelectAll)
	}
	menu.AddRole(application.WindowMenu)
	app.Menu.Set(menu)
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name: "companion", Title: "Muxterm Settings", URL: "/",
		Width: 640, Height: 540, MinWidth: 520, MinHeight: 460,
		JS:               "globalThis.muxtermCompanionToken = '" + companion.token + "'",
		Hidden:           localErr == nil,
		BackgroundColour: application.NewRGB(22, 22, 30),
		Mac: application.MacWindow{
			Appearance:              application.NSAppearanceNameDarkAqua,
			TitleBar:                application.MacTitleBarHidden,
			InvisibleTitleBarHeight: 42,
		},
	})
	if localErr == nil {
		if err := companion.openMuxtermWindow(); err != nil {
			log.Printf("could not open local muxterm: %v", err)
			companion.showSettings()
		}
	}
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
