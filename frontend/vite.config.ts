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
          // Split heavy, independently-cacheable vendors out of the entry
          // chunk. Monaco is lazy-loaded (see MonacoFileView), so isolating it
          // keeps it out of the initial grid load; react/antd change rarely and
          // benefit from their own long-lived cache entries.
          manualChunks: {
            monaco: ["monaco-editor", "@monaco-editor/react"],
            react: ["react", "react-dom"],
            antd: ["antd", "@ant-design/icons"],
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
