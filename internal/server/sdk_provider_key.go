package server

import (
	"io"
	"os"
	"path/filepath"
	"strings"
)

func sdkAmplifierProviderKey(name string) string {
	if key := strings.TrimSpace(os.Getenv(name)); key != "" {
		return key
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	for _, filename := range []string{"keys.env", "key.env"} {
		file, err := os.Open(filepath.Join(home, ".amplifier", filename))
		if err != nil {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(file, 64*1024))
		_ = file.Close()
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "export "))
			key, value, found := strings.Cut(line, "=")
			if found && strings.TrimSpace(key) == name {
				value = strings.TrimSpace(value)
				if len(value) >= 2 && (value[0] == '\'' && value[len(value)-1] == '\'' || value[0] == '"' && value[len(value)-1] == '"') {
					value = value[1 : len(value)-1]
				}
				return value
			}
		}
	}
	return ""
}
