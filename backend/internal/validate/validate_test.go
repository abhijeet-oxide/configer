package validate

import (
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

func param(t model.ParamType, v model.Validation) model.Parameter {
	return model.Parameter{ID: "p", Name: "p", Type: t, Validation: v}
}

func TestTypeEnforcement(t *testing.T) {
	cases := []struct {
		typ   model.ParamType
		value any
		valid bool
	}{
		{model.TypeInteger, 42, true},
		{model.TypeInteger, "abc", false},
		{model.TypeInteger, 3.5, false},
		{model.TypeInteger, "8080", true},
		{model.TypeBoolean, true, true},
		{model.TypeBoolean, "maybe", false},
		{model.TypeIPv4, "10.0.0.1", true},
		{model.TypeIPv4, "999.1.1.1", false},
		{model.TypeIPv4, "not-an-ip", false},
		{model.TypeCIDR, "10.0.0.0/24", true},
		{model.TypeCIDR, "10.0.0.0/99", false},
		{model.TypeString, "anything", true},
	}
	for _, c := range cases {
		got := Value(param(c.typ, model.Validation{}), c.value)
		if got.Valid != c.valid {
			t.Errorf("type %s value %v: valid=%v (%s), want %v", c.typ, c.value, got.Valid, got.Message, c.valid)
		}
	}
}

func TestMinMax(t *testing.T) {
	v := model.Validation{Min: fptr(100), Max: fptr(500)}
	if r := Value(param(model.TypeInteger, v), 99); r.Valid {
		t.Error("99 should be below minimum 100")
	}
	if r := Value(param(model.TypeInteger, v), 501); r.Valid {
		t.Error("501 should be above maximum 500")
	}
	if r := Value(param(model.TypeInteger, v), 250); !r.Valid {
		t.Errorf("250 should be valid: %s", r.Message)
	}
}

func TestLengthRules(t *testing.T) {
	v := model.Validation{MinLength: iptr(3), MaxLength: iptr(5)}
	if r := Value(param(model.TypeString, v), "ab"); r.Valid {
		t.Error("2 chars should fail minLength 3")
	}
	if r := Value(param(model.TypeString, v), "abcdef"); r.Valid {
		t.Error("6 chars should fail maxLength 5")
	}
	if r := Value(param(model.TypeString, v), "abcd"); !r.Valid {
		t.Errorf("4 chars should pass: %s", r.Message)
	}
}

func TestPresets(t *testing.T) {
	// port preset: 1..65535
	port := model.Validation{Preset: "port"}
	if r := Value(param(model.TypeInteger, port), 70000); r.Valid {
		t.Error("70000 should fail port preset")
	}
	if r := Value(param(model.TypeInteger, port), 8443); !r.Valid {
		t.Errorf("8443 should pass port preset: %s", r.Message)
	}
	// fqdn preset
	fqdn := model.Validation{Preset: "fqdn"}
	if r := Value(param(model.TypeString, fqdn), "staging.example.com"); !r.Valid {
		t.Errorf("staging.example.com should pass fqdn: %s", r.Message)
	}
	if r := Value(param(model.TypeString, fqdn), "-bad-"); r.Valid {
		t.Error("-bad- should fail fqdn preset")
	}
	// explicit rules stack on top of preset
	both := model.Validation{Preset: "port", Min: fptr(1000)}
	if r := Value(param(model.TypeInteger, both), 80); r.Valid {
		t.Error("80 should fail explicit min 1000 on top of port preset")
	}
}

func TestRequired(t *testing.T) {
	req := model.Validation{Required: true}
	if r := Value(param(model.TypeString, req), nil); r.Valid {
		t.Error("nil should fail required")
	}
	if r := Value(param(model.TypeString, req), ""); r.Valid {
		t.Error("empty string should fail required")
	}
	if r := Value(param(model.TypeString, model.Validation{}), nil); !r.Valid {
		t.Error("nil should pass when not required")
	}
}
