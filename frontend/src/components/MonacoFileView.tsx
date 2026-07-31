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
  revealLinesInCenter?: (start: number, end: number) => void;
  setPosition: (pos: { lineNumber: number; column: number }) => void;
  setSelection?: (sel: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) => void;
  focus: () => void;
  getValue: () => string;
  onDidChangeModelContent: (cb: () => void) => void;
  addCommand?: (keybinding: number, handler: () => void) => void;
  onDidChangeCursorPosition?: (cb: (e: { position: { lineNumber: number; column: number } }) => void) => void;
  deltaDecorations?: (old: string[], next: Decoration[]) => string[];
  getModel?: () => { getLineMaxColumn?: (line: number) => number; getLineCount?: () => number } | null;
  getLayoutInfo?: () => { height: number };
  onDidLayoutChange?: (cb: () => void) => void;
}

// Below this the editor has not really been measured yet, and "the middle of
// the viewport" is not a place worth scrolling to.
const MIN_CENTER_HEIGHT = 120;

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
  // Left at Monaco's (and VS Code's) default: without the empty run past the
  // last line, a value near the end of a file CANNOT be centred - the editor
  // simply stops scrolling and leaves it pinned to the bottom edge. Landing on
  // a parameter has to look the same wherever in the file it happens to live.
  scrollBeyondLastLine: true,
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

  // The reveal request already carried out, so an ordinary re-render - or the
  // reader typing, which changes `content` - never yanks the viewport back to
  // where they were originally sent.
  const servedRef = useRef("");

  const reveal = (line: number, column?: number) => {
    const ed = edRef.current;
    if (!ed) return;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: column ?? 1 });
    // The cursor lands ON the value when we know where it is; the marks below
    // are what actually make it obvious, so nothing here selects text the
    // reader did not ask to select.
    if (column === undefined) {
      ed.setSelection?.({ startLineNumber: line, startColumn: 1, endLineNumber: line + 1, endColumn: 1 });
    }
    ed.focus();
  };

  // Jump to a line: a find-in-files hit, or a parameter's "view in file".
  //
  // Nothing about that request is ready at the same moment. The text is
  // fetched, Monaco mounts asynchronously, the exact column arrives from a
  // second call once the managed values are located, and the pane's height is
  // only measured after it is on screen. So the request is not carried out
  // until BOTH the model is long enough to hold the line and the editor has a
  // height worth centring in: asking a two-pixel-tall editor to centre a line
  // pins it to the top, which is exactly where a "centred" value kept landing.
  // Every one of those arrivals calls back in here, and the first call that
  // finds the editor ready is the one that scrolls.
  const serveReveal = () => {
    const ed = edRef.current;
    if (!revealLine || !ed) return;
    const key = `${path}:${revealLine}:${revealColumn ?? ""}`;
    if (servedRef.current === key) return;
    const lines = ed.getModel?.()?.getLineCount?.() ?? 0;
    if (lines < revealLine) return;
    if ((ed.getLayoutInfo?.().height ?? 0) < MIN_CENTER_HEIGHT) return;
    servedRef.current = key;
    reveal(revealLine, revealColumn);
  };
  // onDidLayoutChange is wired once, at mount, so it needs the current one.
  const serveRef = useRef(serveReveal);
  useEffect(() => {
    serveRef.current = serveReveal;
  });
  useEffect(() => {
    if (!revealLine) servedRef.current = "";
    serveReveal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealLine, revealColumn, content, path]);

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
      .flatMap((m) => {
        // The VALUE, where we know its columns: marking the whole line paints
        // the key, the indentation and the trailing comment as though Configer
        // owned them too. Only a value that cannot be narrowed (a block scalar)
        // falls back to the line.
        const whole = !m.col || !m.endCol;
        const out = [
          {
            range: whole
              ? { startLineNumber: m.line, startColumn: 1, endLineNumber: m.line, endColumn: 1 }
              : { startLineNumber: m.line, startColumn: m.col!, endLineNumber: m.line, endColumn: m.endCol! },
            options: {
              isWholeLine: whole,
              className: whole ? "cf-managed-line" : "cf-managed-value",
              linesDecorationsClassName: "cf-managed-gutter",
              hoverMessage: { value: m.label },
              overviewRuler: { color: "rgba(0, 87, 184, 0.35)", position: 1 },
            },
          },
        ];
        // The one the reader was sent to also gets its whole LINE washed in
        // highlighter yellow: at a glance, from anywhere on the row, that is
        // where you landed. It is a different question from "which characters
        // are managed", so it is a different mark and a different colour.
        if (m.focus) {
          out.push({
            range: { startLineNumber: m.line, startColumn: 1, endLineNumber: m.line, endColumn: 1 },
            options: {
              isWholeLine: true,
              className: "cf-focus-line",
              linesDecorationsClassName: "cf-focus-gutter",
              hoverMessage: { value: m.label },
              overviewRuler: { color: "rgba(240, 210, 100, 0.9)", position: 7 },
            },
          });
        }
        return out;
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
    editor.onDidLayoutChange?.(() => serveRef.current());
    serveReveal();
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
