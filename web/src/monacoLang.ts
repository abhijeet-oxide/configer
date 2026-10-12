// languageFor maps a file path to a Monaco language id for highlighting. It
// lives apart from ./monaco (which imports the multi-megabyte monaco-editor
// package) so eager callers like FilesView can label files without pulling the
// editor into the main bundle; the editor itself stays behind a lazy import.
/** Files the markdown view can render: a repository's prose lives in .md. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(path);
}

export function languageFor(path: string): string {
  if (path.endsWith(".xml")) return "xml";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  // A repository's prose is edited here too (READMEs, runbooks): its source
  // deserves highlighting like everything else.
  if (/\.(md|markdown|mdown|mkd)$/i.test(path)) return "markdown";
  return "plaintext";
}
