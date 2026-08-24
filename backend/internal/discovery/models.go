package discovery

import (
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/pathedit"
	"github.com/abhijeet-oxide/configer/backend/internal/productmeta"
	"github.com/abhijeet-oxide/configer/backend/internal/region"
	"github.com/abhijeet-oxide/configer/backend/internal/yangschema"
)

// Two optional patterns are recognized here, both of them ordinary facts a
// repository may or may not carry:
//
//   - a PRODUCT DESCRIPTOR in an instance's own metadata directory, which says
//     which product and which software release that instance was built from;
//   - SCHEMA MODELS shipped with the product, which say what each setting
//     actually is - its type, its allowed values, its limits, and the prose
//     that explains it.
//
// Neither is required and neither is announced when absent: a repository
// without them onboards exactly as it did before. When they ARE present they
// outrank inference, because a vendor's written constraint is a fact where a
// rule guessed from a leaf name is a hunch.

// applyDescriptors fills each instance's software release, environment and
// product labels from the descriptor its folder carries, and returns the
// descriptor that also describes the APPLICATION as a whole.
//
// The version is taken from the instances themselves rather than configured,
// so a repository holding several releases side by side lines each instance up
// with the models it was actually built from. When the instances disagree, the
// first one answers: they are then validated against a release one of them
// really is, which beats validating against none.
func applyDescriptors(root string, instances []model.Instance) *productmeta.Descriptor {
	var first *productmeta.Descriptor
	regions := region.Load(root)
	for i := range instances {
		inst := &instances[i]
		// A name that says where it runs should not need somebody to retype it
		// a hundred times. A rule only ever fills a region in; it never
		// overrules one somebody set.
		if inst.Region == "" {
			inst.Region = regions.Detect(inst.Name)
		}
		d, found := productmeta.ForFolder(root, inst.FolderOrDefault())
		if !found {
			continue
		}
		if d.Version != "" && inst.SoftwareVersion == "" {
			inst.SoftwareVersion = d.Version
		}
		if inst.Environment == "" {
			inst.Environment = d.Environment
		}
		if inst.Labels == nil {
			inst.Labels = map[string]string{}
		}
		setLabel(inst.Labels, "product", d.Product)
		setLabel(inst.Labels, "productName", d.DisplayName)
		setLabel(inst.Labels, "release", d.Release)
		setLabel(inst.Labels, "variant", d.Variant)
		for k, v := range d.Extra {
			setLabel(inst.Labels, k, v)
		}
		if len(inst.Labels) == 0 {
			inst.Labels = nil
		}
		if first == nil {
			copied := d
			first = &copied
		}
	}
	return first
}

func setLabel(labels map[string]string, key, value string) {
	if value != "" {
		if _, taken := labels[key]; !taken {
			labels[key] = value
		}
	}
}

// loadModels reads the schema models that belong to a software release, or
// returns nil when the repository ships none.
func loadModels(root, version string) *yangschema.Set {
	dirs := yangschema.FindSchemaRoots(root)
	if len(dirs) == 0 {
		return nil
	}
	set := yangschema.Load(root, yangschema.ForVersion(dirs, version))
	if set.Empty() {
		return nil
	}
	return set
}

// attachModel replaces a parameter's inferred rules with what the schema
// states about the setting, when the schema knows it.
//
// A parameter is matched to a model node by the route of NAMES its binding
// spells. Nothing else is available to match on: a configuration document
// addresses its values with its own prefixes and indices, none of which a
// model has ever seen, while the chain of names is the one thing both sides
// agree on. Every binding is tried, because a deduplicated parameter may be
// spelled more fully in one file than another.
func attachModel(set *yangschema.Set, p *model.Parameter) (*yangschema.Node, bool) {
	if set == nil {
		return nil, false
	}
	for _, b := range p.Bindings {
		steps := pathedit.Segments(b.Format, b.Path)
		if len(steps) == 0 {
			continue
		}
		node, found := set.Lookup(steps)
		if !found {
			continue
		}
		yangschema.Apply(p, node)
		return node, true
	}
	return nil, false
}

// linkModelDependencies turns schema expressions (leafrefs, when, must) into
// the parameter graph the inspector shows. It is intentionally conservative:
// a reference becomes a DependsOn edge only when both ends resolve to discovered
// parameters. Ambiguous or structural references stay in validation constraints
// as readable facts instead of becoming wrong graph edges.
func linkModelDependencies(set *yangschema.Set, params []model.Parameter, nodes map[string]*yangschema.Node) {
	if set == nil || len(nodes) == 0 {
		return
	}
	paramByNode := map[*yangschema.Node]string{}
	for _, p := range params {
		if n := nodes[p.ID]; n != nil {
			paramByNode[n] = p.ID
		}
	}
	for i := range params {
		source := nodes[params[i].ID]
		if source == nil || len(source.DependencyPaths) == 0 {
			continue
		}
		seen := map[string]bool{}
		for _, existing := range params[i].DependsOn {
			seen[existing] = true
		}
		for _, expr := range source.DependencyPaths {
			target, ok := set.LookupDependency(source, expr)
			if !ok {
				continue
			}
			id := paramByNode[target]
			if id == "" || id == params[i].ID || seen[id] {
				continue
			}
			params[i].DependsOn = append(params[i].DependsOn, id)
			seen[id] = true
		}
	}
}
