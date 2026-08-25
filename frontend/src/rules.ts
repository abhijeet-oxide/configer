// Client-side mirror of the backend validation layering: a parameter's
// effective rules are its explicit Validation fields merged over the preset it
// references. The editors use these rules to constrain input before anything
// is ever sent to the server (which re-validates anyway).
import type { Alternative, Parameter, PresetRule, Span, Validation } from "./api";

export interface Rules {
  required?: boolean;
  pattern?: string;
  /** further expressions that must ALL hold on top of `pattern` */
  patterns?: string[];
  /** expressions the value must NOT match */
  notPatterns?: string[];
  enum?: string[];
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  /** the DISJOINT spans a restriction really allows. When present they decide,
   *  and min/max only describe their outer edges - a value in the gap between
   *  two spans satisfies those and not the rule the vendor wrote. */
  ranges?: Span[];
  lengths?: Span[];
  /** named flags a value may be built from: any subset, space-separated */
  bits?: string[];
  /** alternative rule sets, of which the value must satisfy at least ONE */
  anyOf?: Alternative[];
  /** digits allowed after the decimal point */
  maxDecimals?: number;
  /** the model reports this value rather than taking it: shown, never edited */
  readOnly?: boolean;
  /** the value's format type (ipv4, ipv6, cidr, port, …) for live per-entry
   *  validation; for a list this is the element type */
  formatType?: string;
  /** human name + example from the referenced preset, for friendly errors */
  presetName?: string;
  example?: string;
  /** the schema's own wording for a refused value, which beats every generic
   *  sentence this file can write */
  errorMessage?: string;
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
    patterns: v.patterns,
    notPatterns: v.notPatterns,
    enum: v.enum,
    min: v.min ?? pre?.min,
    max: v.max ?? pre?.max,
    minLength: v.minLength ?? pre?.minLength,
    maxLength: v.maxLength ?? pre?.maxLength,
    minItems: v.minItems,
    maxItems: v.maxItems,
    ranges: v.ranges,
    lengths: v.lengths,
    bits: v.bits,
    anyOf: v.anyOf,
    maxDecimals: v.maxDecimals,
    readOnly: v.readOnly,
    formatType: formatType && FORMAT_TYPES.has(formatType) ? formatType : undefined,
    presetName: pre?.name,
    example: pre?.example,
    errorMessage: v.errorMessage,
  };
}

// --- the rules a single value can be held against -------------------------
// Mirrored from backend/internal/validate. The server re-checks everything;
// this is what makes a bad value visible while it is still being typed, which
// is the only moment fixing it is free.

/** Does a number land inside any of the spans? */
function inAnySpan(spans: Span[] | undefined, n: number): boolean {
  if (!spans?.length) return true;
  return spans.some((s) => (s.min == null || n >= s.min) && (s.max == null || n <= s.max));
}

/** Word a set of spans the way the schema meant them. */
export function describeSpans(spans: Span[]): string {
  const parts = spans.map((s) => {
    if (s.min != null && s.max != null) return s.min === s.max ? `${s.min}` : `${s.min} to ${s.max}`;
    if (s.min != null) return `${s.min} or more`;
    if (s.max != null) return `${s.max} or less`;
    return "";
  }).filter(Boolean);
  if (!parts.length) return "within the allowed range";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

function decimalsOf(raw: string): number {
  if (/[eE]/.test(raw)) return 0;
  const dot = raw.indexOf(".");
  return dot < 0 ? 0 : raw.slice(dot + 1).replace(/0+$/, "").length;
}

/** Check a value against one alternative of a union. */
function altAccepts(alt: Alternative, value: string): boolean {
  if (alt.type && FORMAT_TYPES.has(alt.type) && validateTyped(value, alt.type)) return false;
  for (const p of [alt.pattern, ...(alt.patterns ?? [])]) {
    if (!p) continue;
    try {
      if (!new RegExp(p).test(value)) return false;
    } catch {
      return true; // an expression this engine cannot read decides nothing
    }
  }
  for (const p of alt.notPatterns ?? []) {
    try {
      if (new RegExp(p).test(value)) return false;
    } catch {
      /* as above */
    }
  }
  if (alt.enum?.length && !alt.enum.includes(value)) return false;
  if (alt.bits?.length && value.trim() && !value.trim().split(/\s+/).every((w) => alt.bits!.includes(w))) return false;
  const n = Number(value);
  if (Number.isFinite(n) && value.trim() !== "") {
    if (alt.ranges?.length) {
      if (!inAnySpan(alt.ranges, n)) return false;
    } else {
      if (alt.min != null && n < alt.min) return false;
      if (alt.max != null && n > alt.max) return false;
    }
  }
  const len = [...value].length;
  if (alt.minLength != null && len < alt.minLength) return false;
  if (alt.maxLength != null && len > alt.maxLength) return false;
  if (alt.lengths?.length && !inAnySpan(alt.lengths, len)) return false;
  return true;
}

/** validateSchemaRules applies the rules a schema states that the type checks
 *  and the plain min/max do not carry: alternatives, flags, disjoint spans,
 *  inverted patterns and decimal precision.
 *
 *  It returns the SCHEMA's own wording whenever the schema supplied any: a
 *  vendor sentence naming the setting beats a generic one describing
 *  arithmetic, and it is the same sentence the server will answer with. */
export function validateSchemaRules(value: string, rules: Rules): string | null {
  const v = value.trim();
  if (v === "") return null;
  const refuse = (generic: string) => rules.errorMessage || generic;

  // A union is checked WHOLE and first. Its members disagree about what the
  // value even is, so layering their rules would refuse both legitimate
  // spellings of "a number or the word auto".
  if (rules.anyOf?.length) {
    if (rules.anyOf.some((a) => altAccepts(a, v))) return null;
    const labels = rules.anyOf.map((a) => a.label || a.type || "a value");
    return refuse(`Needs to be one of: ${[...new Set(labels)].join(", ")}`);
  }

  for (const p of rules.patterns ?? []) {
    try {
      if (!new RegExp(p).test(v)) return refuse("This doesn't match the required format");
    } catch {
      /* an expression this engine cannot read decides nothing */
    }
  }
  for (const p of rules.notPatterns ?? []) {
    try {
      if (new RegExp(p).test(v)) return refuse("This form of the value is not allowed here");
    } catch {
      /* as above */
    }
  }
  if (rules.bits?.length) {
    const bad = v.split(/\s+/).find((w) => !rules.bits!.includes(w));
    if (bad) return `"${bad}" is not one of the allowed flags (${rules.bits.join(", ")})`;
  }
  const n = Number(v);
  if (Number.isFinite(n)) {
    if (rules.ranges && rules.ranges.length > 1 && !inAnySpan(rules.ranges, n)) {
      return refuse(`Needs to be ${describeSpans(rules.ranges)}`);
    }
    if (rules.maxDecimals != null && decimalsOf(v) > rules.maxDecimals) {
      return refuse(
        rules.maxDecimals === 0
          ? "Needs to be a whole number"
          : `Keep it to ${rules.maxDecimals} decimal place${rules.maxDecimals === 1 ? "" : "s"}`,
      );
    }
  }
  if (rules.lengths && rules.lengths.length > 1 && !inAnySpan(rules.lengths, [...v].length)) {
    return refuse(`The length has to be ${describeSpans(rules.lengths)} characters`);
  }
  return null;
}

// The operational scalar types that carry a real format, mirrored from the
// backend so the editors can flag a bad entry before it is ever sent.
export const FORMAT_TYPES = new Set([
  "ipv4", "ipv6", "cidr", "port", "hostname", "email", "url", "mac", "integer", "number",
  "cpu", "memory", "duration", "percentage",
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
// Kubernetes-style operational quantities, mirrored from the backend.
const CPU_RE = /^\d+(\.\d+)?m?$/;
// Memory requires its unit: a bare number is bytes and a trailing "m" is
// thousandths of a byte, and neither is ever what somebody writing a memory
// limit meant. See backend/internal/validate/quantity.go.
const MEMORY_RE = /^\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|Ei|[kKMGTPE])$/;
const MEMORY_MILLI_RE = /^\d+(\.\d+)?m$/;
const BARE_NUMBER_RE = /^\d+(\.\d+)?$/;
const DURATION_RE = /^\d+(\.\d+)?(ns|us|ms|s|m|h|d)$/;
const PERCENT_RE = /^\d+(\.\d+)?%$/;

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
    case "cpu":
      if (!CPU_RE.test(v)) return "Needs a CPU quantity, e.g. 500m or 2";
      return Number(v.replace("m", "")) > 0 ? null : "CPU must be greater than zero";
    case "memory":
      if (MEMORY_MILLI_RE.test(v)) {
        const base = v.slice(0, -1);
        return `${v} means ${base} thousandths of a byte. Write the unit you mean, e.g. ${base}Mi or ${base}Gi`;
      }
      if (BARE_NUMBER_RE.test(v)) return `${v} has no unit. Memory needs one, e.g. ${v}Mi or ${v}Gi`;
      if (!MEMORY_RE.test(v)) return "Needs a memory quantity with a unit, e.g. 256Mi or 1Gi";
      return parseFloat(v) > 0 ? null : "Memory must be greater than zero";
    case "duration": return DURATION_RE.test(v) ? null : "Needs a duration with a unit, e.g. 30s or 5m";
    case "percentage": {
      if (!PERCENT_RE.test(v)) return "Needs a percentage, e.g. 75%";
      const n = parseFloat(v);
      return n >= 0 && n <= 100 ? null : "Percentage must be between 0% and 100%";
    }
    default: return null;
  }
}

// validateNumber returns an error message, or null when the value satisfies the
// numeric rules. It is the reason the number editor never silently rewrites an
// entry: a value outside min/max (or a fraction where a whole number is
// required) is REPORTED, not clamped or rounded, so the user sees the rule
// instead of a number they did not type.
export function validateNumber(value: string | number, rules: Rules, integer: boolean): string | null {
  const raw = String(value ?? "").trim();
  if (raw === "") return rules.required ? "A value is required here" : null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return "Needs a number";
  if (integer && !Number.isInteger(n)) return "Needs a whole number";
  // A format type (port, percentage, …) names its own range in one sentence,
  // so it answers before the raw min/max rules do.
  if (rules.formatType) {
    const typed = validateTyped(raw, rules.formatType);
    if (typed) return typed;
  }
  // The disjoint spans are the real rule when there is more than one: min/max
  // describe only their outer edges, and a value in the gap between two spans
  // satisfies those while the schema refuses it.
  if (rules.ranges && rules.ranges.length > 1) {
    const schema = validateSchemaRules(raw, rules);
    if (schema) return schema;
  } else {
    if (rules.min != null && n < rules.min) return `Needs to be ${rules.min} or more`;
    if (rules.max != null && n > rules.max) return `Needs to be ${rules.max} or less`;
  }
  return validateSchemaRules(raw, rules);
}

// validateString returns an error message, or null when the value satisfies
// the string-shaped rules. Messages are written for non-technical users:
// they name the expected format and show an example instead of a regex.
export function validateString(value: string, rules: Rules): string | null {
  if (rules.required && value.trim() === "") return "A value is required here";
  // A union is checked whole and before everything else: its members disagree
  // about what the value even is, so the parameter's own format type is the
  // widest of them and cannot speak for any one branch.
  if (rules.anyOf?.length) return validateSchemaRules(value, rules);
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
        if (rules.errorMessage) return rules.errorMessage;
        if (rules.presetName) {
          return `Needs to be a valid ${rules.presetName}${rules.example ? `, for example ${rules.example}` : ""}`;
        }
        return "This doesn't match the required format";
      }
    } catch {
      // invalid regex in metadata: let the server be the judge
    }
  }
  return validateSchemaRules(value, rules);
}

// unitOf returns the unit a CPU or memory value carries ("" when it is a bare
// number), and null when the value is not a well-formed quantity of that type.
function unitOf(type: string | undefined, raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  if (type === "cpu") {
    if (!CPU_RE.test(v)) return null;
    return v.endsWith("m") ? "m" : "";
  }
  if (type === "memory") {
    for (const suf of ["Ki", "Mi", "Gi", "Ti", "Pi", "Ei"]) {
      if (v.endsWith(suf)) return suf;
    }
    const last = v.slice(-1);
    if ("kKMGTPE".includes(last)) return last;
    return BARE_NUMBER_RE.test(v) ? "" : null;
  }
  return null;
}

// validateUnitChange mirrors validate.UnitChange on the backend: a CPU or
// memory value that was written WITH a unit has to keep one.
//
// Kubernetes writes CPU two legitimate ways - "350m" and "2" - so no format
// rule can refuse a bare number without calling every `cpu: "1"` in a real
// chart wrong. But the two forms are a thousand times apart, and a unit going
// missing is invisible in a before/after column: "350m" edited to "350" reads
// like a tidy-up and means 350 whole CPUs. So the rule is about the edit rather
// than the value, and it only refuses the losing direction - adding or swapping
// a unit is a change a reviewer can read.
export function validateUnitChange(value: string, previous: unknown, type?: string): string | null {
  if (type !== "cpu" && type !== "memory") return null;
  const oldUnit = unitOf(type, previous);
  const newUnit = unitOf(type, value);
  if (oldUnit === null || newUnit === null || oldUnit === "" || newUnit !== "") return null;
  const v = String(value).trim();
  if (type === "cpu") {
    return `This value is written in millicores (${previous}). ${v} has no unit, which means ${v} whole CPUs - write ${v}m to keep the millicores`;
  }
  return `This value is written with a unit (${previous}). ${v} has none, which means ${v} bytes - add the unit you mean, e.g. ${v}${oldUnit}`;
}

// fmtValue renders any cell value (scalars, lists, absence) for humans.
export function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "-";
  if (Array.isArray(v)) return v.length ? v.map(String).join(", ") : "[ ]";
  if (typeof v === "boolean") return v ? "on" : "off";
  return String(v);
}
