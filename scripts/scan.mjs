/**
 * scan.mjs — 插件性验证深扫（M1.5 / 榜单可信度）
 *
 * 对榜单前 N 名（默认 200）逐个仓库做轻量验证：用 GitHub Contents API 取根目录
 * 列表 + package.json，检测 DSH 插件特征；同时读取同一 GitHub API 上、当前
 * 默认分支 commit 的 Actions Check 回执（静态安全 / 发布基线兼容）：
 *   - package.json 声明 `dsh` 字段（dsh.bundle / dsh.client）→ 强特征
 *   - dependencies/devDependencies 含 @deepseek-ai/* → 强特征
 *   - cordis 配置（cordis.config.* / *.cordis.yml / agent.cordis.yml / cordis.patch.yml）→ 强特征
 *   - dsh 配置文件（dsh.config.* / .dshrc / dsh.yml 等）→ 强特征
 *   - skills/ 目录或 SKILL.md → 中特征（技能类插件）
 * 命中任一强/中特征 → verified；全无 → unverified（score.mjs 会将其排除出榜）；
 * API 失败 → error（保守保留，不误杀）。
 *
 * 结果写 data/raw/deep-scan.json（gitignored），由 score.mjs 第二阶段合并。
 * 请求预算：每仓库 1~2 个请求（根目录 + 有 package.json 时取内容），前 200 名 ≈ 300 请求。
 * 无 GITHUB_TOKEN 时 core API 限额 60/小时，仅适合 --top 小值冒烟。
 *
 * 用法：node scripts/scan.mjs [--top 200] [--out data/raw/deep-scan.json]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = join(ROOT, 'data')
const GITHUB_API = 'https://api.github.com'
const token = process.env.GITHUB_TOKEN ?? ''
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'dsh-recommend-scan',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
}
/** core API 速率（token 30/min → 2s 间隔；未认证 60/h，小样本冒烟够用）。 */
const INTERVAL_MS = token ? 2000 : 6000

const CORDIS_CONFIG = /^(cordis\.config\..+|agent\.cordis\.ya?ml|cordis\.patch\.ya?ml|.*\.cordis\.ya?ml)$/i
const DSH_CONFIG = /^(dsh\.config\..+|\.dshrc|dsh\.ya?ml|dsh\.json|dsh\.toml)$/i

async function ghJson(url, retries = 2) {
  const res = await fetch(url, { headers })
  if (res.status === 403 || res.status === 429) {
    if (retries <= 0) throw new Error(`GitHub API ${res.status}（重试耗尽）: ${url}`)
    const retryAfter = Number(res.headers.get('retry-after')) || 10
    console.warn(`  限流 ${res.status}：${retryAfter}s 后重试: ${url}`)
    await new Promise((r) => setTimeout(r, retryAfter * 1000))
    return ghJson(url, retries - 1)
  }
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}: ${url}`)
  return res.json()
}

const RECEIPT_FORMAT = 'dsh-plugin-verification/v1'

/** Extract only publisher baseline compatibility from a public Actions check.
 * Static-security evidence comes exclusively from the market-owned scan queue;
 * a repository can otherwise forge a check-summary marker. */
export function receiptFromCheck(check, headSha, repository) {
  const text = `${check?.output?.summary ?? ''}\n${check?.output?.text ?? ''}`
  const match = /<!--\s*dsh-plugin-verification:(\{[\s\S]*?\})\s*-->/.exec(text)
  if (match === null) return null
  try {
    const receipt = JSON.parse(match[1])
    if (receipt?.format !== RECEIPT_FORMAT || receipt?.commit !== headSha) return null
    if (receipt.kind === 'baseline-compatibility'
      && receipt.repository === repository
      && receipt.status === 'passed'
      && receipt.profileMode === 'clean'
      && typeof receipt.checkedAt === 'string'
      && Number.isFinite(Date.parse(receipt.checkedAt))) {
      return { kind: receipt.kind, status: 'passed', profileMode: 'clean', checkedAt: receipt.checkedAt, checkUrl: check.html_url ?? null }
    }
  } catch {
    // A malformed third-party check is ignored rather than becoming a label.
  }
  return null
}

/** Read an optional publisher clean-profile receipt from the current default-branch head. */
export async function fetchWorkflowVerification(owner, name, defaultBranch) {
  try {
    const repository = `${owner}/${name}`
    const branch = typeof defaultBranch === 'string' && defaultBranch !== ''
      ? defaultBranch
      : (await ghJson(`${GITHUB_API}/repos/${owner}/${name}`))?.default_branch
    if (typeof branch !== 'string' || branch === '') return null
    const commit = await ghJson(`${GITHUB_API}/repos/${owner}/${name}/commits/${encodeURIComponent(branch)}`)
    const sha = typeof commit?.sha === 'string' ? commit.sha : null
    if (sha === null) return null
    const checks = await ghJson(`${GITHUB_API}/repos/${owner}/${name}/commits/${sha}/check-runs?per_page=100`)
    const compatibility = (checks?.check_runs ?? [])
      .map((check) => receiptFromCheck(check, sha, repository))
      .find(Boolean) ?? null
    return compatibility === null ? null : { commit: sha, compatibility }
  } catch (error) {
    return { commit: null, compatibility: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 检测单个仓库（contents 根目录 + 可选 package.json）。返回 { status, signals }。 */
export async function scanRepo(owner, name, defaultBranch) {
  const signals = {
    hasPackageJson: false,
    hasDshManifest: false,
    hasDeepseekDeps: false,
    deepseekDepCount: 0,
    hasCordisConfig: false,
    hasDshConfig: false,
    hasSkillDir: false,
    hasSKILLMD: false,
  }
  const listing = await ghJson(`${GITHUB_API}/repos/${owner}/${name}/contents/`)
  if (!Array.isArray(listing)) throw new Error('contents 根目录返回非列表')
  for (const item of listing) {
    const n = item.name
    if (item.type === 'file') {
      if (n === 'package.json') signals.hasPackageJson = true
      if (n.toLowerCase() === 'skill.md') signals.hasSKILLMD = true
      if (CORDIS_CONFIG.test(n)) signals.hasCordisConfig = true
      if (DSH_CONFIG.test(n)) signals.hasDshConfig = true
    } else if (item.type === 'dir' && n.toLowerCase() === 'skills') {
      signals.hasSkillDir = true
    }
  }
  if (signals.hasPackageJson) {
    try {
      const pkg = await ghJson(`${GITHUB_API}/repos/${owner}/${name}/contents/package.json`)
      const text = Buffer.from(pkg.content ?? '', 'base64').toString('utf8')
      // 个别仓库的 package.json 带 UTF-8 BOM（U+FEFF），JSON.parse 会失败——先剥离
      const json = JSON.parse(text.replace(/^\uFEFF/, ''))
      signals.hasDshManifest = typeof json.dsh === 'object' && json.dsh !== null
      const deps = { ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}), ...(json.peerDependencies ?? {}) }
      signals.deepseekDepCount = Object.keys(deps).filter((k) => k.startsWith('@deepseek-ai/')).length
      signals.hasDeepseekDeps = signals.deepseekDepCount > 0
    } catch (err) {
      // package.json 解析失败不算致命：根目录特征仍可判定
      if (!/404/.test(err.message)) console.warn(`  package.json 读取失败 ${owner}/${name}：${err.message}`)
    }
  }
  const verified =
    signals.hasDshManifest
    || signals.hasDeepseekDeps
    || signals.hasCordisConfig
    || signals.hasDshConfig
    || signals.hasSkillDir
    || signals.hasSKILLMD
  const verification = await fetchWorkflowVerification(owner, name, defaultBranch)
  return { status: verified ? 'verified' : 'unverified', signals, verification }
}

const argv = process.argv.slice(2)
const topIndex = argv.indexOf('--top')
const top = topIndex >= 0 ? Number(argv[topIndex + 1]) || 200 : 200
const outIndex = argv.indexOf('--out')
const out = outIndex >= 0 ? argv[outIndex + 1] : join(ROOT, 'data', 'raw', 'deep-scan.json')

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rankings = JSON.parse(await readFile(join(DATA_DIR, 'rankings.json'), 'utf8'))
  const targets = (rankings.rankings ?? []).slice(0, top)
  console.log(`深扫目标：榜单前 ${targets.length} 名（共 ${rankings.rankings?.length ?? 0} 条上榜）`)
  if (!token) console.warn('⚠ 未设置 GITHUB_TOKEN：core API 限额 60/小时，大样本会 403；建议 CI 中运行')

  const results = {}
  const counts = { scanned: 0, verified: 0, unverified: 0, error: 0 }
  for (const r of targets) {
    const [owner, ...rest] = r.fullName.split('/')
    const name = rest.join('/')
    try {
      const { status, signals, verification } = await scanRepo(owner, name)
      results[r.fullName] = { status, signals, verification }
      counts[status] += 1
      counts.scanned += 1
      console.log(`  ${status === 'verified' ? '✓' : '✗'} ${r.fullName}（${status}）`)
    } catch (err) {
      results[r.fullName] = { status: 'error', signals: null, error: String(err.message) }
      counts.error += 1
      counts.scanned += 1
      console.warn(`  ⚠ ${r.fullName} 深扫失败（保留榜单）：${err.message}`)
    }
    await new Promise((r2) => setTimeout(r2, INTERVAL_MS))
  }

  const payload = {
    at: new Date().toISOString(),
    top: targets.length,
    summary: {
      at: new Date().toISOString(),
      top: targets.length,
      scanned: counts.scanned,
      verified: counts.verified,
      unverified: counts.unverified,
      error: counts.error,
    },
    results,
  }
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, JSON.stringify(payload, null, 2))
  console.log(
    `已写入 ${out}：verified=${counts.verified} unverified=${counts.unverified} error=${counts.error}`,
  )
}
