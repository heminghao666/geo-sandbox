import type { BBox } from './geo'

export type OsmFeatureKind =
  | 'building'
  | 'road'
  | 'water'
  | 'waterway'
  | 'green'
  | 'rail'
  | 'barrier'

export type OsmFeature = {
  id: number
  kind: OsmFeatureKind
  subtype: string
  tags: Record<string, string>
  /** [lon, lat] 列表；多边形为首尾相同 */
  coords: [number, number][]
  closed: boolean
}

export type OsmData = {
  bbox: BBox
  features: OsmFeature[]
  counts: Record<string, number>
  fetchedAt: number
}

const ENDPOINTS = [
  '/api/overpass',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

function buildQuery(b: BBox) {
  const bb = `${b.south},${b.west},${b.north},${b.east}`
  return `[out:json][timeout:60];
(
  way["building"](${bb});
  relation["building"]["type"="multipolygon"](${bb});
  way["highway"]["highway"!~"^(proposed|construction|raceway|bus_guideway)$"](${bb});
  way["railway"~"^(rail|light_rail|subway|tram)$"](${bb});
  way["natural"="water"](${bb});
  way["waterway"~"^(river|canal|stream|drain)$"](${bb});
  way["landuse"~"^(forest|grass|meadow|recreation_ground|orchard|farmland|cemetery|village_green)$"](${bb});
  way["leisure"~"^(park|garden|pitch|sports_centre|playground)$"](${bb});
  way["barrier"~"^(wall|fence|hedge)$"](${bb});
);
out geom tags;`
}

function classify(tags: Record<string, string>): { kind: OsmFeatureKind; subtype: string } | null {
  if (tags.building) return { kind: 'building', subtype: tags.building || 'yes' }
  if (tags.highway) return { kind: 'road', subtype: tags.highway }
  if (tags.railway) return { kind: 'rail', subtype: tags.railway }
  if (tags.natural === 'water' || tags.water) return { kind: 'water', subtype: tags.water || 'water' }
  if (tags.landuse === 'basin' || tags.landuse === 'reservoir')
    return { kind: 'water', subtype: tags.landuse }
  if (tags.waterway) return { kind: 'waterway', subtype: tags.waterway }
  if (tags.landuse || tags.leisure) return { kind: 'green', subtype: tags.landuse || tags.leisure }
  if (tags.barrier) return { kind: 'barrier', subtype: tags.barrier }
  return null
}

export async function fetchOsm(b: BBox, signal?: AbortSignal): Promise<OsmData> {
  const body = buildQuery(b)
  let lastErr: unknown = null
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(body),
        signal,
      })
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
      const json = await res.json()
      return parseOverpass(json, b)
    } catch (e) {
      if ((e as any)?.name === 'AbortError') throw e
      lastErr = e
    }
  }
  throw new Error(`Overpass 取数失败：${String(lastErr)}`)
}

export function parseOverpass(json: any, b: BBox): OsmData {
  const features: OsmFeature[] = []
  const counts: Record<string, number> = {}
  for (const el of json.elements ?? []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue
    const tags: Record<string, string> = el.tags ?? {}
    const cls = classify(tags)
    if (!cls) continue
    const coords = el.geometry.map((g: any) => [g.lon, g.lat] as [number, number])
    const closed =
      coords.length > 3 &&
      coords[0][0] === coords[coords.length - 1][0] &&
      coords[0][1] === coords[coords.length - 1][1]
    features.push({ id: el.id, kind: cls.kind, subtype: cls.subtype, tags, coords, closed })
    counts[cls.kind] = (counts[cls.kind] ?? 0) + 1
  }
  return { bbox: b, features, counts, fetchedAt: Date.now() }
}
