import './screens.css'
import { Button } from 'antd'
import { BrandMark, Wordmark } from '../uikit'
import { platformBrand } from './platform'
import { VALIDATING_LABEL } from './labels'

// Keep in step with splashHtml in web/vitePluginPlatform.ts: the server sends
// the same markup as the first paint, and a difference shows as a jump.
export function ValidatingScreen() {
  return (
    <div className="ui-status-screen">
      <div className="ui-boot-splash">
        <BrandMark brand={platformBrand} size={44} />
        <Wordmark name={platformBrand.appName} className="ui-boot-name" />
        <span className="platform-boot-label">{VALIDATING_LABEL}</span>
        <span className="ui-boot-progress" role="progressbar" aria-label={VALIDATING_LABEL} />
      </div>
    </div>
  )
}

/** The platform's moving background, behind the catalogue and the signed-out page. */
export function Backdrop() {
  return (
    <div className="platform-backdrop" aria-hidden="true">
      <span className="platform-glow" />
      <span className="platform-grid" />
    </div>
  )
}

function SignedOutMark() {
  return (
    <svg className="platform-done" viewBox="0 0 88 88" aria-hidden="true">
      <circle className="platform-done-halo" cx="44" cy="44" r="42" />
      <circle className="platform-done-ring" cx="44" cy="44" r="30" pathLength={100} />
      <path className="platform-done-tick" d="M31 45 L40 54 L58 35" pathLength={100} />
    </svg>
  )
}

/** The end of a session: the platform's page, not the identity provider's. */
export function SignedOutScreen({ onSignIn, home }: { onSignIn: () => void; home: string }) {
  return (
    <div className="platform-page">
      <Backdrop />
      <main className="platform-card platform-signed-out">
        <div className="platform-lockup">
          <BrandMark brand={platformBrand} size={28} />
          <Wordmark name={platformBrand.appName} />
        </div>
        <SignedOutMark />
        <h1 className="platform-card-title">Signed out successfully</h1>
        <p className="platform-card-body">This tab can now be closed.</p>
        <div className="platform-actions">
          <Button type="primary" size="large" block onClick={onSignIn}>Sign in again</Button>
          <Button size="large" block href={home}>Return to home</Button>
        </div>
      </main>
    </div>
  )
}
