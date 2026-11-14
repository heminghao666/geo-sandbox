#!/usr/bin/env node
// 用本机 Blender 打开/渲染沙盘 GLB
// 用法： node scripts/blender.mjs --glb geo-sandbox.glb --out sandbox.blend --render sandbox.png
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function findBlender() {
  const candidates = []
  if (process.env.BLENDER_PATH) candidates.push(process.env.BLENDER_PATH)
  for (const drive of ['D:', 'C:', 'E:']) {
    const base = `${drive}\\Blender`
    if (fs.existsSync(base)) {
      for (const d of fs.readdirSync(base)) {
        if (/^blender-?/i.test(d) || /^\d+\.\d+/.test(d)) candidates.push(path.join(base, d, 'blender.exe'))
      }
    }
  }
  candidates.push('C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe')
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

const args = process.argv.slice(2)
const get = (k, d) => {
  const i = args.indexOf('--' + k)
  return i >= 0 ? args[i + 1] : d
}
const has = (k) => args.includes('--' + k)

const glb = path.resolve(ROOT, get('glb', 'geo-sandbox.glb'))
const out = path.resolve(ROOT, get('out', 'sandbox.blend'))
const render = path.resolve(ROOT, get('render', 'sandbox.png'))
const engine = get('engine', 'CYCLES')
const samples = get('samples', '64')
const res = get('res', '1600x900')
const preset = get('preset', 'day')

if (!fs.existsSync(glb)) {
  console.error(`[blender] 找不到 GLB：${glb}`)
  console.error('[blender] 先在网页里点「导出 GLB」，把文件放到项目根目录，或改 --glb 路径')
  process.exit(2)
}

const blender = findBlender()
if (!blender) {
  console.error('[blender] 没找到 blender.exe，请设置环境变量 BLENDER_PATH 指向它')
  process.exit(3)
}

const script = path.join(ROOT, 'blender', 'build_sandbox.py')
const argv = [
  '-b',
  '-P',
  script,
  '--',
  '--glb',
  glb,
  '--out',
  out,
  '--render',
  render,
  '--engine',
  engine,
  '--samples',
  samples,
  '--res',
  res,
  '--preset',
  preset,
]

console.log(`[blender] ${blender} ${argv.join(' ')}`)
const r = spawnSync(blender, argv, { stdio: 'inherit' })
process.exit(r.status ?? 0)
