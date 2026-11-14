import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { OsmData, OsmFeature } from './overpass'
import { sampleHeight, type HeightField } from './terrain'
import type { Vec2 } from './geo'

export type BuildOptions = {
  heightScale: number
  /** DEM 与 OSM 的高度是否对得上（无 DEM 时置 0 = 全部贴平） */
  elevationScale: number
  buildings: boolean
  roads: boolean
  water: boolean
  green: boolean
  plinth: boolean
  showWire: boolean
}

export type BuildResult = {
  group: THREE.Group
  stats: {
    buildings: number
    roads: number
    water: number
    green: number
    triangles: number
    heightRange: [number, number]
  }
}

const ROAD_WIDTH: Record<string, number> = {
  motorway: 18,
  motorway_link: 9,
  trunk: 16,
  trunk_link: 8,
  primary: 13,
  primary_link: 7,
  secondary: 11,
  secondary_link: 6,
  tertiary: 9,
  tertiary_link: 5,
  residential: 7,
  living_street: 6,
  unclassified: 6,
  service: 4.5,
  pedestrian: 5,
  footway: 2.4,
  path: 1.8,
  cycleway: 2.6,
  steps: 2.2,
  track: 3,
}

const WATERWAY_WIDTH: Record<string, number> = { river: 22, canal: 14, stream: 5, drain: 3.5 }

function prep(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  let g = geo.index ? geo.toNonIndexed() : geo
  g.deleteAttribute('uv')
  g.deleteAttribute('uv1')
  const count = g.attributes.position.count
  const arr = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    arr[i * 3] = color.r
    arr[i * 3 + 1] = color.g
    arr[i * 3 + 2] = color.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3))
  return g
}

function projectRing(coords: [number, number][], toWorld: (lon: number, lat: number) => Vec2): Vec2[] {
  const out: Vec2[] = []
  for (const [lon, lat] of coords) {
    const p = toWorld(lon, lat)
    out.push(p)
  }
  return out
}

function centroid(pts: Vec2[]): Vec2 {
  let x = 0
  let z = 0
  let n = 0
  for (const p of pts) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue
    x += p[0]
    z += p[1]
    n++
  }
  return [x / Math.max(1, n), z / Math.max(1, n)]
}

function ribbon(pts: Vec2[], width: number): THREE.BufferGeometry {
  const pos: number[] = []
  const half = width / 2
  if (pts.length < 2) return new THREE.BufferGeometry()
  const normals: Vec2[] = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]
    const b = pts[Math.min(pts.length - 1, i + 1)]
    let dx = b[0] - a[0]
    let dz = b[1] - a[1]
    const len = Math.hypot(dx, dz) || 1
    dx /= len
    dz /= len
    normals.push([-dz, dx])
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i]
    const q = pts[i + 1]
    const n1 = normals[i]
    const n2 = normals[i + 1]
    const a = [p[0] + n1[0] * half, p[1] + n1[1] * half]
    const b = [p[0] - n1[0] * half, p[1] - n1[1] * half]
    const c = [q[0] + n2[0] * half, q[1] + n2[1] * half]
    const d = [q[0] - n2[0] * half, q[1] - n2[1] * half]
    pos.push(a[0], 0, a[1], b[0], 0, b[1], c[0], 0, c[1])
    pos.push(b[0], 0, b[1], d[0], 0, d[1], c[0], 0, c[1])
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
}

function shapeFromRing(pts: Vec2[]): THREE.Shape | null {
  const clean: Vec2[] = []
  for (const p of pts) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue
    const last = clean[clean.length - 1]
    if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < 0.01) continue
    clean.push(p)
  }
  if (clean.length > 3) {
    const f = clean[0]
    const l = clean[clean.length - 1]
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 0.01) clean.pop()
  }
  if (clean.length < 3) return null
  const shape = new THREE.Shape()
  shape.moveTo(clean[0][0], -clean[0][1])
  for (let i = 1; i < clean.length; i++) shape.lineTo(clean[i][0], -clean[i][1])
  shape.closePath()
  return shape
}

function buildingHeight(f: OsmFeature): number {
  const t = f.tags
  const hRaw = t.height ?? t['building:height']
  if (hRaw) {
    const m = parseFloat(String(hRaw).replace(',', '.'))
    if (Number.isFinite(m) && m > 1 && m < 900) return m
  }
  const lv = parseFloat(t['building:levels'] ?? '')
  if (Number.isFinite(lv) && lv > 0 && lv < 300) return lv * 3.2 + 1
  const sub = f.subtype
  if (sub === 'garage' || sub === 'garages' || sub === 'shed' || sub === 'hut') return 3
  if (sub === 'apartments' || sub === 'residential') return 15
  if (sub === 'commercial' || sub === 'office' || sub === 'retail') return 18
  if (sub === 'industrial' || sub === 'warehouse') return 11
  if (sub === 'church' || sub === 'cathedral') return 22
  return 9
}

function buildingColor(sub: string, rnd: number): THREE.Color {
  const palette: Record<string, string> = {
    residential: '#d9d2c4',
    apartments: '#cfc6b6',
    house: '#ded7c8',
    detached: '#e2dccd',
    commercial: '#c9b49b',
    retail: '#cdb79c',
    office: '#c2bdb2',
    industrial: '#9aa0a4',
    warehouse: '#a3a8ab',
    school: '#d3c9b0',
    church: '#cfc8b8',
    yes: '#d5cec0',
  }
  const base = new THREE.Color(palette[sub] ?? '#d2cabb')
  const j = 0.92 + rnd * 0.16
  base.multiplyScalar(j)
  return base
}

function pick(seed: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return x - Math.floor(x)
}

export function buildSandbox(
  data: OsmData,
  hf: HeightField,
  toWorld: (lon: number, lat: number) => Vec2,
  opts: BuildOptions,
): BuildResult {
  const group = new THREE.Group()
  group.name = 'sandbox'
  const ele = opts.elevationScale
  const ground = (x: number, z: number) => (hf.ok ? sampleHeight(hf, x, z) * ele : 0)

  // ---------------- 地形 ----------------
  const n = hf.n
  const terrainGeo = new THREE.BufferGeometry()
  const pos = new Float32Array(n * n * 3)
  const col = new Float32Array(n * n * 3)
  const c = new THREE.Color()
  const lowC = new THREE.Color('#7c8068')
  const midC = new THREE.Color('#8d8a72')
  const highC = new THREE.Color('#a39a89')
  const waterC = new THREE.Color('#5c6a58')
  const range = Math.max(1e-6, hf.max - hf.min)
  for (let j = 0; j < n; j++) {
    const z = -hf.sizeZ / 2 + (hf.sizeZ * j) / (n - 1)
    for (let i = 0; i < n; i++) {
      const x = -hf.sizeX / 2 + (hf.sizeX * i) / (n - 1)
      const h = hf.heights[j * n + i] * ele
      const k = (j * n + i) * 3
      pos[k] = x
      pos[k + 1] = h
      pos[k + 2] = z
      const t = range > 2 ? Math.max(0, Math.min(1, (hf.heights[j * n + i] - hf.min) / range)) : 0.5
      if (t < 0.45) c.copy(waterC).lerp(lowC, t / 0.45)
      else if (t < 0.8) c.copy(lowC).lerp(midC, (t - 0.45) / 0.35)
      else c.copy(midC).lerp(highC, (t - 0.8) / 0.2)
      col[k] = c.r
      col[k + 1] = c.g
      col[k + 2] = c.b
    }
  }
  const idx: number[] = []
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i
      idx.push(a, a + n + 1, a + 1, a, a + n, a + n + 1)
    }
  }
  terrainGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  terrainGeo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  terrainGeo.setIndex(idx)
  terrainGeo.computeVertexNormals()
  const terrainMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    wireframe: opts.showWire,
  })
  const terrainMesh = new THREE.Mesh(terrainGeo, terrainMat)
  terrainMesh.name = 'terrain'
  terrainMesh.receiveShadow = true
  terrainMesh.castShadow = false
  group.add(terrainMesh)

  // ---------------- 建筑 ----------------
  const buildingGeos: THREE.BufferGeometry[] = []
  let buildingCount = 0
  if (opts.buildings) {
    for (const f of data.features) {
      if (f.kind !== 'building' || !f.closed) continue
      if (buildingCount >= 6000) break
      const ring = projectRing(f.coords, toWorld)
      const shape = shapeFromRing(ring)
      if (!shape) continue
      const [cxw, czw] = centroid(ring)
      const base = ground(cxw, czw) + 0.4
      const h = buildingHeight(f) * opts.heightScale
      let geo: THREE.BufferGeometry
      try {
        geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, steps: 1 })
      } catch {
        continue
      }
      geo.rotateX(-Math.PI / 2)
      geo.translate(0, base, 0)
      const g = prep(geo, buildingColor(f.subtype, pick(f.id)))
      buildingGeos.push(g)
      buildingCount++
    }
  }
  if (buildingGeos.length) {
    const merged = mergeGeometries(buildingGeos, false)
    if (merged) {
      merged.computeVertexNormals()
      const mesh = new THREE.Mesh(
        merged,
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.05 }),
      )
      mesh.name = 'buildings'
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
    }
  }

  // ---------------- 道路 / 铁路 ----------------
  let roadCount = 0
  if (opts.roads) {
    const roadGeos: THREE.BufferGeometry[] = []
    const railGeos: THREE.BufferGeometry[] = []
    for (const f of data.features) {
      if (f.kind !== 'road' && f.kind !== 'rail') continue
      const pts = projectRing(f.coords, toWorld)
      const width =
        f.kind === 'rail' ? 4 : (ROAD_WIDTH[f.subtype] ?? 5) * 1
      const g = ribbon(pts, width)
      if (!g.attributes.position || g.attributes.position.count === 0) continue
      const posAttr = g.attributes.position
      for (let i = 0; i < posAttr.count; i++) {
        const x = posAttr.getX(i)
        const z = posAttr.getZ(i)
        posAttr.setY(i, ground(x, z) + 0.45)
      }
      g.computeVertexNormals()
      const color =
        f.kind === 'rail'
          ? new THREE.Color('#4b4b4f')
          : f.subtype.startsWith('motorway') || f.subtype.startsWith('trunk')
            ? new THREE.Color('#6d6a63')
            : f.subtype.startsWith('primary') || f.subtype.startsWith('secondary')
              ? new THREE.Color('#6f6c66')
              : f.subtype === 'footway' || f.subtype === 'path' || f.subtype === 'steps'
                ? new THREE.Color('#8a8478')
                : new THREE.Color('#78746c')
      const pg = prep(g, color)
      if (f.kind === 'rail') railGeos.push(pg)
      else {
        roadGeos.push(pg)
        roadCount++
      }
    }
    for (const [arr, name, rough] of [
      [roadGeos, 'roads', 0.9],
      [railGeos, 'rails', 0.6],
    ] as const) {
      if (!arr.length) continue
      const merged = mergeGeometries(arr, false)
      if (!merged) continue
      const mesh = new THREE.Mesh(
        merged,
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: rough,
          metalness: 0.05,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      )
      mesh.name = name
      mesh.receiveShadow = true
      group.add(mesh)
    }
  }

  // ---------------- 水体 ----------------
  let waterCount = 0
  if (opts.water) {
    const waterGeos: THREE.BufferGeometry[] = []
    for (const f of data.features) {
      if (f.kind === 'water' && f.closed) {
        const ring = projectRing(f.coords, toWorld)
        const shape = shapeFromRing(ring)
        if (!shape) continue
        let lvl = Infinity
        for (const p of ring) lvl = Math.min(lvl, ground(p[0], p[1]))
        if (!Number.isFinite(lvl)) lvl = 0
        const geo = new THREE.ShapeGeometry(shape)
        geo.rotateX(-Math.PI / 2)
        geo.translate(0, lvl + 0.35, 0)
        waterGeos.push(prep(geo, new THREE.Color('#3d6b78')))
        waterCount++
      } else if (f.kind === 'waterway') {
        const pts = projectRing(f.coords, toWorld)
        const g = ribbon(pts, WATERWAY_WIDTH[f.subtype] ?? 5)
        if (!g.attributes.position) continue
        const posAttr = g.attributes.position
        for (let i = 0; i < posAttr.count; i++) {
          const x = posAttr.getX(i)
          const z = posAttr.getZ(i)
          posAttr.setY(i, ground(x, z) + 0.3)
        }
        g.computeVertexNormals()
        waterGeos.push(prep(g, new THREE.Color('#3d6b78')))
        waterCount++
      }
    }
    if (waterGeos.length) {
      const merged = mergeGeometries(waterGeos, false)
      if (merged) {
        const mesh = new THREE.Mesh(
          merged,
          new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.12,
            metalness: 0.35,
            transparent: true,
            opacity: 0.9,
            polygonOffset: true,
            polygonOffsetFactor: -3,
            polygonOffsetUnits: -3,
          }),
        )
        mesh.name = 'water'
        group.add(mesh)
      }
    }
  }

  // ---------------- 绿地 ----------------
  let greenCount = 0
  if (opts.green) {
    const greenGeos: THREE.BufferGeometry[] = []
    for (const f of data.features) {
      if (f.kind !== 'green' || !f.closed) continue
      const ring = projectRing(f.coords, toWorld)
      const shape = shapeFromRing(ring)
      if (!shape) continue
      let sum = 0
      let cnt = 0
      for (const p of ring) {
        sum += ground(p[0], p[1])
        cnt++
      }
      const lvl = cnt ? sum / cnt : 0
      const geo = new THREE.ShapeGeometry(shape)
      geo.rotateX(-Math.PI / 2)
      geo.translate(0, lvl + 0.25, 0)
      const col =
        f.subtype === 'forest'
          ? new THREE.Color('#3f5a3a')
          : f.subtype === 'farmland'
            ? new THREE.Color('#6f7050')
            : new THREE.Color('#4d6b42')
      greenGeos.push(prep(geo, col))
      greenCount++
    }
    if (greenGeos.length) {
      const merged = mergeGeometries(greenGeos, false)
      if (merged) {
        const mesh = new THREE.Mesh(
          merged,
          new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.98,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
          }),
        )
        mesh.name = 'green'
        mesh.receiveShadow = true
        group.add(mesh)
      }
    }
  }

  // ---------------- 沙盘底座 ----------------
  if (opts.plinth) {
    const depth = Math.max(6, (hf.max - hf.min) * 0.35 + 6)
    const baseY = (hf.min * ele) - depth / 2 - 0.5
    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(hf.sizeX * 1.01, depth, hf.sizeZ * 1.01),
      new THREE.MeshStandardMaterial({ color: '#2c2f33', roughness: 0.85, metalness: 0.1 }),
    )
    plinth.name = 'plinth'
    plinth.position.y = baseY - 0.2
    plinth.receiveShadow = true
    group.add(plinth)
  }

  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && opts.showWire) {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial
      m.wireframe = true
    }
  })

  let triangles = 0
  group.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh && m.geometry) {
      const g = m.geometry as THREE.BufferGeometry
      triangles += (g.index ? g.index.count : g.attributes.position.count) / 3
    }
  })

  return {
    group,
    stats: {
      buildings: buildingCount,
      roads: roadCount,
      water: waterCount,
      green: greenCount,
      triangles: Math.round(triangles),
      heightRange: [hf.min, hf.max],
    },
  }
}
