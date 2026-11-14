// EPSG:3857 投影 + 局部米制坐标系
// 约定：three.js 中 +X = 东，+Z = 南（y 向上），1 单位 = 1 米
const R = 6378137
const MAX_LAT = 85.05112878
export const MERC_ORIGIN = 20037508.342789244

export type BBox = { south: number; west: number; north: number; east: number }
export type LonLat = { lon: number; lat: number }
export type Vec2 = [number, number]

export function lonLatToMerc(lon: number, lat: number): Vec2 {
  const la = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * (Math.PI / 180)
  return [R * lon * (Math.PI / 180), R * Math.log(Math.tan(Math.PI / 4 + la / 2))]
}

export function mercToLonLat(x: number, y: number): LonLat {
  const lon = (x / R) * (180 / Math.PI)
  const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)
  return { lon, lat }
}

export function bboxCenterMerc(b: BBox): Vec2 {
  const [x0, y0] = lonLatToMerc(b.west, b.south)
  const [x1, y1] = lonLatToMerc(b.east, b.north)
  return [(x0 + x1) / 2, (y0 + y1) / 2]
}

/** 创建一个把经纬度映射到局部米制坐标（以 bbox 中心为原点）的投影器 */
export function makeProjector(b: BBox) {
  const [cx, cy] = bboxCenterMerc(b)
  return {
    center: [cx, cy] as Vec2,
    /** 世界坐标：x 向东，z 向南（北为 -z） */
    toWorld(lon: number, lat: number): Vec2 {
      const [x, y] = lonLatToMerc(lon, lat)
      return [x - cx, cy - y]
    },
    sizeMeters(): Vec2 {
      const [x0, y0] = lonLatToMerc(b.west, b.south)
      const [x1, y1] = lonLatToMerc(b.east, b.north)
      return [Math.abs(x1 - x0), Math.abs(y1 - y0)]
    },
  }
}

export function bboxFromCenter(lat: number, lon: number, sizeMeters: number): BBox {
  const [x, y] = lonLatToMerc(lon, lat)
  const half = sizeMeters / 2
  const sw = mercToLonLat(x - half, y - half)
  const ne = mercToLonLat(x + half, y + half)
  return { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon }
}

export function bboxSize(b: BBox): { w: number; h: number } {
  const [x0, y0] = lonLatToMerc(b.west, b.south)
  const [x1, y1] = lonLatToMerc(b.east, b.north)
  return { w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
}

export function bboxContains(b: BBox, lon: number, lat: number) {
  return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north
}

export function fmtBBox(b: BBox) {
  return `${b.south.toFixed(5)}, ${b.west.toFixed(5)}, ${b.north.toFixed(5)}, ${b.east.toFixed(5)}`
}
