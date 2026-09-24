import { useState, useCallback } from 'react'
import HomeScreen from './components/HomeScreen.jsx'
import PlayerScreen from './components/PlayerScreen.jsx'
import { pushRecent } from './lib/recents.js'

export const CURATED_TRACKS = [
  {
    id: 'billie-jean',
    title: 'Billie Jean',
    artist: 'Michael Jackson',
    searchQuery: 'Billie+Jean+Michael+Jackson',
    gradient: 'from-purple-400 to-pink-400',
  },
  {
    id: 'blinding-lights',
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    searchQuery: 'Blinding+Lights+The+Weeknd',
    gradient: 'from-red-400 to-orange-400',
  },
  {
    id: 'starboy',
    title: 'Starboy',
    artist: 'The Weeknd',
    searchQuery: 'Starboy+The+Weeknd',
    gradient: 'from-teal-400 to-cyan-400',
  },
  {
    id: 'smooth-criminal',
    title: 'Smooth Criminal',
    artist: 'Michael Jackson',
    searchQuery: 'Michael Jackson Smooth Criminal',
    gradient: 'from-indigo-400 to-purple-500',
  },
  {
    id: 'bohemian-rhapsody',
    title: 'Bohemian Rhapsody',
    artist: 'Queen',
    searchQuery: 'Queen Bohemian Rhapsody',
    gradient: 'from-amber-400 to-rose-500',
  },
  {
    id: 'levitating',
    title: 'Levitating',
    artist: 'Dua Lipa',
    searchQuery: 'Dua Lipa Levitating',
    gradient: 'from-fuchsia-400 to-pink-500',
  },
  {
    id: 'bad-guy',
    title: 'bad guy',
    artist: 'Billie Eilish',
    searchQuery: 'Billie Eilish bad guy',
    gradient: 'from-emerald-400 to-teal-500',
  },
  {
    id: 'uptown-funk',
    title: 'Uptown Funk',
    artist: 'Mark Ronson ft. Bruno Mars',
    searchQuery: 'Mark Ronson Uptown Funk Bruno Mars',
    gradient: 'from-sky-400 to-blue-500',
  },
]

export default function App() {
  const [view, setView] = useState('home')
  const [queue, setQueue] = useState([])
  const [queueIndex, setQueueIndex] = useState(-1)
  const [shuffle, setShuffle] = useState(false)
  const [repeat, setRepeat] = useState('off') // 'off' | 'one' | 'all'
  const [playerKey, setPlayerKey] = useState(0)
  const [showQueue, setShowQueue] = useState(false)

  const activeTrack = queueIndex >= 0 ? queue[queueIndex] : null

  const seedQueue = useCallback((tracks, startIndex = 0) => {
    const list = Array.isArray(tracks) ? tracks : [tracks]
    setQueue(list)
    setQueueIndex(startIndex)
    setPlayerKey(k => k + 1)
    setView('player')
  }, [])

  const handleTrackSelect = useCallback((track) => {
    pushRecent(track)
    seedQueue(track, 0)
  }, [seedQueue])

  const handlePlayTracks = useCallback((tracks, startIndex = 0) => {
    const list = Array.isArray(tracks) ? tracks : [tracks]
    pushRecent(list[startIndex] || track)
    seedQueue(list, startIndex)
  }, [seedQueue])

  const handleNext = useCallback(() => {
    if (queue.length === 0) return
    if (shuffle) {
      const next = Math.floor(Math.random() * queue.length)
      setQueueIndex(next)
      return
    }
    setQueueIndex(i => {
      if (i < queue.length - 1) return i + 1
      return repeat === 'all' ? 0 : i
    })
  }, [queue.length, shuffle, repeat])

  const handlePrev = useCallback(() => {
    if (queue.length === 0) return
    if (queueIndex > 0) setQueueIndex(i => i - 1)
    else if (repeat === 'all') setQueueIndex(queue.length - 1)
  }, [queue.length, queueIndex, repeat])

  const toggleShuffle = useCallback(() => setShuffle(s => !s), [])
  const toggleRepeat = useCallback(() => setRepeat(r => r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'), [])
  const toggleQueueSheet = useCallback(() => setShowQueue(s => !s), [])
  const closePlayer = useCallback(() => { setView('home'); setShowQueue(false) }, [])

  return (
    <div className="relative w-full h-dvh overflow-hidden select-none">
      {view === 'home' && <HomeScreen onSelectTrack={handleTrackSelect} onPlayTracks={handlePlayTracks} />}
      {view === 'player' && activeTrack && (
        <div className="animate-screen-in absolute inset-0">
          <PlayerScreen
            key={playerKey}
            track={activeTrack}
            queue={queue}
            queueIndex={queueIndex}
            shuffle={shuffle}
            repeat={repeat}
            showQueueSheet={showQueue}
            onBack={closePlayer}
            onNext={handleNext}
            onPrev={handlePrev}
            onToggleShuffle={toggleShuffle}
            onToggleRepeat={toggleRepeat}
            onToggleQueue={toggleQueueSheet}
            onTrackSelect={handleTrackSelect}
          />
        </div>
      )}
    </div>
  )
}
