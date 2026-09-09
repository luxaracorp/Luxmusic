// iTunes Search API (free, no key) metadata: album artwork + the canonical
// track duration. Both come from one search hit and are cached together in
// localStorage, so a revisit is instant/offline-safe and artwork + duration
// never cost two separate network round-trips.

import { useEffect, useState } from 'react'

const PREFIX = 'itunes:'

function metaKey(artist, title) {
  return `${PREFIX}${String(artist || '').toLowerCase()}|${String(title || '').toLowerCase()}`
}

/* A cache entry is JSON { art, dur }: art is the 600px URL or '' (known miss),
   dur is the track length in seconds (0 when unknown). A stored entry — even an
   all-empty one — means "iTunes already answered", so we don't re-hit the
   network every mount for a song it doesn't have. Returns null when uncached. */
function loadCached(artist, title) {
  try {
    const raw = localStorage.getItem(metaKey(artist, title))
    if (raw == null) return null
    const p = JSON.parse(raw)
    const dur = Number(p?.dur)
    return { art: p?.art || '', dur: Number.isFinite(dur) && dur > 0 ? dur : null }
  } catch {
    return null
  }
}

function saveCached(artist, title, meta) {
  try {
    localStorage.setItem(metaKey(artist, title), JSON.stringify({ art: meta.art || '', dur: meta.dur || 0 }))
  } catch { /* storage full */ }
}

async function fetchItunesMeta(artist, title, signal) {
  const term = `${artist || ''} ${title || ''}`.trim()
  if (!term) return { art: '', dur: null }
  const res = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&limit=1`,
    { signal },
  )
  if (!res.ok) return { art: '', dur: null }
  const data = await res.json()
  const hit = data?.results?.[0]
  // iTunes returns a 100x100 thumbnail; the CDN serves arbitrary sizes by
  // swapping the dimensions token, so ask for a crisp 600x600.
  const art = hit?.artworkUrl100 ? hit.artworkUrl100.replace('100x100bb', '600x600bb') : ''
  const ms = Number(hit?.trackTimeMillis)
  const dur = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : null
  return { art, dur }
}

/* Canonical track length (seconds) from iTunes, or null on miss. Reads the
   shared cache first; a single fetch populates both artwork and duration so a
   later useArtwork() mount for the same song is free. */
export async function fetchItunesDuration(artist, title, signal) {
  const cached = loadCached(artist, title)
  if (cached) return cached.dur
  const meta = await fetchItunesMeta(artist, title, signal)
  saveCached(artist, title, meta)
  return meta.dur
}

/* React hook: returns the artwork URL for a track, or null while loading / on
   miss. Reads cache synchronously on mount (no flash for known songs), then
   fetches in the background for cache-cold songs. */
export function useArtwork(artist, title) {
  const [url, setUrl] = useState(() => loadCached(artist, title)?.art || null)

  useEffect(() => {
    const cached = loadCached(artist, title)
    if (cached) { setUrl(cached.art || null); return } // '' and null both mean "no art"

    let cancelled = false
    const ctrl = new AbortController()
    fetchItunesMeta(artist, title, ctrl.signal)
      .then(meta => {
        if (cancelled) return
        saveCached(artist, title, meta)
        setUrl(meta.art || null)
      })
      .catch(() => { /* aborted or network error — keep the gradient fallback */ })
    return () => { cancelled = true; ctrl.abort() }
  }, [artist, title])

  return url
}
