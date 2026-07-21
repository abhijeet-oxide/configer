import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import brand from "./plugins/vite-plugin-brand";

// The dev server proxies /api to the Go backend so the SPA and API share an
// origin during development. Point VITE_API_PROXY_TARGET at a remote backend to
// develop the UI against a shared environment.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_API_PROXY_TARGET || "http://localhost:8080";
  return {
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
