package pathedit

import "testing"

// Span points AT the value, not at the line it shares with its key: that is
// what lets the file editor mark "10.0.0.1" rather than the whole of
// "  ip: 10.0.0.1  # the service ip".
func TestSpanNarrowsToTheValue(t *testing.T) {
	yaml := "service:\n  ip: 10.0.0.1 # the service ip\n  name: \"web front\"\n  note: |\n    a block\n"
	d, err := Parse([]byte(yaml), "yaml")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		path              string
		line, col, endCol int
	}{
		{"$.service.ip", 2, 7, 15},          // 10.0.0.1
		{"$.service.name", 3, 9, 20},        // "web front", quotes included
	} {
		line, col, end, ok := d.Span(c.path)
		if !ok || line != c.line || col != c.col || end != c.endCol {
			t.Errorf("Span(%s) = %d:%d-%d ok=%v, want %d:%d-%d", c.path, line, col, end, ok, c.line, c.col, c.endCol)
		}
		if col > 0 {
			text := splitLinesForTest(yaml)[line-1]
			if got := text[col-1 : end-1]; got == "" {
				t.Errorf("Span(%s) selected nothing from %q", c.path, text)
			}
		}
	}
	// A block scalar cannot be narrowed: the line is still located, the columns
	// stay zero, and the caller falls back to marking the line.
	if line, col, _, ok := d.Span("$.service.note"); !ok || line == 0 || col != 0 {
		t.Errorf("block scalar span = %d:%d ok=%v, want a line with no columns", line, col, ok)
	}

	x, err := Parse([]byte("<network ns=\"telco\">\n  <service>\n    <ip>10.0.0.1</ip>\n  </service>\n</network>\n"), "xml")
	if err != nil {
		t.Fatal(err)
	}
	if line, col, end, ok := x.Span("/network/service/ip"); !ok || line != 3 || col != 9 || end != 17 {
		t.Errorf("xml element span = %d:%d-%d ok=%v, want 3:9-17", line, col, end, ok)
	}
	if line, col, end, ok := x.Span("/network/@ns"); !ok || line != 1 || col != 14 || end != 19 {
		t.Errorf("xml attribute span = %d:%d-%d ok=%v, want 1:14-19", line, col, end, ok)
	}
}

func splitLinesForTest(s string) []string {
	out := []string{}
	cur := ""
	for _, r := range s {
		if r == '\n' {
			out = append(out, cur)
			cur = ""
			continue
		}
		cur += string(r)
	}
	return append(out, cur)
}
