# Luxara Music

**A beautiful React + Vite PWA lyric player with music discovery, library management, and synchronized lyrics.**

![Luxara Music Screenshot](https://raw.githubusercontent.com/luxara/luxara-music/main/pwa-icon.svg)

## Overview

Luxara Music is a feature-rich music player web application built with React 19, Vite, and Tailwind CSS. It functions as a lyric player with music discovery capabilities, offering synchronized lyrics, album artwork with gradient fallbacks, mood-based curation, and a full-featured library and playlist system — all packaged as a Progressive Web App.

The app fetches music from multiple sources: iTunes for metadata/duration, YouTube Music/Piped/Invidious for audio streaming, and LRCLIB for synchronized lyrics. All data is cached in localStorage for offline access and instant revisits.

## 🎵 How Music Is Obtained

The music pipeline is the core of Luxara Music. Here is the complete end-to-end flow:

### 1. **Discovery & Browsing**

- **Home Screen**: Fetches iTunes Top Songs RSS feed (`/us/rss/topsongs/limit=20/json`) and iTunes search results for "top hits 2024". Results are cached in `sessionStorage` for 30 minutes.
- **Search Tab**: Simultaneously queries iTunes and LRCLIB when a user types. Results are scored and merged — iTunes hits get priority, with LRCLIB fallback if no iTunes matches found.
- **Mood Curation**: Five mood buttons ("Chill Vibes", "Energy Boost", "Late Night", "Focus Flow") each fetch one iTunes result matching a curated query string.
- **Popular Tracks**: Top-songs RSS results displayed in the search tab and on the home screen.

### 2. **Track Selection → Playback Queue**

When a user clicks a track:

1. `pushRecent(track)` saves the track to `localStorage` under `recents:v1` (max 8 entries, newest first)
2. `seedQueue(track, 0)` pushes the track to the playback queue state (`queue` in App.jsx) and transitions the view to `'player'`
3. The PlayerScreen takes over and begins the resolution pipeline

### 3. **Player Screen — Audio & Lyrics Resolution**

On mount, the player resolves a matched YouTube video + lyrics pair:

**Step A — Check localStorage cache**
- Video ID, lyrics, duration, and sync offset are checked first. If all cached and fresh, playback starts instantly.

**Step B — Fetch iTunes duration & artwork**
- `fetchItunesDuration(artist, title)` from `src/lib/artwork.js` fetches both metadata in one iTunes search hit
- Results are cached per `(artist, title)` key in localStorage as `itunes5:{artist}|{title}`
- Subsequent visits are instant — no network required

**Step C — Search for YouTube candidates (ranked priority)**

Two video sources are searched in parallel, with a 2.5s grace period:

| Source | Query Pattern | Notes |
|---|---|---|
| **Piped** (`api.piped.private.coffee`, `pipedapi.adminforge.de`) | `filter=music_songs` | Studio masters only, no intro, studio-quality |
| **Invidious** (`iv.melmac.space`, `inv.nadeko.net`, `yewtu.be`) | `type=video` | Fallback if Piped fails |

**Duration gate (±3s hard tolerance)**: Candidates whose length differs from iTunes by more than 3 seconds are rejected. If no candidates survive, the gate is ignored (iTunes length may be inaccurate).

**Channel preference**: Official "- Topic" / "auto-generated" / "art track" uploads are preferred. If none exist, non-official candidates are accepted as fallback.

**Step D — Rank candidates** via `rankVideoCandidates()`:
- **Scoring**: title match (+6), duration proximity (10/5 points), artist match (+2), wrong version penalty (-8)
- Returns up to 5 candidates as `{ id, duration, title, uploaderName }`

**Step E — Fetch lyrics from LRCLIB**

Two-step process:

1. **Primary**: `/api/get` with artist + title + duration (matched ~2s server-side)
2. **Fallback**: `/api/search` full-text search, pick closest-duration hit
3. User can manually adjust sync offset in ±0.3s increments, saved per-song in localStorage

**Step F — Cache everything**
- Video ID, lyrics, duration, and offset are all saved in localStorage
- Next visit for the same song skips the entire resolution pipeline

### 4. **Lyrics Rendering**

- **rAF loop** at 60fps writes a single `--wipe` custom property on the active lyric line DOM node
- **CSS `.wipe-word` rule** derives per-word fill from `--wipe` via `calc()` — zero React re-renders per frame
- Active line scales up (1.32x) with GPU-cheap transform-origin-left-center
- Distant lines get subtle blur for depth effect
- **Gap dots** pulse during instrumental intros/gaps between lines

### 5. **Library & Playlists**

- **Saved tracks**: stored in `localStorage` under `library:v1` as full track objects
- **Playlists**: stored under `playlists:v1` with `id`, `name`, `createdAt`, and `tracks` (full track objects for instant playback)
- Operations: create/rename/delete playlists; add/remove tracks; reorder tracks
- Save/unsave individual tracks via the player

### 6. **Recent Tracks & Searches**

- **Recents**: max 8 tracks in `localStorage` under `recents:v1`, newest first, persisted across sessions
- **Recent searches**: max 8 queries in `localStorage` under `luxara:recentSearches`

### 7. **Artwork & Gradients**

- **iTunes artwork**: fetched via `useArtwork(artist, title)` in `src/lib/artwork.js`
- **Cache**: per `(artist, title)` key in localStorage, includes both art URL and duration
- **Gradient fallback**: if artwork fails, a per-song gradient is generated from `gradientFor(`${title} ${artist}`)`
- **Retry logic**: first failure triggers a retry after 1500ms with cache-buster query parameter

## ✨ Features

### Playback
- YouTube Music/Piped/Invidious audio streaming with studio-master preference
- Synchronized lyrics with per-word CSS wipe animation
- Media Session API support for lock screen / control center integration
- Global keyboard shortcuts (if supported)

### Discovery
- iTunes Top Songs RSS feed
- Mood-based curation (5 moods: Chill Vibes, Energy Boost, Late Night, Focus Flow + auto)
- Search across iTunes + LRCLIB with intelligent scoring and merging
- "Hot Right Now" and "Top Picks" rows on home screen
- Curated featured tracks (Billie Jean, Blinding Lights, etc.)

### Library
- Save tracks to personal library
- Create, rename, and delete playlists
- Add tracks to playlists from search results and library
- Reorder playlist tracks
- Play all tracks in a playlist or library

### UI/UX
- PWA with installable manifest and service worker
- Safe-area-inset support for mobile/notch devices
- `prefers-reduced-motion` media query kills decorative animations
- Gradient backgrounds per track/album
- Smooth animations and hover states
- Dark theme with white text, accent color `#fa2d55`

### Settings & Persistence
- All volume, EQ, and preference state in localStorage
- Per-song lyric sync offset calibration
- Per-song artwork cache with retry logic
- Recent tracks and searches history

## 🛠 Technology Stack

| Category | Details |
|---|---|
| **Framework** | React 19.2.6 + Vite 8.0.12 |
| **Styling** | Tailwind CSS 4.3.1 (JIT mode via `@tailwindcss/vite`) |
| **PWA** | `vite-plugin-pwa` with Workbox precaching |
| **Routing** | Client-side view switching (home ↔ player) |
| **Data Storage** | localStorage (library, playlists, recents, searches, caches) |
| **APIs** | iTunes Search, LRCLIB (lyrics), Piped, Invidious (YouTube) |
| **Linting** | ESLint 10 + `eslint-plugin-react-hooks` + `@eslint/js` |
| **No TypeScript** | `.jsx` files, no `tsconfig` |
| **CSS Features** | Custom keyframe animations (float, artDrift, linePop, wipe-word), CSS grid, clamp(), min/max, `env()` safe areas |

## 📦 Dependencies

**Production:**
- `react` `react-dom` (^19.2.6)
- `vite` (^8.0.12)
- `@vitejs/plugin-react`
- `tailwindcss` (^4.3.1) + `@tailwindcss/vite`
- `vite-plugin-pwa` (^1.3.0)
- `zod` (validation)

**Development:**
- `eslint` (^10.3.0) + `eslint-plugin-react-hooks` + `eslint-plugin-react-refresh`
- `@eslint/js`
- `@types/react` + `@types/react-dom`

## 🚀 How to Run

### Development

```bash
cd F:\Luxara Music
npm install          # Install dependencies
npm run dev          # Start Vite dev server at http://localhost:5173
```

The dev server proxies CORS-sensitive requests through localhost. See `vite.config.js` — the `proxyTargets` array maps:
- `itunes.apple.com` → iTunes Search API
- `lrclib.net` → Lyrics lookup
- `iv.melmac.space`, `inv.nadeko.net`, `yewtu.be` → Invidious instances
- `api.piped.private.coffee`, `pipedapi.adminforge.de` → Piped instances

In dev mode, `__VITE_DEV_PROXY__` is `true`, and `toApiUrl()` in `src/lib/apiProxy.js` rewrites external URLs to `/<hostname>/path` for same-origin fetching.

### Build

```bash
npm run build        # Vite build → dist/ directory
```

### Preview

```bash
npm run preview      # Serve dist/ at http://localhost:4173
```

### Production Notes

- In production, API proxies are **disabled** — all external hosts (iTunes, LRCLIB, YouTube/Piped/Invidious) are hit directly from the browser
- The PWA manifest and service worker are configured in `vite.config.js`
- Offline capability relies on localStorage caching (iTunes metadata, lyrics, video candidates)
- Gradients and artwork fallbacks ensure no empty flashes even on cache misses

## 📁 Project Structure

```
F:\Luxara Music\
├── node_modules/           # Dependencies
├── src/
│   ├── index.css           # Tailwind + custom animations
│   ├── main.jsx           # React entry point
│   ├── App.jsx            # App shell, view management
│   ├── components/
│   │   ├── HomeScreen.jsx # Home with carousel, moods, recents
│   │   ├── PlayerScreen.jsx # Full player with lyrics (1315 lines)
│   │   └── ... (other UI components)
│   ├── lib/
│   │   ├── artwork.js     # iTunes meta + artwork fetcher with caching
│   │   ├── curated.js    # CURATED_TRACKS constant
│   │   ├── playlist.js   # Library & playlist management (localStorage)
│   │   ├── recents.js    # Recently played tracks (localStorage)
│   │   └── storage.js    # Generic localStorage JSON helpers
│   └── apiProxy.js       # Dev/production URL routing
├── vite.config.js         # Vite config, PWA, proxy
├── package.json           # Dependencies and scripts
├── public/
│   └── pwa-icon.svg      # PWA manifest icon
├── dist/                 # Build output
├── README.md             # ← You are here
└── index.html            # HTML entry point
```

## 🎛 Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start Vite dev server with HMR and proxy |
| `npm run build` | Build Vite production bundle into `dist/` |
| `npm run preview` | Serve `dist/` at `http://localhost:4173` |
| `npm run lint` | Run ESLint on all source files |

## 🔧 Configuration

### Adding New Piped/Invidious Instances

Edit `src/lib/apiProxy.js` — add hostnames to `PROXY_HOSTS` array for dev proxy, and to `VIDEO_SOURCES` in `src/components/PlayerScreen.jsx` for video search order.

### Modifying Moods

Edit `src/components/HomeScreen.jsx` — the `MOODS` constant defines labels, queries, and gradients for the "Made For You" section.

### Changing Cache TTL

In `src/components/HomeScreen.jsx`, `CACHE_TTL_MS = 30 * 60 * 1000` (30 minutes) controls how long the "Listen Now" RSS cache persists in `sessionStorage`.

## 📜 License

This project is private and source-available. All rights reserved.

---

*Built with ❤️ using React, Vite, Tailwind CSS, and the open music ecosystem.*