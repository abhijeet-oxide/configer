package normalize

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

func init() {
	Register("sarif", normalizeSARIF)
}

// SARIF 2.1.0, the OASIS standard. Only the subset the platform reads is
// modelled: parsing the whole schema would be work with no consumer, and every
// field left out is one the report would have discarded anyway.
type sarifLog struct {
	Runs []struct {
		Tool struct {
			Driver struct {
				Name            string      `json:"name"`
				Version         string      `json:"version"`
				SemanticVersion string      `json:"semanticVersion"`
				InformationURI  string      `json:"informationUri"`
				Rules           []sarifRule `json:"rules"`
			} `json:"driver"`
			Extensions []struct {
				Name  string      `json:"name"`
				Rules []sarifRule `json:"rules"`
			} `json:"extensions"`
		} `json:"tool"`
		Results []sarifResult `json:"results"`
	} `json:"runs"`
}

type sarifRule struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	HelpURI          string `json:"helpUri"`
	ShortDescription struct {
		Text string `json:"text"`
	} `json:"shortDescription"`
	FullDescription struct {
		Text string `json:"text"`
	} `json:"fullDescription"`
	Help struct {
		Text     string `json:"text"`
		Markdown string `json:"markdown"`
	} `json:"help"`
	DefaultConfiguration struct {
		Level string `json:"level"`
	} `json:"defaultConfiguration"`
	Properties struct {
		Tags             []string `json:"tags"`
		Precision        string   `json:"precision"`
		SecuritySeverity string   `json:"security-severity"`
	} `json:"properties"`
}

type sarifResult struct {
	RuleID  string `json:"ruleId"`
	RuleIdx *int   `json:"ruleIndex"`
	Level   string `json:"level"`
	Kind    string `json:"kind"`
	Message struct {
		Text string `json:"text"`
	} `json:"message"`
	Locations           []sarifLocation   `json:"locations"`
	PartialFingerprints map[string]string `json:"partialFingerprints"`
	Fixes               []struct {
		Description struct {
			Text string `json:"text"`
		} `json:"description"`
	} `json:"fixes"`
	Properties struct {
		Tags []string `json:"tags"`
	} `json:"properties"`
}

type sarifLocation struct {
	PhysicalLocation struct {
		ArtifactLocation struct {
			URI string `json:"uri"`
		} `json:"artifactLocation"`
		Region struct {
			StartLine   int `json:"startLine"`
			EndLine     int `json:"endLine"`
			StartColumn int `json:"startColumn"`
			Snippet     struct {
				Text string `json:"text"`
			} `json:"snippet"`
		} `json:"region"`
	} `json:"physicalLocation"`
	LogicalLocations []struct {
		Name               string `json:"name"`
		FullyQualifiedName string `json:"fullyQualifiedName"`
	} `json:"logicalLocations"`
}

func normalizeSARIF(in Input) (Result, error) {
	if len(strings.TrimSpace(string(in.Data))) == 0 {
		return Result{}, nil
	}
	var log sarifLog
	if err := json.Unmarshal(in.Data, &log); err != nil {
		return Result{}, fmt.Errorf("not valid SARIF: %w", err)
	}

	var res Result
	total := 0
	for _, run := range log.Runs {
		rules := map[string]sarifRule{}
		ordered := run.Tool.Driver.Rules
		for _, ext := range run.Tool.Extensions {
			ordered = append(ordered, ext.Rules...)
		}
		for _, r := range ordered {
			rules[r.ID] = r
		}

		for _, r := range run.Results {
			// SARIF uses kind to say a result is informational rather than a
			// problem; counting a "pass" as a finding is a classic mis-import.
			if k := strings.ToLower(r.Kind); k == "pass" || k == "informational" || k == "notApplicable" {
				continue
			}
			ruleID := r.RuleID
			if ruleID == "" && r.RuleIdx != nil && *r.RuleIdx >= 0 && *r.RuleIdx < len(ordered) {
				ruleID = ordered[*r.RuleIdx].ID
			}
			rule := rules[ruleID]

			sev := sarifSeverity(r.Level, rule)
			// Some rulesets put several sentences in the message. A title is a
			// headline: it has to fit a table row, a pull request bullet and a
			// code scanning summary line, so it is cut to one sentence's worth
			// and the rest becomes the detail.
			message := oneLine(firstNonEmpty(r.Message.Text, rule.ShortDescription.Text, ruleID))
			f := finding(in.Analyzer, ruleID, headline(message), sev, sarifLocations(r.Locations)...)

			if d := firstNonEmpty(rule.ShortDescription.Text, rule.FullDescription.Text, message); d != "" && d != f.Title {
				f.Detail = oneLine(truncate(d, 300))
			}
			if s := snippetOf(r.Locations); s != "" {
				f.Evidence = truncate(s, 200)
			}
			if len(r.Fixes) > 0 && r.Fixes[0].Description.Text != "" {
				f.Fix.Recommendation = oneLine(r.Fixes[0].Description.Text)
			}
			if f.Fix.Recommendation == "" {
				f.Fix.Recommendation = firstNonEmpty(rule.Help.Text, rule.FullDescription.Text, "See the rule documentation.")
				f.Fix.Recommendation = oneLine(truncate(f.Fix.Recommendation, 240))
			}
			if rule.HelpURI != "" {
				f.Fix.DocsURL = rule.HelpURI
			}
			f.Tags = mergeTags(f.Tags, rule.Properties.Tags, r.Properties.Tags)
			// A tool's own stable fingerprint beats ours when it offers one:
			// it survives edits that move a finding within a file.
			if fp := pickFingerprint(r.PartialFingerprints); fp != "" {
				f.Fingerprint = model.ComputeFingerprint(ruleID, f.PrimaryPath(), fp)
			}
			// CodeQL-style precision is a direct statement of confidence, and
			// it is better information than the manifest's blanket default.
			if p := strings.ToLower(rule.Properties.Precision); p != "" {
				switch p {
				case "very-high", "high":
					f.Conf = model.ConfidenceHigh
				case "medium":
					f.Conf = model.ConfidenceMedium
				case "low":
					f.Conf = model.ConfidenceLow
				}
			}
			res.Findings = append(res.Findings, f)
			total++
		}
	}

	// Every SARIF-emitting analyzer contributes a count metric, which is what
	// lets a budget say "no new lint errors" without knowing which linter ran.
	res.Metrics = append(res.Metrics, metric(in.Analyzer,
		fmt.Sprintf("%s.%s.findings", in.Analyzer.Category, in.Analyzer.ID),
		in.Analyzer.Name+" findings", float64(total), "count", model.LowerBetter))
	return res, nil
}

func sarifSeverity(level string, rule sarifRule) model.Severity {
	if level == "" {
		level = rule.DefaultConfiguration.Level
	}
	// GitHub's security-severity convention (a CVSS number in a string) is how
	// most security scanners actually express urgency in SARIF.
	if s := rule.Properties.SecuritySeverity; s != "" {
		var v float64
		if _, err := fmt.Sscanf(s, "%f", &v); err == nil {
			switch {
			case v >= 9.0:
				return model.SeverityBlocker
			case v >= 7.0:
				return model.SeverityError
			case v >= 4.0:
				return model.SeverityWarning
			default:
				return model.SeverityNote
			}
		}
	}
	switch strings.ToLower(level) {
	case "error":
		return model.SeverityError
	case "warning":
		return model.SeverityWarning
	case "note":
		return model.SeverityNote
	case "none":
		return model.SeverityInfo
	default:
		return ""
	}
}

func sarifLocations(locs []sarifLocation) []model.Location {
	out := make([]model.Location, 0, len(locs))
	for _, l := range locs {
		loc := model.Location{
			Path:    l.PhysicalLocation.ArtifactLocation.URI,
			Line:    l.PhysicalLocation.Region.StartLine,
			EndLine: l.PhysicalLocation.Region.EndLine,
			Column:  l.PhysicalLocation.Region.StartColumn,
		}
		if len(l.LogicalLocations) > 0 {
			loc.Symbol = firstNonEmpty(l.LogicalLocations[0].FullyQualifiedName, l.LogicalLocations[0].Name)
		}
		if loc.Path == "" && loc.Symbol == "" {
			continue
		}
		out = append(out, loc)
	}
	return out
}

func snippetOf(locs []sarifLocation) string {
	for _, l := range locs {
		if s := l.PhysicalLocation.Region.Snippet.Text; s != "" {
			return s
		}
	}
	return ""
}

func pickFingerprint(fps map[string]string) string {
	// primaryLocationLineHash is the one everybody emits; otherwise take any,
	// deterministically.
	if v, ok := fps["primaryLocationLineHash"]; ok {
		return v
	}
	best := ""
	for k, v := range fps {
		if best == "" || k < best {
			best = v
		}
	}
	return best
}

func mergeTags(sets ...[]string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range sets {
		for _, t := range s {
			t = strings.ToLower(strings.TrimSpace(t))
			if t == "" || seen[t] {
				continue
			}
			seen[t] = true
			out = append(out, t)
		}
	}
	return out
}

func oneLine(s string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(s, "\n", " ")), " ")
}

// headline reduces a multi-sentence diagnostic to its first sentence, falling
// back to a hard cut. Everything dropped survives in the finding's detail and in
// the artifact, so nothing is lost; what changes is that a report full of
// Semgrep findings stays readable, and an agent stops paying two kilobytes for
// a finding it will act on from the first line.
const headlineMax = 160

func headline(s string) string {
	if len(s) <= headlineMax {
		return s
	}
	// Prefer a sentence boundary inside the budget: ". " that is not part of a
	// version number or a file extension.
	if i := strings.Index(s, ". "); i > 40 && i < headlineMax {
		return s[:i+1]
	}
	// Otherwise cut at the last word boundary that fits.
	cut := s[:headlineMax]
	if i := strings.LastIndexByte(cut, ' '); i > 60 {
		cut = cut[:i]
	}
	return strings.TrimRight(cut, " ,;:") + "..."
}
