// Lazy-loaded Monaco pane: importing this module pulls in Monaco (a separate
// build chunk) and runs the offline setup side-effect. Shows an editor for a
// repository file, or a side-by-side diff when the committed baseline differs
// from the draft-applied content (the live "what your edits will change"
// view). When editable, changes report through onDirty and Ctrl/Cmd-S runs
// onSave, the same save path as the grid: staged into the draft.
import { Editor, DiffEditor } from "@monaco-editor/react";
import { useEffect, useRef } from "react";
import "../monaco";
import { languageFor } from "../monacoLang";

// Minimal shape of the Monaco editor instance we use (reveal, cursor,
// decorations), so we avoid importing monaco types into this lazy module's
// public surface.
interface Decoration {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  options: Record<string, unknown>;
}
interface Revealable {
  revealLineInCenter: (line: number) => void;
  setPosition: (pos: { lineNumber: number; column: number }) => void;
  setSelection?: (sel: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) => void;
  focus: () => void;
  getValue: () => string;
  onDidChangeModelContent: (cb: () => void) => void;
  addCommand?: (keybinding: number, handler: () => void) => void;
  onDidChangeCursorPosition?: (cb: (e: { position: { lineNumber: number; column: number } }) => void) => void;
  deltaDecorations?: (old: string[], next: Decoration[]) => string[];
  getModel?: () => { getLineMaxColumn?: (line: number) => number; getLineCount?: () => number } | null;
}

/** One value the file's owner should be able to see at a glance is looked after
 *  by Configer: where it is, and what to say about it on hover. col/endCol
 *  bracket the value itself; without them the whole line is marked. */
export interface LineMark {
  line: number;
  col?: number;
  endCol?: number;
  label: string;
  /** mark this one loudly and briefly: the reader was sent here to look at it */
  focus?: boolean;
}

const baseOptions = {
  minimap: { enabled: true },
  // Monaco's sticky scroll pins the enclosing block over the first lines of the
  // viewport, which is exactly where a value we have just revealed tends to be:
  // it covered the thing the reader was sent to look at. A configuration file is
  // shallow enough that the context it restates is not worth that.
  stickyScroll: { enabled: false },
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
  revealColumn,
  marks,
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
  /** column to land the cursor on within revealLine (the value's own start) */
  revealColumn?: number;
  /** values to mark as managed by Configer (quietly - see the effect below) */
  marks?: LineMark[];
  /** allow typing; edits report through onDirty, Ctrl/Cmd-S calls onSave */
  editable?: boolean;
  onDirty?: (value: string) => void;
  onSave?: (value: string) => void;
  /** live cursor position, for a Ln/Col status strip */
  onCursor?: (line: number, col: number) => void;
}) {
  const language = languageFor(path);
  const theme = dark ? "vs-dark" : "light";
  const decoRef = useRef<string[]>([]);
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

  const reveal = (line?: number, column?: number) => {
    if (!line || !edRef.current) return;
    edRef.current.revealLineInCenter(line);
    edRef.current.setPosition({ lineNumber: line, column: column ?? 1 });
    // The cursor lands ON the value when we know where it is; the mark below
    // (cf-managed-focus) is what actually makes it obvious, so nothing here
    // selects text the reader did not ask to select.
    if (column === undefined) {
      edRef.current.setSelection?.({ startLineNumber: line, startColumn: 1, endLineNumber: line + 1, endColumn: 1 });
    }
    edRef.current.focus();
  };

  // Jump to a line when a find-in-files hit is clicked while this file is open.
  useEffect(() => {
    reveal(revealLine, revealColumn);
     
  }, [revealLine, revealColumn]);

  // Mark the lines Configer manages. A file is mostly ordinary text with a
  // handful of values the product actually looks after, and nothing in the
  // editor said which - so an operator editing by hand had no way to know which
  // line the grid would fight them over. The mark is deliberately quiet: a
  // hairline in the margin and the faintest wash (see .cf-managed-line), never
  // a colour that competes with syntax highlighting or the diff's own green and
  // red. The hover says which parameter owns the line.
  //
  // Applied from BOTH the effect and onMount, because the two arrive in either
  // order: Monaco mounts asynchronously and the lines are fetched, so whichever
  // is last has to be the one that paints.
  const marksRef = useRef(marks);
  useEffect(() => {
    marksRef.current = marks;
  });
  const applyMarks = () => {
    const ed = edRef.current;
    if (!ed?.deltaDecorations) return;
    const lines = ed.getModel?.()?.getLineCount?.() ?? Number.MAX_SAFE_INTEGER;
    const next = (marksRef.current ?? [])
      .filter((m) => m.line > 0 && m.line <= lines)
      .map((m) => {
        // The VALUE, where we know its columns: marking the whole line paints
        // the key, the indentation and the trailing comment as though Configer
        // owned them too. Only a value that cannot be narrowed (a block scalar)
        // falls back to the line.
        const whole = !m.col || !m.endCol;
        return {
          range: whole
            ? { startLineNumber: m.line, startColumn: 1, endLineNumber: m.line, endColumn: 1 }
            : { startLineNumber: m.line, startColumn: m.col!, endLineNumber: m.line, endColumn: m.endCol! },
          options: {
            isWholeLine: whole,
            className: whole
              ? `cf-managed-line${m.focus ? " cf-managed-focus" : ""}`
              : `cf-managed-value${m.focus ? " cf-managed-focus" : ""}`,
            linesDecorationsClassName: "cf-managed-gutter",
            hoverMessage: { value: m.label },
            overviewRuler: { color: m.focus ? "rgba(0, 87, 184, 0.9)" : "rgba(0, 87, 184, 0.35)", position: 1 },
          },
        };
      });
    decoRef.current = ed.deltaDecorations(decoRef.current, next);
  };
  useEffect(() => {
    marksRef.current = marks;
    applyMarks();
     
  }, [marks, content, path]);

  const wire = (editor: Revealable) => {
    edRef.current = editor;
    editor.onDidChangeModelContent(() => dirtyRef.current?.(editor.getValue()));
    editor.addCommand?.(CTRL_CMD_S, () => saveRef.current?.(editor.getValue()));
    editor.onDidChangeCursorPosition?.((e) =>
      cursorRef.current?.(e.position.lineNumber, e.position.column),
    );
    reveal(revealLine, revealColumn);
    applyMarks();
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
