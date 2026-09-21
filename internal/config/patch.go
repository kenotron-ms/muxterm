package config

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/BurntSushi/toml"
)

// ApplyPatch merges explicitly present JSON fields. Writable sections are marked
// on Config; a newly added section must opt in or it fails closed, never silently
// disappearing in a hand-maintained list of field assignments.
func ApplyPatch(base Config, patch map[string]json.RawMessage) (Config, error) {
	if patch == nil {
		return base, fmt.Errorf("changes: expected an object")
	}
	encoded, err := json.Marshal(base)
	if err != nil {
		return base, err
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &object); err != nil {
		return base, err
	}
	if err := mergePatch(object, patch, reflect.TypeOf(base), ""); err != nil {
		return base, err
	}
	encoded, err = json.Marshal(object)
	if err != nil {
		return base, err
	}
	result := base // retain fields deliberately hidden from JSON
	if err := json.Unmarshal(encoded, &result); err != nil {
		return base, err
	}
	if result.Lanes.Approval != "prompt" && result.Lanes.Approval != "never" {
		return base, fmt.Errorf("lanes.approval: invalid value %q (want prompt or never)", result.Lanes.Approval)
	}
	return result, nil
}

func mergePatch(dst, patch map[string]json.RawMessage, typ reflect.Type, prefix string) error {
	keys := make([]string, 0, len(patch))
	for key := range patch {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		path := prefix + key
		var field reflect.StructField
		found := false
		for i := 0; i < typ.NumField(); i++ {
			f := typ.Field(i)
			if strings.Split(f.Tag.Get("json"), ",")[0] == key {
				field, found = f, true
				break
			}
		}
		if !found {
			return fmt.Errorf("%s: unknown or unavailable config key", path)
		}
		if prefix == "" && field.Tag.Get("patch") != "true" {
			return fmt.Errorf("%s: not writable through update_config", path)
		}
		raw := patch[key]
		if strings.TrimSpace(string(raw)) == "null" {
			return fmt.Errorf("%s: null is not a setting value", path)
		}
		if field.Type.Kind() == reflect.Struct {
			var nested, current map[string]json.RawMessage
			if err := json.Unmarshal(raw, &nested); err != nil || nested == nil {
				return fmt.Errorf("%s: expected an object", path)
			}
			if err := json.Unmarshal(dst[key], &current); err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			if err := mergePatch(current, nested, field.Type, path+"."); err != nil {
				return err
			}
			merged, err := json.Marshal(current)
			if err != nil {
				return err
			}
			dst[key] = merged
		} else {
			if err := json.Unmarshal(raw, reflect.New(field.Type).Interface()); err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			dst[key] = raw
		}
	}
	return nil
}

// VerifyWrittenPatch reads the actual file without default substitution and
// checks TOML key presence as well as values. A missing file or omitted key
// cannot pass merely because its default happens to equal the requested value.
func VerifyWrittenPatch(path string, patch map[string]json.RawMessage) error {
	var cfg Config
	metadata, err := toml.DecodeFile(path, &cfg)
	if err != nil {
		return fmt.Errorf("read back config: %w", err)
	}
	var checkPresence func(map[string]json.RawMessage, []string) error
	checkPresence = func(fields map[string]json.RawMessage, prefix []string) error {
		for key, raw := range fields {
			parts := append(append([]string{}, prefix...), key)
			if !metadata.IsDefined(parts...) {
				return fmt.Errorf("%s: missing from persisted file", strings.Join(parts, "."))
			}
			var nested map[string]json.RawMessage
			if json.Unmarshal(raw, &nested) == nil && nested != nil {
				if err := checkPresence(nested, parts); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := checkPresence(patch, nil); err != nil {
		return err
	}
	encoded, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	var actual map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &actual); err != nil {
		return err
	}
	return verifyPatch(actual, patch, "")
}

func verifyPatch(actual, patch map[string]json.RawMessage, prefix string) error {
	for key, requested := range patch {
		path := prefix + key
		var want, got any
		if err := json.Unmarshal(requested, &want); err != nil {
			return err
		}
		raw, exists := actual[key]
		if !exists {
			return fmt.Errorf("%s: missing after persistence", path)
		}
		if err := json.Unmarshal(raw, &got); err != nil {
			return err
		}
		if _, nested := want.(map[string]any); nested {
			var a, p map[string]json.RawMessage
			if err := json.Unmarshal(raw, &a); err != nil {
				return fmt.Errorf("%s: persisted value is not an object", path)
			}
			if err := json.Unmarshal(requested, &p); err != nil {
				return err
			}
			if err := verifyPatch(a, p, path+"."); err != nil {
				return err
			}
		} else if !reflect.DeepEqual(want, got) {
			return fmt.Errorf("%s: requested %s, persisted %s", path, requested, raw)
		}
	}
	return nil
}
