package report

import (
	"encoding/json"
	"fmt"
	"html/template"
	"os"
	"path/filepath"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

// WriteHTML renders the dashboard a person opens.
//
// It is one self-contained file with no network dependency of any kind: a CI
// artifact that needs a CDN to render is an artifact that renders differently
// in six months, or not at all behind a corporate proxy. Everything is inline,
// the whole report is embedded as JSON for a reader who wants the raw numbers,
// and it works in both light and dark.
func WriteHTML(path string, r *model.Report) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	data := struct {
		R       *model.Report
		RawJSON template.JS
		Skipped string
	}{R: r, RawJSON: template.JS(raw), Skipped: strings.Join(r.Selection.Skipped, ", ")}

	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return htmlTemplate.Execute(f, data)
}

var htmlFuncs = template.FuncMap{
	"dur":    duration,
	"num":    num,
	"change": changeWords,
	"counts": countWords,
	"title":  title,
	// The typed vocabulary (Verdict, Severity, BudgetStatus) is deliberately
	// not plain strings, so the template helpers take anything printable rather
	// than forcing a conversion at every call site.
	"upper": func(v any) string { return strings.ToUpper(fmt.Sprint(v)) },
	"join":  strings.Join,
	"short": func(s string, n int) string {
		if len(s) < n {
			return s
		}
		return s[:n]
	},
	"pct": func(n int) string { return fmt.Sprintf("%d%%", n) },
	"statusClass": func(s any) string {
		return "s-" + strings.ToLower(fmt.Sprint(s))
	},
	"sevClass": func(s model.Severity) string { return "sev-" + string(s) },
	"hasLoc":   func(f model.Finding) bool { return len(f.Where) > 0 },
	"loc": func(f model.Finding) string {
		if len(f.Where) == 0 {
			return ""
		}
		return f.Where[0].String()
	},
}

// The stylesheet states each status in more than one channel (a colour AND a
// word AND a border weight) so the dashboard survives being printed, shrunk, or
// read by somebody who cannot separate the hues.
var htmlTemplate = template.Must(template.New("report").Funcs(htmlFuncs).Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quality report {{.R.Meta.ID}}</title>
<style>
:root{--bg:#fff;--fg:#101418;--muted:#5b6672;--line:#e3e8ee;--card:#f7f9fb;
--pass:#1a7f4b;--warn:#9a6700;--fail:#b42318;--info:#3c5bd6;--accent:#101418}
@media(prefers-color-scheme:dark){:root{--bg:#0e1116;--fg:#e6edf3;--muted:#8b98a5;
--line:#232a33;--card:#161b22;--pass:#3fb950;--warn:#d29922;--fail:#f85149;--info:#6f9dff;--accent:#e6edf3}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:17px;margin:36px 0 12px;letter-spacing:.01em}
.sub{color:var(--muted);font-size:13px;margin:0 0 24px}
.verdict{display:inline-block;padding:4px 12px;border-radius:999px;font-weight:650;
font-size:13px;letter-spacing:.06em;border:2px solid currentColor}
.s-pass,.s-ok{color:var(--pass)}.s-warn{color:var(--warn)}.s-fail,.s-error{color:var(--fail)}
.s-skip,.s-skipped{color:var(--muted)}
.headline{font-size:17px;margin:16px 0 8px;font-weight:600}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(165px,1fr))}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.tile .k{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.tile .v{font-size:24px;font-weight:640;margin-top:4px;font-variant-numeric:tabular-nums}
.tile .d{font-size:12px;color:var(--muted);margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}
.scroll{overflow-x:auto}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:600}
td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.f{border-left:3px solid var(--line);padding:10px 0 10px 14px;margin:0 0 6px}
.f.sev-blocker,.f.sev-error{border-left-color:var(--fail)}
.f.sev-warning{border-left-color:var(--warn)}
.f.sev-note,.f.sev-info{border-left-color:var(--muted)}
.f .t{font-weight:600}
.f .m{color:var(--muted);font-size:13px;margin-top:2px}
.tag{display:inline-block;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;
border:1px solid var(--line);border-radius:4px;padding:1px 6px;margin-right:5px;color:var(--muted)}
.new{border-color:var(--info);color:var(--info)}
.auto{border-color:var(--pass);color:var(--pass)}
ol.steps{padding-left:20px}ol.steps li{margin:6px 0}
details{margin-top:12px}summary{cursor:pointer;color:var(--muted);font-size:13px}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;
overflow:auto;max-height:400px;font-size:12px}
footer{margin-top:48px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
</style></head><body><div class="wrap">

<h1>Quality report</h1>
<p class="sub">{{.R.Meta.Branch}}{{if .R.Meta.Commit}} at <span class="mono">{{short .R.Meta.Commit 8}}</span>{{end}}
 &middot; {{.R.Selection.Tier}} stage &middot; {{dur .R.Meta.DurationMS}} &middot; {{.R.Meta.StartedAt.Format "2006-01-02 15:04 MST"}}</p>

<span class="verdict {{statusClass .R.Summary.Verdict}}">{{upper .R.Summary.Verdict}}</span>
<p class="headline">{{.R.Summary.Headline}}</p>

<div class="grid">
  <div class="tile"><div class="k">Score</div><div class="v">{{.R.Summary.Score}}</div>
    <div class="d">{{if .R.Summary.ScoreDelta}}{{.R.Summary.ScoreDelta}} against the baseline{{else}}no baseline yet{{end}}</div></div>
  <div class="tile"><div class="k">Findings</div><div class="v">{{len .R.Findings}}</div>
    <div class="d">{{counts .R.Summary.Counts}}</div></div>
  <div class="tile"><div class="k">New</div><div class="v">{{.R.Summary.NewFindings}}</div>
    <div class="d">{{.R.Summary.FixedSince}} cleared since the baseline</div></div>
  <div class="tile"><div class="k">Checks</div><div class="v">{{len .R.Selection.Selected}}</div>
    <div class="d">{{.R.Meta.CacheHits}} served from cache</div></div>
  <div class="tile"><div class="k">Changed files</div><div class="v">{{.R.Selection.ChangedFiles}}</div>
    <div class="d">{{join .R.Selection.Scopes " + "}}</div></div>
</div>

{{if .R.Summary.NextSteps}}<h2>What to do next</h2>
<ol class="steps">{{range .R.Summary.NextSteps}}<li>{{.}}</li>{{end}}</ol>{{end}}

<h2>Quality budgets</h2>
<div class="scroll"><table>
<tr><th>Budget</th><th>Status</th><th class="n">Measured</th><th class="n">Baseline</th><th class="n">Change</th><th>Rule</th><th>Detail</th></tr>
{{range .R.Budgets}}<tr>
<td>{{.Budget}}</td>
<td class="{{statusClass .Status}}"><strong>{{upper .Status}}</strong>{{if and (eq (print .Status) "fail") (not .Blocking)}} <span class="tag">advisory</span>{{end}}</td>
<td class="n">{{num .Value}}</td><td class="n">{{num .Baseline}}</td><td class="n">{{change .}}</td>
<td>{{.Limit}}</td><td>{{.Message}}</td></tr>{{end}}
</table></div>

{{if .R.Categories}}<h2>By area</h2>
<div class="scroll"><table>
<tr><th>Area</th><th class="n">Score</th><th class="n">Findings</th><th class="n">Metrics</th><th>Verdict</th></tr>
{{range .R.Categories}}<tr><td>{{title (print .Category)}}</td><td class="n">{{.Score}}</td>
<td class="n">{{.Findings}}</td><td class="n">{{.Metrics}}</td>
<td class="{{statusClass .Verdict}}">{{upper .Verdict}}</td></tr>{{end}}
</table></div>{{end}}

{{if .R.Findings}}<h2>Findings</h2>
{{range .R.Findings}}<div class="f {{sevClass .Severity}}">
<div class="t">{{.Title}}</div>
<div class="m">
{{if hasLoc .}}<code>{{loc .}}</code> &middot; {{end}}{{upper .Severity}} &middot; {{.Analyzer}} &middot; {{.Conf}} confidence
{{if .New}} <span class="tag new">new</span>{{end}}
{{if .Fix.SafeToAutomate}} <span class="tag auto">safe to automate</span>{{end}}
</div>
{{if .Fix.Recommendation}}<div class="m">{{.Fix.Recommendation}}</div>{{end}}
{{if .Evidence}}<div class="m mono">{{.Evidence}}</div>{{end}}
</div>{{end}}{{end}}

{{if .R.Metrics}}<h2>Measurements</h2>
<details><summary>{{len .R.Metrics}} metrics</summary>
<div class="scroll"><table><tr><th>Metric</th><th>Subject</th><th class="n">Value</th><th>Unit</th><th>Analyzer</th></tr>
{{range .R.Metrics}}<tr><td><code>{{.ID}}</code></td><td>{{.Subject}}</td>
<td class="n">{{.Format .Value}}</td><td>{{.Unit}}</td><td>{{.Analyzer}}</td></tr>{{end}}
</table></div></details>{{end}}

<h2>What ran</h2>
<div class="scroll"><table>
<tr><th>Check</th><th>Status</th><th class="n">Time</th><th>Cached</th><th class="n">Findings</th><th>Tool</th></tr>
{{range .R.Analyzers}}<tr><td>{{.ID}}</td>
<td class="{{statusClass .Status}}">{{.Status}}{{if .Reason}} <span class="m">({{.Reason}})</span>{{end}}</td>
<td class="n">{{dur .DurationMS}}</td><td>{{if .CacheHit}}yes{{end}}</td>
<td class="n">{{.Findings}}</td><td class="m">{{.Tool}} {{.Version}}</td></tr>{{end}}
</table></div>
{{if .Skipped}}<p class="sub">Not run: {{.Skipped}}</p>{{end}}

{{if .R.Errors}}<h2>The platform itself had trouble</h2>
<ul>{{range .R.Errors}}<li>{{.}}</li>{{end}}</ul>
<p class="sub">These are problems with the checks, not with the code under review.</p>{{end}}

<details><summary>Raw report (JSON)</summary><pre>{{.RawJSON}}</pre></details>

<footer>Continuous Quality Platform &middot; schema {{.R.Schema}} &middot; run {{.R.Meta.ID}}</footer>
</div></body></html>
`))
