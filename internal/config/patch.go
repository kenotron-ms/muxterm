package config

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
)

// Patch retains the caller's field presence and original requested values.
// JSON-visible fields are writable unless explicitly tagged patch:"readonly".
// Fields excluded from JSON remain inaccessible through this API.
type Patch struct {
	fields map[string]json.RawMessage
}

func ParsePatch(data []byte) (Patch, error) {
	fields, err := patchObject(data, "changes")
	return Patch{fields: fields}, err
}

func patchObject(data []byte, path string) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return nil, fmt.Errorf("%s: expected a JSON object", path)
	}
	return fields, nil
}

// Apply copies base, changing only explicitly supplied fields. No zero-value
// sentinel or hand-maintained list of fields participates in the merge.
func (p Patch) Apply(base Config) (Config, error) {
	if err := walkPatch(reflect.ValueOf(&base).Elem(), p.fields, "", false); err != nil {
		return Config{}, err
	}
	if _, ok := p.fields["lanes"]; ok && base.Lanes.Approval != "prompt" && base.Lanes.Approval != "never" {
		return Config{}, fmt.Errorf("lanes.approval: invalid value %q (want prompt or never)", base.Lanes.Approval)
	}
	return base, nil
}

// Verify compares the ORIGINAL request against independently loaded state.
// It does not compare a merged value with itself or with its JSON response.
func (p Patch) Verify(actual Config) error {
	return walkPatch(reflect.ValueOf(&actual).Elem(), p.fields, "", true)
}

// String identifies the requested sections in persistence errors.
func (p Patch) String() string { return strings.Join(patchKeys(p.fields), ", ") }

func patchKeys(fields map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func walkPatch(dst reflect.Value, fields map[string]json.RawMessage, prefix string, verify bool) error {
	for _, key := range patchKeys(fields) {
		path := prefix + key
		index := -1
		for i := 0; i < dst.NumField(); i++ {
			if strings.Split(dst.Type().Field(i).Tag.Get("json"), ",")[0] == key && key != "-" {
				index = i
				break
			}
		}
		if index < 0 {
			return fmt.Errorf("%s: unknown or non-public setting", path)
		}
		if dst.Type().Field(index).Tag.Get("patch") == "readonly" {
			return fmt.Errorf("%s: file-only setting; cannot be changed through update_config or PATCH /api/config", path)
		}
		field := dst.Field(index)
		data := fields[key]
		if field.Kind() == reflect.Struct {
			nested, err := patchObject(data, path)
			if err != nil {
				return err
			}
			if err := walkPatch(field, nested, path+".", verify); err != nil {
				return err
			}
			continue
		}
		if strings.TrimSpace(string(data)) == "null" {
			return fmt.Errorf("%s: null is not a setting value", path)
		}
		value := reflect.New(field.Type())
		if err := json.Unmarshal(data, value.Interface()); err != nil {
			return fmt.Errorf("%s: invalid value: %w", path, err)
		}
		if verify {
			if !reflect.DeepEqual(field.Interface(), value.Elem().Interface()) {
				return fmt.Errorf("%s: requested value was not persisted (wanted %s)", path, data)
			}
		} else {
			field.Set(value.Elem())
		}
	}
	return nil
}
