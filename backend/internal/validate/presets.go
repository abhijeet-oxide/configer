package validate

// PresetRule is a predefined, reusable validation rule that users can pick
// from a dropdown instead of writing rules by hand. A parameter references a
// preset via Validation.Preset; explicit fields on the parameter's Validation
// apply in addition to the preset.
type PresetRule struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Pattern     string   `json:"pattern,omitempty"`
	Min         *float64 `json:"min,omitempty"`
	Max         *float64 `json:"max,omitempty"`
	MinLength   *int     `json:"minLength,omitempty"`
	MaxLength   *int     `json:"maxLength,omitempty"`
}

func fptr(v float64) *float64 { return &v }
func iptr(v int) *int         { return &v }

// presets is the built-in rule library, ordered for display.
var presets = []PresetRule{
	{
		ID: "ipv4", Name: "IPv4 address",
		Description: "Dotted-quad IPv4 address with valid octets (0–255).",
		Pattern:     `^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$`,
	},
	{
		ID: "cidr", Name: "CIDR block",
		Description: "IPv4 network in CIDR notation, e.g. 10.0.0.0/24.",
		Pattern:     `^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)/(3[0-2]|[12]?\d)$`,
	},
	{
		ID: "port", Name: "TCP/UDP port",
		Description: "Network port number between 1 and 65535.",
		Min:         fptr(1), Max: fptr(65535),
	},
	{
		ID: "hostname", Name: "Hostname label",
		Description: "Single RFC 1123 hostname label, up to 63 characters.",
		Pattern:     `^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$`,
		MaxLength:   iptr(63),
	},
	{
		ID: "fqdn", Name: "Fully qualified domain name",
		Description: "Dotted domain name with a TLD, up to 253 characters.",
		Pattern:     `^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$`,
		MaxLength:   iptr(253),
	},
	{
		ID: "url", Name: "HTTP(S) URL",
		Description: "URL starting with http:// or https://.",
		Pattern:     `^https?://[^\s]+$`,
	},
	{
		ID: "email", Name: "Email address",
		Description: "Simple email address check (local@domain.tld).",
		Pattern:     `^[^@\s]+@[^@\s]+\.[^@\s]+$`,
	},
	{
		ID: "uuid", Name: "UUID",
		Description: "RFC 4122 UUID, e.g. 123e4567-e89b-12d3-a456-426614174000.",
		Pattern:     `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`,
	},
	{
		ID: "semver", Name: "Semantic version",
		Description: "Version like 1.2.3 or v24.3.1, optional pre-release suffix.",
		Pattern:     `^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`,
	},
	{
		ID: "duration", Name: "Duration",
		Description: "Duration with unit, e.g. 500ms, 30s, 5m, 2h.",
		Pattern:     `^\d+(ms|s|m|h|d)$`,
	},
}

// Presets returns the predefined rule library.
func Presets() []PresetRule { return presets }

// PresetByID looks up a preset rule.
func PresetByID(id string) (PresetRule, bool) {
	for _, p := range presets {
		if p.ID == id {
			return p, true
		}
	}
	return PresetRule{}, false
}
