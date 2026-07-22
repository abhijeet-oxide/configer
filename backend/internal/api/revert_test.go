package api

import (
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/change"
)

func TestInverseItem(t *testing.T) {
	// A value edit reverses by swapping old and new.
	inv, ok := inverseItem(change.Item{ParamID: "image-tag", Instance: "dev", Action: change.ActionSet, Old: "2.8.0", New: "2.9.0"})
	if !ok || inv.New != "2.8.0" || inv.Old != "2.9.0" || inv.Act() != change.ActionSet {
		t.Fatalf("set inverse = %+v ok=%v, want new=2.8.0 old=2.9.0", inv, ok)
	}
	// A no-op edit (old == new) is not worth reverting.
	if _, ok := inverseItem(change.Item{ParamID: "x", Action: change.ActionSet, Old: "a", New: "a"}); ok {
		t.Error("no-op set should not be reversible")
	}
	// A scaffolded instance reverses to a retire.
	inv, ok = inverseItem(change.Item{Instance: "prod-ap", Action: change.ActionAddInstance, Old: "prod-us", New: map[string]any{"name": "prod-ap"}})
	if !ok || inv.Act() != change.ActionRemoveInstance || inv.Instance != "prod-ap" {
		t.Fatalf("add-instance inverse = %+v ok=%v, want remove-instance prod-ap", inv, ok)
	}
	// Retiring an instance cannot be reconstructed.
	if _, ok := inverseItem(change.Item{Instance: "dev", Action: change.ActionRemoveInstance}); ok {
		t.Error("remove-instance should not be reversible")
	}
	// A file edit reverses by swapping content.
	inv, ok = inverseItem(change.Item{File: "a.yaml", Action: change.ActionEditFile, Old: "old", New: "new"})
	if !ok || inv.New != "old" || inv.Old != "new" {
		t.Fatalf("file inverse = %+v ok=%v", inv, ok)
	}
}
