// Package validate applies a parameter's validation rules to a value and
// reports whether it is valid, with a human-readable message when not.
package validate

import (
	"fmt"
	"regexp"
	"strconv"

	"github.com/abhijeet-oxide/configer/backend/internal/model"
)

// Result is the outcome of validating a single value.
type Result struct {
	Valid   bool   `json:"valid"`
	Message string `json:"message,omitempty"`
}

var patternCache = map[string]*regexp.Regexp{}

// Value validates v against param's rules. A nil value is valid unless the
// parameter is required.
func Value(param model.Parameter, v any) Result {
	val := param.Validation
	if v == nil {
		if val.Required {
			return Result{Valid: false, Message: "value is required"}
		}
		return Result{Valid: true}
	}
	s := fmt.Sprintf("%v", v)

	if val.Pattern != "" {
		re, ok := patternCache[val.Pattern]
		if !ok {
			var err error
			re, err = regexp.Compile(val.Pattern)
			if err != nil {
				return Result{Valid: false, Message: "invalid validation pattern"}
			}
			patternCache[val.Pattern] = re
		}
		if !re.MatchString(s) {
			return Result{Valid: false, Message: "does not match pattern " + val.Pattern}
		}
	}

	if len(val.Enum) > 0 {
		found := false
		for _, e := range val.Enum {
			if e == s {
				found = true
				break
			}
		}
		if !found {
			return Result{Valid: false, Message: "not one of the allowed values"}
		}
	}

	if val.Min != nil || val.Max != nil {
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			if val.Min != nil && f < *val.Min {
				return Result{Valid: false, Message: fmt.Sprintf("below minimum %v", *val.Min)}
			}
			if val.Max != nil && f > *val.Max {
				return Result{Valid: false, Message: fmt.Sprintf("above maximum %v", *val.Max)}
			}
		}
	}

	return Result{Valid: true}
}
