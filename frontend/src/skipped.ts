import type { FileOrigin, SkippedFile } from "./api";

// Why the scan passed a file over, in the user's words.
//
// "Skipped" on its own reads as a fault and answers the wrong question. The
// common case is not an ignore rule at all: it is a file some tool generates.
// Managing one of those would make Configer a second source of truth that the
// next run of the generator reverts - so it is left alone on purpose, and the
// person looking at an empty proposal deserves to be told which tool, what will
// overwrite their edit, and where the same change would survive.
//
// The specifics come from the SERVER, from a recognizer plugin per tool, so
// teaching Configer about another generator never touches this file.

export const SKIP_REASONS: Record<SkippedFile["reason"], string> = {
  generated: "a tool generates it",
  ignored: "an ignore rule in .configer/ignore.yaml matches it",
  structural: "it describes structure rather than settings",
};

export const SKIP_EXPLANATIONS: Record<SkippedFile["reason"], string> = {
  generated:
    "Configer leaves generated files alone because editing one makes a second source of truth: " +
    "the next run of whatever produced it writes over the change.",
  ignored: "An ignore rule in .configer/ignore.yaml matches these files.",
  structural:
    "Kustomizations, Kptfiles, chart plumbing and schemas say how a repository is assembled, not what " +
    "its settings are, so Configer does not turn them into grid columns on its own.",
};

/** What a recognizer knew about one file, as a sentence. */
export function originSentence(o: FileOrigin): string {
  const parts = [`Written by ${o.name}.`];
  if (o.note) parts.push(o.note);
  if (o.instead) parts.push(o.instead);
  return parts.join(" ");
}

/** The caution shown once a generated file IS being managed. */
export function manageWarning(o?: FileOrigin): string {
  if (!o) return "This file is generated. Whatever produced it can write over your changes.";
  return o.regenerates
    ? `Running ${o.regenerates} rewrites this file, and any value you manage here goes back to what that command produces.`
    : `${o.name} rewrites this file, and any value you manage here goes back to what it produces.`;
}

/** Group skipped files by reason, most common first. */
export function groupSkipped(files: SkippedFile[]): { reason: SkippedFile["reason"]; files: SkippedFile[] }[] {
  const by = new Map<SkippedFile["reason"], SkippedFile[]>();
  for (const f of files) by.set(f.reason, [...(by.get(f.reason) ?? []), f]);
  return [...by.entries()]
    .map(([reason, fs]) => ({ reason, files: fs.sort((a, b) => a.file.localeCompare(b.file)) }))
    .sort((a, b) => b.files.length - a.files.length);
}

/** One line for a tooltip: "2 generated, 1 ignored". */
export function skippedSummary(files: SkippedFile[]): string {
  return groupSkipped(files)
    .map((g) => `${g.files.length} ${g.reason}`)
    .join(", ");
}
