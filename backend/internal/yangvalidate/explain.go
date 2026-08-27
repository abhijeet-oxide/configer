package yangvalidate

// A finding is read by somebody who has never heard of YANG, a leafref or an
// XPath predicate, and who is holding a production change. So every message in
// this package is BUILT, deterministically, out of what the model actually
// says - the setting's own name, the values that do exist, the numbers the
// model allows - rather than quoting the schema's vocabulary at the reader.
//
// Three parts, and they answer three different questions:
//
//	message - what is wrong, naming the setting and the value
//	because - what the rule IS and where it comes from, in words
//	fix     - what to do about it
//
// Detail stays the schema's own expression, unchanged, for the reader who wants
// to check the constraint rather than take it on trust. It is evidence, never
// the explanation.

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/abhijeet-oxide/configer/backend/internal/yangschema"
)

// note is one finding before it is placed in a document.
type note struct {
	severity string
	rule     string
	message  string
	because  string
	fix      string
	detail   string
	// value is the value that was refused, carried as data rather than only
	// inside the message so a caller can attribute the finding to an edit.
	value string
}

// ---- references ---------------------------------------------------------

// leafrefNote explains a value that names something which is not there.
//
// This is the single most valuable check the tier makes and it is the hardest
// to say plainly, because the reader was editing ONE box and the consequence is
// somewhere else entirely. So it is told as what actually happened: a name is
// defined in one place and repeated in another, and the two no longer agree.
//
// When exactly one of the names that DO exist is a near-miss of the one that is
// gone, that is said out loud. A rename is overwhelmingly the way this breaks,
// and "did something get renamed" turns a hunt through a 1500-line file into a
// one-line fix.
func leafrefNote(s *yangschema.Node, value string, targets []any) note {
	what := lastStep(s.Type.LeafrefPath)
	if what == "" {
		what = s.Name
	}
	where := routeWords(s.Type.LeafrefPath)

	because := fmt.Sprintf("%s is not free text. Every %q is defined once, further up this same file",
		quoted(displayName(s)), what)
	if where != "" {
		because += " under " + where
	}
	because += fmt.Sprintf(", and everywhere else refers back to it by name. This file defines %s, and %s is not one of them, so nothing tells the device which one is meant.",
		countThing(len(targets), "name", "names"), quoted(value))

	n := note{
		severity: SeverityError,
		rule:     RuleLeafref,
		message:  fmt.Sprintf("Nothing in this file is called %s", quoted(value)),
		because:  because,
		fix:      "Change this to one of the names that do exist: " + summarize(targets) + ".",
		detail:   s.Type.LeafrefPath,
		value:    value,
	}
	if near, found := nearest(value, targets); found {
		n.message = fmt.Sprintf("This still says %s, but the file now says %s", quoted(value), quoted(near))
		n.fix = fmt.Sprintf("If %s was renamed to %s, change this to match. If the rename was a mistake, put %s back where it is defined - anything else still pointing at the old name will break too.",
			quoted(value), quoted(near), quoted(value))
	}
	return n
}

// nearest picks the one existing value that reads as a typo or a rename of
// want. Deliberately strict: a confident wrong suggestion sends somebody to
// edit the wrong line, so a tie or anything but a close match says nothing.
func nearest(want string, targets []any) (string, bool) {
	best, bestAt, ties := "", -1, 0
	limit := len(want)/4 + 1
	if limit > 3 {
		limit = 3
	}
	for _, t := range targets {
		candidate := fmt.Sprintf("%v", t)
		d := editDistance(strings.ToLower(want), strings.ToLower(candidate))
		if d == 0 || d > limit {
			continue
		}
		switch {
		case bestAt < 0 || d < bestAt:
			best, bestAt, ties = candidate, d, 1
		case d == bestAt:
			ties++
		}
	}
	return best, bestAt > 0 && ties == 1
}

// editDistance is Levenshtein over two short names.
func editDistance(a, b string) int {
	if a == b {
		return 0
	}
	ar, br := []rune(a), []rune(b)
	prev := make([]int, len(br)+1)
	cur := make([]int, len(br)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ar); i++ {
		cur[0] = i
		for j := 1; j <= len(br); j++ {
			cost := 1
			if ar[i-1] == br[j-1] {
				cost = 0
			}
			cur[j] = min3(cur[j-1]+1, prev[j]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(br)]
}

func min3(a, b, c int) int {
	if b < a {
		a = b
	}
	if c < a {
		a = c
	}
	return a
}

// ---- values -------------------------------------------------------------

// typeNote explains a value the model's own type will not accept. The refusal
// itself comes from the same rule extractor the cell editor uses, so the two
// tiers say the same thing about the same value.
func typeNote(s *yangschema.Node, refusal, value string) note {
	n := note{
		severity: SeverityError,
		rule:     RuleType,
		message:  capitalize(refusal),
		because:  typeSentence(s),
		detail:   typeDetail(s),
		value:    value,
	}
	switch {
	case s.Type != nil && len(s.Type.Enums) > 0:
		n.fix = "Pick one of the values listed above."
	case s.Type != nil && (len(s.Type.Ranges) > 0 || len(s.Type.Lengths) > 0):
		n.fix = "Bring the value inside the range the model allows."
	default:
		n.fix = "Correct the value, or check with whoever owns this setting."
	}
	if s.Units != "" {
		n.because += " It is measured in " + s.Units + "."
	}
	return n
}

func readOnlyNote(s *yangschema.Node) note {
	return note{
		severity: SeverityWarning,
		rule:     RuleType,
		message:  fmt.Sprintf("%s is reported by the device, not configured", quoted(displayName(s))),
		because:  "The model marks this as something the device fills in for itself, so whatever is written here is ignored.",
		fix:      "Remove it from the file; it has no effect either way.",
	}
}

// ---- what is missing ----------------------------------------------------

func mandatoryNote(s *yangschema.Node, parent string) note {
	where := "this block"
	if parent != "" {
		where = quoted(parent)
	}
	because := fmt.Sprintf("The model requires %s wherever %s appears, so %s without it is incomplete and a device will reject it.",
		quoted(displayName(s)), where, where)
	if d := strings.TrimSpace(s.Description); d != "" {
		because += " The model describes it as: " + d
	}
	return note{
		severity: SeverityError,
		rule:     RuleMandatory,
		message:  fmt.Sprintf("%s is required here and has no value", quoted(displayName(s))),
		because:  because,
		fix:      fmt.Sprintf("Give %s a value, or remove %s entirely if it is not needed.", quoted(displayName(s)), where),
	}
}

// ---- identity -----------------------------------------------------------

func keyMissingNote(list *yangschema.Node, index int, key string) note {
	name := displayName(list)
	return note{
		severity: SeverityError,
		rule:     RuleKey,
		message:  fmt.Sprintf("Entry %d of %s has no %s", index, quoted(name), quoted(key)),
		because: fmt.Sprintf("Every entry in this list is identified by its %s. Without one it cannot be addressed, and a device cannot tell it apart from the next entry.",
			quoted(key)),
		fix: fmt.Sprintf("Give this entry a %s that no other entry uses.", quoted(key)),
	}
}

func keyClashNote(list *yangschema.Node, a, b int, keys, values []string) note {
	return note{
		severity: SeverityError,
		rule:     RuleKey,
		message: fmt.Sprintf("Entries %d and %d of %s are both called %s",
			a, b, quoted(displayName(list)), quoted(strings.Join(values, ", "))),
		because: fmt.Sprintf("%s identifies an entry in this list, so it has to be different for every entry. As written, a device applies whichever of the two it reads last and the other one silently disappears.",
			quotedList(keys)),
		fix: "Rename one of them, or delete the duplicate entry.",
	}
}

func uniqueNote(list *yangschema.Node, a, b int, leaves, values []string) note {
	return note{
		severity: SeverityError,
		rule:     RuleUnique,
		message: fmt.Sprintf("Entries %d and %d of %s both use %s",
			a, b, quoted(displayName(list)), strings.Join(values, ", ")),
		because: fmt.Sprintf("The model requires %s to be different for every entry in this list, even though it is not what identifies them.",
			quotedList(leaves)),
		fix: "Change one of the two so no value is used twice.",
	}
}

// ---- how many -----------------------------------------------------------

func countNote(s *yangschema.Node, have int, min, max *int) note {
	name := quoted(displayName(s))
	n := note{severity: SeverityError, rule: RuleCount}
	switch {
	case min != nil && have < *min:
		n.message = fmt.Sprintf("%s has %s and needs at least %d", name, countThing(have, "entry", "entries"), *min)
		n.fix = fmt.Sprintf("Add %s.", countThing(*min-have, "more entry", "more entries"))
	case max != nil && have > *max:
		n.message = fmt.Sprintf("%s has %s and holds at most %d", name, countThing(have, "entry", "entries"), *max)
		n.fix = fmt.Sprintf("Remove %s.", countThing(have-*max, "entry", "entries"))
	}
	n.because = "The model states how many of these a device will accept: " + boundsWords(min, max) + "."
	return n
}

// ---- alternatives -------------------------------------------------------

func choiceBothNote(choice string, picked []string) note {
	return note{
		severity: SeverityError,
		rule:     RuleChoice,
		message:  fmt.Sprintf("%s cannot be set at the same time", quotedList(picked)),
		because: fmt.Sprintf("These are alternatives - the model lets a device act on one of them at a time (it groups them as %q).",
			choice),
		fix: "Keep whichever one applies here and remove the other.",
	}
}

func choiceNoneNote(choice string) note {
	return note{
		severity: SeverityError,
		rule:     RuleChoice,
		message:  fmt.Sprintf("One of the %q alternatives has to be chosen and none is", choice),
		because:  "The model offers a set of mutually exclusive options here and requires exactly one of them.",
		fix:      "Set one of the alternatives.",
	}
}

// ---- conditions ---------------------------------------------------------

// mustNote explains a condition the model attaches to a setting. The vendor's
// own error-message is used when there is one, because they wrote it for
// exactly this moment; the settings the expression MENTIONS are named either
// way, since a rule that compares three values is unreadable until you know
// which three.
func mustNote(s *yangschema.Node, c yangschema.Condition) note {
	msg := strings.TrimSpace(c.ErrorMessage)
	if msg == "" {
		msg = fmt.Sprintf("%s does not satisfy a rule the model attaches to it", quoted(displayName(s)))
	}
	because := "The vendor's model states a condition that has to hold here."
	if named := mentions(c.Expr); len(named) > 0 {
		because += " It is worked out from: " + quotedList(named) + "."
	}
	return note{
		severity: SeverityError,
		rule:     RuleMust,
		message:  capitalize(msg),
		because:  because,
		fix:      "Adjust the values named above until the condition holds, or check the vendor documentation for this setting.",
		detail:   c.Expr,
	}
}

func whenNote(s *yangschema.Node, c yangschema.Condition) note {
	because := "The model only defines this setting under a condition, and as the file stands that condition does not hold, so a device may ignore it."
	if named := mentions(c.Expr); len(named) > 0 {
		because += " The condition is worked out from: " + quotedList(named) + "."
	}
	return note{
		severity: SeverityWarning,
		rule:     RuleWhen,
		message:  fmt.Sprintf("%s does not apply as this file is configured", quoted(displayName(s))),
		because:  because,
		fix:      "Either set the values that make it apply, or remove it.",
		detail:   c.Expr,
	}
}

// ---- release and lifecycle ----------------------------------------------

func featureNote(s *yangschema.Node) note {
	return note{
		severity: SeverityWarning,
		rule:     RuleFeature,
		message:  fmt.Sprintf("%s is not available in this software release", quoted(displayName(s))),
		because: "The model only defines this setting for builds that include " +
			quotedList(s.IfFeatures) + ", and this release was not built with " +
			plural(len(s.IfFeatures), "it", "them") + ".",
		fix:    "Remove it, or move this instance to a release that includes it.",
		detail: strings.Join(s.IfFeatures, ", "),
	}
}

func statusNote(s *yangschema.Node) note {
	because := "The vendor has marked this setting obsolete, which means a future release may stop honouring it."
	if s.Reference != "" {
		because += " Their reference: " + s.Reference + "."
	}
	return note{
		severity: SeverityWarning,
		rule:     RuleStatus,
		message:  fmt.Sprintf("%s has been withdrawn by the vendor", quoted(displayName(s))),
		because:  because,
		fix:      "Plan to move off it; leaving it set is not an error today.",
	}
}

// ---- wording helpers ----------------------------------------------------

// typeSentence says what the model will accept here, in the reader's terms and
// never in the schema's.
func typeSentence(s *yangschema.Node) string {
	if s == nil || s.Type == nil {
		return ""
	}
	t := s.Type
	switch {
	case len(t.Enums) > 0:
		names := make([]string, 0, len(t.Enums))
		for _, e := range t.Enums {
			names = append(names, e.Name)
		}
		return "The model allows exactly these values here: " + strings.Join(names, ", ") + "."
	case len(t.Ranges) > 0:
		return "The model allows " + baseWords(t.Base) + " " + rangeWords(t.Ranges) + "."
	case len(t.Lengths) > 0:
		return "The model allows text " + rangeWords(t.Lengths) + " characters long."
	case len(t.Patterns) > 0 && t.Patterns[0].ErrorMessage != "":
		return t.Patterns[0].ErrorMessage
	case len(t.Patterns) > 0:
		return "The model requires this to be written in a fixed form."
	case t.Base != "":
		return "The model declares this as " + baseWords(t.Base) + "."
	}
	return ""
}

// baseWords turns a schema type name into something a reader recognizes.
func baseWords(base string) string {
	switch {
	case base == "":
		return "a value"
	case strings.HasPrefix(base, "uint"):
		return "a whole number, zero or above"
	case strings.HasPrefix(base, "int"):
		return "a whole number"
	case strings.HasPrefix(base, "decimal"):
		return "a number"
	case base == "boolean":
		return "true or false"
	case base == "string":
		return "text"
	case base == "enumeration":
		return "one of a fixed set of words"
	case base == "empty":
		return "a setting that is either present or absent"
	case base == "leafref", base == "identityref":
		return "a name defined elsewhere"
	}
	return base
}

func rangeWords(bs []yangschema.Bound) string {
	parts := make([]string, 0, len(bs))
	for _, b := range bs {
		switch {
		case b.Min != nil && b.Max != nil && *b.Min == *b.Max:
			parts = append(parts, "exactly "+num(*b.Min))
		case b.Min != nil && b.Max != nil:
			parts = append(parts, "between "+num(*b.Min)+" and "+num(*b.Max))
		case b.Min != nil:
			parts = append(parts, num(*b.Min)+" or more")
		case b.Max != nil:
			parts = append(parts, num(*b.Max)+" or less")
		}
	}
	if len(parts) == 0 {
		return "any value"
	}
	return strings.Join(parts, ", or ")
}

func boundsWords(min, max *int) string {
	switch {
	case min != nil && max != nil:
		return fmt.Sprintf("between %d and %d", *min, *max)
	case min != nil:
		return fmt.Sprintf("at least %d", *min)
	case max != nil:
		return fmt.Sprintf("at most %d", *max)
	}
	return "any number"
}

// routeWords spells a schema path as the folders it walks, so a reader can find
// the place it names without knowing what a path is.
func routeWords(path string) string {
	var parts []string
	for _, step := range strings.Split(strings.Trim(path, "/"), "/") {
		if name, _, ok := stepName(step); ok && name != "" {
			parts = append(parts, name)
		}
	}
	if len(parts) <= 1 {
		return ""
	}
	return strings.Join(parts[:len(parts)-1], " / ")
}

// lastStep is the name a path ends on: the thing a value is supposed to be one
// of.
func lastStep(path string) string {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	for i := len(parts) - 1; i >= 0; i-- {
		if name, _, ok := stepName(parts[i]); ok && name != "" {
			return name
		}
	}
	return ""
}

var (
	literalRe = regexp.MustCompile(`'[^']*'|"[^"]*"`)
	prefixRe  = regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_.\-]*:`)
	identRe   = regexp.MustCompile(`[A-Za-z_][A-Za-z0-9_\-]*`)
)

// xpathWords are the language's own vocabulary, which names no setting.
var xpathWords = map[string]bool{
	"and": true, "or": true, "not": true, "div": true, "mod": true,
	"count": true, "current": true, "true": true, "false": true, "boolean": true,
	"number": true, "string": true, "concat": true, "sum": true, "position": true,
	"last": true, "text": true, "node": true, "deref": true, "operation": true,
	"starts": true, "contains": true, "with": true, "length": true, "match": true,
	"re": true, "string-length": true, "starts-with": true, "re-match": true,
	"local-name": true, "translate": true, "substring": true, "normalize-space": true,
}

// mentions names the settings an expression is worked out from. It is a
// deterministic reading of the identifiers in the expression, not a translation
// of it: "which values does this rule look at" is answerable and useful, while
// "what does this rule mean" is not, and guessing at the second is how a reader
// stops trusting the first.
func mentions(expr string) []string {
	expr = literalRe.ReplaceAllString(expr, " ")
	expr = prefixRe.ReplaceAllString(expr, "")
	seen := map[string]bool{}
	var out []string
	for _, tok := range identRe.FindAllString(expr, -1) {
		if xpathWords[tok] || seen[tok] || len(tok) < 2 {
			continue
		}
		seen[tok] = true
		out = append(out, tok)
		if len(out) == 6 {
			break
		}
	}
	return out
}

func num(f float64) string { return strconv.FormatFloat(f, 'g', -1, 64) }

func quoted(s string) string {
	if s == "" {
		return "this setting"
	}
	return "\"" + s + "\""
}

func quotedList(items []string) string {
	parts := make([]string, 0, len(items))
	for _, s := range items {
		parts = append(parts, quoted(s))
	}
	switch len(parts) {
	case 0:
		return "nothing"
	case 1:
		return parts[0]
	}
	return strings.Join(parts[:len(parts)-1], ", ") + " and " + parts[len(parts)-1]
}

func countThing(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
