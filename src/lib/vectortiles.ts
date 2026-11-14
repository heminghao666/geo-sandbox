import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'
import type { BBox } from './geo'
import { MERC_ORIGIN } from './geo'
import type { OsmData, OsmFeature, OsmFeatureKind } from './overpass'

const TILEJSON = 'https://tiles.openfreemap.org/planet'
const FALLBACK = 'https://tiles.openfreemap.org/planet/20261101_080013_pt/{z}/{x}/{y}.pbf'

let templateCache: string | null = null

async function tileTemplate(): Promise<string> {
  if (templateCache) return templateCache
  try {
    const r = await fetch(TILEJSON)
    if (!r.ok) throw new Error(String(r.status))
    const j = await r.json()
    templateCache = j.tiles?.[0] ?? FALLBACK
  } catch {
    templateCache = FALLBACK
  }
  return templateCache!
}

function lonToTileX(lon: number, z: number) {
  return ((lon + 180) / 360) * Math.pow(2, z)
}
function latToTileY(lat: number, z: number) {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z)
}

function pickZoom(b: BBox): number {
  const spanLon = Math.abs(b.east - b.west)
  const spanLat = Math.abs(b.north - b.south)
  // OpenFreeMap planet 瓦片最高到 z14，再高会返回空 tile
  for (let z = 14; z >= 9; z--) {
    const nX = (spanLon / 360) * Math.pow(2, z)
    const nY = (spanLat / 360) * Math.pow(2, z)
    if (nX <= 4 && nY <= 4) return z
  }
  return 9
}

const ROAD_CLASS: Record<string, string> = {
  motorway: 'motorway',
  trunk: 'trunk',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  minor: 'residential',
  service: 'service',
  path: 'path',
  track: 'track',
  rail: 'rail',
  transit: 'rail',
  ferry: 'path',
  pedestrian: 'pedestrian',
}

const GREEN_CLASS: Record<string, string> = {
  park: 'park',
  garden: 'garden',
  pitch: 'pitch',
  playground: 'playground',
  forest: 'forest',
  wood: 'forest',
  grass: 'grass',
  meadow: 'meadow',
  farmland: 'farmland',
  cemetery: 'cemetery',
  village_green: 'village_green',
  orchard: 'orchard',
  scrub: 'grass',
  heath: 'grass',
}

type Ring = [number, number][]

/** Sutherland–Hodgman：把多边形环裁到 bbox 内 */
function clipPolygon(ring: Ring, b: BBox): Ring {
  let pts = ring.slice()
  const edges: { inside: (p: [number, number]) => boolean; cut: (a: [number, number], c: [number, number]) => [number, number] }[] = [
    {
      inside: (p) => p[0] >= b.west,
      cut: (a, c) => {
        const t = (b.west - a[0]) / (c[0] - a[0] || 1e-12)
        return [b.west, a[1] + t * (c[1] - a[1])]
      },
    },
    {
      inside: (p) => p[0] <= b.east,
      cut: (a, c) => {
        const t = (b.east - a[0]) / (c[0] - a[0] || 1e-12)
        return [b.east, a[1] + t * (c[1] - a[1])]
      },
    },
    {
      inside: (p) => p[1] >= b.south,
      cut: (a, c) => {
        const t = (b.south - a[1]) / (c[1] - a[1] || 1e-12)
        return [a[0] + t * (c[0] - a[0]), b.south]
      },
    },
    {
      inside: (p) => p[1] <= b.north,
      cut: (a, c) => {
        const t = (b.north - a[1]) / (c[1] - a[1] || 1e-12)
        return [a[0] + t * (c[0] - a[0]), b.north]
      },
    },
  ]
  for (const e of edges) {
    if (pts.length === 0) break
    const out: Ring = []
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i]
      const prev = pts[(i + pts.length - 1) % pts.length]
      const ci = e.inside(cur)
      const pi = e.inside(prev)
      if (ci) {
        if (!pi) out.push(e.cut(prev, cur))
        out.push(cur)
      } else if (pi) {
        out.push(e.cut(prev, cur))
      }
    }
    pts = out
  }
  return pts
}

/** 折线裁剪：返回落在 bbox 内的若干段 */
function clipLine(line: Ring, b: BBox): Ring[] {
  const out: Ring[] = []
  let run: Ring = []
  const inside = (p: [number, number]) => p[0] >= b.west && p[0] <= b.east && p[1] >= b.south && p[1] <= b.north

  const cutAt = (a: [number, number], c: [number, number]): [number, number] => {
    let t0 = 0
    let t1 = 1
    const dx = c[0] - a[0]
    const dy = c[1] - a[1]
    const tests: [number, number][] = [
      [-dx, a[0] - b.west],
      [dx, b.east - a[0]],
      [-dy, a[1] - b.south],
      [dy, b.north - a[1]],
    ]
    for (const [p, q] of tests) {
      if (Math.abs(p) < 1e-12) {
        if (q < 0) return a
        continue
      }
      const r = q / p
      if (p < 0) {
        if (r > t1) return a
        if (r > t0) t0 = r
      } else {
        if (r < t0) return a
        if (r < t1) t1 = r
      }
    }
    return [a[0] + t0 * dx, a[1] + t0 * dy]
  }

  for (let i = 0; i < line.length; i++) {
    const p = line[i]
    if (inside(p)) {
      if (run.length === 0) {
        if (i > 0) run.push(cutAt(p, line[i - 1]))
        run.push(p)
      } else run.push(p)
    } else if (run.length >= 1) {
      if (i > 0) run.push(cutAt(line[i - 1], p))
      if (run.length >= 2) out.push(run)
      run = []
    }
  }
  if (run.length >= 2) out.push(run)
  return out
}

export async function fetchVectorData(b: BBox, signal?: AbortSignal): Promise<OsmData> {
  const template = await tileTemplate()
  const z = pickZoom(b)
  const x0 = Math.floor(lonToTileX(b.west, z))
  const x1 = Math.floor(lonToTileX(b.east, z))
  const y0 = Math.floor(latToTileY(b.north, z))
  const y1 = Math.floor(latToTileY(b.south, z))

  const features: OsmFeature[] = []
  const counts: Record<string, number> = {}
  const seen = new Set<string>()
  let id = 1
  let failed = 0

  const jobs: Promise<void>[] = []
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      jobs.push(
        (async () => {
          const url = template
            .replace('{z}', String(z))
            .replace('{x}', String(x))
            .replace('{y}', String(y))
          let buf: ArrayBuffer
          try {
            const r = await fetch(url, { signal })
            if (!r.ok) throw new Error(String(r.status))
            buf = await r.arrayBuffer()
          } catch {
            failed++
            return
          }
          const tile = new VectorTile(new PbfReader(new Uint8Array(buf)))

          const pushRaw = (
            kind: OsmFeatureKind,
            subtype: string,
            props: any,
            coords: [number, number][],
            closed: boolean,
          ) => {
            if (coords.length < 2) return
            const key = `${kind}|${subtype}|${coords.length}|${coords[0][0].toFixed(7)},${coords[0][1].toFixed(7)}`
            if (seen.has(key)) return
            seen.add(key)
            features.push({ id: id++, kind, subtype, tags: props, coords, closed })
            counts[kind] = (counts[kind] ?? 0) + 1
          }

          const pushPoly = (kind: OsmFeatureKind, subtype: string, props: any, ring: [number, number][]) => {
            const c = clipPolygon(ring, b)
            if (c.length >= 3) pushRaw(kind, subtype, props, c, true)
          }

          const pushLine = (kind: OsmFeatureKind, subtype: string, props: any, line: [number, number][]) => {
            for (const seg of clipLine(line, b)) pushRaw(kind, subtype, props, seg, false)
          }

          const readLayer = (name: string, handle: (props: any, geom: [number, number][], isPoly: boolean) => void) => {
            const layer = tile.layers[name]
            if (!layer) return
            for (let i = 0; i < layer.length; i++) {
              const f = layer.feature(i)
              let gj: any
              try {
                gj = f.toGeoJSON(x, y, z)
              } catch {
                continue
              }
              if (!gj?.geometry?.coordinates) continue
              const g = gj.geometry
              const props = f.properties || {}
              if (g.type === 'Polygon') {
                handle(props, g.coordinates[0] as [number, number][], true)
              } else if (g.type === 'LineString') {
                handle(props, g.coordinates as [number, number][], false)
              } else if (g.type === 'MultiLineString') {
                for (const ls of g.coordinates) handle(props, ls as [number, number][], false)
              } else if (g.type === 'MultiPolygon') {
                for (const poly of g.coordinates) handle(props, poly[0] as [number, number][], true)
              }
            }
          }

          // 建筑
          readLayer('building', (props, ring) => {
            const h = Number(props.render_height ?? props.height ?? 0)
            const tags: Record<string, string> = { ...props }
            if (h > 0) tags.height = String(h)
            else if (props['building:levels']) tags['building:levels'] = String(props['building:levels'])
            pushPoly('building', props.class ?? 'yes', tags, ring)
          })

          // 道路 / 铁路
          readLayer('transportation', (props, line) => {
            const cls = String(props.class ?? '')
            if (props.brunnel === 'tunnel') return
            const kind: OsmFeatureKind = cls === 'rail' || cls === 'transit' ? 'rail' : 'road'
            pushLine(kind, ROAD_CLASS[cls] ?? (cls || 'residential'), props, line)
          })

          // 水体
          readLayer('water', (props, ring) => pushPoly('water', props.class ?? 'water', props, ring))
          readLayer('waterway', (props, line) =>
            pushLine('waterway', props.class ?? 'stream', props, line),
          )

          // 绿地
          readLayer('park', (props, ring) =>
            pushPoly('green', GREEN_CLASS[props.class] ?? props.class ?? 'park', props, ring),
          )
          readLayer('landcover', (props, ring) => {
            const sub = GREEN_CLASS[props.class]
            if (sub) pushPoly('green', sub, props, ring)
          })
          readLayer('landuse', (props, ring) => {
            const sub = GREEN_CLASS[props.class]
            if (sub) pushPoly('green', sub, props, ring)
          })
        })(),
      )
    }
  }

  await Promise.all(jobs)
  if (failed && features.length === 0) {
    throw new Error('矢量瓦片不可达（tiles.openfreemap.org），请检查网络或代理')
  }
  return {
    bbox: b,
    features,
    counts,
    fetchedAt: Date.now(),
  }
}
