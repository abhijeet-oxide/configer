package parsers_test

import (
	"strings"
	"testing"

	"github.com/abhijeet-oxide/configer/backend/internal/parsers"
	"github.com/abhijeet-oxide/configer/backend/internal/pathedit"
	"github.com/abhijeet-oxide/configer/backend/internal/plugin"
)

// Every path the scanner emits has to be writable by the edit engine. They are
// two halves of one contract - discovery proposes a path, the write path uses
// it - and a shape that only one of them understands turns into a change
// request that stages fine and then cannot be submitted.
//
// The shapes here are the ones a real NS-input document uses: a top-level
// array, an "additional_values" list of {name, value} records, arrays of
// scalars, arrays of arrays, and keys carrying dots and brackets.
func TestEveryScannedPathIsWritable(t *testing.T) {
	docs := map[string]string{
		"list of records": `{
  "additional_values": [
    {
      "name": "zts",
      "value": {
        "cmreader": { "resources": { "limits": { "cpu": "350m" } } },
        "global": { "loginBanner": "restricted" }
      }
    },
    {
      "name": "mariadb",
      "value": { "mysqld": { "site-conf": "userstat = on" } }
    }
  ]
}`,
		"array root": `[
  { "value": { "cmreader": { "cpu": "350m" } } },
  { "value": { "cmreader": { "cpu": "500m" } } }
]`,
		"scalar arrays": `{
  "workerNodeSelector": [ { "key": "is_worker", "value": "true" } ],
  "floating_ips": [],
  "static_ips": [ "10.0.0.1", "10.0.0.2" ],
  "matrix": [ [ "a", "b" ], [ "c" ] ]
}`,
		"awkward keys": `{
  "value": {
    "query.dependencies": { "dagMaxNumService": 200 },
    "object-store": { "nodeSelector": {} },
    "empty": { "": "blank key" }
  }
}`,
	}

	reg := plugin.NewRegistry()
	parsers.Register(reg)

	for name, src := range docs {
		t.Run(name, func(t *testing.T) {
			p, err := reg.ParserFor("values.json", []byte(src))
			if err != nil {
				t.Fatal(err)
			}
			cands, err := p.Extract("values.json", []byte(src))
			if err != nil {
				t.Fatal(err)
			}
			if len(cands) == 0 {
				t.Fatal("no candidates extracted")
			}
			for _, c := range cands {
				// Read it back: the path has to address the value it came from.
				got, ok, err := pathedit.Get([]byte(src), "json", c.Path)
				if err != nil || !ok {
					t.Errorf("pathedit.Get(%s): ok=%v err=%v", c.Path, ok, err)
					continue
				}
				if strings.TrimSpace(strings.Trim(c.Path, "$")) == "" {
					continue
				}
				// Write it back: the same path has to be writable.
				out, err := pathedit.Set([]byte(src), "json", c.Path, "string", "REPLACED")
				if err != nil {
					t.Errorf("pathedit.Set(%s): %v  (value was %v)", c.Path, err, got)
					continue
				}
				back, ok, err := pathedit.Get([]byte(out), "json", c.Path)
				if err != nil || !ok || back != "REPLACED" {
					t.Errorf("pathedit.Set(%s) did not land: back=%v ok=%v err=%v\n%s", c.Path, back, ok, err, out)
				}
			}
		})
	}
}
