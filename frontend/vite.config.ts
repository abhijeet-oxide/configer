import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import brand from "./plugins/vite-plugin-brand";

// The dev server proxies /api to the Go backend so the SPA and API share an
// origin during development. Point VITE_API_PROXY_TARGET at a remote backend to
// develop the UI against a shared environment.
export default defineConfig(({ mode }) => {
  // .env.example lives at the REPOSITORY ROOT and documents both halves of the
  // configuration, so the root file has to be read here too - loading only
  // frontend/.env would silently ignore the very file the docs tell people to
  // write. A frontend/.env still wins, so a per-package override works.
  const root = path.resolve(process.cwd(), "..");
  const env = { ...loadEnv(mode, root, ""), ...loadEnv(mode, process.cwd(), "") };
  const target = env.VITE_API_PROXY_TARGET || "http://localhost:8080";
  return {
    // Vite only exposes variables it loaded from its own envDir, so hand the
    // build the ones that came from the root file explicitly.
    define: {
      "import.meta.env.VITE_API_BASE_URL": JSON.stringify(env.VITE_API_BASE_URL ?? ""),
    },
    plugins: [react(), tailwindcss(), brand()],
    build: {
      rollupOptions: {
        output: {
          // Ant Design is large, changes rarely and is used by everything, so
          // it gets its own long-lived cache entry. Monaco is lazy-loaded
          // (see MonacoFileView) and must STAY out of the entry's static graph.
          //
          // Two rules make that work, and both are load-bearing:
          //
          //  1. Match on module ids, never the object form. Naming a chunk in
          //     the object form ({ monaco: ["monaco-editor"] }) lets Rollup use
          //     it as the home for shared runtime helpers - and it put
          //     __vitePreload there, the helper EVERY dynamic import needs. The
          //     entry then statically imported the Monaco chunk: 3.3 MB of
          //     editor plus its render-blocking stylesheet on every page load,
          //     defeating the lazy import entirely.
          //  2. Pin Vite's injected helpers to their own tiny chunk, so that
          //     decision can never land on a multi-megabyte vendor again.
          //
          // React deliberately stays in the entry chunk: splitting it out puts
          // its CommonJS interop in a separate chunk that can evaluate after a
          // consumer, which crashes the app at boot.
          manualChunks(id) {
            if (id.includes("vite/preload-helper")) return "runtime";
            if (!id.includes("node_modules")) return;
            if (id.includes("monaco-editor") || id.includes("@monaco-editor")) return "monaco";
            if (
              id.includes("node_modules/antd/") ||
              id.includes("node_modules/@ant-design/") ||
              id.includes("node_modules/rc-") ||
              id.includes("node_modules/@rc-component/")
            )
              return "antd";
          },
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target,
          changeOrigin: true,
        },
      },
    },
  };
});
