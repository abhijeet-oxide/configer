import type { SkippedFile } from "./api";

// Why the scan passed a file over, in the user's words.
//
// This exists because "skipped" on its own reads as a fault and answers the
// wrong question. The common case is not an ignore rule at all: a file whose
// own header says a generator wrote it (Flux's gotk-components.yaml, a
// committed `helm template` render, codegen output). Managing one of those
// would make Configer a second source of truth that the next run of the
// generator overwrites, so it is left alone on purpose - and the person
// looking at an empty proposal deserves to be told that, not left guessing.

export const SKIP_REASONS: Record<SkippedFile["reason"], string> = {
  generated: "the file says a generator wrote it",
  ignored: "an ignore rule in .configer/ignore.yaml matches it",
};

export const SKIP_EXPLANATIONS: Record<SkippedFile["reason"], string> = {
  generated:
    "These files carry a “generated / do not edit” header. Configer leaves them alone because " +
    "editing generated output makes a second source of truth: the next run of whatever produced them " +
    "writes over it. Manage the inputs the generator reads instead.",
  ignored: "An ignore rule in .configer/ignore.yaml matches these files.",
};

/** Group skipped files by reason, most common first. */
export function groupSkipped(files: SkippedFile[]): { reason: SkippedFile["reason"]; files: string[] }[] {
  const by = new Map<SkippedFile["reason"], string[]>();
  for (const f of files) by.set(f.reason, [...(by.get(f.reason) ?? []), f.file]);
  return [...by.entries()]
    .map(([reason, fs]) => ({ reason, files: fs.sort() }))
    .sort((a, b) => b.files.length - a.files.length);
}

/** One line for a tooltip: "2 generated, 1 ignored". */
export function skippedSummary(files: SkippedFile[]): string {
  return groupSkipped(files)
    .map((g) => `${g.files.length} ${g.reason}`)
    .join(", ");
}
