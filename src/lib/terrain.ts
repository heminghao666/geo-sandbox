import { MERC_ORIGIN, type BBox } from './geo'

export type HeightField = {
  /** 每边采样点数 */
  n: number
  /** 覆盖范围（米） */
  sizeX: number
  sizeZ: number
  /** 行优先：row = z 方向（北->南），col = x 方向（西->东） */
  heights: Float32Array
  min: number
  max: number
  ok: boolean
  zoom: number
  message?: string
}

type TileImage = { data: Uint8ClampedArray; w: number; h: number }

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('tile load failed ' + url))
    img.src = url
  })
}

async function fetchTerrariumTile(z: number, x: number, y: number): Promise<TileImage | null> {
  const urls = [
    `/api/terrain/${z}/${x}/${y}.png`,
    `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  ]
  for (const u of urls) {
    try {
      const img = await loadImage(u)
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height)
      return { data: d.data, w: c.width, h: c.height }
    } catch {
      /* try next */
    }
  }
  return null
}

function pickZoom(b: BBox): number {
  const [x0, y0] = lonLatToMercLocal(b.west, b.south)
  const [x1, y1] = lonLatToMercLocal(b.east, b.north)
  const spanX = Math.abs(x1 - x0)
  const spanY = Math.abs(y1 - y0)
  for (let z = 15; z >= 9; z--) {
    const tileSpan = (2 * MERC_ORIGIN) / Math.pow(2, z)
    if (spanX / tileSpan <= 3 && spanY / tileSpan <= 3) return z
  }
  return 9
}

function lonLatToMercLocal(lon: number, lat: number): [number, number] {
  const R = 6378137
  const la = Math.max(-85.05, Math.min(85.05, lat)) * (Math.PI / 180)
  return [R * lon * (Math.PI / 180), R * Math.log(Math.tan(Math.PI / 4 + la / 2))]
}

/** 从 Terrarium DEM 瓦片采样高程，生成规则网格 */
export async function loadTerrain(
  bbox: BBox,
  center: [number, number],
  sizeMeters: [number, number],
  n = 141,
): Promise<HeightField> {
  const z = pickZoom(bbox)
  const tileSpan = (2 * MERC_ORIGIN) / Math.pow(2, z)
  const [cx, cy] = center
  const sizeX = sizeMeters[0]
  const sizeZ = sizeMeters[1]

  const tx0 = Math.floor((cx - sizeX / 2 + MERC_ORIGIN) / tileSpan)
  const tx1 = Math.floor((cx + sizeX / 2 + MERC_ORIGIN) / tileSpan)
  const ty0 = Math.floor((cy - sizeZ / 2 + MERC_ORIGIN) / tileSpan)
  const ty1 = Math.floor((cy + sizeZ / 2 + MERC_ORIGIN) / tileSpan)
  const maxTiles = 36
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > maxTiles) {
    return flatField(n, sizeX, sizeZ, '区域过大，地形瓦片过多，已退化为平面')
  }

  const tiles = new Map<string, TileImage | null>()
  const jobs: Promise<void>[] = []
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      const key = `${tx}/${ty}`
      jobs.push(
        fetchTerrariumTile(z, tx, ty).then((t) => {
          tiles.set(key, t)
        }),
      )
    }
  }
  await Promise.all(jobs)
  const okCount = [...tiles.values()].filter(Boolean).length
  if (okCount === 0) return flatField(n, sizeX, sizeZ, '地形瓦片不可用（网络或代理问题），已退化为平面')

  const heights = new Float32Array(n * n)
  let min = Infinity
  let max = -Infinity

  const sample = (mercX: number, mercY: number): number => {
    const fx = (mercX + MERC_ORIGIN) / tileSpan
    const fy = (MERC_ORIGIN - mercY) / tileSpan
    const tx = Math.floor(fx)
    const ty = Math.floor(fy)
    const tile = tiles.get(`${tx}/${ty}`)
    const px = (fx - tx) * 256
    const py = (fy - ty) * 256
    const tx2 = Math.floor(px / 256)
    const ty2 = Math.floor(py / 256)
    const t = tiles.get(`${tx + tx2}/${ty + ty2}`)
    if (!t) return 0
    const gx = Math.min(255, Math.max(0, (px - tx2 * 256) * (t.w / 256)))
    const gy = Math.min(255, Math.max(0, (py - ty2 * 256) * (t.h / 256)))
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const x1 = Math.min(t.w - 1, x0 + 1)
    const y1 = Math.min(t.h - 1, y0 + 1)
    const sx = gx - x0
    const sy = gy - y0
    const at = (xx: number, yy: number) => {
      const o = (yy * t.w + xx) * 4
      return t.data[o] * 256 + t.data[o + 1] + t.data[o + 2] / 256 - 32768
    }
    const h00 = at(x0, y0)
    const h10 = at(x1, y0)
    const h01 = at(x0, y1)
    const h11 = at(x1, y1)
    return (h00 * (1 - sx) + h10 * sx) * (1 - sy) + (h01 * (1 - sx) + h11 * sx) * sy
  }

  for (let j = 0; j < n; j++) {
    const zz = -sizeZ / 2 + (sizeZ * j) / (n - 1)
    const mercY = cy - zz
    for (let i = 0; i < n; i++) {
      const xx = -sizeX / 2 + (sizeX * i) / (n - 1)
      const mercX = cx + xx
      const h = sample(mercX, mercY)
      heights[j * n + i] = h
      if (h < min) min = h
      if (h > max) max = h
    }
  }

  // 轻微平滑，去掉 DEM 噪声
  const smoothed = new Float32Array(heights)
  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      smoothed[j * n + i] =
        (heights[j * n + i] * 4 +
          heights[j * n + i - 1] +
          heights[j * n + i + 1] +
          heights[(j - 1) * n + i] +
          heights[(j + 1) * n + i]) /
        8
    }
  }

  return {
    n,
    sizeX,
    sizeZ,
    heights: smoothed,
    min,
    max,
    ok: true,
    zoom: z,
    message: `DEM z${z} · ${okCount} 瓦片 · 高差 ${(max - min).toFixed(1)} m`,
  }
}

function flatField(n: number, sizeX: number, sizeZ: number, message: string): HeightField {
  return {
    n,
    sizeX,
    sizeZ,
    heights: new Float32Array(n * n),
    min: 0,
    max: 0,
    ok: false,
    zoom: 0,
    message,
  }
}

/** 在高度场上双线性采样（世界坐标，米） */
export function sampleHeight(hf: HeightField, x: number, z: number): number {
  const fx = ((x + hf.sizeX / 2) / hf.sizeX) * (hf.n - 1)
  const fz = ((z + hf.sizeZ / 2) / hf.sizeZ) * (hf.n - 1)
  const i0 = Math.max(0, Math.min(hf.n - 1, Math.floor(fx)))
  const j0 = Math.max(0, Math.min(hf.n - 1, Math.floor(fz)))
  const i1 = Math.min(hf.n - 1, i0 + 1)
  const j1 = Math.min(hf.n - 1, j0 + 1)
  const sx = Math.max(0, Math.min(1, fx - i0))
  const sz = Math.max(0, Math.min(1, fz - j0))
  const a = hf.heights[j0 * hf.n + i0]
  const b = hf.heights[j0 * hf.n + i1]
  const c = hf.heights[j1 * hf.n + i0]
  const d = hf.heights[j1 * hf.n + i1]
  return (a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz
}
