import { useState, useEffect, useRef, useCallback, Fragment, memo } from 'react'

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

function cacheKey(artist, title) {
  return `lyrics:${String(artist).toLowerCase()}:${String(title).toLowerCase()}`
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

function loadFromCache(artist, title) {
  try {
    const data = localStorage.getItem(cacheKey(artist, title))
    return data ? JSON.parse(data) : null
  } catch {
    return null
  }
}

function saveToCache(artist, title, lyrics) {
  try {
    localStorage.setItem(cacheKey(artist, title), JSON.stringify(lyrics))
  } catch { /* storage full */ }
}

// Resolved YouTube video IDs, cached like the lyrics so a revisit skips the
// instance round-trip entirely.
function videoKey(artist, title) {
  return `video:${String(artist).toLowerCase()}|${String(title).toLowerCase()}`
}

function loadVideoId(artist, title) {
  try { return localStorage.getItem(videoKey(artist, title)) } catch { return null }
}

function saveVideoId(artist, title, videoId) {
  try { localStorage.setItem(videoKey(artist, title), videoId) } catch { /* storage full */ }
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
  const res = await fetch(`https://${host}/api/v1/search?q=${encodeURIComponent(query)}&type=video&fields=videoId,author,title,description`, { signal })
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

async function pipedSearch(host, query, signal) {
  const res = await fetch(`https://${host}/search?q=${encodeURIComponent(query)}&filter=videos`, { signal })
  if (!res.ok) return []
  const data = await res.json()
  return (data?.items || []).map(i => ({
    videoId: (i?.url?.match(/[?&]v=([a-zA-Z0-9_-]{11})/) || [])[1],
    author: i?.uploaderName,
    title: i?.title,
    description: i?.shortDescription,
  }))
}

/* Official "<Artist> - Topic" / Art Track uploads use the studio master with
   no music-video intro, so they line up with LRCLIB's timing far better than
   fan uploads or official videos. Prefer them whenever one is in the results. */
const OFFICIAL_UPLOAD_RE = /-\s*topic|art track|provided to youtube/i

function rankVideoCandidates(candidates, artist) {
  const artistLc = String(artist || '').toLowerCase()
  let best = null
  let bestScore = -1
  for (const c of candidates) {
    if (!c?.videoId) continue
    const author = String(c.author || '')
    let score = 0
    if (OFFICIAL_UPLOAD_RE.test(`${author} ${c.description || ''}`)) score += 4
    if (artistLc && author.toLowerCase().includes(artistLc)) score += 2
    // Strict > keeps the earliest (highest search-ranked) result on ties.
    if (score > bestScore) { best = c; bestScore = score }
  }
  return best?.videoId ?? null
}

async function scrapeYoutubeVideoId(query, artist) {
  const attempts = VIDEO_SOURCES.map(src => (async () => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), VIDEO_FETCH_TIMEOUT)
    try {
      const candidates = src.type === 'piped'
        ? await pipedSearch(src.host, query, ctrl.signal)
        : await invidiousSearch(src.host, query, ctrl.signal)
      const id = rankVideoCandidates(candidates, artist)
      if (!id) throw new Error('no result')
      return id
    } finally {
      clearTimeout(timer)
    }
  })())
  try {
    return await Promise.any(attempts)
  } catch {
    return null // every instance failed or returned nothing
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

/* One lyric line. Memoized so that when only `wordProgress` ticks each frame,
   just the active line re-renders — the rest of the list is skipped entirely.

   Active line = Apple-Music-style per-word gradient wipe: each word fills
   left→right with a soft feathered edge and a glow at the leading word. */
const LyricLine = memo(function LyricLine({ index, time, text, isCurrent, colorClass, wordProgress, blurPx, onSelect, refCb }) {
  const isGap = isCurrent && text.trim() === ''
  return (
    <p
      ref={el => refCb(el, index)}
      onClick={() => onSelect(index, time)}
      className={[
        'select-none cursor-pointer',
        'font-extrabold leading-snug',
        'transition-[color,opacity,font-size,filter] duration-500 ease-out',
        isCurrent ? 'text-[1.85rem] animate-line-pop' : 'text-[1.4rem]',
        colorClass,
        'active:opacity-50',
      ].join(' ')}
      style={{
        // Inline styles win over all Tailwind/class specificity and
        // are the only reliable way to force wrapping on iOS Safari.
        display: 'block',
        width: '100%',
        wordBreak: 'break-word',
        overflowWrap: 'break-word',
        whiteSpace: 'normal',
        textAlign: 'left',
        // Depth: distant lines blur slightly, like Apple Music.
        filter: blurPx ? `blur(${blurPx}px)` : undefined,
      }}
    >
      {isGap ? (
        <GapDots progress={wordProgress} />
      ) : isCurrent ? (
        text.split(' ').map((word, j, words) => {
          const start = j / words.length
          const end = (j + 1) / words.length
          const local = Math.max(0, Math.min(1, (wordProgress - start) / (end - start)))

          let style
          if (local <= 0) {
            style = { color: DIM_WORD }
          } else if (local >= 1) {
            style = { color: '#fff' }
          } else {
            // Feathered gradient edge = soft wipe instead of a hard color flip.
            const pct = local * 100
            const a = Math.max(0, pct - 9)
            const b = Math.min(100, pct + 9)
            style = {
              backgroundImage: `linear-gradient(90deg, #fff ${a}%, ${DIM_WORD} ${b}%)`,
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              color: 'transparent',
              filter: 'drop-shadow(0 0 14px rgba(255,255,255,0.45))',
            }
          }
          return (
            <Fragment key={j}>
              <span style={style}>{word}</span>
              {/* space lives outside the span so iOS Safari keeps a
                  line-break opportunity between words (prevents the
                  enlarged active line from overflowing off-screen) */}
              {j < words.length - 1 ? ' ' : ''}
            </Fragment>
          )
        })
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
  const [wordProgress, setWordProgress] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playerReady, setPlayerReady] = useState(false)
  const [error, setError] = useState(null)
  // Lyric timing offset in seconds: how much later (+) the words appear vs. the
  // player clock, to reconcile a YouTube upload whose intro differs from the
  // studio recording LRCLIB timed the lyrics against.
  const [syncOffset, setSyncOffset] = useState(0)

  const playerRef = useRef(null)
  const lineRefs = useRef([])
  const scrollRef = useRef(null)
  const mountedRef = useRef(true)
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

  const isReady = activeVideoId && playerReady && !error

  useEffect(() => {
    mountedRef.current = true
    setCurrentLine(-1)
    setWordProgress(0)
    lineRefs.current = []
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    return () => {
      mountedRef.current = false
      clearTimeout(seekTimerRef.current)
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

  /* resolve videoId */
  useEffect(() => {
    setActiveVideoId(null)
    setError(null)
    if (track.videoId) { setActiveVideoId(track.videoId); return }
    if (!track.artist && !track.title) return

    const cached = loadVideoId(track.artist, track.title)
    if (cached) { setActiveVideoId(cached); return }

    let cancelled = false
    // "topic" biases results toward official "<Artist> - Topic" art tracks,
    // which use the studio master and match LRCLIB's timing.
    const q = `${track.artist} ${track.title} topic`
    const attempt = async (retriesLeft) => {
      const id = await scrapeYoutubeVideoId(q, track.artist)
      if (cancelled) return
      if (id) { saveVideoId(track.artist, track.title, id); setActiveVideoId(id); return }
      if (retriesLeft > 0) {
        await new Promise(r => setTimeout(r, 1500))
        if (cancelled) return
        return attempt(retriesLeft - 1)
      }
      setError('No audio stream found')
    }
    attempt(2)
    return () => { cancelled = true }
  }, [track.videoId, track.artist, track.title])

  /* lyrics: cache → syncedLyrics → LRCLIB */
  useEffect(() => {
    setLyrics([])
    const cached = loadFromCache(track.artist, track.title)
    if (cached) { setLyrics(cached); return }

    if (track.syncedLyrics) {
      const parsed = parseLrc(track.syncedLyrics)
      if (parsed.length > 0) { setLyrics(parsed); saveToCache(track.artist, track.title, parsed); return }
      setLyrics(LYRICS_FALLBACK); return
    }
    if (!track.searchQuery) { setLyrics(LYRICS_FALLBACK); return }

    let cancelled = false
    fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(track.searchQuery)}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(data => {
        if (cancelled) return
        const parsed = data?.[0]?.syncedLyrics ? parseLrc(data[0].syncedLyrics) : []
        if (parsed.length === 0) { setLyrics(LYRICS_FALLBACK); return }
        setLyrics(parsed)
        saveToCache(track.artist, track.title, parsed)
      })
      .catch(() => {
        if (cancelled) return
        setLyrics(loadFromCache(track.artist, track.title) || LYRICS_FALLBACK)
      })
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

      if (idx >= 0) {
        const lineStart = lyrics[idx].time
        const lineEnd = idx < lyrics.length - 1 ? lyrics[idx + 1].time : lineStart + 5
        const raw = Math.max(0, Math.min(1, (lyricTime - lineStart) / (lineEnd - lineStart)))
        // Quantize so we don't re-render on imperceptible sub-1% changes.
        setWordProgress(Math.round(raw * 200) / 200)
      } else {
        setWordProgress(0)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playerReady, lyrics])

  /* auto-scroll active line to center */
  useEffect(() => {
    if (currentLine < 0) return
    lineRefs.current[currentLine]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [currentLine])

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

  const togglePlay = useCallback(() => {
    const p = playerRef.current
    if (!p?.playVideo) return
    isPlaying ? p.pauseVideo() : p.playVideo()
  }, [isPlaying])

  const handleLineClick = useCallback((lineIndex, time) => {
    const p = playerRef.current
    if (!p || typeof p.seekTo !== 'function') return

    // Immediately reflect the clicked line in the UI so the layout doesn't
    // jump while waiting for seekTo + getCurrentTime() to agree.
    setCurrentLine(lineIndex)
    setWordProgress(0)

    // Seek in player time = lyric time + the song's calibrated offset.
    const target = time + offsetRef.current

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
                // Only the active line receives live progress; every other line
                // gets the constant 0, keeping its props stable so memo skips it.
                wordProgress={isCurrent ? wordProgress : 0}
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
              {syncOffset === 0 ? 'Sync' : `Sync ${syncOffset > 0 ? '+' : ''}${syncOffset.toFixed(1)}s`}
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
