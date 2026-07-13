import { useState, useEffect, useCallback, useRef } from 'react'
import { CURATED_TRACKS } from '../App.jsx'
import { getRecents } from '../lib/recents.js'

function greeting() {
  const h = new Date().getHours()
  if (h < 5) return 'Late night'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export default function HomeScreen({ onSelectTrack }) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [isSearching, setIsSearching] = useState(false)
  const [recents] = useState(getRecents)
  const debounceRef = useRef(null)
  const inputRef = useRef(null)
  const searchAreaRef = useRef(null)
  const reqIdRef = useRef(0)
  const abortRef = useRef(null)

  const doSearch = useCallback(async (q) => {
    const query = q.trim()
    // Cancel whatever request is currently in flight — its result is now stale.
    abortRef.current?.abort()
    if (!query) { setSearchResults([]); setIsSearching(false); return }

    const id = ++reqIdRef.current
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setIsSearching(true)
    try {
      const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, { signal: ctrl.signal })
      if (!res.ok) throw new Error()
      const data = await res.json()
      // Ignore this response if a newer search has since been started.
      if (id !== reqIdRef.current) return
      setSearchResults(Array.isArray(data) ? data.slice(0, 10) : [])
    } catch (e) {
      if (e.name === 'AbortError' || id !== reqIdRef.current) return
      setSearchResults([])
    } finally {
      if (id === reqIdRef.current) setIsSearching(false)
    }
  }, [])

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

  useEffect(() => () => { clearTimeout(debounceRef.current); abortRef.current?.abort() }, [])

  const selectSearchResult = useCallback((result) => {
    clearSearch()
    onSelectTrack({
      id: `search-${result.id || Date.now()}`,
      title: result.name || 'Unknown',
      artist: result.artistName || 'Unknown',
      videoId: null,
      searchQuery: `${result.artistName || 'Unknown'} ${result.name || 'Unknown'}`,
      syncedLyrics: result.syncedLyrics || null,
    })
  }, [clearSearch, onSelectTrack])

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (searchAreaRef.current && !searchAreaRef.current.contains(e.target) && searchQuery.trim()) {
        clearSearch()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [searchQuery, clearSearch])

  const showDropdown = searchQuery.trim().length > 0

  return (
    <div className="absolute inset-0 overflow-hidden bg-[#08080a] flex flex-col text-white">
      {/* ambient blobs — fixed layer so they don't scroll */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/3 -left-1/4 w-2/3 h-2/3 rounded-full bg-purple-900/25 blur-[120px] animate-float1" />
        <div className="absolute -bottom-1/3 -right-1/4 w-2/3 h-2/3 rounded-full bg-blue-900/20 blur-[120px] animate-float2" />
        <div className="absolute top-1/4 right-0 w-1/2 h-1/2 rounded-full bg-fuchsia-900/15 blur-[120px] animate-float3" />
      </div>

      {/* scrollable content on top of blobs */}
      <div className="relative z-10 flex-1 overflow-y-auto overflow-x-hidden flex flex-col">

      {/* title */}
      <div className="flex-shrink-0 pt-[calc(3.25rem+env(safe-area-inset-top))] pb-2 px-6 animate-fade-in-up">
        <p className="text-white/40 text-[0.82rem] font-medium tracking-wide mb-1.5">{greeting()}</p>
        <h1 className="relative text-[2.7rem] font-black tracking-tight leading-none w-fit">
          <span className="absolute inset-0 bg-gradient-to-r from-purple-400 to-blue-400 bg-clip-text text-transparent blur-[14px] opacity-50 select-none" aria-hidden="true">
            Luxara
          </span>
          <span className="relative bg-gradient-to-br from-white via-white to-white/55 bg-clip-text text-transparent">
            Luxara
          </span>
        </h1>
        <p className="text-white/35 text-[0.82rem] mt-2 font-medium tracking-wide">Lyrics, everywhere you go</p>
      </div>

      {/* search */}
      <div ref={searchAreaRef} className="relative flex-shrink-0 px-6 py-4">
        <div className="relative max-w-2xl mx-auto">
          <div className="flex items-center gap-3 bg-white/[0.06] border border-white/[0.09] rounded-2xl px-5 py-3.5 transition-all duration-200 focus-within:bg-white/[0.09] focus-within:border-white/20">
            {isSearching ? (
              <div className="w-4 h-4 border-[1.5px] border-white/20 border-t-white/60 rounded-full animate-spin flex-shrink-0" />
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-4 h-4 text-white/30 flex-shrink-0">
                <circle cx="11" cy="11" r="7" strokeWidth="2" />
                <path d="M16.5 16.5L21 21" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={handleInput}
              placeholder="Song or artist…"
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
            <div className="absolute left-0 right-0 mt-2 bg-[#111114]/95 backdrop-blur-2xl border border-white/10 rounded-2xl overflow-hidden shadow-2xl z-[100] max-h-64 overflow-y-auto">
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
                  className="w-full text-left flex items-center gap-3.5 px-5 py-3 border-b border-white/[0.05] last:border-0 hover:bg-white/[0.07] active:bg-white/10 transition-colors cursor-pointer"
                >
                  <div className="w-8 h-8 rounded-lg bg-white/10 flex-shrink-0 flex items-center justify-center">
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5 text-white/40 ml-0.5">
                      <polygon points="6,4 20,12 6,20" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.875rem] font-semibold text-white truncate leading-tight">{r.name}</p>
                    <p className="text-xs text-white/40 truncate leading-tight mt-0.5">{r.artistName}</p>
                  </div>
                  {r.syncedLyrics && (
                    <span className="flex-shrink-0 text-[0.65rem] font-semibold text-white/30 uppercase tracking-wider">Lyrics</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* recently played */}
      {recents.length > 0 && (
        <div className="relative flex-shrink-0 pb-2">
          <p className="text-[0.7rem] font-bold text-white/25 uppercase tracking-[0.12em] pb-3 px-6">Recently played</p>
          <div className="flex gap-3 overflow-x-auto no-scrollbar px-6 pb-1">
            {recents.map((track, i) => (
              <button
                key={`${track.title}-${track.artist}-${i}`}
                onClick={() => onSelectTrack(track)}
                style={{ animationDelay: `${i * 45}ms` }}
                className="group flex-shrink-0 w-[8.5rem] text-left animate-fade-in-up active:scale-[0.96] transition-transform duration-200 cursor-pointer"
              >
                <div className={`relative aspect-square w-full rounded-2xl bg-gradient-to-br ${track.gradient} overflow-hidden border border-white/10 shadow-lg`}>
                  <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 group-active:opacity-100 transition-opacity duration-200">
                    <div className="w-10 h-10 rounded-full bg-black/30 backdrop-blur-md flex items-center justify-center">
                      <svg viewBox="0 0 24 24" fill="white" className="w-4 h-4 ml-0.5 opacity-90"><polygon points="6,4 20,12 6,20" /></svg>
                    </div>
                  </div>
                </div>
                <p className="text-white font-semibold text-[0.78rem] leading-tight truncate mt-2 px-0.5">{track.title}</p>
                <p className="text-white/40 text-[0.68rem] leading-tight truncate mt-0.5 px-0.5">{track.artist}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* curated tracks */}
      <div className="relative flex-1 px-6 pt-2 pb-[calc(2.5rem+env(safe-area-inset-bottom))]">
        <p className="text-[0.7rem] font-bold text-white/25 uppercase tracking-[0.12em] pb-4 px-0.5">Featured</p>
        <div className="grid grid-cols-2 gap-3.5 max-w-2xl mx-auto">
          {CURATED_TRACKS.map((track, i) => (
            <button
              key={track.id}
              onClick={() => onSelectTrack(track)}
              style={{ animationDelay: `${i * 60}ms` }}
              className="group text-left bg-white/[0.05] rounded-[1.25rem] overflow-hidden border border-white/[0.08] shadow-lg shadow-black/30 hover:border-white/20 hover:bg-white/[0.08] hover:-translate-y-1 hover:shadow-xl hover:shadow-black/40 active:scale-[0.97] transition-all duration-200 cursor-pointer animate-fade-in-up"
            >
              {/* artwork area */}
              <div className={`relative aspect-square w-full bg-gradient-to-br ${track.gradient} overflow-hidden`}>
                {/* noise texture overlay */}
                <div className="absolute inset-0 opacity-20"
                  style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 256 256\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'noise\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23noise)\' opacity=\'1\'/%3E%3C/svg%3E")' }}
                />
                {/* inner shadow at bottom */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
                {/* play indicator — sits bottom-right, pops on hover/tap */}
                <div className="absolute bottom-2.5 right-2.5 w-11 h-11 rounded-full bg-white/90 backdrop-blur-md flex items-center justify-center shadow-lg shadow-black/30 translate-y-1 opacity-0 group-hover:translate-y-0 group-hover:opacity-100 group-active:translate-y-0 group-active:opacity-100 transition-all duration-300">
                  <svg viewBox="0 0 24 24" fill="black" className="w-5 h-5 ml-0.5">
                    <polygon points="6,4 20,12 6,20" />
                  </svg>
                </div>
              </div>

              {/* track info */}
              <div className="px-3.5 py-3">
                <p className="text-white font-bold text-[0.82rem] leading-tight truncate">{track.title}</p>
                <p className="text-white/40 text-[0.72rem] leading-tight truncate mt-0.5">{track.artist}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      </div>{/* end scrollable content */}
    </div>
  )
}
