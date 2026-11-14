/**
 * 浏览器端 GitHub 读取（全部走 api.github.com，CORS 开放）
 * 用 Git Data API 取 blob，绕开 contents API 的 1MB base64 限制。
 */
const API = 'https://api.github.com'
const TOKEN_KEY = 'geo-sandbox.gh-token'

export type RepoRef = { owner: string; repo: string; path: string; ref: string }

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}
export function setToken(t: string) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

/** 支持 "owner/repo/path/to.glb"、"https://github.com/o/r/blob/main/x.glb"、"o/r@branch/path" */
export function parseRepoInput(input: string): RepoRef {
  let s = input.trim()
  let ref = 'HEAD'
  const mRef = s.match(/@([^/]+)\//)
  if (mRef && !s.startsWith('http')) {
    ref = mRef[1]
    s = s.replace('@' + mRef[1] + '/', '/')
  }
  s = s.replace(/^https?:\/\/github\.com\//, '')
  const parts = s.split('/').filter(Boolean)
  if (parts.length < 3) throw new Error('格式应为 owner/repo/文件路径')
  const owner = parts[0]
  const repo = parts[1]
  let rest = parts.slice(2)
  let branch = ref
  if (rest[0] === 'blob' || rest[0] === 'tree' || rest[0] === 'raw') {
    rest = rest.slice(1)
    if (rest.length > 1) {
      branch = rest[0]
      rest = rest.slice(1)
    }
  }
  return { owner, repo, path: rest.join('/'), ref: branch }
}

async function api<T = any>(pathname: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const res = await fetch(API + pathname, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  })
  if (!res.ok) {
    const txt = await res.text()
    let msg = `${res.status}`
    try {
      msg = JSON.parse(txt).message || msg
    } catch {
      /* ignore */
    }
    throw new Error(`GitHub API ${pathname} → ${res.status} ${msg}`)
  }
  return (await res.json()) as T
}

export type RepoFile = { path: string; size: number; sha: string }

/** 列出仓库内所有 glb / gltf / geojson 文件 */
export async function listSceneFiles(ref: RepoRef): Promise<RepoFile[]> {
  const tree = await api<{ tree: { path: string; type: string; size?: number; sha: string }[] }>(
    `/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(ref.ref)}?recursive=1`,
  )
  return (tree.tree || [])
    .filter((t) => t.type === 'blob' && /\.(glb|gltf|geojson|json)$/i.test(t.path))
    .map((t) => ({ path: t.path, size: t.size ?? 0, sha: t.sha }))
    .slice(0, 400)
}

/** 取任意大小的文件二进制（Git Data API blob → base64） */
export async function fetchRepoFile(ref: RepoRef): Promise<ArrayBuffer> {
  const tree = await api<{ tree: { path: string; type: string; sha: string }[] }>(
    `/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(ref.ref)}?recursive=1`,
  )
  const hit = (tree.tree || []).find((t) => t.type === 'blob' && t.path === ref.path)
  if (!hit) throw new Error(`仓库里没有这个文件：${ref.path}`)
  const blob = await api<{ content: string; encoding: string }>(
    `/repos/${ref.owner}/${ref.repo}/git/blobs/${hit.sha}`,
  )
  if (blob.encoding !== 'base64') throw new Error('意外的 blob 编码：' + blob.encoding)
  const bin = atob(blob.content.replace(/\n/g, ''))
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf.buffer
}

export async function repoInfo(ref: RepoRef) {
  return api<{ full_name: string; html_url: string; default_branch: string; description: string }>(
    `/repos/${ref.owner}/${ref.repo}`,
  )
}
