import { useState, useEffect, useCallback, useRef } from 'react'
import { CURATED_TRACKS } from '../App.jsx'
import { getRecents, gradientFor } from '../lib/recents.js'
import { useArtwork, prefetchArtwork } from '../lib/artwork.js'

const ACCENT = '#fa2d55'
const RECENTS_KEY = 'recents:v1'
const RECENT_SEARCHES_KEY = 'luxara:recentSearches'
const LISTEN_NOW_CACHE_KEY = 'luxara:listenNow'
const CACHE_TTL_MS = 30 * 60 * 1000

function greeting() {
  const h = new Date().getHours()
  if (h < 5) return 'Late Night'
  if (h < 12) return 'Good Morning'
  if (h < 18) return 'Good Afternoon'
  return 'Good Evening'
}

/* ---------------- data ---------------- */

function readListenNowCache() {
  try {
    const raw = sessionStorage.getItem(LISTEN_NOW_CACHE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    if (!p?.ts || Date.now() - p.ts > CACHE_TTL_MS) return null
    if (!Array.isArray(p.topSongs) || !Array.isArray(p.topPicks)) return null
    return p
  } catch {
    return null
  }
}

function parseRssEntry(e) {
  const imgs = e?.['im:image']
  const rawArt = Array.isArray(imgs) ? (imgs[2]?.label || imgs[imgs.length - 1]?.label || '') : ''
  const art = rawArt ? rawArt.replace('100x100bb', '600x600bb').replace('100x100', '600x600bb') : ''
  return {
    trackId: e?.id?.attributes?.['im:id'] || e?.id?.label || '',
    title: e?.['im:name']?.label || 'Unknown',
    artist: e?.['im:artist']?.label || 'Unknown',
    art,
  }
}

function useListenNowData() {
  const [topSongs, setTopSongs] = useState(() => readListenNowCache()?.topSongs || [])
  const [topPicks, setTopPicks] = useState(() => readListenNowCache()?.topPicks || [])
  const [isLoadingTop, setIsLoadingTop] = useState(() => !readListenNowCache())
  const [isLoadingPicks, setIsLoadingPicks] = useState(() => !readListenNowCache())

  useEffect(() => {
    if (readListenNowCache()) return // state already initialized from cache above
    let cancelled = false
    Promise.allSettled([
      fetch('https://itunes.apple.com/us/rss/topsongs/limit=20/json').then(r => { if (!r.ok) throw new Error(); return r.json() }),
      fetch('https://itunes.apple.com/search?term=top+hits+2024&media=music&entity=song&limit=10').then(r => { if (!r.ok) throw new Error(); return r.json() }),
    ]).then(([rss, picks]) => {
      if (cancelled) return
      let songs = []
      let picksArr = []
      if (rss.status === 'fulfilled') {
        const entries = rss.value?.feed?.entry
        if (Array.isArray(entries)) songs = entries.map(parseRssEntry).filter(t => t.title && t.title !== 'Unknown')
      }
      if (picks.status === 'fulfilled') {
        const results = picks.value?.results
        if (Array.isArray(results)) {
          picksArr = results.filter(h => h?.trackName && h?.artistName).map(h => ({
            trackId: h.trackId ?? `${h.artistName}-${h.trackName}`,
            title: h.trackName,
            artist: h.artistName,
            art: h?.artworkUrl100 ? h.artworkUrl100.replace('100x100bb', '600x600bb') : '',
            trackTimeMillis: h.trackTimeMillis || null,
          }))
        }
      }
      setTopSongs(songs)
      setTopPicks(picksArr)
      setIsLoadingTop(false)
      setIsLoadingPicks(false)
      try {
        sessionStorage.setItem(LISTEN_NOW_CACHE_KEY, JSON.stringify({ ts: Date.now(), topSongs: songs, topPicks: picksArr }))
      } catch { /* storage full */ }
    })
    return () => { cancelled = true }
  }, [])

  return { topSongs, topPicks, isLoadingTop, isLoadingPicks }
}

function trackFor(t, prefix) {
  const title = t.title || t.trackName || 'Unknown'
  const artist = t.artist || t.artistName || 'Unknown'
  return {
    id: `${prefix}-${t.trackId || t.id || `${artist}-${title}`}`,
    title,
    artist,
    searchQuery: `${artist} ${title}`,
    syncedLyrics: t.syncedLyrics || null,
    gradient: gradientFor(`${title} ${artist}`),
    videoId: null,
    itunesDurationMs: t.trackTimeMillis || null,
  }
}

/* ---------------- artwork ---------------- */

/* Album cover with a gradient fallback while art loads or on a miss. The
   gradient box is always rendered underneath, so there's no layout shift and
   no empty flash — the image crossfades in on top when it resolves. */
function Cover({ artist, title, fallbackArt, gradient, rounded = 'rounded-2xl', className = '', children, imgRef }) {
  const hookVal = useArtwork(artist, title)
  const hookUrl = Array.isArray(hookVal) ? hookVal[0] : hookVal
  const hookSet = Array.isArray(hookVal) ? hookVal[1] : null
  const resolved = hookUrl || fallbackArt || null
  const [failedUrl, setFailedUrl] = useState(null)
  const [loadedUrl, setLoadedUrl] = useState(null)
  const [retrySrc, setRetrySrc] = useState(null)
  const [retryFor, setRetryFor] = useState(null)
  const retriedRef = useRef(false)
  const timerRef = useRef(null)
  // A new URL re-arms the one-shot retry; stale retry/failed state is
  // ignored via the retryFor/failedUrl comparisons below, so no reset needed.
  useEffect(() => { retriedRef.current = false }, [resolved])
  const broken = failedUrl != null && failedUrl === resolved
  const retryValid = retrySrc != null && retryFor === resolved
  const src = broken ? null : (retryValid ? retrySrc : resolved)
  const loaded = src != null && loadedUrl === src && !broken
  const grad = gradient || gradientFor(`${title} ${artist}`)
  const clear = () => {
    setFailedUrl(resolved)
    if (typeof hookSet === 'function') { try { hookSet(null) } catch { /* noop */ } }
  }
  const handleError = () => {
    if (!retriedRef.current && resolved) {
      // First failure (often a slow-mobile CDN hiccup): retry once after
      // 1500ms with a cache-buster so the CDN is hit fresh.
      retriedRef.current = true
      clearTimeout(timerRef.current)
      const base = resolved
      timerRef.current = setTimeout(() => {
        setRetryFor(base)
        setRetrySrc(`${base}${base.includes('?') ? '&' : '?'}retry=1`)
      }, 1500)
    } else {
      clearTimeout(timerRef.current)
      clear()
    }
  }
  useEffect(() => () => clearTimeout(timerRef.current), [])
  return (
    <div className={`relative aspect-square w-full overflow-hidden ${rounded} bg-gradient-to-br ${grad} ${className}`}>
      <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
      {src && (
        <img
          ref={imgRef}
          src={src}
          alt=""
          loading="eager"
          decoding="async"
          onError={handleError}
          onLoad={() => setLoadedUrl(src)}
          className={`absolute inset-0 w-full h-full object-cover ${loaded ? 'art-enter' : 'art-hidden'}`}
        />
      )}
      {children}
    </div>
  )
}

/* ---------------- small pieces ---------------- */

function SectionHeader({ title, delay = 0 }) {
  const [flash, setFlash] = useState(false)
  const tap = () => {
    setFlash(true)
    setTimeout(() => setFlash(false), 150)
  }
  return (
    <div
      className="flex items-center justify-between px-4 animate-row-in"
      style={{ animationDelay: `${delay}ms`, opacity: flash ? 0.4 : undefined, transition: 'opacity 150ms' }}
    >
      <p className="text-[0.72rem] font-bold text-white/30 uppercase tracking-[0.14em]">{title}</p>
      <button
        onClick={tap}
        className="text-[0.78rem] font-semibold cursor-pointer"
        style={{ color: ACCENT }}
        aria-label={`See all ${title}`}
      >
        See All
      </button>
    </div>
  )
}

function Skeleton({ className = '', delay = 0 }) {
  return (
    <div
      className={`skeleton-shimmer bg-white/[0.06] ${className}`}
      style={{ animationDelay: `${delay}s` }}
    />
  )
}

function removeRecent(track) {
  try {
    const key = t => `${t.title} ${t.artist}`.toLowerCase()
    const next = getRecents().filter(t => key(t) !== key(track))
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
    return next
  } catch {
    return getRecents()
  }
}

/* ---------------- hero carousel ---------------- */

function HeroCard({ track, active, badge, onPlay, onPress, pressed, imgRef }) {
  return (
    <div
      className="flex-shrink-0 snap-start"
      style={{ width: '88vw', maxWidth: '340px' }}
    >
      <div
        onTouchStart={onPress}
        onMouseDown={onPress}
        onClick={() => onPlay(track)}
        className={`relative aspect-[3/4] rounded-[1.75rem] overflow-hidden shadow-2xl shadow-black/60 cursor-pointer transition-transform ${pressed ? 'duration-100' : 'duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]'}`}
        style={{ transform: pressed ? 'scale(0.96)' : `scale(${active})` }}
      >
        <Cover
          artist={track.artist}
          title={track.title}
          fallbackArt={track.art}
          rounded="rounded-[1.75rem]"
          className="absolute inset-0"
          imgRef={imgRef}
        />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.8) 0%, transparent 55%)' }} />
        <div className="absolute top-4 left-4 px-3 py-1 rounded-full bg-white/15 backdrop-blur-md">
          <span className="text-[0.68rem] font-semibold text-white">{badge}</span>
        </div>
        <div className="absolute bottom-0 left-0 right-0 p-5 flex items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-white font-bold text-[1.15rem] leading-tight truncate">{track.title}</p>
            <p className="text-white/60 font-normal text-[0.85rem] leading-tight truncate mt-1">{track.artist}</p>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onPlay(track) }}
            className="flex-shrink-0 h-11 px-5 rounded-full bg-white text-black flex items-center justify-center active:scale-[0.96] transition-transform cursor-pointer"
            aria-label={`Play ${track.title}`}
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><polygon points="6,4 20,12 6,20" /></svg>
          </button>
        </div>
      </div>
    </div>
  )
}

function HeroCarousel({ songs, onPlay }) {
  const tracks = songs.slice(0, 5)
  const [activeIndex, setActiveIndex] = useState(0)
  const [pressedIndex, setPressedIndex] = useState(-1)
  const scrollRef = useRef(null)
  const pauseRef = useRef(false)
  const resumeTimer = useRef(null)
  const rafRef = useRef(0)
  const heroImgRefs = useRef([])

  useEffect(() => {
    heroImgRefs.current.slice(0, 4).forEach(el => {
      try { el?.setAttribute?.('fetchpriority', 'high') } catch { /* noop */ }
    })
  }, [tracks.length])

  const scrollToIndex = useCallback((i) => {
    const c = scrollRef.current
    if (!c || !c.firstChild) return
    const card = c.children[i]
    if (!card) return
    c.scrollTo({ left: card.offsetLeft - 16, behavior: 'smooth' })
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      if (pauseRef.current || tracks.length === 0) return
      setActiveIndex(prev => {
        const next = (prev + 1) % tracks.length
        scrollToIndex(next)
        return next
      })
    }, 4000)
    return () => clearInterval(id)
  }, [tracks.length, scrollToIndex])

  const onScroll = () => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const c = scrollRef.current
      if (!c || !c.children.length) return
      const cardW = c.children[0].offsetWidth + 12
      const i = Math.round((c.scrollLeft) / cardW)
      setActiveIndex(Math.max(0, Math.min(tracks.length - 1, i)))
    })
  }

  const pause = () => {
    pauseRef.current = true
    clearTimeout(resumeTimer.current)
  }
  const resume = () => {
    clearTimeout(resumeTimer.current)
    resumeTimer.current = setTimeout(() => { pauseRef.current = false }, 2000)
  }

  useEffect(() => () => { clearTimeout(resumeTimer.current); cancelAnimationFrame(rafRef.current) }, [])

  if (tracks.length === 0) return null

  return (
    <div className="animate-hero-in">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onTouchStart={pause}
        onTouchEnd={resume}
        className="flex gap-3 overflow-x-auto no-scrollbar snap-x snap-mandatory px-4 pt-2 pb-1"
        style={{ scrollSnapType: 'x mandatory', WebkitOverflowScrolling: 'touch' }}
      >
        {tracks.map((t, i) => {
          const dist = Math.abs(i - activeIndex)
          const scale = dist === 0 ? 1 : dist === 1 ? 0.92 : 0.86
          const opacity = dist === 0 ? 1 : dist === 1 ? 0.55 : 0.3
          return (
            <div key={t.trackId || i} className="transition-all duration-300" style={{ opacity }}>
              <HeroCard
                track={t}
                active={scale}
                badge={i < 2 ? 'New' : 'Featured'}
                onPlay={onPlay}
                pressed={pressedIndex === i}
                onPress={() => setPressedIndex(i)}
                imgRef={el => { heroImgRefs.current[i] = el }}
              />
            </div>
          )
        })}
      </div>
      <div
        onTouchEnd={() => setPressedIndex(-1)}
        onMouseUp={() => setPressedIndex(-1)}
        onMouseLeave={() => setPressedIndex(-1)}
      />
      <div className="flex items-center justify-center gap-1.5 pt-3 pb-1">
        {tracks.map((_, i) => (
          <button
            key={i}
            onClick={() => { setActiveIndex(i); scrollToIndex(i) }}
            aria-label={`Go to card ${i + 1}`}
            className={`rounded-full transition-all duration-300 cursor-pointer ${i === activeIndex ? 'w-5 h-1.5 bg-white' : 'w-1.5 h-1.5 bg-white/30'}`}
          />
        ))}
      </div>
    </div>
  )
}

/* ---------------- recently played ---------------- */

function RecentsRow({ recents, onPlay, onRemoved }) {
  const [menuTrack, setMenuTrack] = useState(null)
  const [menuClosing, setMenuClosing] = useState(false)
  const pressTimer = useRef(null)

  const startPress = (track) => {
    clearTimeout(pressTimer.current)
    pressTimer.current = setTimeout(() => setMenuTrack(track), 400)
  }
  const endPress = () => clearTimeout(pressTimer.current)

  useEffect(() => () => clearTimeout(pressTimer.current), [])

  const closeMenu = () => {
    setMenuClosing(true)
    setTimeout(() => { setMenuTrack(null); setMenuClosing(false) }, 220)
  }

  if (recents.length === 0) return null

  return (
    <div className="animate-row-in" style={{ animationDelay: '120ms' }}>
      <SectionHeader title="Recently Played" delay={60} />
      <div
        className="flex gap-3.5 overflow-x-auto no-scrollbar snap-x snap-mandatory px-4 pt-3 pb-1"
        style={{ scrollSnapType: 'x mandatory', WebkitOverflowScrolling: 'touch' }}
      >
        {recents.map((track, i) => (
          <button
            key={`${track.title}-${track.artist}-${i}`}
            onClick={() => onPlay(trackFor({ title: track.title, artist: track.artist, trackId: track.id }, 'recent'))}
            onTouchStart={() => startPress(track)}
            onTouchEnd={endPress}
            onMouseDown={() => startPress(track)}
            onMouseUp={endPress}
            onMouseLeave={endPress}
            onContextMenu={(e) => { e.preventDefault(); setMenuTrack(track) }}
            className="flex-shrink-0 w-[7.5rem] snap-start text-left active:scale-[0.94] transition-transform duration-200 cursor-pointer"
            style={{ scrollSnapAlign: 'start' }}
          >
            <Cover artist={track.artist} title={track.title} gradient={track.gradient} className="border border-white/10 shadow-lg" />
            <p className="text-white font-semibold text-[0.78rem] leading-tight truncate mt-2 px-0.5">{track.title}</p>
            <p className="text-white/50 font-normal text-[0.68rem] leading-tight truncate mt-0.5 px-0.5">{track.artist}</p>
          </button>
        ))}
      </div>

      {menuTrack && (
        <div className="fixed inset-0 z-[80]">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={closeMenu} />
          <div className={`absolute bottom-0 left-0 right-0 bg-[#1c1c1f] rounded-t-3xl px-5 pt-2 pb-[calc(1.5rem+env(safe-area-inset-bottom))] ${menuClosing ? 'sheet-down' : 'sheet-up'}`}>
            <div className="mx-auto my-2 w-10 h-1 rounded-full bg-white/20" />
            <p className="text-white font-semibold text-[0.95rem] truncate text-center">{menuTrack.title}</p>
            <p className="text-white/50 font-normal text-xs truncate text-center mt-0.5">{menuTrack.artist}</p>
            <button
              onClick={() => { onPlay(trackFor({ title: menuTrack.title, artist: menuTrack.artist, trackId: menuTrack.id }, 'recent')); closeMenu() }}
              className="w-full mt-4 py-3 rounded-2xl bg-white text-black font-semibold text-[0.9rem] active:scale-[0.96] transition-transform cursor-pointer"
            >
              Play
            </button>
            <button
              onClick={() => { onRemoved(removeRecent(menuTrack)); closeMenu() }}
              className="w-full mt-2 py-3 rounded-2xl bg-white/10 text-[#fa2d55] font-semibold text-[0.9rem] active:scale-[0.96] transition-transform cursor-pointer"
            >
              Remove from Recents
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------------- top picks ---------------- */

function TopPicksRow({ picks, isLoading, onPlay }) {
  return (
    <div className="animate-row-in" style={{ animationDelay: '220ms' }}>
      <SectionHeader title="Top Picks" delay={110} />
      <div
        className="flex gap-4 overflow-x-auto no-scrollbar snap-x snap-mandatory px-4 pt-3 pb-1"
        style={{ scrollSnapType: 'x mandatory', WebkitOverflowScrolling: 'touch' }}
      >
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex-shrink-0 w-[10rem] snap-start">
              <Skeleton className="aspect-square rounded-2xl" delay={i * 0.15} />
              <Skeleton className="h-3 rounded-full mt-2 w-4/5" delay={i * 0.15} />
              <Skeleton className="h-3 rounded-full mt-1.5 w-3/5" delay={i * 0.15} />
            </div>
          ))
        ) : (
          picks.map((t, i) => (
            <button
              key={t.trackId || i}
              onClick={() => onPlay(trackFor(t, 'pick'))}
              className="flex-shrink-0 w-[10rem] snap-start text-left active:scale-[0.96] transition-transform duration-200 cursor-pointer"
              style={{ scrollSnapAlign: 'start' }}
            >
              <Cover artist={t.artist} title={t.title} fallbackArt={t.art} className="shadow-lg shadow-black/40" />
              <p className="text-white font-semibold text-[0.82rem] leading-tight truncate mt-2 px-0.5">{t.title}</p>
              <p className="text-white/50 font-normal text-[0.72rem] leading-tight truncate mt-0.5 px-0.5">{t.artist}</p>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

/* ---------------- made for you ---------------- */

const MOODS = [
  { label: 'Chill Vibes', query: 'chill acoustic vibes', gradient: 'from-teal-400 to-cyan-600' },
  { label: 'Energy Boost', query: 'energy workout hits', gradient: 'from-[#fa2d55] to-orange-500' },
  { label: 'Late Night', query: 'late night rnb slow', gradient: 'from-indigo-500 to-purple-800' },
  { label: 'Focus Flow', query: 'focus lofi instrumental', gradient: 'from-sky-400 to-blue-700' },
]

function MadeForYou({ onPlay }) {
  const [loadingMood, setLoadingMood] = useState(null)

  const playMood = useCallback(async (mood) => {
    if (loadingMood) return
    setLoadingMood(mood.label)
    try {
      const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(mood.query)}&media=music&entity=song&limit=1`)
      if (!r.ok) throw new Error()
      const data = await r.json()
      const h = data?.results?.[0]
      if (h?.trackName && h?.artistName) {
        onPlay(trackFor({ title: h.trackName, artist: h.artistName, trackId: h.trackId, trackTimeMillis: h.trackTimeMillis }, 'mood'))
      }
    } catch { /* keep tiles on network error */ }
    finally {
      setLoadingMood(null)
    }
  }, [loadingMood, onPlay])

  return (
    <div className="animate-row-in" style={{ animationDelay: '320ms' }}>
      <SectionHeader title="Made For You" delay={160} />
      <div className="grid grid-cols-2 gap-3.5 px-4 pt-3 pb-1">
        {MOODS.map(m => (
          <button
            key={m.label}
            onClick={() => playMood(m)}
            className="relative aspect-square rounded-[1.4rem] overflow-hidden text-left bg-gradient-to-br active:scale-[0.96] transition-transform duration-200 cursor-pointer"
            style={{ backgroundImage: undefined }}
          >
            <div className={`absolute inset-0 bg-gradient-to-br ${m.gradient}`} />
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(circle at 20% 15%, rgba(255,255,255,0.15), transparent 55%)' }} />
            <div className="absolute inset-0 bg-gradient-to-t from-black/45 to-transparent" />
            <div className="absolute bottom-0 left-0 right-0 p-3.5">
              {loadingMood === m.label ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <p className="text-white font-bold text-[0.95rem] leading-tight">{m.label}</p>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ---------------- hot right now ---------------- */

function HotRow({ songs, isLoading, onPlay }) {
  return (
    <div className="animate-row-in" style={{ animationDelay: '420ms' }}>
      <SectionHeader title="Hot Right Now" delay={210} />
      <div
        className="flex gap-3.5 overflow-x-auto no-scrollbar snap-x snap-mandatory px-4 pt-3 pb-1"
        style={{ scrollSnapType: 'x mandatory', WebkitOverflowScrolling: 'touch' }}
      >
        {isLoading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex-shrink-0 w-[8rem] snap-start">
              <Skeleton className="aspect-square rounded-2xl" delay={i * 0.15} />
              <Skeleton className="h-3 rounded-full mt-2 w-4/5" delay={i * 0.15} />
            </div>
          ))
        ) : (
          songs.map((t, i) => (
            <button
              key={t.trackId || i}
              onClick={() => onPlay(trackFor(t, 'hot'))}
              className="flex-shrink-0 w-[8rem] snap-start text-left active:scale-[0.96] transition-transform duration-200 cursor-pointer"
              style={{ scrollSnapAlign: 'start' }}
            >
              <div className="relative">
                <Cover artist={t.artist} title={t.title} fallbackArt={t.art} className="shadow-lg shadow-black/40" />
                <span className="absolute bottom-1 left-2 text-[2rem] font-black text-white/15 leading-none pointer-events-none">{i + 1}</span>
              </div>
              <p className="text-white font-semibold text-[0.78rem] leading-tight truncate mt-2 px-0.5">{t.title}</p>
              <p className="text-white/50 font-normal text-[0.68rem] leading-tight truncate mt-0.5 px-0.5">{t.artist}</p>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

/* ---------------- mini player ---------------- */

function MiniBar({ track, onOpen, onNext }) {
  const [paused, setPaused] = useState(false)
  if (!track) return null
  return (
    <div className="absolute left-0 right-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 px-4 animate-bar-up">
      <div
        onClick={onOpen}
        className="h-14 mx-0 rounded-2xl bg-white/[0.12] backdrop-blur-xl border border-white/[0.1] flex items-center gap-3 pl-2 pr-1.5 cursor-pointer"
      >
        <div className="w-10 h-10 flex-shrink-0">
          <Cover artist={track.artist} title={track.title} gradient={track.gradient} rounded="rounded-xl" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-white font-semibold text-[0.82rem] leading-tight truncate">{track.title}</p>
          <p className="text-white/50 font-normal text-[0.7rem] leading-tight truncate">{track.artist}</p>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); setPaused(p => !p); onOpen() }}
          className="w-9 h-9 rounded-full flex items-center justify-center text-white active:scale-[0.96] transition-transform cursor-pointer"
          aria-label={paused ? 'Play' : 'Pause'}
        >
          {paused ? (
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 ml-0.5"><polygon points="6,4 20,12 6,20" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><rect x="6" y="4" width="4" height="16" rx="1.5" /><rect x="14" y="4" width="4" height="16" rx="1.5" /></svg>
          )}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onNext() }}
          className="w-9 h-9 rounded-full flex items-center justify-center text-white active:scale-[0.96] transition-transform cursor-pointer"
          aria-label="Next"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5 ml-0.5"><polygon points="5,4 15,12 5,20" /><rect x="16" y="4" width="3" height="16" rx="1" /></svg>
        </button>
      </div>
    </div>
  )
}

/* ---------------- search tab ---------------- */

function loadRecentSearches() {
  try {
    const data = JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY))
    return Array.isArray(data) ? data.slice(0, 8) : []
  } catch {
    return []
  }
}

function SearchTab({ onSelectTrack }) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [isSearching, setIsSearching] = useState(false)
  const [recentSearches, setRecentSearches] = useState(loadRecentSearches)
  const debounceRef = useRef(null)
  const inputRef = useRef(null)
  const reqIdRef = useRef(0)
  const abortRef = useRef(null)

  const doSearch = useCallback(async (q) => {
    const query = q.trim()
    abortRef.current?.abort()
    if (!query) { setSearchResults([]); setIsSearching(false); return }
    const id = ++reqIdRef.current
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setIsSearching(true)
    try {
      const [itunesRes, lrclibRes] = await Promise.allSettled([
        fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=8`, { signal: ctrl.signal }).then(r => { if (!r.ok) throw new Error(); return r.json() }),
        fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, { signal: ctrl.signal }).then(r => { if (!r.ok) throw new Error(); return r.json() }),
      ])
      if (id !== reqIdRef.current) return
      if (ctrl.signal.aborted) return
      const itunesHits = itunesRes.status === 'fulfilled' && Array.isArray(itunesRes.value?.results) ? itunesRes.value.results : []
      const lrclibHits = lrclibRes.status === 'fulfilled' && Array.isArray(lrclibRes.value) ? lrclibRes.value : []
      const norm = s => String(s || '').trim().toLowerCase()
      const findLyrics = (artistName, trackName) => {
        const a = norm(artistName), t = norm(trackName)
        if (!a || !t) return null
        const hit = lrclibHits.find(h => norm(h?.artistName) === a && norm(h?.trackName ?? h?.name) === t)
        return hit?.syncedLyrics || null
      }
      let merged = itunesHits
        .filter(h => h?.trackName && h?.artistName)
        .map(h => ({
          id: h.trackId ?? `${h.artistName}-${h.trackName}`,
          name: h.trackName,
          artistName: h.artistName,
          syncedLyrics: findLyrics(h.artistName, h.trackName),
          trackTimeMillis: h.trackTimeMillis || null,
        }))
      if (merged.length === 0 && lrclibHits.length > 0) {
        merged = lrclibHits.slice(0, 10).map((h, i) => ({
          id: h?.id ?? `lrclib-${i}`,
          name: h?.trackName ?? h?.name ?? 'Unknown',
          artistName: h?.artistName ?? 'Unknown',
          syncedLyrics: h?.syncedLyrics || null,
          trackTimeMillis: null,
        }))
      }
      setSearchResults(merged)
    } catch (e) {
      if (e.name === 'AbortError' || id !== reqIdRef.current) return
      setSearchResults([])
    } finally {
      if (id === reqIdRef.current) setIsSearching(false)
    }
  }, [])

  const saveRecentSearch = useCallback((name, artistName) => {
    setRecentSearches(prev => {
      const key = `${name} ${artistName}`.toLowerCase()
      const next = [{ name, artistName }, ...prev.filter(r => `${r.name} ${r.artistName}`.toLowerCase() !== key)].slice(0, 8)
      try { localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next)) } catch { /* noop */ }
      return next
    })
  }, [])

  const selectSearchResult = useCallback((result) => {
    saveRecentSearch(result.name || 'Unknown', result.artistName || 'Unknown')
    setSearchQuery('')
    setSearchResults([])
    inputRef.current?.blur()
    onSelectTrack({
      id: `search-${result.id || Date.now()}`,
      title: result.name || 'Unknown',
      artist: result.artistName || 'Unknown',
      videoId: null,
      searchQuery: `${result.artistName || 'Unknown'} ${result.name || 'Unknown'}`,
      syncedLyrics: result.syncedLyrics || null,
      itunesDurationMs: result.trackTimeMillis || null,
    })
  }, [saveRecentSearch, onSelectTrack])

  const handleInput = useCallback((e) => {
    const val = e.target.value
    setSearchQuery(val)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(val), 250)
  }, [doSearch])

  const clearSearch = useCallback(() => {
    setSearchQuery('')
    setSearchResults([])
    inputRef.current?.blur()
  }, [])

  const fireRecent = useCallback((r) => {
    const q = `${r.artistName} ${r.name}`
    setSearchQuery(q)
    doSearch(q)
  }, [doSearch])

  const removeRecentSearch = useCallback((r) => {
    setRecentSearches(prev => {
      const key = `${r.name} ${r.artistName}`.toLowerCase()
      const next = prev.filter(x => `${x.name} ${x.artistName}`.toLowerCase() !== key)
      try { localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next)) } catch { /* noop */ }
      return next
    })
  }, [])

  const clearAllRecents = useCallback(() => {
    setRecentSearches([])
    try { localStorage.removeItem(RECENT_SEARCHES_KEY) } catch { /* noop */ }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 100)
    return () => { clearTimeout(t); clearTimeout(debounceRef.current); abortRef.current?.abort() }
  }, [])

  const showDropdown = searchQuery.trim().length > 0

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col px-6 md:px-10 pt-[calc(3.25rem+env(safe-area-inset-top))] pb-[calc(8rem+env(safe-area-inset-bottom))]">
      <p className="text-white/40 text-[0.82rem] font-semibold tracking-wide mb-1">Search</p>
      <h1 className="text-[2rem] font-black tracking-tight leading-none bg-gradient-to-br from-white via-white to-white/55 bg-clip-text text-transparent">
        Find Music
      </h1>
      <div className="relative max-w-2xl mt-4">
        <div className="flex items-center gap-3 bg-white/[0.07] border border-white/[0.09] rounded-2xl px-5 py-3.5 transition-all duration-200 focus-within:bg-white/[0.11] focus-within:border-white/25">
          {isSearching ? (
            <div className="w-4 h-4 border-[1.5px] border-white/20 border-t-white/60 rounded-full animate-spin flex-shrink-0" />
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-4 h-4 text-white/35 flex-shrink-0">
              <circle cx="11" cy="11" r="7" strokeWidth="2" />
              <path d="M16.5 16.5L21 21" strokeWidth="2" strokeLinecap="round" />
            </svg>
          )}
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={handleInput}
            placeholder="Songs, artists, lyrics…"
            className="flex-1 bg-transparent text-white placeholder-white/25 text-[0.93rem] outline-none"
          />
          {searchQuery && (
            <button onClick={clearSearch} className="text-white/25 hover:text-white/50 transition-colors cursor-pointer p-0.5">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {showDropdown && (
          <div className="mt-2 bg-[#1c1c1f]/95 backdrop-blur-2xl border border-white/10 rounded-2xl overflow-hidden shadow-2xl max-h-80 overflow-y-auto">
            {isSearching && searchResults.length === 0 && (
              <div className="flex items-center gap-3 px-5 py-4 text-white/35 text-sm">
                <div className="w-3.5 h-3.5 border-[1.5px] border-white/20 border-t-white/60 rounded-full animate-spin" />
                Searching…
              </div>
            )}
            {!isSearching && searchResults.length === 0 && (
              <div className="px-5 py-5 text-white/30 text-sm text-center">No results found</div>
            )}
            {searchResults.map((r, i) => (
              <button
                key={r.id || i}
                onClick={() => selectSearchResult(r)}
                className="w-full text-left flex items-center gap-3.5 px-4 py-2.5 border-b border-white/[0.05] last:border-0 hover:bg-white/[0.07] active:bg-white/10 transition-colors cursor-pointer"
              >
                <div className="w-10 h-10 flex-shrink-0">
                  <Cover artist={r.artistName} title={r.name} rounded="rounded-lg" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[0.875rem] font-semibold text-white truncate leading-tight">{r.name}</p>
                  <p className="text-xs text-white/40 truncate leading-tight mt-0.5">{r.artistName}</p>
                </div>
                {r.syncedLyrics && (
                  <span className="flex-shrink-0 text-[0.6rem] font-semibold text-white/30 uppercase tracking-wider">Lyrics</span>
                )}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-4 h-4 text-white/25 flex-shrink-0">
                  <polyline points="9,6 15,12 9,18" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ))}
          </div>
        )}
      </div>

      {!showDropdown && recentSearches.length > 0 && (
        <div className="max-w-2xl mt-6">
          <div className="flex items-center justify-between pb-3">
            <p className="text-[0.72rem] font-bold text-white/30 uppercase tracking-[0.14em]">Recent Searches</p>
            <button onClick={clearAllRecents} className="text-[0.78rem] font-semibold cursor-pointer active:opacity-40 transition-opacity" style={{ color: ACCENT }}>
              Clear All
            </button>
          </div>
          <div className="bg-white/[0.04] border border-white/[0.07] rounded-2xl overflow-hidden">
            {recentSearches.map((r, i) => (
              <div key={`${r.name}-${r.artistName}-${i}`} className="w-full flex items-center gap-3.5 px-4 py-2.5 border-b border-white/[0.05] last:border-0">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-4 h-4 text-white/30 flex-shrink-0">
                  <circle cx="12" cy="12" r="8" strokeWidth="2" />
                  <path d="M12 7v5l3 2" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <button onClick={() => fireRecent(r)} className="min-w-0 flex-1 text-left cursor-pointer">
                  <p className="text-[0.875rem] font-semibold text-white truncate leading-tight">{r.name}</p>
                  <p className="text-xs text-white/40 truncate leading-tight mt-0.5">{r.artistName}</p>
                </button>
                <button onClick={() => removeRecentSearch(r)} className="text-white/25 hover:text-white/60 transition-colors cursor-pointer p-1" aria-label="Remove search">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* ---------------- bottom nav ---------------- */

const NAV_ITEMS = [
  {
    id: 'listen',
    label: 'Listen Now',
    icon: (active) => (
      <svg viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" className="w-6 h-6">
        <path d="M3 10.5 12 3l9 7.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5 9.5V21h14V9.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'search',
    label: 'Search',
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6">
        <circle cx="11" cy="11" r="7" />
        <path d="M16.5 16.5 21 21" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'library',
    label: 'Library',
    icon: () => (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-6 h-6">
        <path d="M4 19V6a2 2 0 0 1 2-2h13v13H6a2 2 0 0 0-2 2Zm0 0a2 2 0 0 0 2 2h13" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
]

function BottomNav({ tab, onSwitch, bounceId }) {
  return (
    <nav className="absolute bottom-0 left-0 right-0 z-50 backdrop-blur-xl bg-black/60 border-t border-white/[0.07] pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-stretch justify-around pt-2 pb-1.5">
        {NAV_ITEMS.map(item => {
          const active = tab === item.id
          return (
            <button
              key={item.id}
              onClick={() => onSwitch(item.id)}
              className="flex-1 flex flex-col items-center gap-1 pt-1 cursor-pointer"
              aria-label={item.label}
            >
              <span className={active ? 'text-white' : 'text-white/35'}>
                <span key={bounceId[item.id] || 0} className={bounceId[item.id] ? 'nav-bounce' : 'block'}>
                  {item.icon(active)}
                </span>
              </span>
              <span className={`text-[0.62rem] font-semibold ${active ? 'text-white' : 'text-white/35'}`}>{item.label}</span>
              <span className={`w-1 h-1 rounded-full ${active ? '' : 'bg-transparent'}`} style={active ? { background: ACCENT } : undefined} />
            </button>
          )
        })}
      </div>
    </nav>
  )
}

/* ---------------- home ---------------- */

export default function HomeScreen({ onSelectTrack, activeTrack }) {
  const [tab, setTab] = useState('listen')
  const [bounceId, setBounceId] = useState({})
  const [recents, setRecents] = useState(getRecents)
  const { topSongs, topPicks, isLoadingTop, isLoadingPicks } = useListenNowData()
  const scrollRef = useRef(null)
  const headerRef = useRef(null)

  const playTrack = useCallback((track) => {
    setRecents(getRecents())
    onSelectTrack(track)
  }, [onSelectTrack])

  const playHero = useCallback((t) => playTrack(trackFor(t, 'hero')), [playTrack])
  const openMini = useCallback(() => { if (activeTrack) onSelectTrack(activeTrack) }, [activeTrack, onSelectTrack])
  const playNext = useCallback(() => {
    if (topSongs.length === 0) return
    playTrack(trackFor(topSongs[0], 'hot'))
  }, [topSongs, playTrack])

  const switchTab = useCallback((id) => {
    setTab(id)
    setBounceId(prev => ({ ...prev, [id]: (prev[id] || 0) + 1 }))
    setTimeout(() => setBounceId(prev => ({ ...prev, [id]: 0 })), 350)
    if (id === 'listen') setRecents(getRecents())
  }, [])

  const onScrollListen = useCallback(() => {
    const c = scrollRef.current
    const h = headerRef.current
    if (!c || !h) return
    const op = Math.max(0, 1 - c.scrollTop / 80)
    h.style.setProperty('--header-opacity', op.toFixed(3))
  }, [])

  /* Warm the iTunes metadata cache for the featured tracks on first mount,
     so tapping one finds art + duration instantly. */
  useEffect(() => { void prefetchArtwork(CURATED_TRACKS) }, [])

  /* Warm the browser cache once rows have loaded so artwork is instant later. */
  const prefetched = useRef(false)
  useEffect(() => {
    if (prefetched.current || isLoadingTop || isLoadingPicks) return
    prefetched.current = true
    const urls = [...topSongs.map(t => t.art), ...topPicks.map(t => t.art)].filter(Boolean)
    urls.forEach(u => { try { const im = new Image(); im.src = u } catch { /* noop */ } })
  }, [isLoadingTop, isLoadingPicks, topSongs, topPicks])

  return (
    <div className="absolute inset-0 overflow-hidden flex flex-col text-white bg-gradient-to-b from-[#131316] via-[#0b0b0d] to-[#050506]">
      <style>{`
        @keyframes heroIn { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes rowIn { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
        @keyframes navBounce { 0% { transform: scale(1); } 30% { transform: scale(0.85); } 60% { transform: scale(1.1); } 100% { transform: scale(1); } }
        @keyframes sheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
        @keyframes sheetDown { from { transform: translateY(0); } to { transform: translateY(100%); } }
        @keyframes barUp { from { transform: translateY(64px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes artIn { from { opacity: 0; filter: blur(8px); transform: scale(1.04); } to { opacity: 1; filter: blur(0); transform: scale(1); } }
        .animate-hero-in { opacity: 0; animation: heroIn 600ms cubic-bezier(0.16,1,0.3,1) 0ms forwards; }
        .animate-row-in { opacity: 0; animation: rowIn 600ms cubic-bezier(0.16,1,0.3,1) forwards; }
        .skeleton-shimmer { background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.04) 50%, transparent 100%); background-size: 200% 100%; animation: shimmer 1.4s ease-in-out infinite; }
        .nav-bounce { display: block; animation: navBounce 350ms cubic-bezier(0.34,1.56,0.64,1); }
        .sheet-up { animation: sheetUp 300ms cubic-bezier(0.32,0.72,0,1); }
        .sheet-down { animation: sheetDown 220ms cubic-bezier(0.32,0.72,0,1); }
        .animate-bar-up { animation: barUp 350ms cubic-bezier(0.32,0.72,0,1); }
        .art-enter { opacity: 1; filter: blur(0); transform: scale(1); animation: artIn 500ms cubic-bezier(0.16,1,0.3,1); }
        .art-hidden { opacity: 0; filter: blur(8px); transform: scale(1.04); }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>

      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/3 -left-1/4 w-2/3 h-2/3 rounded-full bg-purple-900/15 blur-[120px]" />
        <div className="absolute -bottom-1/3 -right-1/4 w-2/3 h-2/3 rounded-full bg-blue-900/10 blur-[120px]" />
      </div>

      <div className="relative z-10 flex-1 flex flex-col overflow-hidden">
        {tab === 'listen' && (
          <div ref={scrollRef} onScroll={onScrollListen} className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col pb-[calc(8.5rem+env(safe-area-inset-bottom))]">
            <div ref={headerRef} className="flex-shrink-0 pt-[calc(3.25rem+env(safe-area-inset-top))] pb-2 px-4" style={{ opacity: 'var(--header-opacity, 1)' }}>
              <p className="text-white/40 text-[0.82rem] font-semibold tracking-wide mb-1">{greeting()}</p>
              <h1 className="text-[2.6rem] font-black tracking-tight leading-none bg-gradient-to-br from-white via-white to-white/55 bg-clip-text text-transparent">
                Listen Now
              </h1>
            </div>

            <HeroCarousel songs={topSongs} onPlay={playHero} />

            <div className="flex flex-col gap-7 mt-5">
              <RecentsRow recents={recents} onPlay={playTrack} onRemoved={setRecents} />
              <TopPicksRow picks={topPicks} isLoading={isLoadingPicks} onPlay={playTrack} />
              <MadeForYou onPlay={playTrack} />
              <HotRow songs={topSongs} isLoading={isLoadingTop} onPlay={playTrack} />
            </div>
          </div>
        )}

        {tab === 'search' && <SearchTab onSelectTrack={playTrack} />}

        {tab === 'library' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 pb-[calc(8rem+env(safe-area-inset-bottom))]">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-12 h-12 text-white/20">
              <path d="M4 19V6a2 2 0 0 1 2-2h13v13H6a2 2 0 0 0-2 2Zm0 0a2 2 0 0 0 2 2h13" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <p className="text-white/40 font-semibold text-[0.95rem]">Coming soon</p>
            <p className="text-white/25 text-xs">Your library will live here</p>
          </div>
        )}
      </div>

      {tab === 'listen' && activeTrack && (
        <MiniBar track={activeTrack} onOpen={openMini} onNext={playNext} />
      )}

      <BottomNav tab={tab} onSwitch={switchTab} bounceId={bounceId} />
    </div>
  )
}
