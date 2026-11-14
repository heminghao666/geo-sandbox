import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import { bboxFromCenter, type BBox } from '../lib/geo'

const PRESETS: { name: string; lon: number; lat: number; size: number }[] = [
  { name: '上海 · 外滩', lon: 121.49, lat: 31.2397, size: 700 },
  { name: '北京 · 故宫', lon: 116.397, lat: 39.9163, size: 900 },
  { name: '杭州 · 西湖', lon: 120.145, lat: 30.2489, size: 1600 },
  { name: '深圳 · 福田 CBD', lon: 114.06, lat: 22.54, size: 900 },
  { name: '重庆 · 洪崖洞', lon: 106.5836, lat: 29.5628, size: 600 },
  { name: '威尼斯 · 圣马可', lon: 12.3388, lat: 45.4342, size: 700 },
]

function bboxPolygon(b: BBox) {
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [b.west, b.south],
          [b.east, b.south],
          [b.east, b.north],
          [b.west, b.north],
          [b.west, b.south],
        ],
      ],
    },
  }
}

export default function AreaPicker({
  initial,
  onConfirm,
  onClose,
}: {
  initial: { lon: number; lat: number; size: number }
  onConfirm: (b: BBox, center: { lon: number; lat: number }, size: number) => void
  onClose: () => void
}) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapObj = useRef<maplibregl.Map | null>(null)
  const [center, setCenter] = useState({ lon: initial.lon, lat: initial.lat })
  const [size, setSize] = useState(initial.size)
  const [ready, setReady] = useState(false)

  const bbox = bboxFromCenter(center.lat, center.lon, size)

  useEffect(() => {
    if (!mapRef.current || mapObj.current) return
    const rasterStyle = {
      version: 8 as const,
      sources: {
        osm: {
          type: 'raster' as const,
          tiles: [
            'https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
            'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          ],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors',
        },
      },
      layers: [{ id: 'osm', type: 'raster' as const, source: 'osm' }],
    }
    const map = new maplibregl.Map({
      container: mapRef.current,
      // OpenFreeMap：免费、无需 key 的 OpenStreetMap 矢量底图
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [initial.lon, initial.lat],
      zoom: 15,
      attributionControl: { compact: true },
    })
    let swapped = false
    map.on('error', () => {
      if (!swapped) {
        swapped = true
        map.setStyle(rasterStyle)
      }
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.on('load', () => {
      map.addSource('bbox', { type: 'geojson', data: bboxPolygon(bboxFromCenter(initial.lat, initial.lon, initial.size)) })
      map.addLayer({
        id: 'bbox-fill',
        type: 'fill',
        source: 'bbox',
        paint: { 'fill-color': '#63d2a4', 'fill-opacity': 0.18 },
      })
      map.addLayer({
        id: 'bbox-line',
        type: 'line',
        source: 'bbox',
        paint: { 'line-color': '#63d2a4', 'line-width': 2 },
      })
      setReady(true)
    })
    map.on('moveend', () => {
      const c = map.getCenter()
      setCenter({ lon: c.lng, lat: c.lat })
    })
    mapObj.current = map
    return () => {
      map.remove()
      mapObj.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapObj.current
    if (!map || !ready) return
    const src = map.getSource('bbox') as maplibregl.GeoJSONSource | undefined
    src?.setData(bboxPolygon(bboxFromCenter(center.lat, center.lon, size)))
  }, [center, size, ready])

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setSize(p.size)
    setCenter({ lon: p.lon, lat: p.lat })
    mapObj.current?.jumpTo({ center: [p.lon, p.lat], zoom: 15 })
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>选择沙盘范围 · OpenStreetMap</h3>
          <button className="btn ghost" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="modal-body">
          <div className="map-wrap">
            <div id="pick-map" ref={mapRef} />
          </div>
          <div className="modal-side">
            <div>
              <div className="section" style={{ padding: 0, border: 0 }}>
                <h2>快速定位</h2>
              </div>
              <div style={{ display: 'grid', gap: 6 }}>
                {PRESETS.map((p) => (
                  <button key={p.name} className="btn preset" onClick={() => applyPreset(p)}>
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="slider-row">
              <label>
                范围边长 <b>{size} m</b>
              </label>
              <input
                type="range"
                min={200}
                max={3000}
                step={50}
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
              />
            </div>
            <div className="hint">
              拖动地图改变中心点，绿色方框即沙盘范围。范围越大，Overpass 取数越慢。
            </div>
            <div className="coord">
              center {center.lat.toFixed(5)}, {center.lon.toFixed(5)}
              <br />
              bbox {bbox.south.toFixed(5)}, {bbox.west.toFixed(5)}, {bbox.north.toFixed(5)}, {bbox.east.toFixed(5)}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <span className="hint">数据来源：OpenStreetMap（ODbL）+ Terrarium DEM</span>
          <div className="row" style={{ maxWidth: 260 }}>
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button className="btn primary" onClick={() => onConfirm(bbox, center, size)}>
              生成沙盘
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
