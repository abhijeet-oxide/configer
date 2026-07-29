package pathedit

import (
	"strings"
	"testing"
)

// A JSON edit has to be as surgical as a YAML one. These are the specific ways
// re-emitting a whole document used to restate lines nobody touched: "&" and
// "<" came back as \u0026 / \u003c, 1.50 came back as 1.5, a four-space file
// came back at two, and a quoted "8080" came back unquoted. Each one turned a
// single value change into hundreds of changed lines in the review diff.

const fixture = `{
    "value": {
        "global": {
            "loginBanner": "This system is restricted solely to AT&T authorized <users>",
            "ratio": 1.50,
            "big": 1e3,
            "port": "8080",
            "retries": 3,
            "enabled": true,
            "nothing": null,
            "cidr": "172.30.0.0/16",
            "cpu": "350m"
        }
    }
}
`

// onlyLineChanged asserts that before and after differ on exactly one line, and
// that the line is the expected one.
func onlyLineChanged(t *testing.T, before, after, wantLine string) {
	t.Helper()
	bl := strings.Split(before, "\n")
	al := strings.Split(after, "\n")
	if len(bl) != len(al) {
		t.Fatalf("line count changed: %d -> %d\n%s", len(bl), len(al), after)
	}
	var changed []string
	for i := range bl {
		if bl[i] != al[i] {
			changed = append(changed, al[i])
		}
	}
	if len(changed) != 1 {
		t.Fatalf("expected exactly 1 changed line, got %d:\n%s", len(changed), strings.Join(changed, "\n"))
	}
	if strings.TrimSpace(changed[0]) != wantLine {
		t.Errorf("changed line = %q, want %q", strings.TrimSpace(changed[0]), wantLine)
	}
}

func TestJSONEditTouchesOneLine(t *testing.T) {
	cases := []struct {
		name  string
		path  string
		value any
		want  string
	}{
		{"quoted string", "$.value.global.cpu", "350", `"cpu": "350"`},
		{"quoted number stays quoted", "$.value.global.port", 9090, `"port": "9090",`},
		{"bare number", "$.value.global.retries", 5, `"retries": 5,`},
		{"boolean", "$.value.global.enabled", false, `"enabled": false,`},
		{"last entry in object", "$.value.global.cpu", "1", `"cpu": "1"`},
		{"string with an ampersand", "$.value.global.loginBanner", "Property of AT&T <legal>", `"loginBanner": "Property of AT&T <legal>",`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := fixture
			if tc.name == "last entry in object" {
				// Make cpu the final key so the token runs to the closing brace
				// rather than a comma.
				src = strings.Replace(fixture, `"cidr": "172.30.0.0/16",
            "cpu": "350m"`, `"cpu": "350m",
            "cidr": "172.30.0.0/16"`, 1)
				tc.want = `"cpu": "1",`
			}
			out, err := Set([]byte(src), "json", tc.path, "string", tc.value)
			if err != nil {
				t.Fatal(err)
			}
			onlyLineChanged(t, src, out, tc.want)
		})
	}
}

// A structural edit cannot splice a line, so it re-emits the document. It still
// has to give back the file's own indentation, escaping and number literals for
// every part it did not change.
func TestJSONStructuralEditKeepsFormatting(t *testing.T) {
	out, err := Set([]byte(fixture), "json", "$.value.global.added", "x", "yes")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`            "loginBanner": "This system is restricted solely to AT&T authorized <users>",`,
		`            "ratio": 1.50,`,
		`            "big": 1e3,`,
		`            "port": "8080",`,
		`            "added": "yes"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing line %q in:\n%s", want, out)
		}
	}
	for _, unwanted := range []string{`\u0026`, `\u003c`, `"ratio": 1.5,`, `"big": 1000,`} {
		if strings.Contains(out, unwanted) {
			t.Errorf("output should not contain %q:\n%s", unwanted, out)
		}
	}
}

// Removing a value prunes it and leaves the rest of the document alone.
func TestJSONRemoveKeepsFormatting(t *testing.T) {
	out, err := Remove([]byte(fixture), "json", "$.value.global.retries", "integer")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, `"retries"`) {
		t.Errorf("retries should be gone:\n%s", out)
	}
	if !strings.Contains(out, `            "ratio": 1.50,`) {
		t.Errorf("indentation and number literals should survive:\n%s", out)
	}
}
