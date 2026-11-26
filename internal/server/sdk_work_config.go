package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
)

type workHarnessOption struct {
	Harness  string `json:"harness"`
	Provider string `json:"provider"`
}

// A saved choice stays valid when its runtime is temporarily unavailable.
// Dispatch reports that condition instead of silently choosing another agent.
func validWorkHarness(harness string) bool {
	return harness == "" || slices.Contains([]string{"codex", "claude", "copilot", "amplifier", "amplifier-unified", "pi", "opencode", "deepseek", "antigravity"}, harness)
}

type workModelOption struct {
	ID            string   `json:"id"`
	Efforts       []string `json:"efforts"`
	DefaultEffort string   `json:"defaultEffort"`
}

type workCatalog struct {
	Bundle       string            `json:"bundle"`
	Provider     string            `json:"provider"`
	Model        string            `json:"model"`
	Effort       string            `json:"effort"`
	DefaultModel string            `json:"defaultModel"`
	Bundles      []string          `json:"bundles"`
	Providers    []string          `json:"providers"`
	Models       []workModelOption `json:"models"`
}

// Work uses the same steering, native goal, and native history admission as
// New Chat before reserving a dispatch.
func (s *Server) workHarnessOptions(ctx context.Context) ([]workHarnessOption, error) {
	request := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/sdk-chats/start-options", nil)
	response := httptest.NewRecorder()
	s.handleSDKChatStartOptions(response, request)
	if response.Code != http.StatusOK {
		return nil, fmt.Errorf("worker harness discovery: %s", strings.TrimSpace(response.Body.String()))
	}
	var options []workHarnessOption
	if err := json.Unmarshal(response.Body.Bytes(), &options); err != nil {
		return nil, fmt.Errorf("worker harness discovery: %w", err)
	}
	options = slices.DeleteFunc(options, func(option workHarnessOption) bool { return !supportsWorkGoalControl(option.Harness) })
	return options, nil
}

func supportsWorkGoalControl(harness string) bool {
	// OpenCode uses Muxterm's Work ledger and continuation loop. Its ACP
	// adapter does not expose native goal state or control.
	return supportsNativeGoalControl(harness) || harness == "opencode"
}

func (s *Server) workModelCatalog(ctx context.Context, harness, provider, bundle, projectPath string) (workCatalog, error) {
	query := url.Values{"harness": {harness}, "projectPath": {projectPath}}
	if provider != "" {
		query.Set("provider", provider)
	}
	if bundle != "" {
		query.Set("bundle", bundle)
	}
	request := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/sdk-chats/catalog?"+query.Encode(), nil)
	response := httptest.NewRecorder()
	s.handleSDKChatCatalog(response, request)
	if response.Code != http.StatusOK {
		return workCatalog{}, errors.New(strings.TrimSpace(response.Body.String()))
	}
	var catalog workCatalog
	if err := json.Unmarshal(response.Body.Bytes(), &catalog); err != nil {
		return workCatalog{}, err
	}
	return catalog, nil
}

func workCatalogConfig(option workHarnessOption, catalog workCatalog) (sdkWorkConfiguration, error) {
	config := sdkWorkConfiguration{Harness: option.Harness, Provider: option.Provider}
	if option.Harness == "amplifier" {
		config.Bundle = catalog.Bundle
		if catalog.Bundles != nil && !slices.Contains(catalog.Bundles, config.Bundle) {
			return config, errors.New("worker bundle is unavailable")
		}
		if catalog.Provider != "" {
			config.Provider = catalog.Provider
		}
		if catalog.Providers != nil && !slices.Contains(catalog.Providers, config.Provider) {
			return config, errors.New("worker provider is unavailable")
		}
	}
	if config.Model == "" {
		config.Model = catalog.Model
		if config.Model == "" {
			config.Model = catalog.DefaultModel
		}
		if config.Model == "" && len(catalog.Models) > 0 {
			config.Model = catalog.Models[0].ID
		}
	}
	if config.Model == "" {
		return config, fmt.Errorf("%s did not advertise an available model", option.Harness)
	}
	index := slices.IndexFunc(catalog.Models, func(model workModelOption) bool { return model.ID == config.Model })
	if index < 0 {
		return config, fmt.Errorf("model %q is unavailable for %s", config.Model, option.Harness)
	}
	model := catalog.Models[index]
	if config.Effort == "" {
		// Claude's SDK stream defaults to high when no effort is stored.
		if option.Harness == "claude" {
			config.Effort = "high"
		} else {
			config.Effort = model.DefaultEffort
		}
		if config.Effort == "" && slices.Contains(model.Efforts, "medium") {
			config.Effort = "medium"
		}
	}
	if config.Effort != "" && !slices.Contains(model.Efforts, config.Effort) {
		return config, fmt.Errorf("reasoning effort %q is unavailable for model %q", config.Effort, config.Model)
	}
	return config, nil
}

func (s *Server) workDefaultHarness() string {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	if s.cfg.AI.DefaultHarness == "" {
		return "antigravity"
	}
	return s.cfg.AI.DefaultHarness
}

func (s *Server) selectWorkConfiguration(ctx context.Context, chosen, projectPath string) (sdkWorkConfiguration, error) {
	options, err := s.workHarnessOptions(ctx)
	if err != nil {
		return sdkWorkConfiguration{}, err
	}
	index := slices.IndexFunc(options, func(option workHarnessOption) bool { return option.Harness == chosen })
	if index < 0 {
		return sdkWorkConfiguration{}, fmt.Errorf("selected Work harness %q is unavailable or lacks a safe Work goal path; install or qualify that harness, then retry this Work item", chosen)
	}
	option := options[index]
	catalog, err := s.workModelCatalog(ctx, chosen, option.Provider, "", projectPath)
	if err != nil {
		return sdkWorkConfiguration{}, fmt.Errorf("selected Work harness %q has no available configuration: %w; fix its setup, then retry", chosen, err)
	}
	selected, err := workCatalogConfig(option, catalog)
	if err != nil {
		return sdkWorkConfiguration{}, fmt.Errorf("selected Work harness %q has incompatible settings: %w; update its model settings, then retry", chosen, err)
	}
	return selected, nil
}
