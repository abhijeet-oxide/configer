package api

// A scope-level edit: one value, one instruction, and the service works out
// which instances it reaches.
//
// The grid asks somebody to type a value into a cell, and a cell is one system.
// That is exactly wrong for a setting that is not per-system: a value shared by
// the four machines at one site was edited four times, by hand, and the only
// thing holding those four numbers together was that whoever typed them
// remembered to. Nothing on the screen said they belonged together, and nothing
// stopped the fourth from being missed.
//
// So a scope-level edit says what it means - "this is the value for site
// Dallas" - and this file is the one place that turns it into the writes it
// implies. A global setting bound in a shared file is ONE write to that file;
// everything else fans out to the instances the scope actually reaches, each
// with its own baseline, its own validation and its own row in the review, so
// the change reads as what it does to each system rather than as an instruction
// nobody can check.

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
	"github.com/abhijeet-oxide/configer/backend/internal/model"
	"github.com/abhijeet-oxide/configer/backend/internal/project"
)

// scopePlan is what a scope-level edit resolves to.
type scopePlan struct {
	// Shared is true when the edit is a single write to a shared (base-layer)
	// file that every instance reads - the one case where "global" is genuinely
	// one value in one place rather than N copies that agree.
	Shared bool
	// Instances are the instances a fanned-out edit writes to, in estate order.
	Instances []model.Instance
	// Reach names what the edit applies to, in the words the user chose it by
	// ("every instance", "site dallas"), for the response and the toast.
	Reach string
}

// planScopeEdit works out what an edit at `scope` (with `group` naming which
// site/zone/environment is meant) actually writes.
//
// The rules, and each of them is a decision rather than a detail:
//
//   - global, and the parameter has a shared file: one write, one item. Editing
//     it changes everybody because the file does.
//   - global, and it does not: every instance, written in its own folder. A
//     parameter declared global whose only homes are per-instance files is
//     still global in the sense that matters - an edit is meant to reach
//     everyone - and refusing it because the repository is laid out the other
//     way would leave the declared scope as a label with no behaviour.
//   - a group scope: the instances carrying that site / zone / environment. An
//     instance with no site is in NO site group and is never swept in, because
//     "it had nothing written in that field" is not consent to change it.
func planScopeEdit(p *project.Project, param model.Parameter, scope, group string) (scopePlan, error) {
	sc := model.Scope(strings.TrimSpace(strings.ToLower(scope)))
	active := activeInstances(p)
	switch sc {
	case model.ScopeGlobal:
		if len(param.BindingsOn(model.LayerBase, model.Instance{})) > 0 {
			return scopePlan{Shared: true, Reach: "every instance"}, nil
		}
		if len(active) == 0 {
			return scopePlan{}, fmt.Errorf("this parameter has no shared file location and there are no instances to write it to")
		}
		return scopePlan{Instances: active, Reach: "every instance"}, nil
	case model.ScopeSite, model.ScopeZone, model.ScopeEnvironment:
		field, _ := sc.GroupsBy()
		key := strings.TrimSpace(group)
		if key == "" {
			return scopePlan{}, fmt.Errorf("say which %s this value is for", field)
		}
		var reached []model.Instance
		for _, inst := range active {
			if k, ok := sc.GroupKey(inst); ok && strings.EqualFold(k, key) {
				reached = append(reached, inst)
			}
		}
		if len(reached) == 0 {
			return scopePlan{}, fmt.Errorf("no instance is in %s %q", field, key)
		}
		return scopePlan{Instances: reached, Reach: field + " " + key}, nil
	case model.ScopeInstance:
		return scopePlan{}, fmt.Errorf("an instance-scoped edit names its instance rather than a scope")
	}
	return scopePlan{}, fmt.Errorf("unknown scope %q", scope)
}

// activeInstances is the estate a scope edit can reach: archived instances are
// out of the grid and out of this too, so "every instance" means the ones
// somebody is actually looking at.
func activeInstances(p *project.Project) []model.Instance {
	out := make([]model.Instance, 0, len(p.Registry.Instances))
	for _, inst := range p.Registry.Instances {
		if inst.Status != "archived" {
			out = append(out, inst)
		}
	}
	return out
}

// isGroupScope reports whether a scope string names a group of instances.
func isGroupScope(scope string) bool {
	_, ok := model.Scope(strings.TrimSpace(strings.ToLower(scope))).GroupsBy()
	return ok
}

// stageScopeFanout stages one value across the instances a scope reaches, in a
// single draft lock.
//
// Every instance is staged the way a single cell edit is - its own committed
// baseline, its own coercion, its own type, unit, template and cross-parameter
// checks - so a fan-out can never write something a hand edit would have
// refused. An instance the value cannot be written to is REPORTED, and the rest
// still stage: refusing nineteen good edits over one bad one is how somebody
// ends up doing the whole thing by hand again.
func (s *Server) stageScopeFanout(
	w http.ResponseWriter, r *http.Request,
	p *project.Project, param model.Parameter, plan scopePlan,
	action change.Action, value any,
) {
	type result struct {
		Instance string `json:"instance"`
		OK       bool   `json:"ok"`
		Error    string `json:"error,omitempty"`
	}
	results := make([]result, 0, len(plan.Instances))
	staged := 0

	defer s.lockDraft(draftOwner(r))()
	draft, err := s.Store.Draft(draftOwner(r), s.branch())
	if err != nil {
		writeErr(w, err)
		return
	}
	rv := s.resolve(p)
	if _, err := s.Store.Update(draft.ID, func(cr *change.ChangeRequest) error {
		for _, inst := range plan.Instances {
			switch action {
			case change.ActionSet:
				didStage, msg := stageSetItem(cr, param, inst.Name, inst, inst, value, rv)
				if msg != "" {
					results = append(results, result{Instance: inst.Name, Error: msg})
					continue
				}
				if didStage {
					staged++
				}
			default:
				if len(param.BindingsOn(model.LayerInstance, inst)) == 0 {
					results = append(results, result{Instance: inst.Name, Error: "this parameter has no override here to drop"})
					continue
				}
				cr.UpsertItem(change.Item{
					ParamID: param.ID, Instance: inst.Name, Action: action,
					Old: rv.Resolve(param, inst).Value, UpdatedAt: time.Now().UTC(),
				})
				staged++
			}
			results = append(results, result{Instance: inst.Name, OK: true})
		}
		return nil
	}); err != nil {
		writeErr(w, err)
		return
	}
	// A fan-out that cancelled every edit it touched leaves nothing to review.
	s.dropEmptyDraft(draftOwner(r))
	pending, changeID := 0, draft.ID
	if d := s.Store.CurrentDraft(draftOwner(r)); d != nil {
		pending, changeID = len(d.Items), d.ID
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "value": value, "staged": staged, "results": results,
		"reach": plan.Reach, "instances": len(plan.Instances),
		"pending": pending, "changeId": changeID,
	})
}
