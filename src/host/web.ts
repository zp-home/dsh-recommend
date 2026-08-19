/**
 * dsh-recommend web 半：把本地缓存的 registry.json / history.json 以同源路由供给浏览器，
 * 提供 POST /dsh-recommend/sync 供设置页「刷新数据」按钮触发更新，
 * 并提供 POST /dsh-recommend/install 供设置页「一键安装」按钮触发 `dsh plugin add`（M3）。
 *
 * 独立成行（而非并入 host 工具半）是因为 cordis 的 inject 是强依赖：
 * webServer 只在 web profile 存在，headless 下挂载本行会永远 PENDING。
 * 所以 tools 半（main）不带 webServer，本半（./web）带，由 patch 分两行挂载。
 *
 * 安装安全边界：
 *   1. 客户端只能按 fullName 安装，spec 由服务端从缓存 registry 构造
 *      （`github:owner/repo`），绝不接受客户端传来的任意字符串 —— 防注入；
 *   2. Origin 校验：仅接受同源（或空 Origin，如 curl 本机）请求 —— 防 CSRF
 *      （恶意网页让本地 DSH 装任意插件）；
 *   3. 安装命令交给官方 `dsh plugin --profile <name> add <spec>`，由它完成
 *      profile 初始化、pnpm 安装与 bundles 对账，本行只转发输出。
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { syncRegistry, syncRegistryIfStale, type RegistrySyncConfig } from './sync.ts'

export const name = 'dsh-recommend-web'
export const inject = ['webServer']

export interface Config extends RegistrySyncConfig {
  /** 可选：安装目标 profile 名；缺省为 web（浏览器半所在的 profile）。 */
  installProfile?: string
}

/** 安装/更新超时：pnpm 拉取 git 依赖可能很慢，给足 10 分钟。 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
const UPDATE_TIMER_MS = 15 * 60 * 1000
const PACKAGE_NAME_PATTERN = /^@?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SITE_DIR = join(PACKAGE_ROOT, 'site')
const SITE_ASSETS = [
  { route: '/dsh-recommend/site/', file: 'index.html', type: 'text/html; charset=utf-8' },
  { route: '/dsh-recommend/site/index.html', file: 'index.html', type: 'text/html; charset=utf-8' },
  { route: '/dsh-recommend/site/rankings.html', file: 'rankings.html', type: 'text/html; charset=utf-8' },
  { route: '/dsh-recommend/site/style.css', file: 'style.css', type: 'text/css; charset=utf-8' },
  { route: '/dsh-recommend/site/app.js', file: 'app.js', type: 'text/javascript; charset=utf-8' },
  { route: '/dsh-recommend/site/rankings.js', file: 'rankings.js', type: 'text/javascript; charset=utf-8' },
]

type UpdateMode = 'notify' | 'auto'
interface UpdatePolicy {
  mode: UpdateMode
  intervalHours: number
  allowlist: string[]
  lastAutoRunAt?: string | null
}
interface UpdateItem {
  packageName: string
  spec: string
  source: 'github' | 'npm' | 'unknown'
  installed: string | null
  latest: string | null
  updateAvailable: boolean
  error?: string
}

function profileDirFromCache(cachePath: string, profile: string): string {
  const dshHome = dirname(dirname(cachePath))
  return join(dshHome, 'profiles', profile)
}

function updatePolicyPath(cachePath: string): string {
  return join(dirname(cachePath), 'update-policy.json')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseGithubSpec(spec: string): { owner: string; repo: string } | null {
  const match = spec.match(/^(?:github:|https?:\/\/github\.com\/|git\+https:\/\/github\.com\/)([^/]+)\/([^/#]+)(?:#.*)?$/i)
  const owner = match?.[1]
  const repo = match?.[2]
  return owner && repo ? { owner, repo: repo.replace(/\.git$/, '') } : null
}

function isLocalSpec(spec: string): boolean {
  return /^(?:link:|file:|\.{1,2}(?:[\\/]|$)|[A-Za-z]:[\\/]|[\\/])/.test(spec)
}

function compareSemver(a: string | null, b: string | null): number | null {
  const parse = (value: string | null) => {
    const m = value?.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)
    return m ? m.slice(1).map(Number) : null
  }
  const left = parse(a ?? '')
  const right = parse(b ?? '')
  if (!left || !right) return null
  for (let i = 0; i < 3; i += 1) {
    const lv = left[i] ?? 0
    const rv = right[i] ?? 0
    if (lv !== rv) return lv > rv ? 1 : -1
  }
  return 0
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T } catch { return fallback }
}

async function loadUpdatePolicy(cachePath: string): Promise<UpdatePolicy> {
  const policy = await readJsonFile<Partial<UpdatePolicy>>(updatePolicyPath(cachePath), {})
  return {
    mode: policy.mode === 'auto' ? 'auto' : 'notify',
    intervalHours: Math.min(168, Math.max(1, Number(policy.intervalHours) || 24)),
    allowlist: Array.isArray(policy.allowlist) ? policy.allowlist.filter((p) => PACKAGE_NAME_PATTERN.test(p)) : [],
    lastAutoRunAt: policy.lastAutoRunAt ?? null,
  }
}

async function saveUpdatePolicy(cachePath: string, policy: UpdatePolicy): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true })
  await writeFile(updatePolicyPath(cachePath), JSON.stringify(policy, null, 2), 'utf8')
}

async function readProfileManifest(profileDir: string): Promise<{ dependencies?: Record<string, string> }> {
  return readJsonFile(join(profileDir, 'package.json'), {})
}

async function installedPackageVersion(profileDir: string, packageName: string): Promise<string | null> {
  const manifest = await readJsonFile<{ version?: string }>(join(profileDir, 'node_modules', packageName, 'package.json'), {})
  return manifest.version ?? null
}

async function lockGitCommit(profileDir: string, owner: string, repo: string): Promise<string | null> {
  try {
    const lock = await readFile(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
    const match = lock.match(new RegExp(`https://codeload\\.github\\.com/${escapeRegExp(owner)}/${escapeRegExp(repo)}/tar\\.gz/([0-9a-f]{7,40})`, 'i'))
    return match?.[1] ?? null
  } catch { return null }
}

async function latestGithubCommit(owner: string, repo: string): Promise<string> {
  const headers = { 'user-agent': 'dsh-recommend-update-check' }
  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers })
  if (!repoRes.ok) throw new Error(`GitHub repo ${repoRes.status}`)
  const branch = (await repoRes.json()).default_branch ?? 'main'
  const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`, { headers })
  if (!commitRes.ok) throw new Error(`GitHub commit ${commitRes.status}`)
  return (await commitRes.json()).sha
}

async function latestNpmVersion(packageName: string): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, { headers: { 'user-agent': 'dsh-recommend-update-check' } })
  if (!res.ok) throw new Error(`npm ${res.status}`)
  return (await res.json()).version
}

async function checkProfileUpdates(profileDir: string): Promise<UpdateItem[]> {
  const manifest = await readProfileManifest(profileDir)
  const dependencies = Object.entries(manifest.dependencies ?? {}).filter(([name]) => !name.startsWith('@deepseek-ai/'))
  const result: UpdateItem[] = []
  for (const [packageName, spec] of dependencies) {
    const git = parseGithubSpec(spec)
    const installed = await installedPackageVersion(profileDir, packageName)
    try {
      if (git) {
        const [latest, installedCommit] = await Promise.all([latestGithubCommit(git.owner, git.repo), lockGitCommit(profileDir, git.owner, git.repo)])
        result.push({ packageName, spec, source: 'github', installed: installedCommit ?? installed, latest, updateAvailable: Boolean(installedCommit && latest !== installedCommit) })
      } else if (isLocalSpec(spec)) {
        // link:/file:/相对路径开发插件不应被误当 npm 包更新。
        result.push({ packageName, spec, source: 'unknown', installed, latest: null, updateAvailable: false, error: 'local linked package' })
      } else {
        const latest = await latestNpmVersion(packageName)
        result.push({ packageName, spec, source: 'npm', installed, latest, updateAvailable: compareSemver(installed, latest) === -1 })
      }
    } catch (error) {
      result.push({ packageName, spec, source: git ? 'github' : 'unknown', installed, latest: null, updateAvailable: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

async function readBodyJson(req: AsyncIterable<Uint8Array>): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function sameOrigin(req: { headers: { origin?: string; host?: string } }): boolean {
  const origin = req.headers.origin
  return !origin || origin === `http://${req.headers.host}`
}

export function apply(ctx: Context, config: Config): void {
  const historyPath = config.historyPath ?? config.cachePath.replace(/registry\.json$/, 'history.json')
  const profile = config.installProfile ?? 'web'
  const profileDir = profileDirFromCache(config.cachePath, profile)
  const verificationPath = config.verificationPath ?? config.cachePath.replace(/registry\.json$/, 'verification.json')
  let updateBusy = false

  /** Manual refresh always downloads; automatic refresh only runs after the cache TTL expires. */
  async function refresh(force: boolean) {
    return force ? syncRegistry(config) : syncRegistryIfStale(config)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-recommend/registry.json',
    async handler(_req, res) {
      try {
        const body = await readFile(config.cachePath)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('registry cache missing — run sync_registry first')
      }
    },
  }), 'dsh-recommend: registry route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-recommend/history.json',
    async handler(_req, res) {
      try {
        const body = await readFile(historyPath)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('history cache missing — run sync_registry first')
      }
    },
  }), 'dsh-recommend: history route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-recommend/verification.json',
    async handler(_req, res) {
      try {
        const body = await readFile(verificationPath)
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(body)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('verification cache missing — refresh marketplace data first')
      }
    },
  }), 'dsh-recommend: verification route')

  // 独立静态排行榜：复用本 web 半的缓存，使本地沙盒和 GitHub Pages 之外也能直接预览。
  for (const asset of SITE_ASSETS) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: asset.route,
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('method not allowed')
          return
        }
        try {
          const body = await readFile(join(SITE_DIR, asset.file))
          res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' })
          res.end(body)
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`static site asset missing: ${asset.file}`)
        }
      },
    }), `dsh-recommend: static ${asset.file}`)
  }

  // 静态站原本从 ../data/ 读取；同源别名改为服务隔离缓存，保证本地预览与插件页数据一致。
  for (const [route, filePath] of [
    ['/dsh-recommend/data/registry.json', config.cachePath],
    ['/dsh-recommend/data/history.json', historyPath],
  ] as const) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: route,
      async handler(_req, res) {
        try {
          const body = await readFile(filePath)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(body)
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('data cache missing — run sync_registry first')
        }
      },
    }), `dsh-recommend: static data ${route}`)
  }

  // 设置页加载后以默认模式检查缓存 TTL；按钮传 force=1 强制同步完整快照。
  // 注：WebRoute 契约无 method 字段（同路径下方法不可区分），故在 handler 内校验 req.method。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-recommend/sync',
    async handler(req, res) {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('method not allowed — use POST')
        return
      }
      try {
        const requestUrl = new URL(req.url ?? '/dsh-recommend/sync', 'http://localhost')
        const result = await refresh(requestUrl.searchParams.get('force') === '1')
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, ...result }))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }))
      }
    },
  }), 'dsh-recommend: sync route')

  // 一键安装：body = { fullName: 'owner/repo' }；spec 由服务端从缓存 registry 构造
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-recommend/install',
    async handler(req, res) {
      const json = (code: number, body: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      try {
        if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' })

        // 防 CSRF：Origin 非空且非同源时拒绝（同源请求的 Origin 为空或匹配 Host）
        const origin = req.headers.origin
        if (origin && origin !== `http://${req.headers.host}`) {
          return json(403, { ok: false, error: 'cross-origin install rejected' })
        }

        // 读取并校验 body
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { fullName?: unknown }
        const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : ''
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
          return json(400, { ok: false, error: `illegal fullName: ${fullName}` })
        }

        // 服务端从缓存 registry 构造 spec：fullName 必须真实存在且未被排除
        let registry: { plugins?: Array<{ fullName: string; excluded: string | null }> }
        try {
          registry = JSON.parse(await readFile(config.cachePath, 'utf8'))
        } catch {
          return json(409, { ok: false, error: 'registry cache missing — run sync_registry first' })
        }
        const entry = registry.plugins?.find((p) => p.fullName === fullName)
        if (!entry) return json(404, { ok: false, error: `not in registry: ${fullName}` })
        if (entry.excluded) return json(400, { ok: false, error: `excluded plugin: ${fullName}（${entry.excluded}）` })

        const spec = `github:${fullName}`
        const result = await runInstall(config.installProfile ?? 'web', spec)
        json(200, { ok: result.exitCode === 0, spec, profile: config.installProfile ?? 'web', ...result })
      } catch (err) {
        json(500, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
  }), 'dsh-recommend: install route')

  // 更新检查：读取当前 web profile 的直接依赖，比较 GitHub commit 或 npm 版本。
  async function updateStatus() {
    const policy = await loadUpdatePolicy(config.cachePath)
    const updates = await checkProfileUpdates(profileDir)
    return { checkedAt: new Date().toISOString(), profile, policy, updates }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-recommend/updates',
    async handler(req, res) {
      const json = (code: number, body: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      try {
        if (req.method !== 'GET' && req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' })
        const status = await updateStatus()
        return json(200, { ok: true, ...status })
      } catch (error) {
        return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dsh-recommend: updates route')

  // 用户确认后的单包更新：只允许更新 profile package.json 中已有的直接依赖。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-recommend/update',
    async handler(req, res) {
      const json = (code: number, body: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      try {
        if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' })
        if (!sameOrigin(req)) return json(403, { ok: false, error: 'cross-origin update rejected' })
        const body = await readBodyJson(req)
        const packageName = typeof body.packageName === 'string' ? body.packageName.trim() : ''
        if (!PACKAGE_NAME_PATTERN.test(packageName)) return json(400, { ok: false, error: 'illegal packageName' })
        const manifest = await readProfileManifest(profileDir)
        if (!Object.prototype.hasOwnProperty.call(manifest.dependencies ?? {}, packageName)) {
          return json(403, { ok: false, error: 'only direct profile dependencies can be updated' })
        }
        if (updateBusy) return json(409, { ok: false, error: 'another plugin operation is running' })
        updateBusy = true
        try {
          const result = await runDsh(profile, ['update', packageName])
          return json(200, { ok: result.exitCode === 0, packageName, profile, restartRequired: result.exitCode === 0, ...result })
        } finally {
          updateBusy = false
        }
      } catch (error) {
        return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dsh-recommend: update route')

  // 进阶策略：默认 notify；用户明确选择 auto 后，只更新 allowlist 中的包。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-recommend/update-policy',
    async handler(req, res) {
      const json = (code: number, body: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      try {
        if (req.method !== 'GET' && req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' })
        if (req.method === 'GET') return json(200, { ok: true, policy: await loadUpdatePolicy(config.cachePath) })
        if (!sameOrigin(req)) return json(403, { ok: false, error: 'cross-origin policy change rejected' })
        const body = await readBodyJson(req)
        const mode: UpdateMode = body.mode === 'auto' ? 'auto' : 'notify'
        const intervalHours = Math.min(168, Math.max(1, Number(body.intervalHours) || 24))
        const allowlist = Array.isArray(body.allowlist)
          ? body.allowlist.filter((p): p is string => typeof p === 'string' && PACKAGE_NAME_PATTERN.test(p))
          : []
        const manifest = await readProfileManifest(profileDir)
        const direct = new Set(Object.keys(manifest.dependencies ?? {}))
        const safeAllowlist = allowlist.filter((p) => direct.has(p))
        const policy: UpdatePolicy = { mode, intervalHours, allowlist: safeAllowlist, lastAutoRunAt: null }
        await saveUpdatePolicy(config.cachePath, policy)
        return json(200, { ok: true, policy })
      } catch (error) {
        return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dsh-recommend: update policy route')

  // 后台自动更新：每 15 分钟检查一次策略，默认 notify 因此不会产生任何更新。
  const autoTimer = setInterval(() => {
    void runAutoUpdate(config.cachePath, profileDir, profile, () => updateBusy, (value) => { updateBusy = value })
  }, UPDATE_TIMER_MS)
  ctx.effect(() => () => clearInterval(autoTimer), 'dsh-recommend: update timer')
  // 重启后若已开启 auto，不必额外等待一个 15 分钟轮询周期。
  void runAutoUpdate(config.cachePath, profileDir, profile, () => updateBusy, (value) => { updateBusy = value })
}

/** 执行 `dsh plugin --profile <p> <verb> <package>`，收集输出，超时杀进程。 */
function runDsh(profile: string, args: string[]): Promise<{
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}> {
  return new Promise((resolve, reject) => {
    const child = spawn('dsh', ['plugin', '--profile', profile, ...args], {
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ exitCode: -1, stdout, stderr: `${stderr}\n[dsh-recommend] 操作超时（${INSTALL_TIMEOUT_MS / 60000} 分钟），已终止`, timedOut: true })
    }, INSTALL_TIMEOUT_MS)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut: false })
    })
  })
}

function runInstall(profile: string, spec: string) {
  return runDsh(profile, ['add', spec])
}

async function runAutoUpdate(
  cachePath: string,
  profileDir: string,
  profile: string,
  isBusy: () => boolean,
  setBusy: (value: boolean) => void,
): Promise<void> {
  if (isBusy()) return
  const policy = await loadUpdatePolicy(cachePath)
  if (policy.mode !== 'auto' || policy.allowlist.length === 0) return
  const last = policy.lastAutoRunAt ? Date.parse(policy.lastAutoRunAt) : 0
  if (last && Date.now() - last < policy.intervalHours * 3_600_000) return
  const updates = await checkProfileUpdates(profileDir)
  const targets = updates.filter((item) => item.updateAvailable && policy.allowlist.includes(item.packageName))
  setBusy(true)
  try {
    for (const item of targets) await runDsh(profile, ['update', item.packageName])
    policy.lastAutoRunAt = new Date().toISOString()
    await saveUpdatePolicy(cachePath, policy)
  } finally {
    setBusy(false)
  }
}
