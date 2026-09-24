// In dev (Vite), cross-origin requests are proxied through localhost via the
// vite.config.js `server.proxy` map. Each external host is mapped to
// /<hostname>/... so the browser treats it as same-origin.
//
// In production the app is a PWA served from its own origin, so external
// hosts are hit directly (no proxy). We detect "dev" by checking for the Vite
// server header at module load; a fallback is the `__VITE_DEV_PROXY__` env
// injected by Vite only in dev.

const VITE_MARKER = typeof __VITE_DEV_PROXY__ !== 'undefined' ? __VITE_DEV_PROXY__ : undefined

function isDev() {
  // Vite sets this at runtime; if absent we're in a production build.
  return VITE_MARKER === true || (typeof location !== 'undefined' && location.hostname === 'localhost')
}

const PROXY_HOSTS = [
  'itunes.apple.com',
  'lrclib.net',
  'iv.melmac.space',
  'inv.nadeko.net',
  'yewtu.be',
  'api.piped.private.coffee',
  'pipedapi.adminforge.de',
]

export function toApiUrl(url) {
  if (!isDev()) return url
  try {
    const u = new URL(url)
    if (PROXY_HOSTS.includes(u.hostname)) {
      // Proxy format: /<hostname>/path => https://<hostname>/path
      return `${location.origin}/${u.hostname}/${u.pathname.replace(/^\//, '')}${u.search}`
    }
  } catch { /* noop */ }
  return url
}

// Fetch wrapper that routes proxied hosts through the dev server.
export function apiFetch(url, opts = {}) {
  return fetch(toApiUrl(url), opts)
}
