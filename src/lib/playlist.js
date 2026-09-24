import { loadJSON, saveJSON, removeKey } from './storage.js'

const LIBRARY_KEY = 'library:v1'
const PLAYLISTS_KEY = 'playlists:v1'

// A library-tracked track shape mirrors what the player already consumes:
// { id, title, artist, searchQuery, gradient, syncedLyrics?, videoId? }
// We store the full object so playing it back just works.

export function getSavedTracks() {
  const arr = loadJSON(LIBRARY_KEY, [])
  if (!Array.isArray(arr)) return []
  return arr
}

export function saveTrack(track) {
  const tracks = getSavedTracks()
  const key = `${track.title || ''}${track.artist || ''}`.toLowerCase()
  const next = [track, ...tracks.filter(t => `${t.title || ''}${t.artist || ''}`.toLowerCase() !== key)]
  saveJSON(LIBRARY_KEY, next)
  return next
}

export function unsaveTrack(track) {
  const key = `${track.title || ''}${track.artist || ''}`.toLowerCase()
  const next = getSavedTracks().filter(t => `${t.title || ''}${t.artist || ''}`.toLowerCase() !== key)
  saveJSON(LIBRARY_KEY, next)
  return next
}

export function isTrackSaved(track) {
  const key = `${track.title || ''}${track.artist || ''}`.toLowerCase()
  return getSavedTracks().some(t => `${t.title || ''}${t.artist || ''}`.toLowerCase() === key)
}

// --- playlists ---

export function getPlaylists() {
  const arr = loadJSON(PLAYLISTS_KEY, [])
  if (!Array.isArray(arr)) return []
  return arr
}

export function getPlaylist(id) {
  return getPlaylists().find(p => p.id === id) || null
}

export function createPlaylist(name = 'New Playlist', tracks = []) {
  const list = {
    id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    createdAt: Date.now(),
    trackIds: [],
    tracks: [], // full track objects so playback doesn't need a join
  }
  const existing = getPlaylists()
  saveJSON(PLAYLISTS_KEY, [list, ...existing])
  if (tracks.length) addTracksToPlaylist(list.id, tracks)
  return list
}

export function renamePlaylist(id, newName) {
  const next = getPlaylists().map(p => p.id === id ? { ...p, name: newName || p.name } : p)
  saveJSON(PLAYLISTS_KEY, next)
  return next
}

export function deletePlaylist(id) {
  const next = getPlaylists().filter(p => p.id !== id)
  saveJSON(PLAYLISTS_KEY, next)
  return next
}

export function addTracksToPlaylist(id, tracks) {
  const next = getPlaylists().map(p => {
    if (p.id !== id) return p
    const merged = [...p.tracks, ...tracks].filter(t => t && (t.title || t.artist))
    // dedupe by title+artist
    const seen = new Set()
    const tracks = merged.filter(t => {
      const k = `${t.title || ''}${t.artist || ''}`.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    return { ...p, tracks }
  })
  saveJSON(PLAYLISTS_KEY, next)
  return next.find(p => p.id === id) || null
}

export function reorderPlaylist(id, fromIndex, toIndex) {
  const next = getPlaylists().map(p => {
    if (p.id !== id) return p
    const tracks = [...p.tracks]
    const [moved] = tracks.splice(fromIndex, 1)
    tracks.splice(toIndex, 0, moved)
    return { ...p, tracks }
  })
  saveJSON(PLAYLISTS_KEY, next)
  return next.find(p => p.id === id) || null
}

export function removeTrackFromPlaylist(id, index) {
  const next = getPlaylists().map(p => {
    if (p.id !== id) return p
    const tracks = [...p.tracks]
    tracks.splice(index, 1)
    return { ...p, tracks }
  })
  saveJSON(PLAYLISTS_KEY, next)
  return next.find(p => p.id === id) || null
}
