// Package telemetry instruments the platform itself, because a quality
// platform that cannot answer "why did this run take four minutes" has no
// standing to ask that question of anybody else's code.
//
// It emits OpenTelemetry, following the CI/CD semantic conventions the OTel
// CI/CD SIG published: a SERVER span for the pipeline run, INTERNAL spans for
// each task, and the cicd.pipeline.* attributes. It does NOT pull in the
// OpenTelemetry SDK. The whole surface needed here is "build a trace, write it
// as OTLP/JSON, optionally POST it", the SDK is a large dependency tree for a
// binary that runs in a pre-commit hook, and OTLP/JSON is a stable wire format.
// A collector reads the output either way.
package telemetry

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Span is one unit of work.
type Span struct {
	Name       string
	Kind       string // SERVER for the run, INTERNAL for a task
	TraceID    string
	SpanID     string
	ParentID   string
	Start      time.Time
	End        time.Time
	Attributes map[string]any
	Status     string // OK | ERROR
	StatusMsg  string
}

// Tracer collects spans for one run.
type Tracer struct {
	mu       sync.Mutex
	spans    []*Span
	traceID  string
	service  string
	resource map[string]any
	enabled  bool
}

// New starts a tracer. A disabled tracer still hands out span handles so no
// caller has to nil-check; it simply keeps nothing.
func New(service string, attrs map[string]string, enabled bool) *Tracer {
	res := map[string]any{
		"service.name":    service,
		"service.version": "1.0.0",
	}
	for k, v := range attrs {
		res[k] = v
	}
	// The CI/CD conventions want to know which system is running this, and it
	// is knowable without being told.
	if sys := detectCI(); sys != "" {
		res["cicd.system"] = sys
	}
	return &Tracer{traceID: randomHex(16), service: service, resource: res, enabled: enabled}
}

// TraceID exposes the run's trace id so it can be printed and correlated.
func (t *Tracer) TraceID() string { return t.traceID }

// Start opens a span. The returned function closes it.
func (t *Tracer) Start(name, kind, parent string, attrs map[string]any) (*Span, func(status, msg string)) {
	s := &Span{
		Name: name, Kind: kind, TraceID: t.traceID, SpanID: randomHex(8),
		ParentID: parent, Start: time.Now(), Attributes: attrs, Status: "OK",
	}
	if s.Attributes == nil {
		s.Attributes = map[string]any{}
	}
	return s, func(status, msg string) {
		s.End = time.Now()
		s.Status = status
		s.StatusMsg = msg
		if !t.enabled {
			return
		}
		t.mu.Lock()
		t.spans = append(t.spans, s)
		t.mu.Unlock()
	}
}

// Flush writes the trace. It writes to a file always (so a runner with no
// collector still leaves evidence in the artifacts) and POSTs to a collector
// when one is configured. A telemetry failure is never a run failure: this
// returns an error for logging, and every caller treats it as advisory.
func (t *Tracer) Flush(ctx context.Context, path, endpoint string) error {
	if !t.enabled || len(t.spans) == 0 {
		return nil
	}
	payload, err := json.MarshalIndent(t.otlp(), "", "  ")
	if err != nil {
		return err
	}
	if path != "" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, append(payload, '\n'), 0o644); err != nil {
			return err
		}
	}
	if endpoint == "" {
		return nil
	}
	url := strings.TrimSuffix(endpoint, "/") + "/v1/traces"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("could not reach the telemetry collector: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("the telemetry collector answered %s", resp.Status)
	}
	return nil
}

// otlp renders the collected spans as an OTLP/JSON ExportTraceServiceRequest.
func (t *Tracer) otlp() map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()

	spans := make([]map[string]any, 0, len(t.spans))
	for _, s := range t.spans {
		span := map[string]any{
			"traceId":           s.TraceID,
			"spanId":            s.SpanID,
			"name":              s.Name,
			"kind":              kindCode(s.Kind),
			"startTimeUnixNano": fmt.Sprint(s.Start.UnixNano()),
			"endTimeUnixNano":   fmt.Sprint(s.End.UnixNano()),
			"attributes":        kvList(s.Attributes),
			"status":            map[string]any{"code": statusCode(s.Status), "message": s.StatusMsg},
		}
		if s.ParentID != "" {
			span["parentSpanId"] = s.ParentID
		}
		spans = append(spans, span)
	}
	return map[string]any{
		"resourceSpans": []map[string]any{{
			"resource": map[string]any{"attributes": kvList(t.resource)},
			"scopeSpans": []map[string]any{{
				"scope": map[string]any{"name": "configer/quality", "version": "1.0.0"},
				"spans": spans,
			}},
		}},
	}
}

func kvList(m map[string]any) []map[string]any {
	out := make([]map[string]any, 0, len(m))
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// Sorted so two runs of the same shape produce comparable payloads.
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[j] < keys[i] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	for _, k := range keys {
		out = append(out, map[string]any{"key": k, "value": anyValue(m[k])})
	}
	return out
}

func anyValue(v any) map[string]any {
	switch x := v.(type) {
	case string:
		return map[string]any{"stringValue": x}
	case bool:
		return map[string]any{"boolValue": x}
	case int:
		return map[string]any{"intValue": fmt.Sprint(x)}
	case int64:
		return map[string]any{"intValue": fmt.Sprint(x)}
	case float64:
		return map[string]any{"doubleValue": x}
	default:
		return map[string]any{"stringValue": fmt.Sprint(x)}
	}
}

func kindCode(k string) int {
	switch strings.ToUpper(k) {
	case "SERVER":
		return 2
	case "CLIENT":
		return 3
	default:
		return 1 // INTERNAL
	}
}

func statusCode(s string) int {
	if s == "ERROR" {
		return 2
	}
	return 1
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// A trace id that is not unique is worse than useless, but so is
		// failing a quality run over one. Fall back to the clock.
		now := time.Now().UnixNano()
		for i := range b {
			b[i] = byte(now >> (8 * (i % 8)))
		}
	}
	return hex.EncodeToString(b)
}

// detectCI names the system running this, using the variables each one sets.
func detectCI() string {
	switch {
	case os.Getenv("GITHUB_ACTIONS") == "true":
		return "github-actions"
	case os.Getenv("TF_BUILD") == "True", os.Getenv("TF_BUILD") == "true":
		return "azure-devops"
	case os.Getenv("GITLAB_CI") != "":
		return "gitlab"
	case os.Getenv("JENKINS_URL") != "":
		return "jenkins"
	case os.Getenv("CI") != "":
		return "unknown-ci"
	default:
		return ""
	}
}

// DetectCI is the exported form, used for the run metadata too.
func DetectCI() string {
	if s := detectCI(); s != "" {
		return s
	}
	return "local"
}
