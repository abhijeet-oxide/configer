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
  };
}

// validateString returns an error message, or null when the value satisfies
// the string-shaped rules. Used to block invalid commits in the cell editor.
export function validateString(value: string, rules: Rules): string | null {
  if (rules.required && value.trim() === "") return "Value is required";
  if (rules.minLength != null && value.length < rules.minLength)
    return `Minimum ${rules.minLength} characters`;
  if (rules.maxLength != null && value.length > rules.maxLength)
    return `Maximum ${rules.maxLength} characters`;
  if (rules.pattern) {
    try {
      if (!new RegExp(rules.pattern).test(value)) return `Must match ${rules.pattern}`;
    } catch {
      // invalid regex in metadata: let the server be the judge
    }
  }
  return null;
}
