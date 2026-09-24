import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ command }) => {
  const proxy = {}
  // Proxy iTunes, LRCLIB, and music-API hosts through the dev server so the
  // browser never sees a CORS error (iTunes blocks cross-origin requests).
  const proxyTargets = [
    'https://itunes.apple.com',
    'https://lrclib.net',
    'https://iv.melmac.space',
    'https://inv.nadeko.net',
    'https://yewtu.be',
    'https://api.piped.private.coffee',
    'https://pipedapi.adminforge.de',
  ]
  for (const target of proxyTargets) {
    const host = new URL(target).hostname
    // Requests to /itunes.apple.com/... get proxied to https://itunes.apple.com/...
    // The rewrite strips the hostname prefix from the path.
    proxy[`/${host}/`] = {
      target,
      changeOrigin: true,
      secure: false,
      rewrite: (path) => path.replace(new RegExp(`^/${host.replace(/\./g, '\\.')}/`), '/'),
    }
  }

  return {
    define: {
      __VITE_DEV_PROXY__: command === 'serve',
    },
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['pwa-icon.svg'],
        manifest: {
          name: 'Luxara Music',
          short_name: 'Luxara',
          description: 'A beautiful lyric player PWA',
          theme_color: '#000000',
          background_color: '#000000',
          display: 'standalone',
          orientation: 'portrait',
          icons: [
            {
              src: 'pwa-icon.svg',
              sizes: 'any',
              type: 'image/svg+xml',
              purpose: 'any maskable'
            }
          ]
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico}']
        }
      })
    ],
    ...(command === 'serve' ? { server: { proxy } } : {}),
  }
})
