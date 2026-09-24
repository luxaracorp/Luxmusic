import { useState, useCallback } from 'react'
import HomeScreen from './components/HomeScreen.jsx'
import PlayerScreen from './components/PlayerScreen.jsx'
import { pushRecent } from './lib/recents.js'

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
    pushRecent(list[startIndex] || list[0])
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
