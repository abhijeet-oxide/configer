// Lazy-loaded Monaco pane: importing this module pulls in Monaco (a separate
// build chunk) and runs the offline setup side-effect. Shows a read-only editor
// for a rendered file, or a side-by-side diff when a committed baseline differs
// from the draft-applied content (the live "what your edits will change" view).
import { Editor, DiffEditor } from "@monaco-editor/react";
import { useEffect, useRef } from "react";
import "../monaco";
import { languageFor } from "../monaco";

// Minimal shape of the Monaco editor instance we use (reveal + cursor), so we
// avoid importing monaco types into this lazy module's public surface.
interface Revealable {
  revealLineInCenter: (line: number) => void;
  setPosition: (pos: { lineNumber: number; column: number }) => void;
  focus: () => void;
}

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
  revealLine,
}: {
  path: string;
  content: string;
  original?: string;
  dark: boolean;
  revealLine?: number;
}) {
  const language = languageFor(path);
  const theme = dark ? "vs-dark" : "light";
  const showDiff = original !== undefined && original !== content;
  const edRef = useRef<Revealable | null>(null);

  const reveal = (line?: number) => {
    if (!line || !edRef.current) return;
    edRef.current.revealLineInCenter(line);
    edRef.current.setPosition({ lineNumber: line, column: 1 });
    edRef.current.focus();
  };

  // Jump to a line when a find-in-files hit is clicked while this file is open.
  useEffect(() => {
    reveal(revealLine);
  }, [revealLine]);

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
      onMount={(editor) => {
        edRef.current = editor as unknown as Revealable;
        reveal(revealLine);
      }}
    />
  );
}
