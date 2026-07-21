// Offline Monaco setup. @monaco-editor/react loads Monaco from a CDN by
// default; we self-host the bundled npm package instead (matching the
// bundled-icons convention, so the app works in air-gapped deployments) and
// provide the editor web worker via Vite's ?worker import. YAML/XML/JSON
// tokenizers run on the main thread, so a single editor worker is enough.
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { loader } from "@monaco-editor/react";

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

loader.config({ monaco });

// Re-exported for callers that already have the editor loaded; light callers
// should import from ./monacoLang directly to avoid pulling monaco-editor.
export { languageFor } from "./monacoLang";
