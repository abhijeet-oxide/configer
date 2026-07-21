// Package writer performs the .configer/ METADATA writes: parameter metadata
// in parameters.yaml, instance metadata in instances.yaml, and ignore rules.
// It never writes values - those live in the repository's own files and go
// through the writeback engine. The metadata files are machine-managed YAML;
// yaml.v3 marshals deterministically, so writes produce minimal diffs.
package writer

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/pathedit"
	"github.com/abhijeet-oxide/configer/backend/internal/writeback"
	"gopkg.in/yaml.v3"
)

func parametersPath(root string) string {
	return filepath.Join(root, ".configer", "parameters.yaml")
}

func mutateCatalog(root string, fn func(*model.Catalog) error) error {
	path := parametersPath(root)
	var cat model.Catalog
	if b, err := os.ReadFile(path); err == nil {
		if err := yaml.Unmarshal(b, &cat); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if cat.APIVersion == "" {
		cat.APIVersion = "configer.io/v1"
	}
	if cat.Kind == "" {
		cat.Kind = "ParameterCatalog"
	}
	if err := fn(&cat); err != nil {
		return err
	}
	return writeYAML(path, cat)
}

// ParamPatch is a partial update to a parameter's metadata. Nil fields are
// left unchanged. Bindings is patchable only as a whole (the attach/re-map
// flow: completing a design-phase parameter, or re-pointing one after a file
// rename); it is never edited as free text in the UI.
type ParamPatch struct {
	Type        *model.ParamType
	ItemType    *model.ParamType
	Validation  *model.Validation
	DisplayName *string
	Description *string
	Category    *string
	Scope       *model.Scope
	Secret      *bool
	Default     *any
	Bindings    *[]model.Binding
}

// UpdateParameter applies a patch to one parameter in .configer/parameters.yaml
// and returns the updated parameter.
func UpdateParameter(root, paramID string, patch ParamPatch) (model.Parameter, error) {
	var out model.Parameter
	err := mutateCatalog(root, func(cat *model.Catalog) error {
		idx := -1
		for i := range cat.Parameters {
			if cat.Parameters[i].ID == paramID {
				idx = i
				break
			}
		}
		if idx < 0 {
			return fmt.Errorf("parameter %q not found", paramID)
		}
		p := &cat.Parameters[idx]
		if patch.Type != nil {
			p.Type = *patch.Type
		}
		// ItemType only makes sense on a list; clear it otherwise so a stale
		// element type never lingers after a type change.
		if patch.ItemType != nil {
			p.ItemType = *patch.ItemType
		}
		effectiveType := p.Type
		if patch.Type != nil {
			effectiveType = *patch.Type
		}
		if effectiveType != model.TypeList {
			p.ItemType = ""
		}
		if patch.Validation != nil {
			p.Validation = *patch.Validation
		}
		if patch.DisplayName != nil {
			p.DisplayName = *patch.DisplayName
		}
		if patch.Description != nil {
			p.Description = *patch.Description
		}
		if patch.Category != nil && *patch.Category != "" {
			p.Category = *patch.Category
		}
		if patch.Scope != nil && *patch.Scope != "" {
			p.Scope = *patch.Scope
		}
		if patch.Secret != nil {
			p.Secret = *patch.Secret
		}
		if patch.Default != nil {
			p.Default = *patch.Default
		}
		if patch.Bindings != nil {
			for _, b := range *patch.Bindings {
				if b.File == "" || b.Path == "" {
					return fmt.Errorf("attaching a parameter requires both the file and the path")
				}
			}
			p.Bindings = *patch.Bindings
		}
		out = *p
		return nil
	})
	return out, err
}

// AddParameter appends a new parameter to the catalog (e.g. a user-added
// optional key that only some instances will carry).
func AddParameter(root string, param model.Parameter) error {
	return mutateCatalog(root, func(cat *model.Catalog) error {
		for _, p := range cat.Parameters {
			if p.ID == param.ID {
				return fmt.Errorf("parameter %q already exists", param.ID)
			}
			if p.Name == param.Name {
				return fmt.Errorf("parameter named %q already exists", param.Name)
			}
		}
		cat.Parameters = append(cat.Parameters, param)
		return nil
	})
}

// AddParameters appends many parameters in a SINGLE catalog read + write.
// Parameters whose id or name collides (with an existing one or an earlier one
// in the batch) are skipped and their names returned. Onboarding a large repo
// (thousands of settings) is then one file mutation instead of O(n²) rewrites.
func AddParameters(root string, params []model.Parameter) (added int, skipped []string, err error) {
	err = mutateCatalog(root, func(cat *model.Catalog) error {
		haveID := make(map[string]bool, len(cat.Parameters)+len(params))
		haveName := make(map[string]bool, len(cat.Parameters)+len(params))
		for _, p := range cat.Parameters {
			haveID[p.ID] = true
			haveName[p.Name] = true
		}
		for _, p := range params {
			if p.ID == "" || haveID[p.ID] || (p.Name != "" && haveName[p.Name]) {
				skipped = append(skipped, p.Name)
				continue
			}
			cat.Parameters = append(cat.Parameters, p)
			haveID[p.ID] = true
			haveName[p.Name] = true
			added++
		}
		return nil
	})
	return added, skipped, err
}

// DeleteParameter retires a parameter everywhere: the catalog entry is removed
// and the bound key/element is deleted from every real file it lives in, for
// every instance, so the setting disappears from the whole repository.
func DeleteParameter(root, paramID string, instances []model.Instance) error {
	var param model.Parameter
	if err := mutateCatalog(root, func(cat *model.Catalog) error {
		idx := -1
		for i := range cat.Parameters {
			if cat.Parameters[i].ID == paramID {
				idx = i
				break
			}
		}
		if idx < 0 {
			return fmt.Errorf("parameter %q not found", paramID)
		}
		param = cat.Parameters[idx]
		cat.Parameters = append(cat.Parameters[:idx], cat.Parameters[idx+1:]...)
		return nil
	}); err != nil {
		return err
	}

	// Remove the value from every bound location. Base-layer bindings are
	// shared files: remove once. Instance-layer bindings: once per instance.
	removed := map[string]bool{}
	remove := func(b model.Binding) error {
		key := b.File + "|" + b.Path
		if removed[key] {
			return nil
		}
		removed[key] = true
		return writeback.RemoveValue(root, b.File, b.Format, b.Path, param.Type)
	}
	for _, b := range param.Bindings {
		if b.EffectiveLayer() == model.LayerBase {
			if err := remove(b); err != nil {
				return fmt.Errorf("remove %s from %s: %w", paramID, b.File, err)
			}
			continue
		}
		for _, inst := range instances {
			if err := remove(b.ForInstance(inst)); err != nil {
				return fmt.Errorf("remove %s from %s: %w", paramID, b.ForInstance(inst).File, err)
			}
		}
	}
	return nil
}

// --- instance registry ----------------------------------------------------

// InstancePatch is a partial update to an instance's metadata. Nil fields are
// left unchanged; Labels replaces the whole map when non-nil.
type InstancePatch struct {
	Environment     *string
	Region          *string
	Zone            *string
	Site            *string
	SoftwareVersion *string
	Status          *string
	Labels          *map[string]string
}

// editRegistry surgically edits .configer/instances.yaml through pathedit's
// comment- and style-preserving node round trip: only the touched entry
// changes, so an instance edit is a one-line Git diff even in hand-formatted
// registries (never a whole-file re-marshal).
func editRegistry(root string, fn func(instances *yaml.Node) error) error {
	path := filepath.Join(root, ".configer", "instances.yaml")
	doc, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	out, err := pathedit.EditDoc(doc, func(top *yaml.Node) error {
		ensureScalar(top, "apiVersion", "configer.io/v1")
		ensureScalar(top, "kind", "InstanceRegistry")
		return fn(ensureSeq(top, "instances"))
	})
	if err != nil {
		return fmt.Errorf("edit %s: %w", path, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(out), 0o644)
}

// --- yaml.Node helpers for the registry edits (structure only; the path
// engine itself stays pathedit) -------------------------------------------

func mapVal(m *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

// ensureScalar sets key to val only when the key is absent.
func ensureScalar(m *yaml.Node, key, val string) {
	if mapVal(m, key) != nil {
		return
	}
	m.Content = append(m.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key},
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: val})
}

func ensureSeq(m *yaml.Node, key string) *yaml.Node {
	if v := mapVal(m, key); v != nil {
		if v.Kind == yaml.SequenceNode {
			return v
		}
		nv := &yaml.Node{Kind: yaml.SequenceNode}
		*v = *nv
		return v
	}
	v := &yaml.Node{Kind: yaml.SequenceNode}
	m.Content = append(m.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, v)
	return v
}

// itemNamed finds the sequence element whose "name" equals name.
func itemNamed(seq *yaml.Node, name string) (node *yaml.Node, idx int) {
	for i, el := range seq.Content {
		if v := mapVal(el, "name"); v != nil && v.Value == name {
			return el, i
		}
	}
	return nil, -1
}

// setItemScalar sets key on an item mapping (replacing in place, comments
// kept); an empty value removes the key entirely, matching omitempty.
func setItemScalar(item *yaml.Node, key, val string) {
	for i := 0; i+1 < len(item.Content); i += 2 {
		if item.Content[i].Value == key {
			if val == "" {
				item.Content = append(item.Content[:i], item.Content[i+2:]...)
				return
			}
			item.Content[i+1].SetString(val)
			return
		}
	}
	if val == "" {
		return
	}
	item.Content = append(item.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key},
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: val})
}

// setItemLabels replaces the labels map, keeping the old node's style (flow
// stays flow); an empty map removes the key.
func setItemLabels(item *yaml.Node, labels map[string]string) {
	if len(labels) == 0 {
		for i := 0; i+1 < len(item.Content); i += 2 {
			if item.Content[i].Value == "labels" {
				item.Content = append(item.Content[:i], item.Content[i+2:]...)
				return
			}
		}
		return
	}
	nv := &yaml.Node{}
	_ = nv.Encode(labels)
	if old := mapVal(item, "labels"); old != nil {
		nv.Style = old.Style
		*old = *nv
		return
	}
	item.Content = append(item.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "labels"}, nv)
}

// ApplyInstancePatch applies a partial metadata update to inst in place (nil
// fields left untouched). Exported so a pending draft item can be folded into
// a not-yet-committed instance without going through the file.
func ApplyInstancePatch(inst *model.Instance, patch InstancePatch) {
	applyInstancePatch(inst, patch)
}

func applyInstancePatch(inst *model.Instance, patch InstancePatch) {
	if patch.Environment != nil {
		inst.Environment = *patch.Environment
	}
	if patch.Region != nil {
		inst.Region = *patch.Region
	}
	if patch.Zone != nil {
		inst.Zone = *patch.Zone
	}
	if patch.Site != nil {
		inst.Site = *patch.Site
	}
	if patch.SoftwareVersion != nil {
		inst.SoftwareVersion = *patch.SoftwareVersion
	}
	if patch.Status != nil {
		inst.Status = *patch.Status
	}
	if patch.Labels != nil {
		inst.Labels = *patch.Labels
	}
}

// instanceNode encodes a new registry entry (defaults applied) as a block
// mapping node ready to append to the instances sequence.
func instanceNode(inst model.Instance) (*yaml.Node, error) {
	if inst.Status == "" {
		inst.Status = "active"
	}
	if inst.Folder == "" {
		inst.Folder = inst.FolderOrDefault()
	}
	n := &yaml.Node{}
	if err := n.Encode(inst); err != nil {
		return nil, err
	}
	return n, nil
}

// AddInstance appends a new instance to the registry (error if the name is
// taken). Scaffolding the instance's folder is the caller's concern (the
// layout adapter); the registry only records the binding.
func AddInstance(root string, inst model.Instance) error {
	return editRegistry(root, func(seq *yaml.Node) error {
		if el, _ := itemNamed(seq, inst.Name); el != nil {
			return fmt.Errorf("instance %q already exists", inst.Name)
		}
		n, err := instanceNode(inst)
		if err != nil {
			return err
		}
		seq.Content = append(seq.Content, n)
		return nil
	})
}

// AddInstances appends many instances in a SINGLE registry read + write (the
// onboarding batch companion to AddInstance).
func AddInstances(root string, insts []model.Instance) error {
	return editRegistry(root, func(seq *yaml.Node) error {
		for _, inst := range insts {
			if el, _ := itemNamed(seq, inst.Name); el != nil {
				return fmt.Errorf("instance %q already exists", inst.Name)
			}
			n, err := instanceNode(inst)
			if err != nil {
				return err
			}
			seq.Content = append(seq.Content, n)
		}
		return nil
	})
}

// UpdateInstance patches one instance's metadata and returns it. The edit is
// surgical: only the patched keys of that one entry change in the file.
func UpdateInstance(root, name string, patch InstancePatch) (model.Instance, error) {
	var out model.Instance
	err := editRegistry(root, func(seq *yaml.Node) error {
		el, _ := itemNamed(seq, name)
		if el == nil {
			return fmt.Errorf("instance %q not found", name)
		}
		if patch.Environment != nil {
			setItemScalar(el, "environment", *patch.Environment)
		}
		if patch.Region != nil {
			setItemScalar(el, "region", *patch.Region)
		}
		if patch.Zone != nil {
			setItemScalar(el, "zone", *patch.Zone)
		}
		if patch.Site != nil {
			setItemScalar(el, "site", *patch.Site)
		}
		if patch.SoftwareVersion != nil {
			setItemScalar(el, "softwareVersion", *patch.SoftwareVersion)
		}
		if patch.Status != nil {
			setItemScalar(el, "status", *patch.Status)
		}
		if patch.Labels != nil {
			setItemLabels(el, *patch.Labels)
		}
		return el.Decode(&out)
	})
	return out, err
}

// DeleteInstance removes an instance from the registry and deletes its folder
// so nothing stale is left behind.
func DeleteInstance(root, name string) error {
	var folder string
	if err := editRegistry(root, func(seq *yaml.Node) error {
		el, idx := itemNamed(seq, name)
		if el == nil {
			return fmt.Errorf("instance %q not found", name)
		}
		var inst model.Instance
		if err := el.Decode(&inst); err != nil {
			return err
		}
		folder = inst.FolderOrDefault()
		seq.Content = append(seq.Content[:idx], seq.Content[idx+1:]...)
		return nil
	}); err != nil {
		return err
	}
	if folder != "" && folder != "." && folder != "/" {
		_ = os.RemoveAll(filepath.Join(root, folder))
	}
	return nil
}

// AddIgnoreFiles appends file globs to .configer/ignore.yaml so the scan
// skips them (the import wizard's "don't import these" persistence).
func AddIgnoreFiles(root string, files []string) error {
	path := filepath.Join(root, ".configer", "ignore.yaml")
	var ig struct {
		Files      []string `yaml:"files"`
		Parameters []string `yaml:"parameters"`
	}
	if b, err := os.ReadFile(path); err == nil {
		if err := yaml.Unmarshal(b, &ig); err != nil {
			return fmt.Errorf("parse %s: %w", path, err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	have := map[string]bool{}
	for _, f := range ig.Files {
		have[f] = true
	}
	for _, f := range files {
		if !have[f] {
			ig.Files = append(ig.Files, f)
		}
	}
	return writeYAML(path, ig)
}

// WriteApplication persists .configer/application.yaml.
func WriteApplication(root string, app model.Application) error {
	if app.APIVersion == "" {
		app.APIVersion = "configer.io/v1"
	}
	if app.Kind == "" {
		app.Kind = "Application"
	}
	dir := filepath.Join(root, ".configer")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return writeYAML(filepath.Join(dir, "application.yaml"), app)
}

func writeYAML(path string, v any) error {
	b, err := yaml.Marshal(v)
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}
