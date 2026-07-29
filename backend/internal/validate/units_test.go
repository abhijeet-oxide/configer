package validate

import (
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

func TestMemoryRequiresAUnit(t *testing.T) {
	param := model.Parameter{ID: "mem", Name: "resources.limits.memory", Type: model.TypeMemory}
	valid := []string{"256Mi", "1Gi", "512M", "2G", "1024Ki", "8Ei", "1.5Gi"}
	for _, v := range valid {
		if r := Value(param, v); !r.Valid {
			t.Errorf("%s should be a valid memory quantity: %s", v, r.Message)
		}
	}
	// A bare number is bytes and a trailing "m" is thousandths of a byte.
	// Neither is what anybody writing a memory limit meant, and both are the
	// shape a dropped unit leaves behind.
	for _, v := range []string{"350", "256", "1.5"} {
		r := Value(param, v)
		if r.Valid {
			t.Errorf("%s has no unit and should be rejected", v)
		}
		if !strings.Contains(r.Message, "no unit") {
			t.Errorf("message for %s should say the unit is missing, got %q", v, r.Message)
		}
	}
	r := Value(param, "350m")
	if r.Valid {
		t.Error("350m as memory is 0.35 bytes and should be rejected")
	}
	if !strings.Contains(r.Message, "350Mi") {
		t.Errorf("message should suggest a real unit, got %q", r.Message)
	}
}

func TestCPUKeepsBothLegitimateForms(t *testing.T) {
	param := model.Parameter{ID: "cpu", Name: "resources.limits.cpu", Type: model.TypeCPU}
	// Both spellings are legal Kubernetes and both appear in real charts, so
	// neither may be flagged on its own.
	for _, v := range []string{"350m", "1", "2", "0.5", "2500m"} {
		if r := Value(param, v); !r.Valid {
			t.Errorf("%s should be a valid CPU quantity: %s", v, r.Message)
		}
	}
}

func TestUnitChangeRefusesADroppedUnit(t *testing.T) {
	cpu := model.Parameter{ID: "cpu", Name: "resources.limits.cpu", Type: model.TypeCPU}
	mem := model.Parameter{ID: "mem", Name: "resources.limits.memory", Type: model.TypeMemory}

	// The reported bug: 350m edited to 350 is a thousandfold change that reads
	// like a tidy-up.
	r := UnitChange(cpu, "350m", "350")
	if r.Valid {
		t.Fatal("350m -> 350 drops the millicore unit and should be refused")
	}
	if !strings.Contains(r.Message, "350m") {
		t.Errorf("message should name the millicore spelling, got %q", r.Message)
	}

	// Everything that is not a dropped unit stays allowed: there is always a
	// way to say what you meant, and the check must not stand in the way of it.
	allowed := []struct {
		name     string
		param    model.Parameter
		old, new any
	}{
		{"millicores to millicores", cpu, "350m", "500m"},
		{"cores to cores", cpu, "1", "2"},
		{"bare gains a unit", cpu, "1", "1500m"},
		{"memory unit swapped", mem, "256Mi", "1Gi"},
		{"no previous value", cpu, "", "350"},
		{"unrelated type", model.Parameter{Type: model.TypeString}, "350m", "350"},
	}
	for _, tc := range allowed {
		if r := UnitChange(tc.param, tc.old, tc.new); !r.Valid {
			t.Errorf("%s: should be allowed, got %q", tc.name, r.Message)
		}
	}

	if r := UnitChange(mem, "256Mi", "256"); r.Valid {
		t.Error("256Mi -> 256 drops the unit and should be refused")
	}
}
