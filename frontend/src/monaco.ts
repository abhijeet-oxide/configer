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

// languageFor maps a file path to a Monaco language id for highlighting.
export function languageFor(path: string): string {
  if (path.endsWith(".xml")) return "xml";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  return "plaintext";
}
