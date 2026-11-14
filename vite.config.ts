import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// OSM / 地形数据的同源代理：开发期走 vite，生产期走 server/index.mjs
const proxy = {
  '/api/overpass': {
    target: 'https://overpass-api.de',
    changeOrigin: true,
    rewrite: () => '/api/interpreter',
    secure: true,
  },
  '/api/terrain': {
    target: 'https://s3.amazonaws.com',
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api\/terrain/, '/elevation-tiles-prod/terrarium'),
    secure: true,
  },
  '/api/tile': {
    target: 'https://tile.openstreetmap.org',
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api\/tile/, ''),
    headers: { Referer: 'http://localhost/' },
  },
}

export default defineConfig({
  base: './',
  plugins: [react()],
  server: { port: 5178, host: '127.0.0.1', proxy },
  preview: { port: 5178, host: '127.0.0.1', proxy },
  build: { target: 'es2020', sourcemap: false },
})
