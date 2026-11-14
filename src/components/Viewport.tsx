import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'

export type Preset = 'day' | 'dusk' | 'night'
export type ViewMode = 'iso' | 'top'

const PRESETS: Record<
  Preset,
  { bg: string; sun: string; sunI: number; amb: string; ambI: number; hemi: string; hemiI: number; fog: number }
> = {
  day: { bg: '#cfe0ee', sun: '#fff6e2', sunI: 2.4, amb: '#bcd0e4', ambI: 0.7, hemi: '#dfe9f2', hemiI: 0.9, fog: 0.00022 },
  dusk: { bg: '#3a3348', sun: '#ff9a5c', sunI: 1.5, amb: '#5d5a7a', ambI: 0.55, hemi: '#8a6f7a', hemiI: 0.5, fog: 0.0003 },
  night: { bg: '#0a1120', sun: '#a9c2ff', sunI: 1.5, amb: '#2e4468', ambI: 1.0, hemi: '#26364f', hemiI: 0.85, fog: 0.00028 },
}

function Model({ group }: { group: THREE.Group | null }) {
  const scene = useThree((s) => s.scene)
  useEffect(() => {
    if (!group) return
    scene.add(group)
    return () => {
      scene.remove(group)
    }
  }, [group, scene])
  return null
}

function Rig({ size, view }: { size: number; view: ViewMode }) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as any
  useEffect(() => {
    const d = Math.max(120, size * 1.25)
    if (view === 'top') {
      camera.position.set(0.001, d * 1.15, d * 0.28)
    } else {
      camera.position.set(d * 0.62, d * 0.55, d * 0.78)
    }
    camera.near = 1
    camera.far = Math.max(20000, d * 30)
    camera.updateProjectionMatrix()
    if (controls?.target) {
      controls.target.set(0, 0, 0)
      controls.update()
    }
  }, [size, view, camera, controls])
  return null
}

export default function Viewport({
  group,
  preset,
  view,
  size,
}: {
  group: THREE.Group | null
  preset: Preset
  view: ViewMode
  size: number
}) {
  const p = PRESETS[preset]
  const bg = useMemo(() => new THREE.Color(p.bg), [p.bg])
  const sunRef = useRef<THREE.DirectionalLight>(null)
  const shadowExtent = Math.max(60, size * 0.75)

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ position: [400, 350, 500], fov: 42, near: 1, far: 40000 }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping
        gl.toneMappingExposure = preset === 'night' ? 1.7 : 1.05
      }}
    >
      <color attach="background" args={[bg]} />
      <fogExp2 attach="fog" args={[bg, p.fog]} />

      <hemisphereLight args={[p.hemi, '#2a2a26', p.hemiI]} />
      <ambientLight color={p.amb} intensity={p.ambI} />
      <directionalLight
        ref={sunRef}
        color={p.sun}
        intensity={p.sunI}
        position={[size * 0.7, size * 0.9, size * 0.5]}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={shadowExtent * 6}
        shadow-camera-left={-shadowExtent}
        shadow-camera-right={shadowExtent}
        shadow-camera-top={shadowExtent}
        shadow-camera-bottom={-shadowExtent}
        shadow-bias={-0.0006}
      />

      <Model group={group} />
      <Rig size={size} view={view} />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        maxPolarAngle={Math.PI / 2.04}
        minDistance={20}
        maxDistance={size * 8}
      />
    </Canvas>
  )
}
