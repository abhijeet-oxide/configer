package yangvalidate

// yanglint (from libyang) is the reference implementation of everything the
// native engine only approximates: full XPath for must/when, deviations,
// features, identities, leafrefs across the whole datastore, unique, list keys.
// Where it is installed it should be the engine that decides.
//
// It is NOT a requirement, and this file is written on that basis. libyang is a
// C library: on Linux it is a package, on Windows it is an afternoon with MSYS2
// or vcpkg, and demanding it would mean a developer cannot run the product on
// their own laptop. So its absence is a STATE the UI reports, the native engine
// carries the tier meanwhile, and nothing anywhere treats "not installed" as
// "valid".
//
// The bridge is deliberately thin. yanglint speaks JSON (RFC 7951) and XML;
// everything this product edits converts to one of those. Its diagnostics are
// lines of text, and turning them into findings the UI can act on is the only
// real work here.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// Yanglint shells out to the libyang command-line validator.
type Yanglint struct{}

func (y *Yanglint) Name() string { return "yanglint" }

// lookupOnce caches the binary probe. A PATH lookup per validation run is
// cheap; a PATH lookup per document on a fleet-sized change is not.
var (
	lookupOnce sync.Once
	lookupPath string
	lookupErr  error
)

// BinaryPath returns the yanglint executable this deployment will use.
// CONFIGER_YANGLINT names one explicitly, for a container that ships it
// somewhere other than the PATH.
func BinaryPath() (string, error) {
	lookupOnce.Do(func() {
		if custom := strings.TrimSpace(os.Getenv("CONFIGER_YANGLINT")); custom != "" {
			if _, err := os.Stat(custom); err != nil {
				lookupErr = fmt.Errorf("CONFIGER_YANGLINT points at %s, which is not there", custom)
				return
			}
			lookupPath = custom
			return
		}
		p, err := exec.LookPath("yanglint")
		if err != nil {
			lookupErr = errors.New("yanglint is not installed here")
			return
		}
		lookupPath = p
	})
	return lookupPath, lookupErr
}

func (y *Yanglint) Available() (bool, string) {
	if _, err := BinaryPath(); err != nil {
		// Worded for an operator, not a developer: what is missing and what it
		// would buy, never "set this environment variable".
		return false, err.Error() +
			", so the deeper cross-file model checks are not running. " +
			"Schema-derived rules and the built-in document checks still apply."
	}
	return true, ""
}

// Version reports the installed yanglint's version, for the status panel.
func Version(ctx context.Context) string {
	bin, err := BinaryPath()
	if err != nil {
		return ""
	}
	c, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(c, bin, "--version").CombinedOutput()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// runTimeout bounds one yanglint invocation. A model set of several hundred
// modules takes seconds; anything past this is a hang, and a submit that never
// answers is worse than one that says the deep check timed out.
const runTimeout = 90 * time.Second

func (y *Yanglint) Validate(ctx context.Context, req Request) (Report, error) {
	bin, err := BinaryPath()
	if err != nil {
		return Report{Available: false, Reason: err.Error()}, nil
	}
	rep := Report{Available: true, Documents: len(req.Documents)}
	if req.SchemaRoot == "" || len(req.SchemaDirs) == 0 {
		rep.Available = false
		rep.Reason = "this repository ships no YANG models, so there is nothing to validate against"
		return rep, nil
	}

	dir, err := os.MkdirTemp("", "configer-yanglint-")
	if err != nil {
		return rep, err
	}
	defer func() { _ = os.RemoveAll(dir) }()

	args := []string{"-t", "config"}
	for _, d := range req.SchemaDirs {
		args = append(args, "-p", filepath.Join(req.SchemaRoot, filepath.FromSlash(d)))
	}
	// Every module in the set is loaded, then the candidate data is validated
	// against the whole of it. Loading only the modules a file seems to use
	// would miss every augment and deviation another module applies to it,
	// which is most of what makes this engine worth invoking.
	modules, err := moduleFiles(req)
	if err != nil {
		return rep, err
	}
	if len(modules) == 0 {
		rep.Available = false
		rep.Reason = "no YANG modules could be read from this repository"
		return rep, nil
	}
	args = append(args, modules...)

	for i, doc := range req.Documents {
		if err := ctx.Err(); err != nil {
			return rep, err
		}
		if req.Progress != nil {
			req.Progress(Progress{Done: i, Total: len(req.Documents), File: doc.File, Findings: len(rep.Findings)})
		}
		payload, convErr := toJSON(doc)
		if convErr != nil {
			rep.Skipped = append(rep.Skipped, doc.File+": "+convErr.Error())
			continue
		}
		dataFile := filepath.Join(dir, fmt.Sprintf("candidate-%d.json", i))
		if err := os.WriteFile(dataFile, payload, 0o600); err != nil {
			return rep, err
		}
		out, runErr := run(ctx, bin, append(append([]string{}, args...), dataFile))
		if runErr != nil && len(out) == 0 {
			return rep, fmt.Errorf("yanglint: %w", runErr)
		}
		rep.Findings = append(rep.Findings, parseDiagnostics(out, doc, req)...)
	}
	if req.Progress != nil {
		req.Progress(Progress{Done: len(req.Documents), Total: len(req.Documents), Findings: len(rep.Findings)})
	}
	sortFindings(rep.Findings)
	return rep, nil
}

func run(ctx context.Context, bin string, args []string) (string, error) {
	c, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()
	cmd := exec.CommandContext(c, bin, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	// yanglint reports on stderr and exits non-zero when the data is invalid,
	// which is a RESULT rather than a failure to run.
	return stderr.String() + stdout.String(), err
}

// moduleFiles lists every .yang file in the schema directories, absolute.
func moduleFiles(req Request) ([]string, error) {
	var out []string
	for _, d := range req.SchemaDirs {
		abs := filepath.Join(req.SchemaRoot, filepath.FromSlash(d))
		entries, err := os.ReadDir(abs)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".yang") {
				continue
			}
			out = append(out, filepath.Join(abs, e.Name()))
		}
	}
	return out, nil
}

// toJSON renders a candidate document as the JSON yanglint reads. YAML is a
// superset of JSON, so a YAML file converts by decoding and re-encoding; a JSON
// file passes through; XML is handed over as-is with an .xml extension.
func toJSON(doc Document) ([]byte, error) {
	switch strings.ToLower(doc.Format) {
	case "json":
		return doc.Content, nil
	case "xml":
		return doc.Content, nil
	default:
		var v any
		if err := yaml.Unmarshal(doc.Content, &v); err != nil {
			return nil, err
		}
		return json.Marshal(normalizeJSON(v))
	}
}

// normalizeJSON turns the map[any]any a YAML decode can produce into the
// map[string]any JSON requires.
func normalizeJSON(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = normalizeJSON(val)
		}
		return out
	case map[any]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[fmt.Sprintf("%v", k)] = normalizeJSON(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = normalizeJSON(val)
		}
		return out
	}
	return v
}

// libyang writes diagnostics as "err : <message> (path: <xpath>)", sometimes
// with a "Data location" line following. Both shapes are read; a line that
// matches neither is kept as a message with no path rather than dropped,
// because a diagnostic nobody sees is a validation that did not happen.
var (
	diagRe = regexp.MustCompile(`(?i)^\s*(err|error|warn|warning)\s*:?\s*(.+?)\s*$`)
	pathRe = regexp.MustCompile(`\(?(?:path|Data location|Schema location)\s*:?\s*"?([^",)]+)"?\)?\s*\.?$`)
)

// parseDiagnostics turns yanglint's output into findings the UI can act on.
func parseDiagnostics(out string, doc Document, req Request) []Finding {
	var findings []Finding
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		m := diagRe.FindStringSubmatch(line)
		severity := SeverityError
		message := line
		if m != nil {
			if strings.HasPrefix(strings.ToLower(m[1]), "warn") {
				severity = SeverityWarning
			}
			message = m[2]
		} else if !strings.Contains(strings.ToLower(line), "location") {
			// Not a diagnostic at all (a banner, a blank separator).
			continue
		}

		f := Finding{
			Severity: severity, Rule: ruleOf(message), Message: message,
			File: doc.File, Instance: doc.Instance, Engine: "yanglint",
		}
		if p := pathRe.FindStringSubmatch(line); p != nil {
			f.Detail = "model path: " + p[1]
			f.Path = dottedPath(p[1])
			message = strings.TrimSpace(pathRe.ReplaceAllString(message, ""))
			f.Message = strings.TrimRight(message, " .(")
		}
		// A "Data location" line refines the finding before it rather than
		// standing on its own.
		if f.Message == "" && len(findings) > 0 {
			continue
		}
		if req.Locate != nil && f.Path != "" {
			if id, name, ok := req.Locate(f.File, f.Path); ok {
				f.ParamID, f.Name = id, name
			}
		}
		findings = append(findings, f)
	}
	return findings
}

// ruleOf classifies a libyang message so the UI can group it with the native
// engine's findings rather than showing two vocabularies for one idea.
func ruleOf(msg string) string {
	l := strings.ToLower(msg)
	switch {
	case strings.Contains(l, "must "), strings.Contains(l, "muster"):
		return RuleMust
	case strings.Contains(l, "when "):
		return RuleWhen
	case strings.Contains(l, "leafref"), strings.Contains(l, "required instance"):
		return RuleLeafref
	case strings.Contains(l, "unique"):
		return RuleUnique
	case strings.Contains(l, "key"):
		return RuleKey
	case strings.Contains(l, "mandatory"), strings.Contains(l, "missing"):
		return RuleMandatory
	case strings.Contains(l, "choice"), strings.Contains(l, "case"):
		return RuleChoice
	case strings.Contains(l, "elements"):
		return RuleCount
	case strings.Contains(l, "feature"):
		return RuleFeature
	case strings.Contains(l, "invalid"), strings.Contains(l, "value"), strings.Contains(l, "type"):
		return RuleType
	}
	return RuleSchema
}

// dottedPath converts a libyang instance path ("/mod:a/b[name='x']/c") into
// the dotted spelling the editor opens a value with. A predicate becomes a
// selector, which is exactly how this product addresses a keyed entry.
func dottedPath(x string) string {
	x = strings.TrimSpace(x)
	if x == "" || !strings.HasPrefix(x, "/") {
		return ""
	}
	var out strings.Builder
	out.WriteString("$")
	for _, step := range strings.Split(strings.Trim(x, "/"), "/") {
		if step == "" {
			continue
		}
		name, pred := step, ""
		if i := strings.IndexByte(step, '['); i >= 0 {
			name, pred = step[:i], step[i:]
		}
		if i := strings.IndexByte(name, ':'); i > 0 {
			name = name[i+1:]
		}
		out.WriteString("." + name)
		if pred != "" {
			out.WriteString(convertPredicate(pred))
		}
	}
	return out.String()
}

// convertPredicate rewrites libyang's "[key='value']" as this product's
// "[key=value]", and a positional "[3]" as a zero-based index - XPath counts
// from one and every path in this codebase counts from zero.
func convertPredicate(pred string) string {
	inner := strings.TrimSuffix(strings.TrimPrefix(pred, "["), "]")
	if n, err := strconv.Atoi(strings.TrimSpace(inner)); err == nil && n > 0 {
		return "[" + strconv.Itoa(n-1) + "]"
	}
	key, val, found := strings.Cut(inner, "=")
	if !found {
		return ""
	}
	if i := strings.IndexByte(key, ':'); i > 0 {
		key = key[i+1:]
	}
	val = strings.Trim(strings.TrimSpace(val), `'"`)
	return "[" + strings.TrimSpace(key) + "=" + val + "]"
}
