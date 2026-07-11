// Lazy-loaded Monaco pane: importing this module pulls in Monaco (a separate
// build chunk) and runs the offline setup side-effect. Shows a read-only editor
// for a rendered file, or a side-by-side diff when a committed baseline differs
// from the draft-applied content (the live "what your edits will change" view).
import { Editor, DiffEditor } from "@monaco-editor/react";
import "../monaco";
import { languageFor } from "../monaco";

const baseOptions = {
  readOnly: true,
  minimap: { enabled: true },
  fontSize: 12.5,
  lineNumbers: "on" as const,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderWhitespace: "none" as const,
  wordWrap: "off" as const,
};

export default function MonacoFileView({
  path,
  content,
  original,
  dark,
}: {
  path: string;
  content: string;
  original?: string;
  dark: boolean;
}) {
  const language = languageFor(path);
  const theme = dark ? "vs-dark" : "light";
  const showDiff = original !== undefined && original !== content;

  if (showDiff) {
    return (
      <DiffEditor
        height="100%"
        original={original}
        modified={content}
        language={language}
        theme={theme}
        options={{ ...baseOptions, renderSideBySide: true, ignoreTrimWhitespace: false }}
      />
    );
  }
  return (
    <Editor
      height="100%"
      value={content}
      language={language}
      theme={theme}
      options={baseOptions}
    />
  );
}
