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

export const name = 'dsh-recommend-web'
export const inject = ['webServer']

export interface Config {
  /** 本地缓存路径（与 host 半一致）。 */
  cachePath: string
  /** 数据仓库 registry.json 下载地址（POST /sync 拉取用，与 host 半一致）。 */
  dataUrl: string
  /** 可选：历史数据缓存路径（默认 cachePath 同级 history.json）。 */
  historyPath?: string
  /** 可选：安装目标 profile 名；缺省为 web（浏览器半所在的 profile）。 */
  installProfile?: string
}

/** 安装超时：pnpm 拉取 git 依赖可能很慢，给足 10 分钟。 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000
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

export function apply(ctx: Context, config: Config): void {
  const historyPath = config.historyPath ?? config.cachePath.replace(/registry\.json$/, 'history.json')

  /** 拉取最新 registry 并覆写本地缓存（与 host 半 sync_registry 相同逻辑）。 */
  async function refresh(): Promise<{ fetchedAt: string; count: number }> {
    const res = await fetch(config.dataUrl)
    if (!res.ok) throw new Error(`下载 registry 失败: ${res.status}`)
    const text = await res.text()
    const doc = JSON.parse(text) as { meta?: { generatedAt?: string }; plugins?: unknown[] }
    if (!Array.isArray(doc.plugins)) throw new Error('下载的 registry 结构异常')
    await mkdir(dirname(config.cachePath), { recursive: true })
    await writeFile(config.cachePath, text, 'utf8')
    return { fetchedAt: doc.meta?.generatedAt ?? new Date().toISOString(), count: doc.plugins.length }
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

  // 设置页「刷新数据」：拉取最新 registry 覆写缓存。只读数据，不执行任何插件代码。
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
        const result = await refresh()
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
}

/** 执行 `dsh plugin --profile <p> add <spec>`，收集输出，超时杀进程。 */
function runInstall(profile: string, spec: string): Promise<{
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}> {
  return new Promise((resolve, reject) => {
    // Windows 下 dsh 是 .cmd shim，spawn 需 shell（与官方 CLI spawn pnpm 同处理）
    const child = spawn('dsh', ['plugin', '--profile', profile, 'add', spec], {
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    const timer = setTimeout(() => {
      child.kill()
      resolve({ exitCode: -1, stdout, stderr: `${stderr}\n[dsh-recommend] 安装超时（${INSTALL_TIMEOUT_MS / 60000} 分钟），已终止`, timedOut: true })
    }, INSTALL_TIMEOUT_MS)

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut: false })
    })
  })
}
