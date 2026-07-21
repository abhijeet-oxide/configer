// Client-side mirror of the backend validation layering: a parameter's
// effective rules are its explicit Validation fields merged over the preset it
// references. The editors use these rules to constrain input before anything
// is ever sent to the server (which re-validates anyway).
import type { Parameter, PresetRule, Validation } from "./api";

export interface Rules {
  required?: boolean;
  pattern?: string;
  enum?: string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  /** the value's format type (ipv4, ipv6, cidr, port, …) for live per-entry
   *  validation; for a list this is the element type */
  formatType?: string;
  /** human name + example from the referenced preset, for friendly errors */
  presetName?: string;
  example?: string;
}

export function effectiveRules(p: Parameter, presets?: PresetRule[]): Rules {
  const v: Validation = p.validation ?? {};
  const pre = v.preset ? presets?.find((x) => x.id === v.preset) : undefined;
  // A list validates its ELEMENTS against itemType; a scalar validates itself
  // against its own type. Either way the format check runs per entry.
  const formatType = p.type === "list" ? p.itemType : p.type;
  return {
    required: v.required,
    pattern: v.pattern ?? pre?.pattern,
    enum: v.enum,
    min: v.min ?? pre?.min,
    max: v.max ?? pre?.max,
    minLength: v.minLength ?? pre?.minLength,
    maxLength: v.maxLength ?? pre?.maxLength,
    minItems: v.minItems,
    maxItems: v.maxItems,
    formatType: formatType && FORMAT_TYPES.has(formatType) ? formatType : undefined,
    presetName: pre?.name,
    example: pre?.example,
  };
}

// The operational scalar types that carry a real format, mirrored from the
// backend so the editors can flag a bad entry before it is ever sent.
export const FORMAT_TYPES = new Set([
  "ipv4", "ipv6", "cidr", "port", "hostname", "email", "url", "mac", "integer", "number",
]);

// Friendly label for a type, including a list's element type: list<ipv4>.
export function typeLabel(type: string, itemType?: string): string {
  if (type === "list") return itemType ? `list<${itemType}>` : "list";
  return type;
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6_RE =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|::(ffff(:0{1,4})?:)?((25[0-5]|(2[0-4]|1?\d)?\d)\.){3}(25[0-5]|(2[0-4]|1?\d)?\d))$/;
const HOSTNAME_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

function isCIDR(v: string): boolean {
  const [addr, bits, ...rest] = v.split("/");
  if (rest.length || bits === undefined) return false;
  const n = Number(bits);
  if (!Number.isInteger(n)) return false;
  if (IPV4_RE.test(addr)) return n >= 0 && n <= 32;
  if (IPV6_RE.test(addr)) return n >= 0 && n <= 128;
  return false;
}

// validateTyped checks a single value against a format type, returning a
// human-readable message (with an example) or null when it is fine. Empty is
// always fine here; required-ness is handled separately.
export function validateTyped(value: string, type?: string): string | null {
  const v = value.trim();
  if (v === "" || !type) return null;
  switch (type) {
    case "ipv4": return IPV4_RE.test(v) ? null : "Needs a valid IPv4 address, e.g. 10.0.0.1";
    case "ipv6": return IPV6_RE.test(v) ? null : "Needs a valid IPv6 address, e.g. 2001:db8::1";
    case "cidr": return isCIDR(v) ? null : "Needs a valid CIDR block, e.g. 10.0.0.0/24";
    case "port": {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 65535 ? null : "Needs a port between 1 and 65535";
    }
    case "hostname": return HOSTNAME_RE.test(v) ? null : "Needs a valid hostname, e.g. api.example.com";
    case "email": return EMAIL_RE.test(v) ? null : "Needs a valid email, e.g. ops@example.com";
    case "url": {
      try {
        const u = new URL(v);
        return u.protocol && u.host ? null : "Needs a full URL, e.g. https://example.com";
      } catch {
        return "Needs a full URL, e.g. https://example.com";
      }
    }
    case "mac": return MAC_RE.test(v) ? null : "Needs a valid MAC address, e.g. 00:1a:2b:3c:4d:5e";
    case "integer": return Number.isInteger(Number(v)) ? null : "Needs a whole number";
    case "number": return Number.isNaN(Number(v)) ? "Needs a number" : null;
    default: return null;
  }
}

// validateString returns an error message, or null when the value satisfies
// the string-shaped rules. Messages are written for non-technical users:
// they name the expected format and show an example instead of a regex.
export function validateString(value: string, rules: Rules): string | null {
  if (rules.required && value.trim() === "") return "A value is required here";
  // Format types (ipv4, ipv6, cidr, port, …) get a friendly, example-led check
  // before the pattern/length rules.
  if (rules.formatType) {
    const typed = validateTyped(value, rules.formatType);
    if (typed) return typed;
  }
  if (rules.minLength != null && value.length < rules.minLength)
    return `Needs at least ${rules.minLength} characters`;
  if (rules.maxLength != null && value.length > rules.maxLength)
    return `Keep it under ${rules.maxLength + 1} characters`;
  if (rules.pattern) {
    try {
      if (!new RegExp(rules.pattern).test(value)) {
        if (rules.presetName) {
          return `Needs to be a valid ${rules.presetName}${rules.example ? `, for example ${rules.example}` : ""}`;
        }
        return "This doesn't match the required format";
      }
    } catch {
      // invalid regex in metadata: let the server be the judge
    }
  }
  return null;
}

// fmtValue renders any cell value (scalars, lists, absence) for humans.
export function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "-";
  if (Array.isArray(v)) return v.length ? v.map(String).join(", ") : "[ ]";
  if (typeof v === "boolean") return v ? "on" : "off";
  return String(v);
}
