import React from 'react'
import ReactDOM from 'react-dom/client'
import { App as AntApp } from 'antd'
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App.tsx'
import BootGate from './components/BootGate'
import AuthGate from './components/AuthGate'
import { useUI } from './store'
import { ThemeProvider, watchSystemMode } from './uikit'
import { ApiError } from './api'
import { notifyError, setNotifier } from './notify'
import './styles.css'
// The shared design system, ahead of this app's own stylesheet so anything
// Configer states about a surface still wins. The COLOUR variables are not in
// here - the brand plugin inlines them into <head>, ahead of every stylesheet,
// so the page never paints once in the wrong theme.
import './uikit/styles.css'
import './index.css'
import './geo.css'
import './group.css'

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

// ThemeRoot binds this app's settings to the shared design system.
//
// The kit's ThemeProvider is used in CONTROLLED mode: Configer already keeps a
// versioned settings document (settings.ts, persisted through the UI store),
// and that stays the truth. The provider just paints it - building the Ant
// Design theme from the same tokens the CSS variables come from, and stamping
// the painted mode, the density and the font scale on <html> so the
// hand-rolled surfaces answer to the same three controls as the component
// library. Adopting the shared system did not mean adopting a second copy of
// everybody's preferences.
//
// AntApp (inside the provider) supplies the message/notification context that
// components consume via AntApp.useApp().
function ThemeRoot() {
  const themePref = useUI((s) => s.themePref)
  const fontScale = useUI((s) => s.fontScale)
  const density = useUI((s) => s.density)
  // The provider paints "follow system" itself, but the store's resolved
  // `mode` is read by the surfaces that cannot express themselves in CSS
  // variables - Monaco's own theme, the chart colours - so it has to keep up
  // with the OS too. One watcher, the kit's, feeding both.
  React.useEffect(() => {
    if (themePref !== 'system') return
    return watchSystemMode((m) => useUI.getState().applySystemMode(m))
  }, [themePref])
  return (
    <ThemeProvider
      value={{ theme: themePref, fontScale, density }}
      onChange={(next) => {
        const ui = useUI.getState()
        if (next.theme !== themePref) ui.setThemePref(next.theme)
        if (next.fontScale !== fontScale) ui.setFontScale(next.fontScale)
        if (next.density !== density) ui.setDensity(next.density)
      }}
    >
      <GlobalFeedback />
      {/* Nothing renders until we know the service is there (BootGate) and
          whether this browser may see it at all (AuthGate). */}
      <BootGate>
        <AuthGate>
          <App />
        </AuthGate>
      </BootGate>
    </ThemeProvider>
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
