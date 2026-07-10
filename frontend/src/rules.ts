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
  /** human name + example from the referenced preset, for friendly errors */
  presetName?: string;
  example?: string;
}

export function effectiveRules(p: Parameter, presets?: PresetRule[]): Rules {
  const v: Validation = p.validation ?? {};
  const pre = v.preset ? presets?.find((x) => x.id === v.preset) : undefined;
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
    presetName: pre?.name,
    example: pre?.example,
  };
}

// validateString returns an error message, or null when the value satisfies
// the string-shaped rules. Messages are written for non-technical users:
// they name the expected format and show an example instead of a regex.
export function validateString(value: string, rules: Rules): string | null {
  if (rules.required && value.trim() === "") return "A value is required here";
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
