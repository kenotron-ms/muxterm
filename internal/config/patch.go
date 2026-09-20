package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
)

// Patch applies only explicitly supplied fields. Writable sections opt in on
// Config; their fields are discovered from the schema, not a second merge list.
// File-only sections remain inaccessible, including fields hidden from JSON.
func Patch(base Config, changes map[string]json.RawMessage) (Config, error) {
	result := base
	if err := patchFields(reflect.ValueOf(&result).Elem(), changes, ""); err != nil {
		return Config{}, err
	}
	if _, ok := changes["lanes"]; ok && result.Lanes.Approval != "prompt" && result.Lanes.Approval != "never" {
		return Config{}, fmt.Errorf("lanes.approval: invalid value %q (want prompt or never)", result.Lanes.Approval)
	}
	return result, nil
}

func patchFields(dst reflect.Value, changes map[string]json.RawMessage, prefix string) error {
	keys := make([]string, 0, len(changes))
	for key := range changes {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		path := prefix + key
		index := -1
		for i := 0; i < dst.NumField(); i++ {
			field := dst.Type().Field(i)
			if strings.Split(field.Tag.Get("json"), ",")[0] == key || strings.Split(field.Tag.Get("toml"), ",")[0] == key {
				index = i
				break
			}
		}
		if index < 0 {
			return fmt.Errorf("%s: unknown config key", path)
		}
		field := dst.Type().Field(index)
		if field.Tag.Get("json") == "-" || (prefix == "" && field.Tag.Get("patch") != "true") {
			return fmt.Errorf("%s: not writable via update_config; edit the config file", path)
		}
		raw := changes[key]
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return fmt.Errorf("%s: null is not a config value", path)
		}
		value := dst.Field(index)
		if value.Kind() == reflect.Struct {
			var nested map[string]json.RawMessage
			if err := json.Unmarshal(raw, &nested); err != nil {
				return fmt.Errorf("%s: expected an object: %w", path, err)
			}
			if err := patchFields(value, nested, path+"."); err != nil {
				return err
			}
		} else if err := json.Unmarshal(raw, value.Addr().Interface()); err != nil {
			return fmt.Errorf("%s: invalid value: %w", path, err)
		}
	}
	return nil
}

// VerifyPatch compares the original request with independently loaded config.
// It does not compare a merged object with itself or silently normalize values.
func VerifyPatch(cfg Config, changes map[string]json.RawMessage) error {
	encoded, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	var actual map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &actual); err != nil {
		return err
	}
	return verifyFields(actual, changes, "")
}

func verifyFields(actual, changes map[string]json.RawMessage, prefix string) error {
	for key, raw := range changes {
		var want, got any
		if err := json.Unmarshal(raw, &want); err != nil {
			return err
		}
		if err := json.Unmarshal(actual[key], &got); err != nil {
			return fmt.Errorf("%s%s: missing after persistence", prefix, key)
		}
		if _, ok := want.(map[string]any); ok {
			var child, expected map[string]json.RawMessage
			_ = json.Unmarshal(actual[key], &child)
			_ = json.Unmarshal(raw, &expected)
			if err := verifyFields(child, expected, prefix+key+"."); err != nil {
				return err
			}
		} else if !reflect.DeepEqual(want, got) {
			return fmt.Errorf("%s%s: requested %s, persisted %s", prefix, key, raw, actual[key])
		}
	}
	return nil
}
