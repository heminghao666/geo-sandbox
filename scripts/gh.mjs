#!/usr/bin/env node
/**
 * GitHub 集成 CLI —— 全部走 REST API（api.github.com），不依赖 github.com / git push
 *
 * 用法：
 *   node scripts/gh.mjs status                       # 检查 token / 限额 / 登录身份
 *   node scripts/gh.mjs create --name geo-sandbox    # 建仓库（默认 public）
 *   node scripts/gh.mjs push --repo owner/name       # 用 Git Data API 提交整个目录
 *   node scripts/gh.mjs pages --repo owner/name      # 开启 GitHub Pages（main 分支根目录）
 *   node scripts/gh.mjs list --repo owner/name       # 列仓库根目录
 *
 * Token 来源（按优先级）：--token 参数 > GITHUB_TOKEN 环境变量 > .github-token 文件 > git config github.token
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const API = 'https://api.github.com'

const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (name, def = undefined) => {
  const i = argv.indexOf('--' + name)
  if (i < 0) return def
  const v = argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const has = (n) => argv.includes('--' + n)

function readToken() {
  if (typeof flag('token') === 'string') return flag('token')
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim()
  const f = path.join(ROOT, '.github-token')
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim()
  try {
    return execSync('git config --get github.token', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

const TOKEN = readToken()

async function api(pathname, { method = 'GET', body, raw = false, headers = {} } = {}) {
  const res = await fetch(API + pathname, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'geo-sandbox-cli',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (raw) return res
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const msg = json?.message || res.statusText
    const err = new Error(`${method} ${pathname} -> ${res.status} ${msg}`)
    err.status = res.status
    err.payload = json
    throw err
  }
  return json
}

// ---------------------------------------------------------------- 文件收集
const SKIP_DIRS = new Set(['node_modules', '.git', '.vite', '__pycache__', '.cache'])
const SKIP_EXT = new Set(['.blend', '.blend1', '.exe', '.dll', '.psd'])
const MAX_FILE = 40 * 1024 * 1024

function collect(dir, base = '', out = [], opts = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.name === 'dist' && opts.noDist) continue
      collect(full, rel, out, opts)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (SKIP_EXT.has(ext)) continue
      if (entry.name === '.github-token') continue
      if (entry.name === '.gitignore') continue
      if (entry.name.startsWith('_') && ext === '.log') continue
      const size = fs.statSync(full).size
      if (size > MAX_FILE) {
        console.warn(`  跳过超大文件 ${rel} (${(size / 1048576).toFixed(1)} MB)`)
        continue
      }
      out.push({ rel, full, size })
    }
  }
  return out
}

// ---------------------------------------------------------------- 命令
async function status() {
  console.log(`token: ${TOKEN ? '已配置 (' + TOKEN.slice(0, 4) + '…' + TOKEN.slice(-3) + ')' : '未配置'}`)
  try {
    const rl = await api('/rate_limit')
    console.log(`限额: core ${rl.resources.core.remaining}/${rl.resources.core.limit}  (重置 ${new Date(rl.resources.core.reset * 1000).toLocaleTimeString()})`)
  } catch (e) {
    console.log('限额查询失败:', e.message)
  }
  if (TOKEN) {
    try {
      const me = await api('/user')
      console.log(`身份: ${me.login}  (${me.name || '-'})  repos=${me.public_repos}`)
    } catch (e) {
      console.log('身份查询失败:', e.message)
    }
  } else {
    console.log('提示: 建仓库/推送需要 token（repo 权限）—— 写进 .github-token 或设 GITHUB_TOKEN')
  }
}

async function create() {
  if (!TOKEN) throw new Error('需要 GITHUB_TOKEN')
  const name = flag('name', 'geo-sandbox')
  const privateRepo = has('private')
  const body = {
    name,
    description: flag('desc', 'OSM 三维沙盘工具 · React + three.js + Blender'),
    private: privateRepo,
    auto_init: false,
    has_issues: true,
    has_wiki: false,
  }
  const repo = await api('/user/repos', { method: 'POST', body })
  console.log(`已创建 ${repo.full_name}  (${repo.private ? 'private' : 'public'})`)
  console.log(`  ${repo.html_url}`)
  return repo
}

async function pushTo(owner, repo, { branch, message, noDist = false } = {}) {
  if (!TOKEN) throw new Error('推送需要 token（GITHUB_TOKEN / .github-token）')
  message = message || `update: ${new Date().toISOString()}`

  const info = await api(`/repos/${owner}/${repo}`)
  branch = branch || info.default_branch || 'main'

  const files = collect(ROOT, '', [], { noDist })
  const total = files.reduce((s, f) => s + f.size, 0)
  console.log(`待上传 ${files.length} 个文件 / ${(total / 1048576).toFixed(2)} MB → ${owner}/${repo}@${branch}`)

  // 1) 现有 head（可能不存在 = 初始提交）
  let headSha = null
  let baseTree = null
  try {
    const ref = await api(`/repos/${owner}/${repo}/git/ref/heads/${branch}`)
    headSha = ref.object.sha
    const commit = await api(`/repos/${owner}/${repo}/git/commits/${headSha}`)
    baseTree = commit.tree.sha
  } catch (e) {
    if (e.status !== 404 && e.status !== 409) throw e
  }

  // 空仓库：Git Data API 会 409（Git Repository is empty），先用 contents API 打一个初始提交
  if (!headSha) {
    console.log('  仓库为空，先用 contents API 创建初始提交')
    await api(`/repos/${owner}/${repo}/contents/README.md`, {
      method: 'PUT',
      body: {
        message: 'init: created by geo-sandbox',
        content: Buffer.from(`# ${repo}\n\nbootstrapped by geo-sandbox\n`, 'utf8').toString('base64'),
        branch,
      },
    })
    const ref = await api(`/repos/${owner}/${repo}/git/ref/heads/${branch}`)
    headSha = ref.object.sha
    const commit = await api(`/repos/${owner}/${repo}/git/commits/${headSha}`)
    baseTree = commit.tree.sha
  }

  // 2) blob（并发 4）
  const blobs = []
  let done = 0
  const queue = [...files]
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const f = queue.shift()
      const content = fs.readFileSync(f.full).toString('base64')
      const blob = await api(`/repos/${owner}/${repo}/git/blobs`, {
        method: 'POST',
        body: { content, encoding: 'base64' },
      })
      blobs.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha })
      done++
      if (done % 10 === 0 || done === files.length) process.stdout.write(`\r  上传 ${done}/${files.length}`)
    }
  })
  await Promise.all(workers)
  process.stdout.write('\n')

  // 3) tree
  const tree = await api(`/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    body: { base_tree: baseTree ?? undefined, tree: blobs },
  })

  // 4) commit
  const commit = await api(`/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: { message, tree: tree.sha, parents: headSha ? [headSha] : [] },
  })

  // 5) 更新 ref
  if (headSha) {
    await api(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      body: { sha: commit.sha, force: false },
    })
  } else {
    await api(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha: commit.sha },
    })
  }
  console.log(`已提交 ${commit.sha.slice(0, 7)} → https://github.com/${owner}/${repo}/tree/${branch}`)
}

async function pages() {
  if (!TOKEN) throw new Error('需要 token')
  const repoArg = flag('repo')
  if (!repoArg) throw new Error('需要 --repo owner/name')
  const [owner, repo] = String(repoArg).split('/')
  const info = await api(`/repos/${owner}/${repo}`)
  const branch = typeof flag('branch') === 'string' ? flag('branch') : info.default_branch || 'main'
  try {
    const r = await api(`/repos/${owner}/${repo}/pages`, {
      method: 'POST',
      body: { source: { branch, path: '/' } },
    })
    console.log(`Pages 已开启: ${r.html_url || `https://${owner}.github.io/${repo}/`}`)
  } catch (e) {
    if (e.status === 409) console.log('Pages 已经开启过了')
    else throw e
  }
  const page = await api(`/repos/${owner}/${repo}/pages`)
  console.log(`站点: ${page.html_url}  状态: ${page.status}`)
}

async function list() {
  const repoArg = flag('repo')
  if (!repoArg) throw new Error('需要 --repo owner/name')
  const dir = flag('path', '')
  const items = await api(`/repos/${repoArg}/contents/${dir}`)
  for (const it of items) console.log(`${it.type === 'dir' ? 'd' : '-'} ${String(it.size ?? '').padStart(9)}  ${it.path}`)
}

// ---------------------------------------------------------------- token 落盘
function readClipboard() {
  try {
    return execSync('powershell -NoProfile -Command Get-Clipboard', { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

async function tokenCmd() {
  let t = typeof flag('set') === 'string' ? String(flag('set')).trim() : ''
  if (!t && has('clip')) t = readClipboard()
  if (!t) t = readClipboard()
  if (!t) throw new Error('没读到 token：用 --set <token>，或先复制 token 再执行 --clip')
  if (!/^(gh[pousr]_|github_pat_)/.test(t)) console.warn('提醒: 这个串不像 GitHub token（通常以 ghp_ / github_pat_ 开头），仍会写入')
  const f = path.join(ROOT, '.github-token')
  fs.writeFileSync(f, t + '\n')
  console.log(`已写入 ${f}`)
  const me = await api('/user', { headers: { Authorization: `Bearer ${t}` } })
  console.log(`验证通过: ${me.login}  (${me.name || '-'})  public=${me.public_repos} private=${me.total_private_repos ?? '?'}`)
  console.log(`下一步: npm run gh publish --repo ${me.login}/geo-sandbox`)
}

// ---------------------------------------------------------------- 一键发布
async function publish() {
  if (!TOKEN) throw new Error('先配置 token：npm run gh -- token --clip')
  const me = await api('/user')
  const repoArg = flag('repo')
  const name = repoArg
    ? String(repoArg).includes('/')
      ? String(repoArg).split('/')[1]
      : String(repoArg)
    : 'geo-sandbox'
  const owner = String(repoArg || '').includes('/') ? String(repoArg).split('/')[0] : me.login

  let exists = true
  try {
    await api(`/repos/${owner}/${name}`)
    console.log(`仓库已存在: ${owner}/${name}`)
  } catch (e) {
    if (e.status !== 404) throw e
    exists = false
  }
  if (!exists) {
    await api('/user/repos', {
      method: 'POST',
      body: {
        name,
        description: 'OSM 三维沙盘工具 · React + three.js + Blender',
        private: has('private'),
        auto_init: false,
      },
    })
    console.log(`仓库已创建: ${owner}/${name}`)
  }

  console.log('构建 dist …')
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true })
  if (r.status !== 0) throw new Error('构建失败，先修掉上面的报错')

  await pushTo(owner, name, { message: flag('message', 'deploy: geo-sandbox build') })

  const repoInfo = await api(`/repos/${owner}/${name}`)
  const br = repoInfo.default_branch || 'main'
  try {
    await api(`/repos/${owner}/${name}/pages`, {
      method: 'POST',
      body: { source: { branch: br, path: '/' } },
    })
    console.log('Pages 已开启')
  } catch (e) {
    if (e.status === 409) console.log('Pages 之前已开启')
    else if (e.status === 422 || e.status === 403) console.log(`Pages 没开成（${e.message}）—— 去 Settings → Pages 手动选 ${br} / root`)
    else throw e
  }
  const info = await api(`/repos/${owner}/${name}/pages`).catch(() => null)
  console.log('\n完成。')
  console.log(`  仓库: https://github.com/${owner}/${name}`)
  console.log(`  站点: ${info?.html_url ?? `https://${owner}.github.io/${name}/`}  (首次部署约 1 分钟)`)
}

const HELP = `geo-sandbox GitHub CLI（走 REST API）

  node scripts/gh.mjs token --clip            # 从剪贴板取 token 写入 .github-token 并验证
  node scripts/gh.mjs token --set ghp_xxx
  node scripts/gh.mjs publish [--repo owner/name] [--private]   # 建仓 + 构建 + 推送 + 开 Pages
  node scripts/gh.mjs status
  node scripts/gh.mjs create --name geo-sandbox [--private] [--desc "..."]
  node scripts/gh.mjs push   --repo owner/name [--branch main] [--message "..."] [--no-dist]
  node scripts/gh.mjs pages  --repo owner/name
  node scripts/gh.mjs list   --repo owner/name [--path dist]

Token: GITHUB_TOKEN / .github-token / git config github.token
`

function pushCmd() {
  const repoArg = flag('repo')
  if (!repoArg) throw new Error('需要 --repo owner/name')
  const [owner, repo] = String(repoArg).split('/')
  return pushTo(owner, repo, {
    branch: flag('branch', 'main'),
    message: flag('message'),
    noDist: has('no-dist'),
  })
}

try {
  if (cmd === 'status') await status()
  else if (cmd === 'token') await tokenCmd()
  else if (cmd === 'publish') await publish()
  else if (cmd === 'create') await create()
  else if (cmd === 'push') await pushCmd()
  else if (cmd === 'pages') await pages()
  else if (cmd === 'list') await list()
  else console.log(HELP)
} catch (e) {
  console.error(`错误: ${e.message}`)
  if (e.payload?.errors) console.error(JSON.stringify(e.payload.errors, null, 2))
  process.exitCode = 1
}
