package normalize

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/abhijeet-oxide/configer/quality/internal/model"
)

func init() {
	Register("cyclonedx", normalizeCycloneDX)
}

// CycloneDX is the SBOM format the platform standardizes on. It is an OWASP
// project and an ECMA standard, every scanner in the ecosystem reads or writes
// it, and unlike SPDX it carries vulnerabilities and licences in the SAME
// document as the component inventory, so one artifact answers "what is in
// this build", "is any of it vulnerable" and "may we ship it" at once.
type cycloneDX struct {
	SpecVersion string `json:"specVersion"`
	Metadata    struct {
		Component struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"component"`
	} `json:"metadata"`
	Components      []cdxComponent `json:"components"`
	Vulnerabilities []cdxVuln      `json:"vulnerabilities"`
}

type cdxComponent struct {
	Type     string `json:"type"`
	Name     string `json:"name"`
	Version  string `json:"version"`
	PURL     string `json:"purl"`
	Licenses []struct {
		License struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"license"`
		Expression string `json:"expression"`
	} `json:"licenses"`
}

type cdxVuln struct {
	ID     string `json:"id"`
	Source struct {
		Name string `json:"name"`
		URL  string `json:"url"`
	} `json:"source"`
	Ratings []struct {
		Severity string   `json:"severity"`
		Score    *float64 `json:"score"`
		Method   string   `json:"method"`
	} `json:"ratings"`
	Description    string `json:"description"`
	Recommendation string `json:"recommendation"`
	Affects        []struct {
		Ref string `json:"ref"`
	} `json:"affects"`
}

// copyleftLicences are the identifiers that need a human decision before they
// ship in a product. The platform does not decide policy; it surfaces the
// question, because "we accidentally linked AGPL code" is discovered far too
// late by everyone who does not check.
var copyleftLicences = map[string]bool{
	"AGPL-1.0": true, "AGPL-3.0": true, "AGPL-3.0-only": true, "AGPL-3.0-or-later": true,
	"GPL-2.0": true, "GPL-3.0": true, "GPL-3.0-only": true, "GPL-3.0-or-later": true,
	"SSPL-1.0": true, "BUSL-1.1": true, "CC-BY-NC-4.0": true,
}

func normalizeCycloneDX(in Input) (Result, error) {
	var doc cycloneDX
	if err := json.Unmarshal(in.Data, &doc); err != nil {
		return Result{}, fmt.Errorf("not a CycloneDX SBOM: %w", err)
	}
	var res Result
	a := in.Analyzer

	res.Metrics = append(res.Metrics,
		metric(a, "security.sbom.components", "Components in the SBOM", float64(len(doc.Components)), "count", model.HigherBetter))

	bySeverity := map[model.Severity]int{}
	for _, v := range doc.Vulnerabilities {
		sev := cdxSeverity(v)
		bySeverity[sev]++
		affected := affectedNames(v, doc.Components)
		f := finding(a, v.ID, fmt.Sprintf("%s in %s", v.ID, humanList(affected, 3)), sev,
			model.Location{Path: manifestFor(affected, doc.Components), Symbol: strings.Join(affected, ", ")})
		f.Conf = model.ConfidenceHigh
		f.Detail = oneLine(truncate(v.Description, 300))
		f.Fix.Recommendation = oneLine(truncate(firstNonEmpty(v.Recommendation,
			"Upgrade the affected package to a version the advisory marks as fixed."), 240))
		f.Fix.DocsURL = v.Source.URL
		f.Fix.SafeToAutomate = false // a version bump is a code change with a blast radius
		f.Fix.Effort = "small"
		f.Tags = append(f.Tags, "security", "dependency")
		res.Findings = append(res.Findings, f)
	}
	res.Metrics = append(res.Metrics,
		metric(a, "security.vulnerabilities", "Known vulnerabilities", float64(len(doc.Vulnerabilities)), "count", model.LowerBetter),
		metric(a, "security.vulnerabilities.critical", "Critical vulnerabilities",
			float64(bySeverity[model.SeverityBlocker]), "count", model.LowerBetter),
		metric(a, "security.vulnerabilities.high", "High vulnerabilities",
			float64(bySeverity[model.SeverityError]), "count", model.LowerBetter))

	// Licences: one finding per distinct restrictive licence, listing its
	// packages, rather than one per package. The decision is per licence.
	byLicence := map[string][]string{}
	unlicensed := 0
	for _, c := range doc.Components {
		ids := licenceIDs(c)
		if len(ids) == 0 {
			unlicensed++
			continue
		}
		for _, id := range ids {
			if copyleftLicences[id] {
				byLicence[id] = append(byLicence[id], c.Name)
			}
		}
	}
	keys := make([]string, 0, len(byLicence))
	for k := range byLicence {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, lic := range keys {
		pkgs := byLicence[lic]
		sort.Strings(pkgs)
		f := finding(a, "licence/"+lic,
			fmt.Sprintf("%d dependencies are %s licensed", len(pkgs), lic), model.SeverityWarning)
		f.Conf = model.ConfidenceHigh
		f.Detail = "Packages: " + humanList(pkgs, 8)
		f.Fix.Recommendation = "Confirm with whoever owns licensing that this obligation is acceptable for a distributed product, or replace the dependency."
		f.Fix.SafeToAutomate = false
		f.Fix.Effort = "medium"
		f.Tags = append(f.Tags, "licence", "security")
		res.Findings = append(res.Findings, f)
	}
	res.Metrics = append(res.Metrics,
		metric(a, "security.licence.restricted", "Dependencies under a restrictive licence",
			float64(countAll(byLicence)), "count", model.LowerBetter),
		metric(a, "security.licence.unknown", "Dependencies with no declared licence",
			float64(unlicensed), "count", model.LowerBetter))
	return res, nil
}

func licenceIDs(c cdxComponent) []string {
	var out []string
	for _, l := range c.Licenses {
		if id := firstNonEmpty(l.License.ID, l.Expression, l.License.Name); id != "" {
			// An expression like "MIT OR GPL-3.0" is satisfiable by the
			// permissive half, so only a pure copyleft expression counts.
			for _, part := range strings.FieldsFunc(id, func(r rune) bool { return r == ' ' || r == '(' || r == ')' }) {
				out = append(out, strings.TrimSpace(part))
			}
		}
	}
	return out
}

func cdxSeverity(v cdxVuln) model.Severity {
	worst := model.SeverityNote
	for _, r := range v.Ratings {
		s := model.ParseSeverity(r.Severity)
		if r.Score != nil && *r.Score >= 9 {
			s = model.SeverityBlocker
		}
		if s.Rank() > worst.Rank() {
			worst = s
		}
	}
	return worst
}

func affectedNames(v cdxVuln, comps []cdxComponent) []string {
	byRef := map[string]string{}
	for _, c := range comps {
		byRef[c.PURL] = c.Name + "@" + c.Version
	}
	var out []string
	for _, a := range v.Affects {
		if n, ok := byRef[a.Ref]; ok {
			out = append(out, n)
		} else if a.Ref != "" {
			out = append(out, a.Ref)
		}
	}
	sort.Strings(out)
	if len(out) == 0 {
		out = []string{"an unnamed component"}
	}
	return out
}

// manifestFor points a dependency finding at the file a developer would edit.
// A vulnerability with no location is a vulnerability nobody fixes.
func manifestFor(names []string, comps []cdxComponent) string {
	for _, c := range comps {
		for _, n := range names {
			if !strings.HasPrefix(n, c.Name+"@") {
				continue
			}
			switch {
			case strings.HasPrefix(c.PURL, "pkg:golang/"):
				return "backend/go.mod"
			case strings.HasPrefix(c.PURL, "pkg:npm/"):
				return "frontend/package.json"
			}
		}
	}
	return ""
}

func humanList(items []string, max int) string {
	if len(items) <= max {
		return strings.Join(items, ", ")
	}
	return strings.Join(items[:max], ", ") + fmt.Sprintf(" and %d more", len(items)-max)
}

func countAll(m map[string][]string) int {
	n := 0
	for _, v := range m {
		n += len(v)
	}
	return n
}
