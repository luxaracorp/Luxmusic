import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { useArtwork, fetchItunesDuration } from '../lib/artwork.js'
import { gradientFor } from '../lib/recents.js'

function parseLrc(syncedLyrics) {
  if (!syncedLyrics) return []
  const stamp = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g
  const out = []
  for (const line of syncedLyrics.split('\n')) {
    const stamps = [...line.matchAll(stamp)]
    if (stamps.length === 0) continue
    const text = line.replace(stamp, '').trim()
    for (const m of stamps) {
      const min = parseInt(m[1], 10)
      const sec = parseInt(m[2], 10)
      const frac = m[3] ? parseInt(m[3], 10) / Math.pow(10, m[3].length) : 0
      out.push({ time: min * 60 + sec + frac, text })
    }
  }
  return out.sort((a, b) => a.time - b.time)
}

const LYRICS_FALLBACK = [{ time: 0, text: 'Instrumental / Lyrics unavailable' }]

/* The "lyrics4:" prefix invalidates entries cached before candidates were
   validated against LRCLIB (which could pair a live/edit upload with
   mismatched lyrics); older "lyrics:"/"lyrics3:" keys stay, ignored. */
function cacheKey(artist, title) {
  return `lyrics4:${String(artist).toLowerCase()}:${String(title).toLowerCase()}`
}

// Per-song lyric timing offset (seconds), so a calibration sticks between visits.
function offsetKey(artist, title) {
  return `offset:${String(artist).toLowerCase()}:${String(title).toLowerCase()}`
}

function loadOffset(artist, title) {
  const v = parseFloat(localStorage.getItem(offsetKey(artist, title)))
  return Number.isFinite(v) ? v : 0
}

function saveOffset(artist, title, seconds) {
  try { localStorage.setItem(offsetKey(artist, title), String(seconds)) } catch { /* noop */ }
}

/* Cached shape is { lyrics, duration } — duration being the length (seconds)
   of the recording the lyrics were timed against, or null when unknown. */
function loadFromCache(artist, title) {
  try {
    const data = localStorage.getItem(cacheKey(artist, title))
    if (!data) return null
    const parsed = JSON.parse(data)
    if (!Array.isArray(parsed?.lyrics)) return null
    const dur = Number(parsed.duration)
    return { lyrics: parsed.lyrics, duration: Number.isFinite(dur) && dur > 0 ? dur : null }
  } catch {
    return null
  }
}

function saveToCache(artist, title, lyrics, duration) {
  try {
    localStorage.setItem(cacheKey(artist, title), JSON.stringify({ lyrics, duration }))
  } catch { /* storage full */ }
}

// Resolved audio, cached like the lyrics so a revisit skips the instance
// round-trip entirely. Shape is { id, duration } — the chosen upload's length
// feeds the lyrics lookup on cached revisits too. The "video4:" prefix
// invalidates entries picked before LRCLIB validation (which could be a
// live/edit version); older "video:"/"video2:"/"video3:" keys stay, ignored.
function videoKey(artist, title) {
  return `video4:${String(artist).toLowerCase()}|${String(title).toLowerCase()}`
}

function loadVideo(artist, title) {
  try {
    const data = localStorage.getItem(videoKey(artist, title))
    if (!data) return null
    const parsed = JSON.parse(data)
    if (!parsed?.id) return null
    const dur = Number(parsed.duration)
    return { id: parsed.id, duration: Number.isFinite(dur) && dur > 0 ? dur : null }
  } catch {
    return null
  }
}

function saveVideo(artist, title, id, duration) {
  try { localStorage.setItem(videoKey(artist, title), JSON.stringify({ id, duration })) } catch { /* storage full */ }
}

/* Hosts raced in parallel for a YouTube video ID — first success wins.
   Edit freely: any mix of Invidious and Piped instances works. */
const VIDEO_SOURCES = [
  { type: 'invidious', host: 'iv.melmac.space' },
  { type: 'invidious', host: 'inv.nadeko.net' },
  { type: 'invidious', host: 'yewtu.be' },
  { type: 'piped', host: 'api.piped.private.coffee' },
  { type: 'piped', host: 'pipedapi.adminforge.de' },
]

const VIDEO_FETCH_TIMEOUT = 3500

async function invidiousSearch(host, query, signal) {
  const res = await fetch(`https://${host}/api/v1/search?q=${encodeURIComponent(query)}&type=video&fields=videoId,author,title,description,lengthSeconds`, { signal })
  if (!res.ok) return []
  const data = await res.json()
  if (!Array.isArray(data)) return []
  return data.map(v => ({ ...v, duration: Number(v?.lengthSeconds) || null }))
}

/* filter=music_songs searches YouTube Music's song catalog: studio masters
   only, never music videos — so whatever it returns has no intro and lines
   up with duration-matched lyrics automatically. */
async function pipedSearch(host, query, signal) {
  const res = await fetch(`https://${host}/search?q=${encodeURIComponent(query)}&filter=music_songs`, { signal })
  if (!res.ok) return []
  const data = await res.json()
  return (data?.items || []).map(i => ({
    videoId: (i?.url?.match(/[?&]v=([a-zA-Z0-9_-]{11})/) || [])[1],
    author: i?.uploaderName,
    title: i?.title,
    description: i?.shortDescription,
    duration: Number(i?.duration) || null,
  }))
}

/* Official "<Artist> - Topic" / auto-generated Art Track uploads use the studio
   master with no music-video intro, so they line up with LRCLIB's timing far
   better than fan uploads or official videos. These are the ONLY uploads we
   accept unless the search turns up nothing else (see rankVideoCandidates). */
const OFFICIAL_UPLOAD_RE = /-\s*topic|auto-?generated|art track|provided to youtube/i

/* Duration gating/scoring against the canonical iTunes length.
   HARD_TOLERANCE is a reject gate — a candidate whose length is off by more
   than this is not the same recording and is dropped outright. CLOSE/NEAR only
   act as ranking tiebreakers among survivors and drive the sync pill. */
const DURATION_HARD_TOLERANCE = 3   // seconds — reject beyond this from iTunes
const DURATION_CLOSE_TOLERANCE = 2  // seconds — same recording
const DURATION_NEAR_TOLERANCE = 5   // seconds — probably the same recording
const LYRICS_MATCH_TOLERANCE = 7    // seconds — LRCLIB search result accepted as matching

/* Alternate versions whose timings can't match the album original's lyrics.
   Deliberately absent: "remaster" — same recording, same timings, and most
   official catalog entries carry it. */
const WRONG_VERSION_RE = /\b(live|cover|remix|karaoke|instrumental|acoustic|demo|sped.?up|slowed|reverb|8d|mashup|medley|tribute)\b/i

/* Strip junk parentheticals/brackets and noise for title comparison, so
   "Beat It (Official Audio) [HD]" still counts as matching "Beat It". */
function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const MAX_AUDIO_CANDIDATES = 5

/* Rank candidates best-first and return up to MAX_AUDIO_CANDIDATES as
   { id, duration, title, uploaderName }.

   Two hard gates run before scoring:
     1. Duration — with a canonical iTunes length known, drop anything more
        than ±DURATION_HARD_TOLERANCE off it (a candidate with an unknown
        length can't be gated, so it's kept). If the gate empties the pool the
        iTunes length is suspect, so we ignore the gate rather than strand the
        song — LRCLIB validation downstream is still keyed on iTunes anyway.
     2. Channel — keep only official "- Topic"/auto-generated art tracks,
        unless none exist, in which case fall back to whatever's left.
   Survivors are then scored (wrong version −8, exact/prefix title +6, duration
   proximity and artist-in-channel as tiebreakers). */
function rankVideoCandidates(candidates, artist, trackTitle, refDuration) {
  const artistLc = String(artist || '').toLowerCase()
  const wantTitle = normalizeTitle(trackTitle)
  const hasRef = Number.isFinite(refDuration) && refDuration > 0

  let pool = candidates.filter(c => c?.videoId)

  // (1) Hard duration gate — only accept recordings within ±3s of iTunes.
  if (hasRef) {
    const within = pool.filter(c => {
      const d = Number(c.duration)
      return !Number.isFinite(d) || d <= 0 || Math.abs(d - refDuration) <= DURATION_HARD_TOLERANCE
    })
    if (within.length) pool = within
    else console.warn('[luxara] no YouTube candidate within ±3s of the iTunes duration — ignoring the duration gate')
  }

  // (2) Hard channel gate — official/auto-generated uploads only, else fall back.
  const official = pool.filter(c => OFFICIAL_UPLOAD_RE.test(`${c.author || ''} ${c.description || ''}`))
  if (official.length) pool = official
  else if (pool.length) console.warn('[luxara] no Topic/auto-generated upload found — falling back to non-official candidates')

  const scored = []
  for (let i = 0; i < pool.length; i++) {
    const c = pool[i]
    const author = String(c.author || '')
    const title = String(c.title || '')
    let score = 0
    if (WRONG_VERSION_RE.test(title)) score -= 8
    if (wantTitle) {
      const got = normalizeTitle(title)
      if (got === wantTitle || got.startsWith(wantTitle)) score += 6
    }
    if (hasRef && Number.isFinite(c.duration) && c.duration > 0) {
      const delta = Math.abs(c.duration - refDuration)
      if (delta <= DURATION_CLOSE_TOLERANCE) score += 10
      else if (delta <= DURATION_NEAR_TOLERANCE) score += 5
    }
    if (artistLc && author.toLowerCase().includes(artistLc)) score += 2
    scored.push({ score, i, c })
  }
  // Stable best-first: on equal scores keep the search engine's own order.
  scored.sort((a, b) => b.score - a.score || a.i - b.i)
  return scored.slice(0, MAX_AUDIO_CANDIDATES).map(({ c }) => ({
    id: c.videoId,
    duration: Number.isFinite(c.duration) && c.duration > 0 ? c.duration : null,
    title: c.title || '',
    uploaderName: c.author || '',
  }))
}

/* How long the Piped music_songs race gets to win outright before the
   Invidious fallback race starts alongside it. */
const MUSIC_SEARCH_GRACE_MS = 2500

function raceSources(sources, search, rank) {
  const attempts = sources.map(src => (async () => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), VIDEO_FETCH_TIMEOUT)
    try {
      const found = rank(await search(src.host, ctrl.signal))
      if (!found?.length) throw new Error('no result')
      return found
    } finally {
      clearTimeout(timer)
    }
  })())
  return Promise.any(attempts) // rejects if every instance fails
}

/* Resolve audio as a ranked list of up to MAX_AUDIO_CANDIDATES candidates
   { id, duration, title, uploaderName } — YouTube Music songs first.
   refDuration is the canonical iTunes length: rankVideoCandidates gates
   candidates to ±3s of it. music_songs results are studio masters by
   construction (never music videos), so any hit is intro-free; the Invidious
   type=video race is only a fallback for when every Piped instance fails,
   keeping the old " topic" query bias. Both paths run through the same
   ranking. A late music_songs result still beats the fallback via Promise.any
   ordering. */
async function scrapeAudioCandidates(artist, title, refDuration) {
  const rank = candidates => rankVideoCandidates(candidates, artist, title, refDuration)
  const pipedRace = raceSources(
    VIDEO_SOURCES.filter(s => s.type === 'piped'),
    (host, signal) => pipedSearch(host, `${artist} ${title}`, signal),
    rank,
  )
  // Grace window: give the music races first shot; on timeout — or every
  // instance failing early — move on to the fallback.
  try {
    const graced = await Promise.race([
      pipedRace,
      new Promise(resolve => setTimeout(() => resolve(null), MUSIC_SEARCH_GRACE_MS)),
    ])
    if (graced) return graced
  } catch { /* all piped instances failed — fall through immediately */ }

  const invidiousRace = raceSources(
    VIDEO_SOURCES.filter(s => s.type === 'invidious'),
    (host, signal) => invidiousSearch(host, `${artist} ${title} topic`, signal),
    rank,
  )
  try {
    return await Promise.any([pipedRace, invidiousRace])
  } catch {
    return null // every instance of every type failed or returned nothing
  }
}

/* LRCLIB /api/get lookup for a specific recording: artist + title + duration
   (matched within ~2s server-side). Returns parsed synced lyrics or null —
   instrumental entries and plain-text-only hits count as misses. */
const LRCLIB_GET_TIMEOUT = 4000

async function fetchLyricsForDuration(artist, title, duration) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), LRCLIB_GET_TIMEOUT)
  try {
    const params = new URLSearchParams({
      artist_name: artist || '',
      track_name: title || '',
      duration: String(Math.round(duration)),
    })
    const r = await fetch(`https://lrclib.net/api/get?${params}`, { signal: ctrl.signal })
    if (!r.ok) return null
    const hit = await r.json()
    if (hit?.instrumental || !hit?.syncedLyrics) return null
    const parsed = parseLrc(hit.syncedLyrics)
    return parsed.length > 0 ? parsed : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/* ---- smooth playback clock ----
   The YouTube iframe API only refreshes getCurrentTime() in ~250ms steps,
   which makes a per-frame word-wipe stutter and lag. We sample the raw clock
   on an interval and interpolate between samples with performance.now() scaled
   by the playback rate. A stale sample (small backward diff) is ignored; a
   large jump in either direction is a seek and re-anchors immediately. */
const CLOCK_SAMPLE_MS = 200
const SEEK_JUMP_THRESHOLD = 0.4 // seconds — beyond this, a sample is a seek

// YouTube's reported clock leads what you actually hear by roughly this much
// (decode + output latency). Applied globally, on top of the per-song offset.
const OUTPUT_LATENCY_OFFSET = 0.15

function createSmoothClock() {
  let baseMedia = 0 // media time at the anchor
  let basePerf = 0  // performance.now() at the anchor
  let rate = 1
  let running = false
  let anchored = false

  const predict = () => running
    ? baseMedia + ((performance.now() - basePerf) / 1000) * rate
    : baseMedia

  return {
    sample(mediaTime, playbackRate, isPlaying) {
      rate = playbackRate || 1
      running = isPlaying
      if (!anchored) {
        baseMedia = mediaTime
        basePerf = performance.now()
        anchored = true
        return
      }
      const diff = mediaTime - predict()
      // Forward progress or a big jump (seek): trust the raw sample.
      // A small backward diff means the iframe clock just hasn't ticked to a
      // fresh value yet — keep the prediction instead of wobbling backward.
      if (diff >= 0 || Math.abs(diff) > SEEK_JUMP_THRESHOLD) {
        baseMedia = mediaTime
        basePerf = performance.now()
      }
    },
    /* Current interpolated media time, or null before the first sample. */
    now() {
      return anchored ? predict() : null
    },
    /* Forget the anchor so the next sample is trusted unconditionally.
       Call right after any seek. */
    resync() {
      anchored = false
    },
  }
}

const DIM_WORD = 'rgba(255,255,255,0.28)'

/* Three pulsing dots for instrumental intros / gaps between lines. */
function GapDots({ progress = 0.6 }) {
  return (
    <span className="inline-flex items-center gap-2 align-middle" style={{ opacity: 0.35 + progress * 0.55 }}>
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="w-2.5 h-2.5 rounded-full bg-white animate-dot-pulse"
          style={{ animationDelay: `${i * 180}ms` }}
        />
      ))}
    </span>
  )
}

/* One lyric line. All lines are the same font size; the active line scales up
   via transform (scale, origin left-center) so scaling is GPU-cheap and never
   reflows its neighbors. The per-word wipe is driven by a single `--wipe`
   custom property written on this node by the rAF loop (see the loop below) —
   each word derives its own fill via calc() in the `.wipe-word` CSS rule, so
   nothing re-renders through React per frame.

   Memoized on (isCurrent, colorClass, blurPx, text): while a line stays
   active only the DOM --wipe changes, and React skips re-rendering entirely. */
const LyricLine = memo(function LyricLine({ index, time, text, isCurrent, colorClass, blurPx, onSelect, refCb }) {
  const isGap = isCurrent && text.trim() === ''
  const words = text.split(' ')
  return (
    <p
      ref={el => refCb(el, index)}
      onClick={() => onSelect(index, time)}
      data-current={isCurrent ? 'true' : undefined}
      className={[
        'select-none cursor-pointer origin-left',
        'font-extrabold leading-snug tracking-[-0.02em]',
        'text-[1.6rem] md:text-[2.2rem]',
        'transition-[color,opacity,filter,transform] duration-[600ms] ease-[cubic-bezier(0.32,0.9,0.35,1.04)]',
        isCurrent ? 'scale-[1.32] animate-line-pop' : 'scale-100',
        colorClass,
        'active:opacity-50',
      ].join(' ')}
      style={{
        // Inline styles win over all Tailwind/class specificity and
        // are the only reliable way to force wrapping on iOS Safari.
        display: 'block',
        // The active line scales 1.32x from the left edge — shrink its layout
        // width by the same factor so the scaled text still fits exactly
        // inside the container instead of clipping off-screen on mobile.
        width: isCurrent ? 'calc(100% / 1.32)' : '100%',
        wordBreak: 'break-word',
        overflowWrap: 'break-word',
        whiteSpace: 'normal',
        textAlign: 'left',
        transformOrigin: 'left center',
        // Depth: distant lines blur slightly, like Apple Music.
        filter: blurPx ? `blur(${blurPx}px)` : undefined,
      }}
    >
      {isGap ? (
        <GapDots progress={0.6} />
      ) : isCurrent ? (
        words.map((word, j) => (
          <span key={j}>
            <span className="wipe-word" style={{ '--wj': j, '--wm': words.length }}>{word}</span>
            {/* space lives outside the span so iOS Safari keeps a
                line-break opportunity between words (prevents the
                enlarged active line from overflowing off-screen) */}
            {j < words.length - 1 ? ' ' : ''}
          </span>
        ))
      ) : (
        text
      )}
    </p>
  )
})

export default function PlayerScreen({ track, onBack }) {
  const [activeVideoId, setActiveVideoId] = useState(null)
  const [lyrics, setLyrics] = useState([])
  const [currentLine, setCurrentLine] = useState(-1)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playerReady, setPlayerReady] = useState(false)
  const [error, setError] = useState(null)
  // Lyric timing offset in seconds: how much later (+) the words appear vs. the
  // player clock, to reconcile a YouTube upload whose intro differs from the
  // studio recording LRCLIB timed the lyrics against.
  const [syncOffset, setSyncOffset] = useState(0)
  // Upload duration matched LRCLIB's studio length — no calibration needed.
  const [inSync, setInSync] = useState(false)

  // Album art for this song (background wash + header/desktop thumbnail).
  const [artUrl] = useArtwork(track.artist, track.title)
  const gradient = track.gradient || gradientFor(`${track.title} ${track.artist}`)

  const playerRef = useRef(null)
  const lineRefs = useRef([])
  const scrollRef = useRef(null)
  const mountedRef = useRef(true)
  // The active line's DOM node, so the rAF loop can write --wipe on it every
  // frame without going through React state.
  const activeNodeRef = useRef(null)
  // After a click-seek we ignore the poll until the player has actually
  // reached the clicked line (seekTo snaps to the nearest keyframe, which can
  // land just *before* the target and otherwise snap the UI to the prior line).
  const seekingRef = useRef(false)
  const seekTargetRef = useRef(0)
  const seekTimerRef = useRef(null)
  // Mirror syncOffset in a ref so the rAF loop reads the latest value without
  // being torn down and recreated on every nudge.
  const offsetRef = useRef(0)
  // Interpolated playback clock — see createSmoothClock above.
  const clockRef = useRef(null)
  if (clockRef.current == null) clockRef.current = createSmoothClock()
  // LRCLIB's reported track length in seconds (the studio master), or null
  // when lyrics came from a passed-in LRC with no known duration.
  const refDurationRef = useRef(null)
  // Spring auto-scroll state + a "paused until" timestamp set when the user
  // scrolls by hand, so we don't fight their manual scrolling.
  const scrollAnimRef = useRef(null)
  const scrollPausedUntilRef = useRef(0)

  const isReady = activeVideoId && playerReady && !error

  useEffect(() => {
    mountedRef.current = true
    setCurrentLine(-1)
    lineRefs.current = []
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    return () => {
      mountedRef.current = false
      clearTimeout(seekTimerRef.current)
      if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current)
    }
  }, [])

  /* load saved lyric offset for this song */
  useEffect(() => {
    setSyncOffset(loadOffset(track.artist, track.title))
  }, [track.artist, track.title])

  useEffect(() => { offsetRef.current = syncOffset }, [syncOffset])

  const adjustOffset = useCallback((delta) => {
    setSyncOffset(prev => {
      const next = delta === 0 ? 0 : Math.round((prev + delta) * 10) / 10
      saveOffset(track.artist, track.title, next)
      return next
    })
  }, [track.artist, track.title])

  /* audio + lyrics resolution as a matched pair, anchored on the canonical
     iTunes duration. That length gates the YouTube candidate search to ±3s
     (rankVideoCandidates) and is the duration handed to LRCLIB — so lyrics are
     timed to the studio recording, never to whatever the chosen upload happens
     to be. When iTunes has no length for the song we fall back to validating
     the candidates' own durations against LRCLIB, first-recognized-wins. */
  useEffect(() => {
    setLyrics([])
    setActiveVideoId(null)
    setError(null)
    refDurationRef.current = null
    let cancelled = false

    const MATCH_ATTEMPTS = 3

    const cacheAndShow = (audio, parsedLyrics, lyricsDuration) => {
      if (audio) {
        saveVideo(track.artist, track.title, audio.id, audio.duration)
        setActiveVideoId(audio.id)
      }
      if (parsedLyrics) {
        refDurationRef.current = lyricsDuration
        setLyrics(parsedLyrics)
        saveToCache(track.artist, track.title, parsedLyrics, lyricsDuration)
      }
    }

    // iTunes canonical duration (seconds) for this song, fetched at most once
    // per resolution and memoized — undefined until first asked, then a
    // number or null (miss). Kept lazy so cached fast-paths stay instant.
    let itunesDur // undefined = not fetched yet
    const getItunesDuration = async () => {
      if (itunesDur !== undefined) return itunesDur
      itunesDur = await fetchItunesDuration(track.artist, track.title).catch(() => null)
      return itunesDur
    }

    // Ranked candidate list, or null. Retries preserved from the old flow.
    const findCandidates = async (retriesLeft, refDuration) => {
      const found = await scrapeAudioCandidates(track.artist, track.title, refDuration)
      if (cancelled) return null
      if (found?.length) return found
      if (retriesLeft > 0) {
        await new Promise(r => setTimeout(r, 1500))
        if (cancelled) return null
        return findCandidates(retriesLeft - 1, refDuration)
      }
      return null
    }

    // Best-effort lyrics via full-text search, picking the hit closest in
    // duration to targetDuration (the iTunes length when known) instead of
    // blindly taking the first.
    const searchLyricsFallback = async (targetDuration) => {
      try {
        const q = track.searchQuery || `${track.artist} ${track.title}`
        const r = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`)
        if (!r.ok) throw new Error()
        const data = await r.json()
        if (cancelled) return
        const hits = (Array.isArray(data) ? data : []).filter(h => h?.syncedLyrics)
        if (hits.length === 0) { setLyrics(LYRICS_FALLBACK); return }

        let hit = hits[0]
        if (Number.isFinite(targetDuration) && targetDuration > 0) {
          hit = hits.reduce((a, b) =>
            Math.abs(Number(b.duration) - targetDuration) < Math.abs(Number(a.duration) - targetDuration) ? b : a)
          const delta = Math.abs(Number(hit.duration) - targetDuration)
          if (!(delta <= LYRICS_MATCH_TOLERANCE)) {
            console.warn(`[luxara] closest LRCLIB match is ${Math.round(delta)}s off the target duration — lyrics may need manual sync`)
          }
        }
        const parsed = parseLrc(hit.syncedLyrics)
        if (parsed.length === 0) { setLyrics(LYRICS_FALLBACK); return }
        const dur = Number(hit.duration)
        cacheAndShow(null, parsed, Number.isFinite(dur) && dur > 0 ? dur : null)
      } catch {
        if (!cancelled) setLyrics(loadFromCache(track.artist, track.title)?.lyrics || LYRICS_FALLBACK)
      }
    }

    ;(async () => {
      // Cached matched pair — instant, no loop re-run.
      const cachedVideo = (track.artist || track.title) ? loadVideo(track.artist, track.title) : null
      const cachedLyrics = loadFromCache(track.artist, track.title)
      if (cachedVideo) setActiveVideoId(cachedVideo.id)
      if (cachedLyrics) { setLyrics(cachedLyrics.lyrics); refDurationRef.current = cachedLyrics.duration }

      // Lyrics passed in directly (e.g. a hand-picked search result) are
      // authoritative — they bypass the LRCLIB validation loop.
      let providedLyrics = null
      if (!cachedLyrics && track.syncedLyrics) {
        providedLyrics = parseLrc(track.syncedLyrics)
        if (providedLyrics.length > 0) cacheAndShow(null, providedLyrics, null)
        else { providedLyrics = null; setLyrics(LYRICS_FALLBACK) }
      }
      const haveLyrics = !!(cachedLyrics || providedLyrics)

      // Audio already known — only the lyrics half may still be missing. Key
      // the lookup on the iTunes duration when available, falling back to the
      // cached upload's own length.
      if (cachedVideo) {
        if (haveLyrics) return
        const itunes = await getItunesDuration()
        if (cancelled) return
        const dur = Number.isFinite(itunes) && itunes > 0
          ? itunes
          : (Number.isFinite(cachedVideo.duration) && cachedVideo.duration > 0 ? cachedVideo.duration : null)
        const parsed = dur ? await fetchLyricsForDuration(track.artist, track.title, dur) : null
        if (cancelled) return
        if (parsed) cacheAndShow(null, parsed, dur)
        else await searchLyricsFallback(dur)
        return
      }
      if (track.videoId) {
        setActiveVideoId(track.videoId)
        if (!haveLyrics) {
          const itunes = await getItunesDuration()
          if (cancelled) return
          await searchLyricsFallback(itunes)
        }
        return
      }
      if (!track.artist && !track.title) {
        if (!haveLyrics && !track.syncedLyrics) setLyrics(LYRICS_FALLBACK)
        return
      }

      // Canonical length first — it gates the candidate search and keys LRCLIB.
      const itunesDuration = await getItunesDuration()
      if (cancelled) return
      const hasItunes = Number.isFinite(itunesDuration) && itunesDuration > 0

      const candidates = await findCandidates(2, itunesDuration)
      if (cancelled) return
      if (!candidates) {
        setError('No audio stream found')
        // Still try lyrics (best effort) so the user at least sees words.
        if (!haveLyrics) await searchLyricsFallback(itunesDuration)
        return
      }

      if (haveLyrics) {
        // Lyrics are fixed — take the best-ranked candidate. The iTunes
        // duration already gated/steered the ranking.
        cacheAndShow(candidates[0], null, null)
        return
      }

      if (hasItunes) {
        // Primary path: ask LRCLIB for lyrics timed to the iTunes recording.
        // Every candidate is already within ±3s of it, so the best-ranked one
        // is the studio master these lyrics belong to.
        const parsed = await fetchLyricsForDuration(track.artist, track.title, itunesDuration)
        if (cancelled) return
        if (parsed) {
          cacheAndShow(candidates[0], parsed, itunesDuration)
          return
        }
      } else {
        // No iTunes length — fall back to the old matched-pair loop: validate
        // each top candidate's own duration against LRCLIB, first hit wins, so
        // a live/edit upload LRCLIB doesn't recognize is skipped.
        for (const cand of candidates.slice(0, MATCH_ATTEMPTS)) {
          if (!Number.isFinite(cand.duration) || cand.duration <= 0) continue
          const parsed = await fetchLyricsForDuration(track.artist, track.title, cand.duration)
          if (cancelled) return
          if (parsed) {
            cacheAndShow(cand, parsed, cand.duration)
            return
          }
        }
      }

      // LRCLIB /api/get missed: play the best-ranked candidate anyway and take
      // the closest-duration lyrics full-text search can offer (targeting the
      // iTunes length when known).
      const first = candidates[0]
      cacheAndShow(first, null, null)
      await searchLyricsFallback(hasItunes ? itunesDuration : first.duration)
    })()
    return () => { cancelled = true }
  }, [track])

  /* YouTube player */
  useEffect(() => {
    if (!activeVideoId) return
    const createPlayer = () => {
      if (!window.YT?.Player) return
      playerRef.current = new window.YT.Player('youtube-player', {
        height: '100%', width: '100%', videoId: activeVideoId,
        playerVars: { playsinline: 1, controls: 0, rel: 0, modestbranding: 1, enablejsapi: 1, autoplay: 0 },
        events: {
          onReady: () => setPlayerReady(true),
          onStateChange: (e) => {
            const S = window.YT.PlayerState
            setIsPlaying(e.data === S.PLAYING)
            if (e.data === S.ENDED) setCurrentLine(-1)
          },
        },
      })
    }
    window.onYouTubeIframeAPIReady = createPlayer
    if (!window.YT) {
      const tag = document.createElement('script')
      tag.src = 'https://www.youtube.com/iframe_api'
      document.head.appendChild(tag)
    } else {
      createPlayer()
    }
    return () => {
      playerRef.current?.destroy?.()
      playerRef.current = null
      window.onYouTubeIframeAPIReady = null
      setPlayerReady(false)
      setIsPlaying(false)
    }
  }, [activeVideoId])

  /* feed the smooth clock with raw player samples */
  useEffect(() => {
    if (!playerReady) return
    const clock = clockRef.current
    const id = setInterval(() => {
      const p = playerRef.current
      if (!p || typeof p.getCurrentTime !== 'function') return
      const t = p.getCurrentTime()
      if (t == null) return
      const rate = typeof p.getPlaybackRate === 'function' ? p.getPlaybackRate() : 1
      const playing = typeof p.getPlayerState === 'function'
        ? p.getPlayerState() === window.YT?.PlayerState?.PLAYING
        : true
      clock.sample(t, rate, playing)
    }, CLOCK_SAMPLE_MS)
    return () => { clearInterval(id); clock.resync() }
  }, [playerReady])

  /* sync pill — the upload was picked by duration matching, so if its actual
     length agrees with LRCLIB's reference, surface "In sync" in the UI. */
  useEffect(() => {
    if (!playerReady) return
    let cancelled = false
    let timer
    let tries = 0

    const check = () => {
      if (cancelled) return
      const p = playerRef.current
      const duration = typeof p?.getDuration === 'function' ? p.getDuration() : 0
      const reference = refDurationRef.current
      // getDuration() can be 0 right after ready, and the LRCLIB fetch may
      // still be in flight — retry briefly, then give up.
      if (!duration || !reference) {
        if (++tries < 20) timer = setTimeout(check, 300)
        return
      }
      if (Math.abs(duration - reference) <= DURATION_NEAR_TOLERANCE) setInSync(true)
    }
    timer = setTimeout(check, 0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [playerReady, activeVideoId])

  /* rAF loop — 60fps current-line + word-progress tracking (smooth reveal) */
  useEffect(() => {
    if (!playerReady || lyrics.length === 0) return
    let raf
    const tick = () => {
      raf = requestAnimationFrame(tick)

      const time = clockRef.current.now()
      if (time == null) return

      // While a click-seek is in flight, hold the clicked line until playback
      // has actually reached it. Resuming earlier would let a keyframe-snapped
      // getCurrentTime() bounce the highlight back to the previous line.
      if (seekingRef.current) {
        if (time >= seekTargetRef.current - 0.05) {
          seekingRef.current = false
          clearTimeout(seekTimerRef.current)
          // fall through and resolve the line normally this same frame
        } else {
          return
        }
      }

      // Shift the player clock into "lyric time": the global output-latency
      // constant plus a per-song calibration line the words up with whatever
      // YouTube upload we ended up playing.
      const lyricTime = time - OUTPUT_LATENCY_OFFSET - offsetRef.current

      let idx = -1
      for (let i = lyrics.length - 1; i >= 0; i--) {
        if (lyricTime >= lyrics[i].time) { idx = i; break }
      }
      setCurrentLine(idx) // React bails out when unchanged

      // Word-wipe: write a single --wipe (0..1 across the whole active line)
      // straight onto its DOM node. The CSS .wipe-word rule turns that into a
      // per-word gradient via calc(), so there's no React re-render per frame.
      const node = activeNodeRef.current
      if (node) {
        if (idx >= 0) {
          const lineStart = lyrics[idx].time
          const lineEnd = idx < lyrics.length - 1 ? lyrics[idx + 1].time : lineStart + 5
          const raw = Math.max(0, Math.min(1, (lyricTime - lineStart) / (lineEnd - lineStart)))
          node.style.setProperty('--wipe', raw.toFixed(4))
        } else {
          node.style.setProperty('--wipe', '0')
        }
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playerReady, lyrics])

  /* spring auto-scroll: animate the container's scrollTop so the active line
     sits at ~40% height (Apple-Music-like, a touch above center). A critically
     damped-ish spring (stiffness 170, damping 26) settles smoothly; a new
     target mid-flight just re-aims the same spring. Paused for ~3s after any
     manual wheel/touch scroll so we don't fight the user. Also caches the
     active line's DOM node for the rAF word-wipe writer. */
  useEffect(() => {
    if (currentLine < 0) { activeNodeRef.current = null; return }
    const container = scrollRef.current
    const node = lineRefs.current[currentLine]
    activeNodeRef.current = node || null
    if (!container || !node) return
    if (performance.now() < scrollPausedUntilRef.current) return

    const target = node.offsetTop - container.clientHeight * 0.4 + node.clientHeight / 2
    const max = container.scrollHeight - container.clientHeight
    const dest = Math.max(0, Math.min(max, target))

    if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current)

    const stiffness = 170, damping = 26, mass = 1
    let pos = container.scrollTop
    let vel = 0
    let last = performance.now()

    const step = (now) => {
      // Clamp dt so a backgrounded tab doesn't fling the spring on resume.
      const dt = Math.min(0.032, (now - last) / 1000)
      last = now
      // Bail if the user grabbed the scroll mid-animation.
      if (performance.now() < scrollPausedUntilRef.current) { scrollAnimRef.current = null; return }
      const force = -stiffness * (pos - dest) - damping * vel
      vel += (force / mass) * dt
      pos += vel * dt
      if (Math.abs(vel) < 0.5 && Math.abs(pos - dest) < 0.5) {
        container.scrollTop = dest
        scrollAnimRef.current = null
        return
      }
      container.scrollTop = pos
      scrollAnimRef.current = requestAnimationFrame(step)
    }
    scrollAnimRef.current = requestAnimationFrame(step)
    return () => { if (scrollAnimRef.current) cancelAnimationFrame(scrollAnimRef.current) }
  }, [currentLine, lyrics])

  /* pause auto-scroll for ~3s whenever the user scrolls by hand */
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const onManual = () => {
      scrollPausedUntilRef.current = performance.now() + 3000
      if (scrollAnimRef.current) { cancelAnimationFrame(scrollAnimRef.current); scrollAnimRef.current = null }
    }
    container.addEventListener('wheel', onManual, { passive: true })
    container.addEventListener('touchmove', onManual, { passive: true })
    return () => {
      container.removeEventListener('wheel', onManual)
      container.removeEventListener('touchmove', onManual)
    }
  }, [])

  /* lock-screen / control-center metadata + play-pause handlers */
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: track.title || '',
        artist: track.artist || '',
        album: 'Luxara',
      })
      navigator.mediaSession.setActionHandler('play', () => playerRef.current?.playVideo?.())
      navigator.mediaSession.setActionHandler('pause', () => playerRef.current?.pauseVideo?.())
    } catch { /* MediaSession unsupported */ }
    return () => {
      try {
        navigator.mediaSession.setActionHandler('play', null)
        navigator.mediaSession.setActionHandler('pause', null)
      } catch { /* noop */ }
    }
  }, [track])

  useEffect(() => {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
    }
  }, [isPlaying])

  const [bounceKey, setBounceKey] = useState(0)
  const togglePlay = useCallback(() => {
    const p = playerRef.current
    if (!p?.playVideo) return
    setBounceKey(k => k + 1) // retrigger the scale-bounce animation
    isPlaying ? p.pauseVideo() : p.playVideo()
  }, [isPlaying])

  const handleLineClick = useCallback((lineIndex, time) => {
    const p = playerRef.current
    if (!p || typeof p.seekTo !== 'function') return

    // Immediately reflect the clicked line in the UI so the layout doesn't
    // jump while waiting for seekTo + getCurrentTime() to agree.
    setCurrentLine(lineIndex)
    // Reset the wipe on whatever node is/was active; the rAF loop repopulates.
    activeNodeRef.current?.style.setProperty('--wipe', '0')
    // An explicit tap is intent to jump there — clear any manual-scroll pause
    // so the spring scrolls the clicked line into view.
    scrollPausedUntilRef.current = 0

    // Seek in player time = lyric time + per-song offset + global latency —
    // the exact inverse of the rAF loop's lyricTime mapping, so a clicked
    // line lands precisely on its own start.
    const target = time + offsetRef.current + OUTPUT_LATENCY_OFFSET

    // Hold the poll until playback actually reaches this timestamp.
    seekingRef.current = true
    seekTargetRef.current = target
    clearTimeout(seekTimerRef.current)
    // Safety net: never suppress forever if the player fails to reach the target.
    seekTimerRef.current = setTimeout(() => { seekingRef.current = false }, 2500)

    p.seekTo(target, true)
    // Throw away the interpolation anchor — the next raw sample (at the
    // post-seek position) is trusted unconditionally instead of being
    // mistaken for wobble.
    clockRef.current.resync()

    // A single playVideo() right after seekTo() is often swallowed while the
    // player is buffering/cued — so kick it again shortly after to make sure
    // playback actually starts.
    const play = () => { try { p.playVideo?.() } catch { /* not ready */ } }
    play()
    setTimeout(play, 150)
  }, [])

  const setLineRef = useCallback((el, i) => { lineRefs.current[i] = el }, [])

  return (
    <div className="absolute inset-0 overflow-hidden bg-black flex flex-col">
      {/* ambient blobs */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/4 -left-1/4 w-3/4 h-3/4 rounded-full bg-purple-500/30 blur-[120px] animate-float1" />
        <div className="absolute -bottom-1/4 -right-1/4 w-3/4 h-3/4 rounded-full bg-blue-500/30 blur-[120px] animate-float2" />
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-1/2 h-1/2 rounded-full bg-teal-500/25 blur-[120px] animate-float3" />
        <div className="absolute inset-0 z-10 bg-black/40 backdrop-blur-[60px]" />
      </div>

      {/* hidden YouTube audio engine */}
      <div id="youtube-player" className="absolute w-px h-px opacity-0 pointer-events-none -z-50" />

      {/* loading overlay */}
      {!isReady && !error && (
        <div className="absolute inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-black/60 backdrop-blur-2xl">
          <div className="w-10 h-10 border-2 border-white/20 border-t-white/80 rounded-full animate-spin" />
          <p className="text-white/40 text-sm font-medium tracking-wide">
            {!activeVideoId ? 'Locating audio…' : 'Loading…'}
          </p>
        </div>
      )}

      {/* header: back + now-playing info */}
      <div className="relative z-30 flex-shrink-0 pt-[calc(0.875rem+env(safe-area-inset-top))] px-4 pb-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-full bg-white/10 backdrop-blur-xl border border-white/15 hover:bg-white/20 active:bg-white/30 transition-all cursor-pointer text-white/70 hover:text-white"
            aria-label="Back"
          >
            <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5">
              <polyline points="15,5 9,12 15,19" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          <div className="flex-1 min-w-0 text-center pr-10">
            <p className="text-white font-semibold text-[0.95rem] leading-tight truncate">{track.title}</p>
            <p className="text-white/45 text-xs leading-tight mt-0.5 truncate">{track.artist}</p>
          </div>
        </div>
      </div>

      {/* lyrics */}
      <div
        ref={scrollRef}
        className="relative z-20 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
        style={{
          maskImage: 'linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 8%, black 92%, transparent 100%)',
        }}
      >
        {/* block layout (not flex) so Safari can't stretch children past the container width */}
        <div className="w-full px-5 pt-6 pb-[50vh] space-y-7">
          {error && <p className="text-white/30 text-2xl font-bold">{error}</p>}

          {!error && lyrics.length === 0 && (
            <div className="space-y-6 pt-2">
              {[68, 48, 62, 44, 76, 52, 66, 40].map((w, i) => (
                <div key={i} className="h-6 rounded-full animate-shimmer" style={{ width: `${w}%` }} />
              ))}
            </div>
          )}

          {/* instrumental intro — pulsing dots before the first line lands */}
          {!error && lyrics.length > 0 && currentLine < 0 && isPlaying && (
            <div className="pt-2 animate-fade-in-up">
              <GapDots progress={0.7} />
            </div>
          )}

          {lyrics.map((line, i) => {
            const dist = i - currentLine
            const isCurrent = i === currentLine
            const absDist = Math.abs(dist)
            const isPast = dist < 0

            let colorClass
            if (currentLine < 0) {
              colorClass = 'text-white/30'
            } else if (isCurrent) {
              colorClass = ''
            } else if (absDist === 1) {
              colorClass = isPast ? 'text-white/55' : 'text-white/35'
            } else if (absDist === 2) {
              colorClass = isPast ? 'text-white/38' : 'text-white/22'
            } else {
              colorClass = isPast ? 'text-white/22' : 'text-white/12'
            }

            // Distant lines blur for depth (0 when no line is active yet).
            const blurPx = !isCurrent && currentLine >= 0
              ? (absDist >= 4 ? 2 : absDist === 3 ? 1 : 0)
              : 0

            return (
              <LyricLine
                key={i}
                index={i}
                time={line.time}
                text={line.text}
                isCurrent={isCurrent}
                colorClass={colorClass}
                blurPx={blurPx}
                onSelect={handleLineClick}
                refCb={setLineRef}
              />
            )
          })}
        </div>
      </div>

      {/* sync calibration + play / pause */}
      <footer className="relative z-30 flex-shrink-0 flex flex-col items-center gap-3 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-3">
        {isReady && lyrics.length > 1 && !error && (
          <div className="flex items-center gap-1 text-white/60 text-xs font-medium">
            <button
              onClick={() => adjustOffset(-0.3)}
              className="w-8 h-8 rounded-full bg-white/8 hover:bg-white/15 active:bg-white/25 flex items-center justify-center transition-colors cursor-pointer text-base leading-none"
              aria-label="Lyrics earlier"
            >−</button>
            <button
              onClick={() => adjustOffset(0)}
              className="min-w-[5.5rem] px-2 py-1.5 rounded-full hover:bg-white/8 active:bg-white/15 transition-colors cursor-pointer tabular-nums"
              aria-label="Reset lyric sync"
              title="Tap to reset"
            >
              {syncOffset !== 0
                ? `Sync ${syncOffset > 0 ? '+' : ''}${syncOffset.toFixed(1)}s`
                : inSync ? 'In sync' : 'Sync'}
            </button>
            <button
              onClick={() => adjustOffset(0.3)}
              className="w-8 h-8 rounded-full bg-white/8 hover:bg-white/15 active:bg-white/25 flex items-center justify-center transition-colors cursor-pointer text-base leading-none"
              aria-label="Lyrics later"
            >+</button>
          </div>
        )}

        <button
          onClick={togglePlay}
          className="w-[3.75rem] h-[3.75rem] rounded-full bg-white/12 backdrop-blur-xl border border-white/20 flex items-center justify-center text-white hover:bg-white/20 active:bg-white/30 transition-all active:scale-90 cursor-pointer"
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? (
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7">
              <rect x="6" y="4" width="4" height="16" rx="1.5" />
              <rect x="14" y="4" width="4" height="16" rx="1.5" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-7 h-7 ml-0.5">
              <polygon points="6,4 20,12 6,20" />
            </svg>
          )}
        </button>
      </footer>
    </div>
  )
}
