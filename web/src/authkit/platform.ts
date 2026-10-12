import type { BrandIdentity } from '../uikit'
import brand from '../brand'

// The platform's name, from config/apps/catalogue.yaml. The build writes it
// into <meta name="application-name"> and the web tier rewrites it at start
// (PLATFORM_NAME), so a rename needs no rebuild. Read from the document, not
// from a fetch: the tab title and the first screen already carry it.
function readName(): string {
  if (typeof document === 'undefined') return brand.appName
  const meta = document.querySelector('meta[name="application-name"]')?.getAttribute('content')
  return meta?.trim() || brand.appName
}

export const platformName = readName()

/** The identity worn before a person is inside one application. */
export const platformBrand: BrandIdentity = { ...brand, appName: platformName, tagline: '', navCaption: '' }
