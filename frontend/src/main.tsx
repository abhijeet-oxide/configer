import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider, App as AntApp } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { buildTheme } from "./theme";
import { useUI } from "./store";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

function Root() {
  const mode = useUI((s) => s.mode);
  const brand = useUI((s) => s.brand);
  return (
    <ConfigProvider theme={buildTheme(mode, brand)}>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
