import React from 'react'
import ReactDOM from 'react-dom/client'
import { App as AntApp, ConfigProvider } from 'antd'
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.tsx'
import BootGate from './components/BootGate'
import AuthGate from './components/AuthGate'
import { useUI } from './store'
import { buildTheme } from './theme'
import { ApiError } from './api'
import { notifyError, setNotifier } from './notify'
import './styles.css'
import './tokens.css'
import './index.css'
import './geo.css'

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
      // The service probe owns its own presentation (the boot screen and the
      // connection banner), so a failed probe must not also raise a popup.
      if (query.queryKey[0] === 'health') return
      // A READ refused by the user's role is a property of the page, not an
      // event: the view says what this person may see. Toasting it would repeat
      // the same sentence for every read the page happens to make.
      if (err instanceof ApiError && err.isForbidden) return
      if (query.state.data === undefined) notifyError(err)
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
        {/* Nothing renders until we know the service is there (BootGate) and
            whether this browser may see it at all (AuthGate). */}
        <BootGate>
          <AuthGate>
            <App />
          </AuthGate>
        </BootGate>
      </AntApp>
    </ConfigProvider>
  )
}

// GlobalFeedback bridges the react-query cache handlers to Ant's theme-aware
// notification context. A 401 is deliberately NOT handled here: a missing or
// expired session is not a per-request failure to pop up once per read, it is a
// state of the whole app - AuthGate swaps the app for the sign-in page, which
// says what happened and offers the one action that fixes it.
function GlobalFeedback() {
  const { notification } = AntApp.useApp()
  React.useEffect(() => {
    setNotifier(notification)
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
