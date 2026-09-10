// iTunes Search API (free, no key) metadata: album artwork + the canonical
// track duration. Both come from one search hit and are cached together in
// localStorage, so a revisit is instant/offline-safe and artwork + duration
// never cost two separate network round-trips.

import { useEffect, useState } from 'react'

const PREFIX = 'itunes5:'

/* Module-level request deduplication: one in-flight Promise per song, shared
   by every mount. Fetching is decoupled from the component lifecycle so fast
   remounts on mobile never kill a nearly-finished request. */
const inFlight = new Map()

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

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

/* Score one iTunes hit against the wanted artist/title. +3 for an artist
   match (either direction, case-insensitive), +2 for a title match. */
function scoreHit(hit, artist, title) {
  let score = 0
  const a = String(artist || '').trim().toLowerCase()
  const t = String(title || '').trim().toLowerCase()
  const ha = String(hit?.artistName || '').trim().toLowerCase()
  const ht = String(hit?.trackName || '').trim().toLowerCase()
  if (a && ha && (ha.includes(a) || a.includes(ha))) score += 3
  if (t && ht && (ht.includes(t) || t.includes(ht))) score += 2
  return score
}

/* Highest-scoring result wins; results[0] is the last resort when nothing
   scores above 0. */
function pickBestHit(results, artist, title) {
  if (!Array.isArray(results) || results.length === 0) return null
  let best = results[0]
  let bestScore = 0
  for (const r of results) {
    const s = scoreHit(r, artist, title)
    if (s > bestScore) { bestScore = s; best = r }
  }
  return best || results[0] || null
}

function metaFromHit(hit) {
  // The artwork URL carries a dimensions token (usually 100x100bb, sometimes
  // 170x170bb or with a .jpg suffix) — swap any of them for a crisp 600x600.
  const art = hit?.artworkUrl100
    ? hit.artworkUrl100.replace(/\d+x\d+bb/, '600x600bb')
    : ''
  const ms = Number(hit?.trackTimeMillis)
  const dur = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : null
  return { art, dur }
}

async function searchOnce(term) {
  const res = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=5`,
  )
  // A network error or non-ok response throws: NOT a cache miss, so the
  // caller skips the localStorage write and the next mount retries.
  if (!res.ok) throw new Error(`iTunes search failed: ${res.status}`)
  const data = await res.json()
  return Array.isArray(data?.results) ? data.results : []
}

async function doFetchItunesMeta(artist, title) {
  const first = `${artist || ''} ${title || ''}`.trim()
  if (!first) return { art: '', dur: null }
  let results = await searchOnce(first)
  if (results.length === 0) {
    // CDN variance sometimes answers empty on the first try — retry once
    // after 800ms with the query reversed.
    const reversed = `${title || ''} ${artist || ''}`.trim()
    if (reversed && reversed !== first) {
      await sleep(800)
      results = await searchOnce(reversed)
    }
  }
  // Empty after retry is a genuine miss, worth caching so we don't re-fetch.
  if (results.length === 0) return { art: '', dur: null }
  return metaFromHit(pickBestHit(results, artist, title))
}

function fetchItunesMeta(artist, title) {
  const key = metaKey(artist, title)
  const existing = inFlight.get(key)
  if (existing) return existing
  const p = doFetchItunesMeta(artist, title).finally(() => {
    if (inFlight.get(key) === p) inFlight.delete(key)
  })
  inFlight.set(key, p)
  return p
}

/* Canonical track length (seconds) from iTunes, or null on miss. Reads the
   shared cache first; a single fetch populates both artwork and duration so a
   later useArtwork() mount for the same song is free. */
export async function fetchItunesDuration(artist, title) {
  const cached = loadCached(artist, title)
  if (cached) return cached.dur
  const meta = await fetchItunesMeta(artist, title)
  saveCached(artist, title, meta)
  return meta.dur
}

/* Warm the cache for a list of tracks ahead of time. Sequential with a 200ms
   gap between calls to stay under iTunes rate limits; skips anything already
   cached and never writes on network errors. */
export async function prefetchArtwork(tracks) {
  if (!Array.isArray(tracks)) return
  let first = true
  for (const t of tracks) {
    const artist = t?.artist
    const title = t?.title
    if (!artist && !title) continue
    if (loadCached(artist, title)) continue
    if (!first) await sleep(200)
    first = false
    try {
      const meta = await fetchItunesMeta(artist, title)
      saveCached(artist, title, meta)
    } catch { /* network error — skip, do not cache */ }
  }
}

/* React hook: returns [url, setUrl] — the artwork URL for a track (or null
   while loading / on miss) plus its setter so callers can clear a broken
   image to the gradient fallback. Reads cache synchronously on mount (no
   flash for known songs), then fetches in the background for cache-cold
   songs. Genuine misses are cached; network errors are not, so the next
   mount retries. No AbortController: the shared fetch runs to completion
   even if this component unmounts, warming the cache for the next mount —
   only setUrl is gated by the cancelled flag. */
export function useArtwork(artist, title) {
  const [url, setUrl] = useState(() => loadCached(artist, title)?.art || null)

  useEffect(() => {
    const cached = loadCached(artist, title)
    if (cached?.art) {
      setUrl(cached.art)
      return undefined
    }
    if (!cached) {
      let cancelled = false
      fetchItunesMeta(artist, title)
        .then(meta => {
          saveCached(artist, title, meta) // runs even when unmounted
          if (!cancelled) setUrl(meta.art || null)
        })
        .catch(() => { /* network error — do not cache, keep the gradient fallback */ })
      return () => { cancelled = true }
    }
    // Stale empty-art entry with a valid duration: stay on the gradient for
    // now, but re-fetch art in the background after 2000ms in case iTunes
    // has it now. A still-missing entry leaves the cache untouched.
    if (cached.dur == null) return undefined
    let cancelled = false
    const timer = setTimeout(() => {
      fetchItunesMeta(artist, title)
        .then(meta => {
          if (!meta.art) return
          saveCached(artist, title, { art: meta.art, dur: cached.dur })
          if (!cancelled) setUrl(meta.art)
        })
        .catch(() => { /* network error — keep old entry */ })
    }, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [artist, title])

  return [url, setUrl]
}
