// The path prefix this app is served under, read from the <base href> the web
// container writes into index.html. "" at the origin root, "/softwaregateway"
// or "/artiauto" behind the one-host front door (docs/design/38). Routes, API
// calls and the sign-in callback all hang off it; a root-absolute URL anywhere
// else 404s behind the front door.
function readBase(): string {
  if (typeof document === 'undefined') return ''
  const href = document.querySelector('base')?.getAttribute('href') ?? '/'
  return href.replace(/\/+$/, '')
}

export const basename = readBase()

export function appUrl(path: string): string {
  return basename + path
}
