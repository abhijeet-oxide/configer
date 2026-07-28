// Offline Monaco setup. @monaco-editor/react loads Monaco from a CDN by
// default; we self-host the bundled npm package instead (matching the
// bundled-icons convention, so the app works in air-gapped deployments) and
// provide the editor web worker via Vite's ?worker import. YAML/XML/JSON
// tokenizers run on the main thread, so a single editor worker is enough.
//
// The import is deliberately NOT the "monaco-editor" package entry: that entry
// is editor + EVERY language Monaco ships (abap, elixir, redshift, solidity,
// …), which is most of the download and produced ~80 extra chunks. `edcore.main`
// is the same editor with all of its own features (find, folding, suggestions,
// bracket matching, context menu) and no languages; Configer edits YAML, JSON
// and XML, so those three are registered explicitly below. Adding a format
// means adding its contribution here - nothing else changes.
// (`editor.api` is the same module object edcore.main re-exports, and it is the
//  one that ships type declarations - so the namespace is imported from there
//  and edcore.main is pulled in for its editor-feature side effects.)
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/edcore.main";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import { loader } from "@monaco-editor/react";

self.MonacoEnvironment = {
  // JSON carries a real language service (schema validation, completion) and
  // asks for its own worker by label; everything else runs on the plain editor
  // worker. Answering with the right one keeps JSON diagnostics working.
  getWorker: (_workerId: string, label: string) =>
    label === "json" ? new JsonWorker() : new EditorWorker(),
};

loader.config({ monaco });

// Re-exported for callers that already have the editor loaded; light callers
// should import from ./monacoLang directly to avoid pulling monaco-editor.
export { languageFor } from "./monacoLang";
