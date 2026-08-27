import { Editor } from "@monaco-editor/react";
import "../../monaco";

// The group editor's JSON view, in its own lazily-loaded module for exactly the
// reason the file editor is: Monaco is the largest thing in the bundle, and a
// dialog most people never switch out of form mode must not make everybody pay
// for it on load.

export default function JsonPane({
  value,
  onChange,
  readOnly,
  dark,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
  dark?: boolean;
}) {
  return (
    <Editor
      height="100%"
      language="json"
      value={value}
      theme={dark ? "vs-dark" : "vs"}
      onChange={(v) => onChange(v ?? "")}
      options={{
        readOnly,
        minimap: { enabled: false },
        lineNumbersMinChars: 3,
        scrollBeyondLastLine: false,
        fontSize: 12,
        tabSize: 2,
        renderLineHighlight: "none",
        overviewRulerLanes: 0,
        automaticLayout: true,
      }}
    />
  );
}
