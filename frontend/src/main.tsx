import React from 'react'
import ReactDOM from 'react-dom/client'
import { App as AntApp, ConfigProvider } from 'antd'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.tsx'
import { useUI } from './store'
import { buildTheme } from './theme'
import './index.css'

const queryClient = new QueryClient()

// ThemeRoot applies the design system: light/dark algorithm, brand primary
// color and comfort font scale all come from the UI store, so the TopBar
// toggles take effect app-wide. AntApp provides the message/notification
// context that components consume via AntApp.useApp().
function ThemeRoot() {
  const mode = useUI((s) => s.mode)
  const brand = useUI((s) => s.brand)
  const fontScale = useUI((s) => s.fontScale)
  React.useEffect(() => {
    // Expose the mode to plain CSS (index.css) for non-AntD surfaces.
    document.documentElement.dataset.theme = mode
    document.documentElement.style.colorScheme = mode
  }, [mode])
  return (
    <ConfigProvider theme={buildTheme(mode, brand, fontScale)}>
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeRoot />
    </QueryClientProvider>
  </React.StrictMode>,
)
