import React from 'react'
import ReactDOM from 'react-dom/client'
import { App as AntApp, ConfigProvider } from 'antd'
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.tsx'
import { useUI } from './store'
import { buildTheme } from './theme'
import { ApiError, UNAUTHORIZED_EVENT } from './api'
import { notifyError, setNotifier } from './notify'
import './styles.css'
import './tokens.css'
import './index.css'

// isRetryable governs automatic retries: a client error (4xx) will never
// succeed on retry, so only network blips, timeouts, rate limits (429), and
// server faults (5xx) are retried - with exponential backoff.
function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) return err.isRetryable;
  return true; // network / timeout / offline: worth a retry
}

// Global cache handlers so a FAILED read or write is always surfaced to the
// user, never swallowed. Mutations additionally never auto-retry (a write may
// not be idempotent); reads retry retryable failures a few times.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => isRetryable(err) && count < 3,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 15_000),
      staleTime: 5_000,
    },
    mutations: { retry: false },
  },
  // A failed READ has no place to show an error (unlike a mutation, which has a
  // button/form), so surface it globally - but only on the first load, when
  // there is no cached data to fall back on; a failed background refetch should
  // not nag. Mutations keep their own onError handlers (which now receive the
  // typed ApiError with a friendly message), so they are not globally toasted
  // here to avoid duplicate popups.
  queryCache: new QueryCache({
    onError: (err, query) => {
      if (query.state.data === undefined) notifyError(err);
    },
  }),
})

// ThemeRoot applies the design system: light/dark algorithm and comfort font
// scale come from the UI store, so the appearance controls take effect
// app-wide. AntApp provides the message/notification context that components
// consume via AntApp.useApp().
function ThemeRoot() {
  const mode = useUI((s) => s.mode)
  const themePref = useUI((s) => s.themePref)
  const fontScale = useUI((s) => s.fontScale)
  const density = useUI((s) => s.density)
  React.useEffect(() => {
    // Expose the mode to plain CSS (tokens.css) for non-AntD surfaces.
    document.documentElement.dataset.theme = mode
    document.documentElement.style.colorScheme = mode
  }, [mode])
  React.useEffect(() => {
    // Density and font scale for the hand-rolled surfaces (grid, rail).
    document.documentElement.dataset.density = density
    document.documentElement.dataset.fontscale = fontScale
  }, [density, fontScale])
  // "Follow system": track the OS setting live for as long as it is chosen.
  React.useEffect(() => {
    if (themePref !== 'system' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => useUI.getState().applySystemMode(mq.matches ? 'dark' : 'light')
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [themePref])
  return (
    <ConfigProvider
      theme={buildTheme(mode, fontScale, density)}
      componentSize={density === 'compact' ? 'small' : 'middle'}
    >
      <AntApp>
        <GlobalFeedback />
        <App />
      </AntApp>
    </ConfigProvider>
  )
}

// GlobalFeedback bridges the react-query cache handlers to Ant's theme-aware
// notification context, and turns a 401 (session missing/expired) into a
// graceful, dismissible "sign in again" prompt instead of an abrupt redirect or
// a silent failure. The login endpoint is provider-agnostic (GitHub today, any
// OIDC/SSO provider the backend adds tomorrow), so this needs no change to
// support new providers.
function GlobalFeedback() {
  const { notification } = AntApp.useApp()
  React.useEffect(() => {
    setNotifier(notification)
  }, [notification])
  React.useEffect(() => {
    let open = false
    const onUnauthorized = () => {
      if (open) return
      open = true
      notification.warning({
        key: 'session-expired',
        message: 'Please sign in again',
        description: 'Your session has expired or you are not signed in.',
        placement: 'bottomRight',
        duration: 0,
        btn: (
          <a className="ant-btn ant-btn-primary ant-btn-sm" href="/api/auth/login">
            Sign in
          </a>
        ),
        onClose: () => {
          open = false
        },
      })
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [notification])
  return null
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeRoot />
    </QueryClientProvider>
  </React.StrictMode>,
)
