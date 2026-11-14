// 生产/局域网模式：静态托管 dist + 同源代理（Overpass / Terrarium / OSM 瓦片）
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const PORT = Number(process.env.PORT || 5179)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
}

async function proxy(req, res, url) {
  let target = null
  if (url.pathname === '/api/overpass') target = 'https://overpass-api.de/api/interpreter'
  else if (url.pathname.startsWith('/api/terrain/'))
    target = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium' + url.pathname.replace('/api/terrain', '')
  else if (url.pathname.startsWith('/api/tile/'))
    target = 'https://tile.openstreetmap.org' + url.pathname.replace('/api/tile', '')

  if (!target) return false

  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = chunks.length ? Buffer.concat(chunks) : undefined

  const upstream = await fetch(target, {
    method: req.method,
    headers: {
      'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded',
      'User-Agent': 'geo-sandbox/0.1 (local dev)',
      Accept: req.headers.accept || '*/*',
    },
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  })

  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=86400',
  })
  const buf = Buffer.from(await upstream.arrayBuffer())
  res.end(buf)
  return true
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    if (url.pathname.startsWith('/api/')) {
      const handled = await proxy(req, res, url)
      if (!handled) {
        res.writeHead(404)
        res.end('unknown api')
      }
      return
    }
    let filePath = path.join(DIST, decodeURIComponent(url.pathname))
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(DIST, 'index.html')
    }
    const ext = path.extname(filePath).toLowerCase()
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    fs.createReadStream(filePath).pipe(res)
  } catch (e) {
    res.writeHead(500)
    res.end(String(e))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[geo-sandbox] http://127.0.0.1:${PORT}  (dist: ${DIST})`)
})
