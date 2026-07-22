package validate

import (
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// The hostname preset must accept both a bare label and a dotted FQDN (RFC 1123
// / JSON-Schema "hostname" format), and reject malformed names. Regression test
// for the bug where every dotted ingress host was flagged invalid.
func TestHostnamePresetAcceptsFQDN(t *testing.T) {
	p := model.Parameter{Type: model.TypeString, Validation: model.Validation{Preset: "hostname"}}
	valid := []string{"web-01", "app.example.com", "us.platform.example.com", "localhost"}
	for _, v := range valid {
		if r := Value(p, v); !r.Valid {
			t.Errorf("hostname %q should be valid, got %q", v, r.Message)
		}
	}
	invalid := []string{"-bad", "bad_host", "app..com", "has space"}
	for _, v := range invalid {
		if r := Value(p, v); r.Valid {
			t.Errorf("hostname %q should be invalid", v)
		}
	}
}
