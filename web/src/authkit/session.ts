/**
 * Browser OIDC authorization-code + PKCE.
 *
 * Sign-in starts on 401. SWGW_AUTH_ENABLED=false needs no browser flag.
 * Tokens live in sessionStorage, not localStorage (tab-scoped). Refresh
 * token is there too: public client, no secret; long shifts would otherwise
 * redirect every hour.
 */

import { appUrl } from './base'

/** What the deployment published at /runtime-config.json. */
export interface AuthConfig {
  issuer: string
  clientId: string
  /** the redirect the issuer will accept, as registered. */
  redirectUri: string
}

/** The endpoints the issuer advertises. */
interface Endpoints {
  authorization: string
  token: string
  endSession: string | undefined
}

interface Tokens {
  accessToken: string
  refreshToken: string | undefined
  /**
   * The ID token, kept for one purpose: WHO the person is, for the screen.
   *
   * The access token is what the Coordinator validates, and it carries the
   * subject and the roles and nothing else - no name, no e-mail. That is not
   * an oversight in ZITADEL, it is the split OpenID Connect draws: an access
   * token is for the API and says what the bearer may do, an ID token is for
   * the client and says who they are. Reading a name off the access token is
   * the mistake this comment exists to prevent somebody making later.
   *
   * Nothing here is trusted for a DECISION. Every permission comes from the
   * Coordinator, which checks a signature; these claims only decide what
   * a person's own name looks like on their own screen.
   */
  idToken: string | undefined
  /** epoch milliseconds */
  expiresAt: number
}

/** The claims worth showing. Absent when the provider asserted none. */
export interface IdentityClaims {
  name?: string
  email?: string
  preferredUsername?: string
  /**
   * The halves of the name, kept apart from `name`.
   *
   * Not redundant with it, and not decoration: which of these the provider
   * actually asserted is the difference between a directory that knows who
   * somebody is and one that holds a login id and nothing else. A profile that
   * shows the fields it received, and says plainly which it did not, is the
   * only place an administrator can see that without a console.
   */
  givenName?: string
  familyName?: string
  /** BCP-47, when the directory holds one. */
  locale?: string
  /** Epoch SECONDS, as OpenID Connect defines `updated_at`. */
  updatedAt?: number
}

const TOKENS_KEY = 'platform.auth.tokens'
const PENDING_KEY = 'platform.auth.pending'
const OBTAINED_KEY = 'platform.auth.obtained'

/**
 * How close to expiry a token may be and still be used.
 *
 * Sixty seconds because the alternative is a request that leaves here valid
 * and arrives expired, which fails as a 401 the reader sees rather than as a
 * renewal nobody notices.
 */
const EXPIRY_SKEW_MS = 60_000

/**
 * How long after a completed sign-in a 401 stops meaning "sign in".
 *
 * A token that the issuer minted and the Coordinator rejects is a
 * CONFIGURATION fault - a mismatched issuer, audience or clock - and sending
 * the browser back to the issuer cannot fix it. Without this the two of them
 * bounce the reader between them forever and the screen never says why.
 */
const REJECT_WINDOW_MS = 60_000

// --- the state the screens read ---------------------------------------------

/**
 * Why the application cannot proceed, when it cannot.
 *
 *   redirecting  - the browser is on its way to the issuer
 *   unconfigured - the Coordinator wants a token and this deployment never
 *                  published an issuer to get one from
 *   rejected     - a token was obtained and the Coordinator refused it anyway
 */
export type SignInStatus = 'idle' | 'redirecting' | 'unconfigured' | 'rejected'

let status: SignInStatus = 'idle'
const listeners = new Set<() => void>()

function setStatus(next: SignInStatus): void {
  if (status === next) return
  status = next
  for (const l of listeners) l()
}

/** For useSyncExternalStore. */
export function subscribeSignIn(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function signInStatus(): SignInStatus {
  return status
}

/**
 * WHEN THIS TAB'S TOKEN IS REPLACED.
 *
 * # Why anything listens
 *
 * Roles travel IN the access token. Granting somebody a product changes nothing
 * a live token can express, and the token this tab holds lives fifteen minutes
 * (docs/design/24 §8.5) - so the grant reaches the Coordinator at the next
 * renewal, silently, with no sign-out and no reload.
 *
 * The interface has to notice that, or it renders the permissions the session
 * STARTED with for as long as the tab stays open: an administrator grants a
 * product owner discovery, the API starts accepting it within the quarter hour,
 * and the button stays hidden until somebody thinks to press F5. Telling them
 * to sign in again is the workaround for this, not the design.
 *
 * So a renewal is an event, and `auth/permissions` re-reads /whoami on it.
 */
const renewalListeners = new Set<() => void>()

export function subscribeTokenRenewal(listener: () => void): () => void {
  renewalListeners.add(listener)
  return () => renewalListeners.delete(listener)
}

// --- storage ----------------------------------------------------------------

/**
 * Reads and writes never throw.
 *
 * Storage is unavailable in a browser configured to block it, and a sign-in
 * that dies on a DOMException while STORING a token it already holds is worse
 * than one that simply cannot be remembered.
 */
function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    // The session survives in memory; it will not survive a reload.
  }
}

function forget(key: string): void {
  try {
    sessionStorage.removeItem(key)
  } catch {
    // Nothing to do, and nothing depends on it having worked.
  }
}

/** Held in memory as well as in storage, so a blocked store still works. */
let tokens: Tokens | undefined = loadTokens()

function loadTokens(): Tokens | undefined {
  const raw = read(TOKENS_KEY)
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Tokens
    return parsed.accessToken ? parsed : undefined
  } catch {
    return undefined
  }
}

function keepTokens(next: Tokens | undefined): void {
  tokens = next
  if (next) write(TOKENS_KEY, JSON.stringify(next))
  else forget(TOKENS_KEY)
}

// --- configuration and discovery --------------------------------------------

let configPromise: Promise<AuthConfig | null> | undefined

/**
 * The deployment's OIDC settings, fetched once.
 *
 * Written by the web container at start (deploy/web/docker-entrypoint.sh) from
 * a value ZITADEL generates, which is why it cannot be a build-time constant.
 * Absent or empty means this deployment did not configure a sign-in, which is
 * the normal state of a development server.
 */
export function authConfig(): Promise<AuthConfig | null> {
  configPromise ??= (async () => {
    try {
      const doc = await runtimeConfig()
      const oidc = doc?.oidc
      if (!oidc?.issuer || !oidc.clientId) return null
      return {
        issuer: oidc.issuer.replace(/\/$/, ''),
        clientId: oidc.clientId,
        // The registered redirect wins over one derived here: it is what the
        // issuer will actually accept, and a derived one that differs by a
        // port fails at the issuer with a message about a URI nobody typed.
        redirectUri: oidc.redirectUri || `${window.location.origin}${appUrl('/auth/callback')}`,
      }
    } catch {
      return null
    }
  })()
  return configPromise
}

/** The whole published document, fetched once. */
interface RuntimeConfig {
  oidc?: Partial<AuthConfig>
  support?: { contact?: string }
  identityProvider?: { name?: string }
  deployment?: { environment?: string; deployedAt?: string }
  platform?: { url?: string }
}

let runtimePromise: Promise<RuntimeConfig | null> | undefined

/**
 * The deployment's own runtime document, read once and shared.
 *
 * One fetch rather than one per reader: it is a static file on this origin and
 * the answer does not change while a tab is open.
 */
function runtimeConfig(): Promise<RuntimeConfig | null> {
  runtimePromise ??= (async () => {
    try {
      const response = await fetch(appUrl('/runtime-config.json'), {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      if (!response.ok) return null
      return (await response.json()) as RuntimeConfig
    } catch {
      return null
    }
  })()
  return runtimePromise
}

/**
 * Where to ask for access, when this deployment has said where.
 *
 * Empty is a real answer and the screen respects it: a refusal that invents a
 * route sends somebody to a mailbox nobody reads, which is worse than naming
 * none. See SUPPORT_CONTACT in the compose file.
 */
export async function supportContact(): Promise<string> {
  const doc = await runtimeConfig()
  return doc?.support?.contact?.trim() || ''
}

/**
 * What this deployment's directory is CALLED.
 *
 * The same string the sign-in screen puts on the button, so a profile can name
 * where somebody's details came from rather than presenting them from nowhere.
 * Empty when no identity provider is configured; the page then names no source
 * instead of guessing one.
 */
export async function identityProviderName(): Promise<string> {
  const doc = await runtimeConfig()
  return doc?.identityProvider?.name?.trim() || ''
}

/**
 * The short deployment tier shown permanently in the application chrome.
 *
 * It is published at container start rather than inferred from the hostname:
 * the same deployment can have several aliases, and an alias must never make
 * NPRD look like PROD. The Vite development server has no runtime document, so
 * DEV is the one truthful local fallback; a deployed image missing the value
 * says UNKNOWN instead of guessing.
 */
export async function deploymentEnvironment(): Promise<string> {
  const doc = await runtimeConfig()
  const configured = doc?.deployment?.environment?.trim()
  if (configured) return configured.toUpperCase()
  return import.meta.env.DEV ? 'DEV' : 'UNKNOWN'
}

/**
 * When this container published its runtime document, if the deployment said.
 *
 * Empty when the document omits it. Used in the sidebar deployment note so a
 * preview can show when it came up without inventing a time from the hostname.
 */
export async function deploymentDeployedAt(): Promise<string> {
  const doc = await runtimeConfig()
  return doc?.deployment?.deployedAt?.trim() || ''
}

/**
 * Where the ngUSPe Automation Platform page is, if anywhere: what the product
 * mark in the navigation opens. See platformHome for the fallback.
 */
export async function platformUrl(): Promise<string> {
  const doc = await runtimeConfig()
  return doc?.platform?.url?.trim() || ''
}

let endpointsPromise: Promise<Endpoints | null> | undefined

/**
 * The issuer's own endpoints, from its discovery document.
 *
 * Read rather than assembled: the paths differ between identity providers, and
 * a deployment is free to put a different one behind the same variable.
 */
function endpoints(config: AuthConfig): Promise<Endpoints | null> {
  endpointsPromise ??= (async () => {
    const cached = cachedEndpoints(config.issuer)
    if (cached) return cached
    try {
      const response = await fetch(`${config.issuer}/.well-known/openid-configuration`, {
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) return null
      const doc = (await response.json()) as Record<string, string>
      if (!doc.authorization_endpoint || !doc.token_endpoint) return null
      const found = {
        authorization: doc.authorization_endpoint,
        token: doc.token_endpoint,
        endSession: doc.end_session_endpoint,
      }
      cacheEndpoints(config.issuer, found)
      return found
    } catch {
      return null
    }
  })()
  return endpointsPromise
}

/*
  THE DISCOVERY DOCUMENT IS KEPT FOR A DAY.

  Every sign-in fetched it twice - once before the redirect and again on the
  callback page, which is a fresh page load - and sign-out fetched it a third
  time, each a cross-origin round trip to the identity provider before the
  browser could move. It is public and changes when the provider is
  reconfigured, which a day's cache and the issuer in the key both cover.
*/
const DISCOVERY_KEY = 'platform.auth.discovery'
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000

function cachedEndpoints(issuer: string): Endpoints | null {
  try {
    const raw = localStorage.getItem(DISCOVERY_KEY)
    if (!raw) return null
    const held = JSON.parse(raw) as { issuer: string; at: number; endpoints: Endpoints }
    if (held.issuer !== issuer || Date.now() - held.at > DISCOVERY_TTL_MS) return null
    return held.endpoints?.authorization && held.endpoints.token ? held.endpoints : null
  } catch {
    return null
  }
}

function cacheEndpoints(issuer: string, found: Endpoints): void {
  try {
    localStorage.setItem(DISCOVERY_KEY, JSON.stringify({ issuer, at: Date.now(), endpoints: found }))
  } catch {
    // Unavailable storage costs one round trip on the next sign-in.
  }
}

/** Opens the TLS connection to the issuer while the page is still loading. */
function preconnect(origin: string): void {
  try {
    const href = new URL(origin).origin
    if (document.head.querySelector(`link[rel="preconnect"][href="${href}"]`)) return
    const link = document.createElement('link')
    link.rel = 'preconnect'
    link.href = href
    link.crossOrigin = 'anonymous'
    document.head.appendChild(link)
  } catch {
    // A hint, nothing depends on it.
  }
}

/**
 * Starts the sign-in prerequisites alongside the first API call rather than
 * after its 401, and on the callback page before the exchange asks for them.
 */
export function prewarmSignIn(): void {
  void authConfig().then((config) => {
    if (!config) return
    preconnect(config.issuer)
    void endpoints(config)
  })
}

// --- PKCE -------------------------------------------------------------------

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomString(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(digest)
}

// --- starting a sign-in -----------------------------------------------------

interface Pending {
  verifier: string
  state: string
  /** where to put the reader back once the exchange succeeds */
  returnTo: string
  /** The token exchange must repeat the redirect the authorization used. */
  redirectUri?: string
}

export interface SignInOptions {
  /** Defaults to the current address. */
  returnTo?: string
  /** Defaults to the published one. The catalogue at `/` signs in on its own address. */
  redirectUri?: string
}

/**
 * Sends the browser to the issuer.
 *
 * Returns only if it could not: everything after a successful call is a page
 * that is being replaced.
 */
export async function beginSignIn(options: SignInOptions = {}): Promise<void> {
  const config = await authConfig()
  if (!config) {
    setStatus('unconfigured')
    return
  }
  const ends = await endpoints(config)
  if (!ends) {
    setStatus('unconfigured')
    return
  }

  const verifier = randomString()
  const redirectUri = options.redirectUri ?? config.redirectUri
  const pending: Pending = {
    verifier,
    state: randomString(),
    // The whole address, so a link into a release comes back to that release
    // rather than to the overview.
    returnTo: options.returnTo ?? window.location.pathname + window.location.search + window.location.hash,
    redirectUri,
  }
  write(PENDING_KEY, JSON.stringify(pending))

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    // offline_access is what earns a refresh token, and a refresh token is
    // what keeps an eight-hour shift from being interrupted by a redirect.
    //
    // The resourceowner scope carries WHICH TENANT this person belongs to.
    // The Coordinator refuses a token that does not say, because an issuer
    // hosting more than one organization signs all of their tokens with the
    // same keys - so without it, "valid token" and "belongs to this
    // deployment" are two different facts and only the first was checked.
    scope: 'openid profile email offline_access urn:zitadel:iam:user:resourceowner',
    state: pending.state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
  })
  setStatus('redirecting')
  // replace, not assign: Back from the sign-in screen must not land on a page
  // that immediately sends the browser to it again.
  window.location.replace(`${ends.authorization}?${params.toString()}`)
}

/**
 * Starts a sign-in because the Coordinator asked for one.
 *
 * Called from the API client on any 401. It is deliberately fire-and-forget
 * and deliberately idempotent: a page that fans out six reads gets six 401s,
 * and six redirects would each cancel the last.
 */
export function requireSignIn(): void {
  if (status === 'redirecting' || status === 'unconfigured' || status === 'rejected') return
  if (isCallback()) return

  // A token this session obtained a moment ago, refused by the Coordinator.
  // Redirecting would only obtain the same token again.
  const obtained = Number(read(OBTAINED_KEY) ?? 0)
  if (obtained && Date.now() - obtained < REJECT_WINDOW_MS) {
    setStatus('rejected')
    return
  }

  keepTokens(undefined)
  void beginSignIn()
}

// --- coming back ------------------------------------------------------------

/** The address the issuer was told to return to. */
export function isCallback(): boolean {
  return window.location.pathname === appUrl('/auth/callback')
}

/**
 * Exchanges the code the issuer sent back for tokens.
 *
 * Returns where the reader was before the sign-in started, so the caller can
 * put them back there. Throws with a sentence fit to show on a screen: this is
 * the one moment in the flow with nothing else to fall back on.
 */
export async function completeSignIn(): Promise<string> {
  const params = new URLSearchParams(window.location.search)

  const raw = read(PENDING_KEY)
  if (!raw) {
    throw new Error('This sign-in did not start in this tab, so it cannot be completed here.')
  }
  const pending = JSON.parse(raw) as Pending

  // The state is the only thing tying this response to the request that
  // started it. A mismatch is a cross-site request forgery attempt or a stale
  // tab, and neither may be exchanged. Checked BEFORE any issuer-supplied
  // text is read: `error_description` is attacker-controlled on the query
  // string and used to live on the refusal screen.
  if (params.get('state') !== pending.state) {
    forget(PENDING_KEY)
    throw new Error('This sign-in response does not match the request that started it.')
  }
  forget(PENDING_KEY)

  if (params.get('error')) {
    throw new Error('The identity provider refused this sign-in.')
  }

  const code = params.get('code')
  if (!code) throw new Error('The identity provider returned no authorization code.')

  const config = await authConfig()
  if (!config) throw new Error('Sign-in is not configured on this deployment.')
  const ends = await endpoints(config)
  if (!ends) throw new Error(`The identity provider at ${config.issuer} did not answer.`)

  const response = await fetch(ends.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri ?? config.redirectUri,
      client_id: config.clientId,
      code_verifier: pending.verifier,
    }),
  })
  if (!response.ok) {
    // The token endpoint's own error names the real fault - an unregistered
    // redirect URI, most often - and repeating it saves a round trip through
    // a container log.
    const body = (await response.json().catch(() => ({}))) as Record<string, string>
    throw new Error(
      body.error_description || body.error || `The identity provider answered ${response.status}.`,
    )
  }

  store((await response.json()) as TokenResponse)
  setStatus('idle')
  return pending.returnTo || appUrl('/')
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

function store(body: TokenResponse): void {
  keepTokens({
    accessToken: body.access_token,
    // A response that renews without reissuing keeps the refresh token it was
    // given; dropping it here would end the session at the next expiry.
    refreshToken: body.refresh_token ?? tokens?.refreshToken,
    // Same rule: a refresh commonly returns no new ID token, and dropping it
    // would make somebody's name disappear an hour into their session.
    idToken: body.id_token ?? tokens?.idToken,
    // A response with no expires_in is treated as five minutes rather than as
    // forever: a token believed valid forever is one the Coordinator rejects
    // and nothing here renews.
    expiresAt: Date.now() + (body.expires_in ?? 300) * 1000,
  })
  write(OBTAINED_KEY, String(Date.now()))
  scheduleRenewal()
  // A NEW TOKEN MAY CARRY NEW ROLES. See subscribeTokenRenewal: this is the
  // only moment in a session when what the caller may do can change, and
  // nothing else in the application can observe it.
  for (const l of renewalListeners) l()
}

// --- using the session ------------------------------------------------------

/** Whether this tab holds a session at all. */
export function isSignedIn(): boolean {
  return Boolean(tokens)
}

/** Whether this tab holds a usable session, renewing an expired one first. */
export async function hasSession(): Promise<boolean> {
  if (!tokens) return false
  if (tokens.expiresAt - Date.now() >= EXPIRY_SKEW_MS) return true
  return renewSession()
}

/**
 * The Authorization header for one request, renewing first if the token is
 * about to expire. Nothing when this tab has no session, which is the normal
 * case against a Coordinator running without authentication.
 */
export async function authorization(): Promise<Record<string, string>> {
  if (!tokens) return {}
  if (tokens.expiresAt - Date.now() < EXPIRY_SKEW_MS) await renewSession()
  return tokens ? { Authorization: `Bearer ${tokens.accessToken}` } : {}
}

let renewal: Promise<boolean> | undefined
let renewalTimer: ReturnType<typeof setTimeout> | undefined

/*
  RENEWED AHEAD OF EXPIRY, in the background.

  Renewal used to happen inside the first request after the token aged out, so
  every read on the page waited on a round trip to the identity provider, and
  the page froze for it every fifteen minutes.
*/
const RENEW_AHEAD_MS = 2 * 60_000

function scheduleRenewal(): void {
  if (renewalTimer !== undefined) clearTimeout(renewalTimer)
  renewalTimer = undefined
  if (!tokens?.refreshToken || typeof window === 'undefined') return
  const wait = Math.max(5_000, tokens.expiresAt - Date.now() - RENEW_AHEAD_MS)
  renewalTimer = setTimeout(() => {
    renewalTimer = undefined
    void renewSession()
  }, wait)
}

/**
 * Exchanges the refresh token for a new access token. Reports whether it now
 * holds a usable one.
 *
 * SINGLE FLIGHT. Every read on a page whose token has just expired arrives
 * here at the same moment, and an identity provider that rotates refresh
 * tokens invalidates the previous one - so the second concurrent attempt would
 * spend a token the first had already replaced and end the session.
 */
export function renewSession(): Promise<boolean> {
  renewal ??= (async () => {
    try {
      const refreshToken = tokens?.refreshToken
      if (!refreshToken) return false
      const config = await authConfig()
      if (!config) return false
      const ends = await endpoints(config)
      if (!ends) return false

      const response = await fetch(ends.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: config.clientId,
        }),
      })
      if (!response.ok) {
        keepTokens(undefined)
        return false
      }
      store((await response.json()) as TokenResponse)
      return true
    } catch {
      return false
    } finally {
      // Cleared on the next tick rather than immediately, so the callers that
      // are already waiting all share this one attempt.
      setTimeout(() => {
        renewal = undefined
      }, 0)
    }
  })()
  return renewal
}

const SIGNED_OUT_PATH = '/signed-out'

export function isSignedOutPage(): boolean {
  return window.location.pathname === appUrl(SIGNED_OUT_PATH)
}

/**
 * Ends the session here and, when the issuer supports it, there as well.
 *
 * Clearing only this tab's tokens would put the reader back on the issuer's
 * still-valid session at the next redirect, which reads as a sign-out button
 * that does nothing.
 */
export async function signOut(
  // Registered as a post-logout address by the seeder.
  to = `${window.location.origin}${appUrl(SIGNED_OUT_PATH)}`,
): Promise<void> {
  const config = await authConfig()
  const ends = config ? await endpoints(config) : null
  const idToken = tokens?.idToken
  if (renewalTimer !== undefined) clearTimeout(renewalTimer)
  renewalTimer = undefined
  keepTokens(undefined)
  forget(PENDING_KEY)
  forget(OBTAINED_KEY)
  setStatus('idle')

  if (config && ends?.endSession) {
    const params = new URLSearchParams({
      client_id: config.clientId,
      post_logout_redirect_uri: to,
    })
    // Without the hint ZITADEL's Login V2 cannot tell which session ends, and
    // shows its own "Click an account to end the session" page instead of
    // returning here (TerminateSessionFromRequest, v4.17.3).
    if (idToken) params.set('id_token_hint', idToken)
    window.location.replace(`${ends.endSession}?${params.toString()}`)
    return
  }
  window.location.replace(to)
}


/**
 * Who this session belongs to, for display.
 *
 * Read from the ID token, which is the only place these claims are: the access
 * token the Coordinator validates carries the subject and the roles, so
 * /whoami can report an opaque id and what it may do, and cannot report a name.
 *
 * NOT VERIFIED HERE, and it does not need to be. The token arrived on a
 * response to a request this code made to an endpoint it discovered from the
 * configured issuer, and nothing it says is used for a decision - every
 * permission is the Coordinator's answer, checked against a signature there.
 * It decides what a person's own name looks like on their own screen.
 */
export function idTokenClaims(): Record<string, unknown> {
  const payload = tokens?.idToken?.split('.')[1]
  if (!payload) return {}
  try {
    const binary = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function identityClaims(): IdentityClaims {
  const claims = idTokenClaims()
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  return {
    name: str(claims.name) ?? str(claims.given_name),
    email: str(claims.email),
    preferredUsername: str(claims.preferred_username),
    givenName: str(claims.given_name),
    familyName: str(claims.family_name),
    locale: str(claims.locale),
    updatedAt: num(claims.updated_at),
  }
}

scheduleRenewal()
