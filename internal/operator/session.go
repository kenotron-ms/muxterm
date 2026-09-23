// Package operator owns the identity of muxterm's persistent Operator session.
package operator

import "os"

const (
	DefaultSessionID = "muxterm-cos"
	EnvSessionID     = "MUXTERM_COS_SESSION_ID"
)

// ResolveSessionID returns the Operator session id and where it came from.
func ResolveSessionID(override string) (id, source string) {
	if override != "" {
		return override, "explicit"
	}
	if env := os.Getenv(EnvSessionID); env != "" {
		return env, "$" + EnvSessionID
	}
	return DefaultSessionID, "default"
}

// IsSession reports whether id names this muxterm instance's Operator.
func IsSession(id string) bool {
	operatorID, _ := ResolveSessionID("")
	return id != "" && id == operatorID
}

// IsFleetSession recognizes the Operator after sessiond's durable hook ingress
// has projected a native Amplifier id into its harness-qualified fleet id.
// nativeID is the hook's execution/run identity when available.
func IsFleetSession(id, harness, nativeID string) bool {
	operatorID, _ := ResolveSessionID("")
	if id == operatorID {
		return true
	}
	return harness == "amplifier" &&
		(nativeID == operatorID || id == "amplifier-"+operatorID)
}
