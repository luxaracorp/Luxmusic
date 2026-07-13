import { useState, useCallback } from 'react'
import HomeScreen from './components/HomeScreen.jsx'
import PlayerScreen from './components/PlayerScreen.jsx'
import { pushRecent } from './lib/recents.js'

export const CURATED_TRACKS = [
  {
    id: 'billie-jean',
    title: 'Billie Jean',
    artist: 'Michael Jackson',
    videoId: 'Zi_XLOBDo_Y',
    searchQuery: 'Billie+Jean+Michael+Jackson',
    gradient: 'from-purple-400 to-pink-400',
  },
  {
    id: 'blinding-lights',
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    videoId: '4NRXx6U8ABQ',
    searchQuery: 'Blinding+Lights+The+Weeknd',
    gradient: 'from-red-400 to-orange-400',
  },
  {
    id: 'starboy',
    title: 'Starboy',
    artist: 'The Weeknd',
    videoId: '34Na4j8AVgA',
    searchQuery: 'Starboy+The+Weeknd',
    gradient: 'from-teal-400 to-cyan-400',
  },
  {
    id: 'smooth-criminal',
    title: 'Smooth Criminal',
    artist: 'Michael Jackson',
    videoId: null,
    searchQuery: 'Michael Jackson Smooth Criminal',
    gradient: 'from-indigo-400 to-purple-500',
  },
  {
    id: 'bohemian-rhapsody',
    title: 'Bohemian Rhapsody',
    artist: 'Queen',
    videoId: null,
    searchQuery: 'Queen Bohemian Rhapsody',
    gradient: 'from-amber-400 to-rose-500',
  },
  {
    id: 'levitating',
    title: 'Levitating',
    artist: 'Dua Lipa',
    videoId: null,
    searchQuery: 'Dua Lipa Levitating',
    gradient: 'from-fuchsia-400 to-pink-500',
  },
  {
    id: 'bad-guy',
    title: 'bad guy',
    artist: 'Billie Eilish',
    videoId: null,
    searchQuery: 'Billie Eilish bad guy',
    gradient: 'from-emerald-400 to-teal-500',
  },
  {
    id: 'uptown-funk',
    title: 'Uptown Funk',
    artist: 'Mark Ronson ft. Bruno Mars',
    videoId: null,
    searchQuery: 'Mark Ronson Uptown Funk Bruno Mars',
    gradient: 'from-sky-400 to-blue-500',
  },
]

export default function App() {
  const [view, setView] = useState('home')
  const [activeTrack, setActiveTrack] = useState(null)
  const [playerKey, setPlayerKey] = useState(0)

  const handleTrackSelect = useCallback((track) => {
    pushRecent(track)
    setActiveTrack(track)
    setPlayerKey(k => k + 1)
    setView('player')
  }, [])

  const closePlayer = useCallback(() => {
    setView('home')
  }, [])

  return (
    <div className="relative w-full h-dvh overflow-hidden select-none">
      {view === 'home' && <HomeScreen onSelectTrack={handleTrackSelect} />}
      {view === 'player' && activeTrack && (
        <div className="animate-slide-in-right absolute inset-0">
          <PlayerScreen key={playerKey} track={activeTrack} onBack={closePlayer} />
        </div>
      )}
    </div>
  )
}
