package pathedit

import "testing"

// A save must be able to say WHERE a file stopped parsing. "the file does not
// parse" alone sent the reader hunting through nine hundred lines with the
// parser's own vocabulary for company.
func TestCheckSyntaxLocatesTheDamage(t *testing.T) {
	cases := []struct {
		name    string
		format  string
		doc     string
		line    int
		snippet string
	}{
		{
			name:   "yaml indentation slip",
			format: "yaml",
			doc:    "app:\n  port: 8080\n   name: demo\n",
			line:   3,
		},
		{
			name:    "json missing comma",
			format:  "json",
			doc:     "{\n  \"a\": 1\n  \"b\": 2\n}\n",
			line:    3,
			snippet: `"b": 2`,
		},
		{
			name:   "xml unclosed tag",
			format: "xml",
			doc:    "<config>\n  <a>1</a>\n  <b>2\n</config>\n",
			line:   4,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := CheckSyntax([]byte(tc.doc), tc.format)
			if err == nil {
				t.Fatal("broken document reported as valid")
			}
			if err.Line != tc.line {
				t.Errorf("line = %d, want %d (%+v)", err.Line, tc.line, err)
			}
			if err.Message == "" {
				t.Error("no message")
			}
			if tc.snippet != "" && err.Snippet != tc.snippet {
				t.Errorf("snippet = %q, want %q", err.Snippet, tc.snippet)
			}
		})
	}
}

// Well-formed documents pass, and so does an empty file: absence of content is
// a legitimate state, not damage.
func TestCheckSyntaxAcceptsValidDocuments(t *testing.T) {
	for _, tc := range []struct{ format, doc string }{
		{"yaml", "app:\n  port: 8080\n"},
		{"yaml", "a: 1\n---\nb: 2\n"}, // a multi-document stream
		{"json", `{"a":[1,2,{"b":null}]}`},
		{"xml", "<config><a>1</a></config>"},
		{"yaml", ""},
		{"json", "   \n"},
	} {
		if err := CheckSyntax([]byte(tc.doc), tc.format); err != nil {
			t.Errorf("%s %q reported %+v", tc.format, tc.doc, err)
		}
	}
}

// The position is a FIELD, not something restated inside the sentence: the UI
// puts it on a line number of its own.
func TestSyntaxMessageDoesNotRepeatTheLine(t *testing.T) {
	err := CheckSyntax([]byte("app:\n  port: 8080\n   name: demo\n"), "yaml")
	if err == nil {
		t.Fatal("expected a failure")
	}
	if got := err.Message; got == "" || got[0] == 'l' && len(got) > 4 && got[:4] == "line" {
		t.Errorf("message still carries the position: %q", got)
	}
}
