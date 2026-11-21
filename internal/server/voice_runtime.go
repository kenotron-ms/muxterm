package server

import (
	"fmt"
	"net/http"

	muxcfg "github.com/kenotron-ms/muxterm/internal/config"
)

// currentSDKVoice returns a host whose lifetime extends through a request.
// A replaced host rejects a late connection and closes its existing calls.
func (s *Server) currentSDKVoice() *sdkVoiceHost {
	s.voiceMu.RLock()
	h := s.sdkVoice
	s.voiceMu.RUnlock()
	return h
}

func (s *Server) currentVoiceGeneration() uint64 {
	s.voiceMu.RLock()
	generation := s.voiceGeneration
	s.voiceMu.RUnlock()
	return generation
}

func (s *Server) voiceProvider() string {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	if !s.cfg.Voice.Enabled {
		return ""
	}
	if s.cfg.Voice.Provider == "gemini" {
		return "gemini"
	}
	return "openai"
}

func (s *Server) requireVoiceProvider(w http.ResponseWriter, r *http.Request, provider string) bool {
	if s.voiceProvider() == provider {
		return true
	}
	http.NotFound(w, r)
	return false
}

// prepareVoiceHost runs before persisting a new config. A bad enabled config
// cannot replace the working host or be reported as successfully applied.
func (s *Server) prepareVoiceHost(v muxcfg.VoiceConfig) (*sdkVoiceHost, error) {
	if !v.Enabled {
		return nil, nil
	}
	if err := v.Validate(); err != nil {
		return nil, err
	}
	if v.Provider == "gemini" {
		if !s.geminiVoiceKeyPresent(v) {
			return nil, fmt.Errorf("Gemini Live needs a saved API key before it can be enabled")
		}
		return nil, nil
	}
	if v.AuthMode == muxcfg.VoiceAuthAPIKey && !s.voiceKeyPresent(v) {
		return nil, fmt.Errorf("Voice cannot be turned on yet: no key is saved for this mode")
	}
	return newSDKVoiceHost(v, s.sdkChats)
}

// applyVoiceConfig publishes the new provider and retires active calls.
// Settings mutations are serialized by voiceSettingsMu; request readers use
// voiceMu or cfgMu and never observe an unsynchronized host pointer.
func (s *Server) applyVoiceConfig(v muxcfg.VoiceConfig, next *sdkVoiceHost) {
	s.voiceMu.Lock()
	old := s.sdkVoice
	s.sdkVoice = next
	s.voiceGeneration++
	s.cfgMu.Lock()
	s.cfg.Voice = v
	s.cfgMu.Unlock()
	s.voiceMu.Unlock()

	if old != nil {
		old.closeWithReason("Voice settings changed. Start a new call to use the saved provider.")
	}
	s.geminiVoiceMu.Lock()
	sessions := s.geminiVoiceSessions
	s.geminiVoiceSessions = nil
	s.geminiVoiceMu.Unlock()
	for id, entry := range sessions {
		s.sdkChats.appendEvent(sdkEvent{SessionID: entry.chatID, Type: "voice.session.error",
			GenerationID: id, Message: "Voice settings changed. Start a new call to use the saved provider."})
	}
}
