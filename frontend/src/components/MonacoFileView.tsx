// Lazy-loaded Monaco pane: importing this module pulls in Monaco (a separate
// build chunk) and runs the offline setup side-effect. Shows an editor for a
// repository file, or a side-by-side diff when the committed baseline differs
// from the draft-applied content (the live "what your edits will change"
// view). When editable, changes report through onDirty and Ctrl/Cmd-S runs
// onSave — the same save path as the grid: staged into the draft.
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
  getValue: () => string;
  onDidChangeModelContent: (cb: () => void) => void;
  addCommand?: (keybinding: number, handler: () => void) => void;
  onDidChangeCursorPosition?: (cb: (e: { position: { lineNumber: number; column: number } }) => void) => void;
}

const baseOptions = {
  minimap: { enabled: true },
  fontSize: 12.5,
  lineNumbers: "on" as const,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderWhitespace: "none" as const,
  wordWrap: "off" as const,
};

// Monaco's KeyMod.CtrlCmd | KeyCode.KeyS without importing monaco eagerly.
const CTRL_CMD_S = 2048 | 49;

export default function MonacoFileView({
  path,
  content,
  original,
  dark,
  revealLine,
  editable = false,
  onDirty,
  onSave,
  onCursor,
}: {
  path: string;
  content: string;
  original?: string;
  dark: boolean;
  revealLine?: number;
  /** allow typing; edits report through onDirty, Ctrl/Cmd-S calls onSave */
  editable?: boolean;
  onDirty?: (value: string) => void;
  onSave?: (value: string) => void;
  /** live cursor position, for a Ln/Col status strip */
  onCursor?: (line: number, col: number) => void;
}) {
  const language = languageFor(path);
  const theme = dark ? "vs-dark" : "light";
  const showDiff = original !== undefined && original !== content;
  const edRef = useRef<Revealable | null>(null);
  const saveRef = useRef(onSave);
  const dirtyRef = useRef(onDirty);
  const cursorRef = useRef(onCursor);
  useEffect(() => {
    saveRef.current = onSave;
    dirtyRef.current = onDirty;
    cursorRef.current = onCursor;
  });

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

  const wire = (editor: Revealable) => {
    edRef.current = editor;
    editor.onDidChangeModelContent(() => dirtyRef.current?.(editor.getValue()));
    editor.addCommand?.(CTRL_CMD_S, () => saveRef.current?.(editor.getValue()));
    editor.onDidChangeCursorPosition?.((e) =>
      cursorRef.current?.(e.position.lineNumber, e.position.column),
    );
    reveal(revealLine);
  };

  if (showDiff) {
    return (
      <DiffEditor
        height="100%"
        original={original}
        modified={content}
        language={language}
        theme={theme}
        options={{
          ...baseOptions,
          readOnly: !editable,
          originalEditable: false,
          renderSideBySide: true,
          ignoreTrimWhitespace: false,
        }}
        onMount={(diff) => {
          const modified = diff.getModifiedEditor() as unknown as Revealable;
          wire(modified);
        }}
      />
    );
  }
  return (
    <Editor
      height="100%"
      value={content}
      language={language}
      theme={theme}
      options={{ ...baseOptions, readOnly: !editable }}
      onMount={(editor) => wire(editor as unknown as Revealable)}
    />
  );
}
