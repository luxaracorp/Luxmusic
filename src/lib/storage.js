// Generic localStorage helpers with JSON round-tripping + versioned keys.
// Every function is a safe no-op on parse/quota errors so callers never crash.

export function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (raw == null) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function removeKey(key) {
  try {
    localStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}
