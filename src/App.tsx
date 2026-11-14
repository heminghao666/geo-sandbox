import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import Viewport, { type Preset, type ViewMode } from './components/Viewport'
import AreaPicker from './components/AreaPicker'
import { fetchRepoFile, getToken, parseRepoInput, setToken } from './lib/github'
import { bboxFromCenter, makeProjector, type BBox } from './lib/geo'
import { fetchOsm, type OsmData } from './lib/overpass'
import { fetchVectorData } from './lib/vectortiles'
import { loadTerrain, type HeightField } from './lib/terrain'
import { buildSandbox, type BuildOptions } from './lib/sceneBuilder'

type Scene = {
  osm: OsmData
  hf: HeightField
  toWorld: (lon: number, lat: number) => [number, number]
  sizeMeters: number
}

const DEFAULT = { lon: 116.397, lat: 39.9163, size: 900 }

function disposeGroup(g: THREE.Group) {
  g.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh) {
      m.geometry?.dispose()
      const mat = m.material as THREE.Material | THREE.Material[]
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
      else mat?.dispose()
    }
  })
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}

export default function App() {
  const [pickOpen, setPickOpen] = useState(false)
  const [area, setArea] = useState(DEFAULT)
  const [bbox, setBbox] = useState<BBox>(() => bboxFromCenter(DEFAULT.lat, DEFAULT.lon, DEFAULT.size))
  const [scene, setScene] = useState<Scene | null>(null)
  const [group, setGroup] = useState<THREE.Group | null>(null)
  const [stats, setStats] = useState<{
    buildings: number
    roads: number
    water: number
    green: number
    triangles: number
    heightRange: [number, number]
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [busyMsg, setBusyMsg] = useState('')
  const [toast, setToast] = useState('')
  const urlParams = new URLSearchParams(location.search)
  const [preset, setPreset] = useState<Preset>(
    (['day', 'dusk', 'night'] as Preset[]).includes(urlParams.get('preset') as Preset)
      ? (urlParams.get('preset') as Preset)
      : 'day',
  )
  const [view, setView] = useState<ViewMode>(urlParams.get('view') === 'top' ? 'top' : 'iso')
  const [source, setSource] = useState<'vector' | 'overpass'>('vector')
  const [ghPath, setGhPath] = useState('')
  const [ghToken, setGhTokenState] = useState(getToken())
  const [ghBusy, setGhBusy] = useState(false)
  const [ghMsg, setGhMsg] = useState('')
  const [imported, setImported] = useState<THREE.Group | null>(null)
  const [importedSize, setImportedSize] = useState(0)

  const [opts, setOpts] = useState<BuildOptions>({
    heightScale: 1,
    elevationScale: 1,
    buildings: true,
    roads: true,
    water: true,
    green: true,
    plinth: true,
    showWire: false,
  })

  const oldGroup = useRef<THREE.Group | null>(null)

  const say = (m: string) => {
    setToast(m)
    window.setTimeout(() => setToast(''), 2600)
  }

  const loadArea = useCallback(
    async (b: BBox, center: { lon: number; lat: number }, size: number) => {
      setBusy(true)
      setBusyMsg(source === 'overpass' ? '正在拉取 Overpass 数据…' : '正在拉取矢量瓦片与地形…')
      setPickOpen(false)
      try {
        const proj = makeProjector(b)
        const [w, h] = proj.sizeMeters()
        const hfPromise = loadTerrain(b, proj.center, [w, h], 141)
        const osmPromise = source === 'overpass' ? fetchOsm(b) : fetchVectorData(b)
        const [hf, osm] = await Promise.all([hfPromise, osmPromise])
        setArea({ ...center, size })
        setBbox(b)
        setScene({ osm, hf, toWorld: proj.toWorld, sizeMeters: Math.max(w, h) })
        if (!hf.ok) say(hf.message ?? '地形不可用，已退化为平面')
        else say(`已生成：建筑 ${osm.counts.building ?? 0} · 道路 ${osm.counts.road ?? 0}`)
      } catch (e: any) {
        setBusyMsg('')
        say(`加载失败：${e?.message ?? e}`)
      } finally {
        setBusy(false)
      }
    },
    [source],
  )

  // 首次进入自动加载默认区域
  useEffect(() => {
    loadArea(bboxFromCenter(DEFAULT.lat, DEFAULT.lon, DEFAULT.size), { lon: DEFAULT.lon, lat: DEFAULT.lat }, DEFAULT.size)
    const gh = new URLSearchParams(location.search).get('gh')
    if (gh) {
      setGhPath(gh)
      importFromGithub(gh)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 数据或参数变化 -> 重建几何
  useEffect(() => {
    if (!scene) return
    const t = window.setTimeout(() => {
      try {
        const res = buildSandbox(scene.osm, scene.hf, scene.toWorld, opts)
        setGroup((prev) => {
          if (prev) disposeGroup(prev)
          return res.group
        })
        setStats(res.stats)
      } catch (e: any) {
        say(`构建失败：${e?.message ?? e}`)
      }
    }, 90)
    return () => window.clearTimeout(t)
  }, [scene, opts])

  useEffect(() => {
    oldGroup.current = group
  }, [group])

  const exportGlb = () => {
    if (!group) return
    setBusy(true)
    setBusyMsg('正在导出 GLB…')
    const exporter = new GLTFExporter()
    exporter.parse(
      group,
      (result) => {
        if (result instanceof ArrayBuffer) {
          download(new Blob([result], { type: 'model/gltf-binary' }), 'geo-sandbox.glb')
        } else {
          download(new Blob([JSON.stringify(result)], { type: 'model/gltf+json' }), 'geo-sandbox.gltf')
        }
        const meta = {
          bbox,
          center: area,
          options: opts,
          stats,
          note: 'GLB 单位=米，Y 轴向上，原点 = 区域中心。用 blender/build_sandbox.py 导入。',
        }
        download(new Blob([JSON.stringify(meta, null, 2)], { type: 'application/json' }), 'geo-sandbox.meta.json')
        setBusy(false)
        say('已导出 geo-sandbox.glb，可交给 Blender')
      },
      (err) => {
        setBusy(false)
        say(`导出失败：${err}`)
      },
      { binary: true, onlyVisible: true },
    )
  }

  const exportGeoJSON = () => {
    if (!scene) return
    const fc = {
      type: 'FeatureCollection',
      features: scene.osm.features.map((f) => ({
        type: 'Feature',
        id: f.id,
        properties: { kind: f.kind, subtype: f.subtype, ...f.tags },
        geometry: { type: 'LineString', coordinates: f.coords },
      })),
    }
    download(new Blob([JSON.stringify(fc)], { type: 'application/json' }), 'geo-sandbox.osm.geojson')
    say('已导出 OSM GeoJSON')
  }

  const copyBlenderCmd = async () => {
    const cmd = 'npm run blender -- --glb geo-sandbox.glb --out sandbox.blend --render sandbox.png'
    try {
      await navigator.clipboard.writeText(cmd)
      say('命令已复制')
    } catch {
      say(cmd)
    }
  }

  // ---------------- GitHub ----------------
  const importFromGithub = async (input?: string) => {
    const raw = (input ?? ghPath).trim()
    if (!raw) {
      say('先填 owner/repo/文件路径，例如 someone/geo-sandbox/geo-sandbox.glb')
      return
    }
    setGhBusy(true)
    setGhMsg('正在读取仓库…')
    try {
      const ref = parseRepoInput(raw)
      const buf = await fetchRepoFile(ref)
      setGhMsg(`已下载 ${(buf.byteLength / 1048576).toFixed(2)} MB，解析中…`)
      const loader = new GLTFLoader()
      const gltf = await new Promise<any>((resolve, reject) =>
        loader.parse(buf as ArrayBuffer, '', resolve, reject),
      )
      const g: THREE.Group = gltf.scene
      const box = new THREE.Box3().setFromObject(g)
      const size = new THREE.Vector3()
      box.getSize(size)
      g.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) {
          m.castShadow = true
          m.receiveShadow = true
        }
      })
      if (imported) disposeGroup(imported)
      setImported(g)
      setImportedSize(Math.max(size.x, size.z))
      setGhMsg(`已导入 ${ref.owner}/${ref.repo} · ${ref.path}（${size.x.toFixed(0)}×${size.z.toFixed(0)} m）`)
      say('已载入 GitHub 上的模型')
    } catch (e: any) {
      setGhMsg(`导入失败：${e?.message ?? e}`)
    } finally {
      setGhBusy(false)
    }
  }

  const clearImported = () => {
    if (imported) disposeGroup(imported)
    setImported(null)
    setImportedSize(0)
    setGhMsg('已切回本地生成的沙盘')
  }

  const copyPublishCmd = async () => {
    const cmd =
      'node scripts/gh.mjs create --name geo-sandbox\n' +
      'npm run build\n' +
      'node scripts/gh.mjs push --repo <你的用户名>/geo-sandbox\n' +
      'node scripts/gh.mjs pages --repo <你的用户名>/geo-sandbox'
    try {
      await navigator.clipboard.writeText(cmd)
      say('发布命令已复制')
    } catch {
      say('见 README「发布到 GitHub」')
    }
  }

  const b = (k: keyof BuildOptions) => ({
    checked: opts[k] as boolean,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setOpts((o) => ({ ...o, [k]: e.target.checked })),
  })

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>
            Geo<span>Sandbox</span>
          </h1>
          <p>OpenStreetMap + three.js 三维沙盘 · 可导出 Blender</p>
        </div>

        <div className="section">
          <h2>区域</h2>
          <div className="stat">
            <span>中心</span>
            <b>
              {area.lat.toFixed(4)}, {area.lon.toFixed(4)}
            </b>
          </div>
          <div className="stat">
            <span>边长</span>
            <b>{area.size} m</b>
          </div>
          <div className="toggle" style={{ marginTop: 6 }}>
            数据源
            <select
              value={source}
              onChange={(e) => setSource(e.target.value as 'vector' | 'overpass')}
              className="btn"
              style={{ width: 'auto', padding: '4px 8px', fontSize: 12 }}
            >
              <option value="vector">矢量瓦片</option>
              <option value="overpass">Overpass</option>
            </select>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={() => setPickOpen(true)}>
              选择区域
            </button>
            <button className="btn" onClick={() => loadArea(bboxFromCenter(area.lat, area.lon, area.size), area, area.size)}>
              重新加载
            </button>
          </div>
        </div>

        <div className="section">
          <h2>图层</h2>
          <label className="toggle">
            建筑体块 <input type="checkbox" {...b('buildings')} />
          </label>
          <label className="toggle">
            道路 / 铁路 <input type="checkbox" {...b('roads')} />
          </label>
          <label className="toggle">
            水体 <input type="checkbox" {...b('water')} />
          </label>
          <label className="toggle">
            绿地 <input type="checkbox" {...b('green')} />
          </label>
          <label className="toggle">
            沙盘底座 <input type="checkbox" {...b('plinth')} />
          </label>
          <label className="toggle">
            线框模式 <input type="checkbox" {...b('showWire')} />
          </label>
        </div>

        <div className="section">
          <h2>参数</h2>
          <div className="slider-row">
            <label>
              建筑高度倍率 <b>{opts.heightScale.toFixed(2)}×</b>
            </label>
            <input
              type="range"
              min={0.2}
              max={3}
              step={0.05}
              value={opts.heightScale}
              onChange={(e) => setOpts((o) => ({ ...o, heightScale: Number(e.target.value) }))}
            />
          </div>
          <div className="slider-row">
            <label>
              地形起伏倍率 <b>{opts.elevationScale.toFixed(2)}×</b>
            </label>
            <input
              type="range"
              min={0}
              max={3}
              step={0.05}
              value={opts.elevationScale}
              onChange={(e) => setOpts((o) => ({ ...o, elevationScale: Number(e.target.value) }))}
            />
          </div>
        </div>

        <div className="section">
          <h2>视图</h2>
          <div className="row">
            {(['day', 'dusk', 'night'] as Preset[]).map((p) => (
              <button
                key={p}
                className={'btn' + (preset === p ? ' primary' : '')}
                onClick={() => setPreset(p)}
              >
                {p === 'day' ? '白天' : p === 'dusk' ? '黄昏' : '夜景'}
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className={'btn' + (view === 'iso' ? ' primary' : '')} onClick={() => setView('iso')}>
              轴测
            </button>
            <button className={'btn' + (view === 'top' ? ' primary' : '')} onClick={() => setView('top')}>
              俯视
            </button>
          </div>
        </div>

        <div className="section">
          <h2>导出</h2>
          <div className="row">
            <button className="btn primary" onClick={exportGlb} disabled={!group}>
              导出 GLB
            </button>
            <button className="btn" onClick={exportGeoJSON} disabled={!scene}>
              导出 GeoJSON
            </button>
          </div>
          <button className="btn" style={{ width: '100%', marginTop: 8 }} onClick={copyBlenderCmd}>
            复制 Blender 导入命令
          </button>
          <p className="hint">
            把 <code>geo-sandbox.glb</code> 放到项目根目录后执行上面的命令，Blender 会导入并渲染出图。
          </p>
        </div>

        <div className="section">
          <h2>GitHub</h2>
          <input
            className="field"
            placeholder="owner/repo/geo-sandbox.glb"
            value={ghPath}
            onChange={(e) => setGhPath(e.target.value)}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" onClick={() => importFromGithub()} disabled={ghBusy}>
              {ghBusy ? '读取中…' : '从 GitHub 导入'}
            </button>
            <button className="btn" onClick={clearImported} disabled={!imported}>
              切回本地
            </button>
          </div>
          <input
            className="field"
            type="password"
            style={{ marginTop: 8 }}
            placeholder="可选：PAT（私有仓库用，存在浏览器）"
            value={ghToken}
            onChange={(e) => {
              setGhTokenState(e.target.value)
              setToken(e.target.value.trim())
            }}
          />
          <button className="btn" style={{ width: '100%', marginTop: 8 }} onClick={copyPublishCmd}>
            复制发布命令（create / push / pages）
          </button>
          <p className="hint">
            {ghMsg || '发布走 api.github.com（Git Data API），不依赖 git push；github.com 网页打不开也能发。'}
          </p>
        </div>

        <div className="section" style={{ borderBottom: 0 }}>
          <h2>统计</h2>
          <div className="stat">
            <span>建筑</span>
            <b>{stats?.buildings ?? '—'}</b>
          </div>
          <div className="stat">
            <span>道路</span>
            <b>{stats?.roads ?? '—'}</b>
          </div>
          <div className="stat">
            <span>水体 / 绿地</span>
            <b>
              {stats ? `${stats.water} / ${stats.green}` : '—'}
            </b>
          </div>
          <div className="stat">
            <span>三角面</span>
            <b>{stats ? stats.triangles.toLocaleString() : '—'}</b>
          </div>
          <div className="stat">
            <span>地形</span>
            <b>{scene?.hf.message ?? '—'}</b>
          </div>
          <div style={{ marginTop: 8 }}>
            <span className={'badge' + (scene?.hf.ok ? '' : ' warn')}>
              {scene ? (scene.hf.ok ? 'DEM 已接入' : '平面退化') : '未加载'}
            </span>
          </div>
        </div>
      </aside>

      <main className="viewport">
        <Viewport
          group={imported ?? group}
          preset={preset}
          view={view}
          size={imported ? importedSize || 700 : (scene?.sizeMeters ?? 700)}
        />
        <div className="overlay">
          <kbd>左键拖拽</kbd> 旋转 · <kbd>滚轮</kbd> 缩放 · <kbd>右键</kbd> 平移
          <br />
          1 单位 = 1 米 · 数据 © OpenStreetMap contributors
        </div>
        {busy && (
          <div className="loading">
            <div style={{ display: 'grid', placeItems: 'center' }}>
              <div className="spinner" />
              <div className="loading-msg">{busyMsg}</div>
            </div>
          </div>
        )}
      </main>

      {pickOpen && (
        <AreaPicker
          initial={area}
          onClose={() => setPickOpen(false)}
          onConfirm={(bp, c, s) => loadArea(bp, c, s)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
