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

func workCatalogConfig(option workHarnessOption, catalog workCatalog, prior *sdkChat) (sdkWorkConfiguration, error) {
	config := sdkWorkConfiguration{Harness: option.Harness, Provider: option.Provider}
	if prior != nil {
		if prior.Harness != option.Harness || (prior.Provider != "" && prior.Provider != option.Provider && option.Harness != "amplifier") {
			return config, errors.New("previous worker harness or provider is unavailable")
		}
		config.Bundle, config.Model, config.Effort = prior.Bundle, prior.Model, prior.Effort
		if prior.Provider != "" {
			config.Provider = prior.Provider
		}
	}
	if option.Harness == "amplifier" {
		if config.Bundle == "" {
			config.Bundle = catalog.Bundle
		}
		if catalog.Bundles != nil && !slices.Contains(catalog.Bundles, config.Bundle) {
			return config, errors.New("previous worker bundle is unavailable")
		}
		if prior == nil || prior.Provider == "" {
			if catalog.Provider != "" {
				config.Provider = catalog.Provider
			}
		}
		if catalog.Providers != nil && !slices.Contains(catalog.Providers, config.Provider) {
			return config, errors.New("previous worker provider is unavailable")
		}
	} else if config.Bundle != "" {
		return config, errors.New("previous worker bundle is incompatible with this harness")
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
		// Claude's SDK stream uses high when no effort is stored. New
		// workers receive this explicitly; reused workers keep that same
		// effective setting instead of being mislabeled medium.
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

// An owner of a completed direct prerequisite is the only automatic reuse
// source. A participant link, recent activity, or similar title says nothing
// about whether that chat contains useful task context.
func (h *sdkChatHost) workContextCandidatesLocked(item *sdkWorkItem) map[string]string {
	result := map[string]string{}
	for _, dependencyID := range item.DependsOn {
		dependency := h.workItems[dependencyID]
		if dependency == nil || dependency.Status != "done" {
			continue
		}
		workerID := dependency.OwnerSessionID
		if workerID == "" && dependency.Dispatch != nil && dependency.Dispatch.State == "claimed" {
			workerID = dependency.Dispatch.SessionID
		}
		if workerID != "" {
			result[workerID] = dependencyID
		}
	}
	return result
}

func (s *Server) workDefaultHarness() string {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	if s.cfg.AI.DefaultHarness == "" {
		return "antigravity"
	}
	return s.cfg.AI.DefaultHarness
}

func (s *Server) selectWorkConfiguration(ctx context.Context, chosen string, candidates []sdkChat, related map[string]string, goalReady map[string]bool, projectPath string) (sdkWorkConfiguration, string, string, string, error) {
	options, err := s.workHarnessOptions(ctx)
	if err != nil {
		return sdkWorkConfiguration{}, "", "", "", err
	}
	index := slices.IndexFunc(options, func(option workHarnessOption) bool { return option.Harness == chosen })
	if index < 0 {
		return sdkWorkConfiguration{}, "", "", "", fmt.Errorf("selected Work harness %q is unavailable or lacks a safe Work goal path; install or qualify that harness, then retry this Work item", chosen)
	}
	option := options[index]
	catalog, err := s.workModelCatalog(ctx, chosen, option.Provider, "", projectPath)
	if err != nil {
		return sdkWorkConfiguration{}, "", "", "", fmt.Errorf("selected Work harness %q has no available configuration: %w; fix its setup, then retry", chosen, err)
	}
	selected, err := workCatalogConfig(option, catalog, nil)
	if err != nil {
		return sdkWorkConfiguration{}, "", "", "", fmt.Errorf("selected Work harness %q has incompatible settings: %w; update its model settings, then retry", chosen, err)
	}
	var skipped []string
	// Dependency order is stable because DependsOn is normalized at write time.
	for _, chat := range candidates {
		if related[chat.ID] == "" {
			continue
		}
		if chat.Harness != chosen {
			skipped = append(skipped, "related chat "+chat.ID+" uses "+chat.Harness+", not "+chosen)
			continue
		}
		if !goalReady[chat.ID] {
			skipped = append(skipped, "related chat "+chat.ID+" has an active or paused goal")
			continue
		}
		priorCatalog, catalogErr := s.workModelCatalog(ctx, chosen, chat.Provider, chat.Bundle, chat.ProjectPath)
		if catalogErr == nil {
			var prior sdkWorkConfiguration
			prior, catalogErr = workCatalogConfig(option, priorCatalog, &chat)
			if catalogErr == nil && prior == selected {
				return selected, chat.ID, related[chat.ID], strings.Join(skipped, "; "), nil
			}
			if catalogErr == nil {
				catalogErr = errors.New("provider, bundle, model, or effort differs from the selected configuration")
			}
		}
		skipped = append(skipped, "related chat "+chat.ID+" is incompatible: "+catalogErr.Error())
	}
	return selected, "", "", strings.Join(skipped, "; "), nil
}

// Pin the resolved settings on a reused chat before installing its Work goal.
// A catalog default is only a prediction until the adapter accepts select.
func (s *Server) applyReusedWorkConfiguration(ctx context.Context, chatID string, config sdkWorkConfiguration) error {
	h := s.sdkChats
	h.mu.Lock()
	current := h.chats[chatID]
	if current == nil || current.Archived || current.State != "ready" {
		h.mu.Unlock()
		return errors.New("related worker is no longer available")
	}
	chat := *current
	h.mu.Unlock()
	if err := h.resume(ctx, &chat); err != nil {
		return fmt.Errorf("resume related worker: %w", err)
	}
	result, err := h.call(ctx, "select", map[string]any{"sessionId": chatID, "bundle": config.Bundle, "provider": amplifierProviderModule(config.Harness, config.Provider), "model": config.Model, "effort": config.Effort})
	if err != nil {
		return fmt.Errorf("activate related worker settings: %w", err)
	}
	var selected struct {
		Bundle, Provider, Model, Effort string
	}
	if err := json.Unmarshal(result, &selected); err != nil {
		return fmt.Errorf("read activated worker settings: %w", err)
	}
	if selected.Model != config.Model || selected.Effort != config.Effort || (selected.Bundle != "" && selected.Bundle != config.Bundle) || (selected.Provider != "" && selected.Provider != config.Provider && selected.Provider != amplifierProviderModule(config.Harness, config.Provider)) {
		return errors.New("related worker did not activate the selected configuration")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	current = h.chats[chatID]
	if current == nil || current.State != "ready" || current.Archived {
		return errors.New("related worker changed while settings were applied")
	}
	previous := *current
	current.Bundle, current.Provider, current.Model, current.Effort = config.Bundle, config.Provider, config.Model, config.Effort
	if err := h.saveLocked(current); err != nil {
		*current = previous
		return err
	}
	return nil
}
