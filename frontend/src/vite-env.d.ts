/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional base URL for API calls in the built SPA (default same-origin "/api"). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Runtime configuration injected before the app boots (see public/config.js),
// so operators can change the API base without rebuilding the bundle.
interface Window {
  __CONFIGER__?: {
    apiBaseUrl?: string;
  };
}
