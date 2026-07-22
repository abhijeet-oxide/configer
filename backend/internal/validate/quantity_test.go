package validate

import (
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

func TestQuantityTypes(t *testing.T) {
	cases := []struct {
		typ   model.ParamType
		value any
		valid bool
	}{
		{model.TypeCPU, "500m", true},
		{model.TypeCPU, "2", true},
		{model.TypeCPU, "2.5", true},
		{model.TypeCPU, "0", false},   // zero is not a valid request/limit
		{model.TypeCPU, "-1", false},  // negative
		{model.TypeCPU, "banana", false},
		{model.TypeMemory, "256Mi", true},
		{model.TypeMemory, "1Gi", true},
		{model.TypeMemory, "512M", true},
		{model.TypeMemory, "0", false},
		{model.TypeMemory, "10furlongs", false},
		{model.TypeDuration, "30s", true},
		{model.TypeDuration, "5m", true},
		{model.TypeDuration, "500ms", true},
		{model.TypeDuration, "5", false}, // no unit
		{model.TypePercentage, "75%", true},
		{model.TypePercentage, "0%", true},
		{model.TypePercentage, "150%", false},
		{model.TypePercentage, "75", false}, // missing %
	}
	for _, c := range cases {
		r := Value(model.Parameter{Type: c.typ}, c.value)
		if r.Valid != c.valid {
			t.Errorf("%s(%q) valid=%v (%q), want %v", c.typ, c.value, r.Valid, r.Message, c.valid)
		}
	}
}

// The comparison must be by real magnitude, not lexical: "1" (core) exceeds
// "500m", and "1Gi" exceeds "512Mi".
func TestResourceRelation(t *testing.T) {
	limitCPU := model.Parameter{Type: model.TypeCPU, Name: "limit", Validation: model.Validation{AtLeast: "req"}}
	reqCPU := model.Parameter{Type: model.TypeCPU, Name: "request"}
	rel := func(string) (model.Parameter, any, bool) { return reqCPU, "500m", true }

	if r := ValueInContext(limitCPU, "250m", rel); r.Valid {
		t.Error("cpu limit 250m below request 500m should be rejected")
	}
	if r := ValueInContext(limitCPU, "1", rel); !r.Valid {
		t.Errorf("cpu limit 1 core above request 500m should pass: %s", r.Message)
	}

	limitMem := model.Parameter{Type: model.TypeMemory, Name: "limit", Validation: model.Validation{AtLeast: "req"}}
	memRel := func(string) (model.Parameter, any, bool) {
		return model.Parameter{Type: model.TypeMemory, Name: "request"}, "512Mi", true
	}
	if r := ValueInContext(limitMem, "256Mi", memRel); r.Valid {
		t.Error("memory limit 256Mi below request 512Mi should be rejected")
	}
	if r := ValueInContext(limitMem, "1Gi", memRel); !r.Valid {
		t.Errorf("memory limit 1Gi above request 512Mi should pass: %s", r.Message)
	}

	// The request side is bounded from above by the limit.
	reqBounded := model.Parameter{Type: model.TypeCPU, Name: "request", Validation: model.Validation{AtMost: "limit"}}
	limRel := func(string) (model.Parameter, any, bool) {
		return model.Parameter{Type: model.TypeCPU, Name: "limit"}, "500m", true
	}
	if r := ValueInContext(reqBounded, "1", limRel); r.Valid {
		t.Error("request 1 core above limit 500m should be rejected")
	}

	// An unresolvable sibling skips the relation rather than failing the edit.
	skip := func(string) (model.Parameter, any, bool) { return model.Parameter{}, nil, false }
	if r := ValueInContext(limitCPU, "250m", skip); !r.Valid {
		t.Errorf("unresolved sibling should skip relation, got %q", r.Message)
	}
}
