/**
 * score.mjs — 过滤 + 评分
 *
 * 把 data/raw/repos.json 加工为：
 *   data/registry.json   全量仓库 + 每个信号 + 分数 + 排除原因
 *   data/rankings.json   可上榜仓库按分数降序（含分数构成）
 *   data/meta.json       生成时间/数量/评分版本/公式/信号源健康度
 *
 * 评分模型 v2（权威定义见 docs/scoring.md，改权重必须先改文档）：
 *   maintenance = exp(-daysSincePush / 180)                  # 维护性：半衰期 180 天
 *   popularity  = min(1, log10(stars + 1) / 3)               # 热度：1000 stars 封顶
 *   quality     = 0.4*hasLicense + 0.3*richDescription + 0.3*hasContent
 *   ecosystem   = curated ? 1.0 : 0.2                        # 精选收录信号
 *   score       = 0.35*maintenance + 0.30*popularity
 *               + 0.20*quality + 0.15*ecosystem
 *
 * 认证与下载量（展示层，不进评分公式，M3）：
 *   - certified：来自 scripts/curated.json（issue 审核通过的精选认证），
 *     打 `certified: true` + `certifiedAt` 标记，site/插件端展示 🏅 徽章；
 *   - npmWeekly/npmMonthly：来自 data/raw/npm.json（fetch 阶段抓取的 npm 下载量），
 *     仅对 curated 列表里声明了 npmPackage 的插件存在。
 *
 * 排除规则（进 registry，不进 rankings，附 reason）：
 *   - fork 或 archived
 *   - 占位/空仓库：sizeKb == 0 或描述命中占位特征
 *   - 描述为空
 *   - 官方本体/非插件 denylist（scripts/exclude-list.json）
 *   - 深扫未检出插件特征（scripts/scan.mjs 对榜单前 N 名的验证结果；未深扫的仓库不排除）
 *
 * 深扫：data/raw/deep-scan.json（scan.mjs 产物）存在时自动合并；
 * --no-scan 强制忽略（sync.mjs 第一阶段用，避免读入昨天的旧结果）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SCORING_VERSION = 2

const WEIGHTS = { maintenance: 0.35, popularity: 0.3, quality: 0.2, ecosystem: 0.15 }

const PLACEHOLDER_HINTS = /占位|待填充|placeholder|description pending|empty repo|wip|coming soon|预留/i

function daysSince(iso) {
  if (!iso) return Number.POSITIVE_INFINITY
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / 86_400_000)
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x))
}

/** 计算单个仓库的信号与分数。ecosystem 为 0..1。 */
export function scoreRepo(repo, ecosystem) {
  const daysSincePush = daysSince(repo.pushedAt)
  const signals = {
    maintenance: clamp01(Math.exp(-daysSincePush / 180)),
    popularity: clamp01(Math.log10(repo.stars + 1) / 3),
    quality: clamp01(
      0.4 * (repo.license ? 1 : 0)
      + 0.3 * (repo.description.length >= 40 ? 1 : 0)
      + 0.3 * ((repo.sizeKb ?? 0) > 0 ? 1 : 0),
    ),
    ecosystem: clamp01(ecosystem),
  }
  const score = Object.entries(WEIGHTS)
    .reduce((sum, [key, w]) => sum + w * signals[key], 0)
  return { signals, score, daysSincePush }
}

/** 判定一个仓库是否应排除出榜单（不含 denylist / 深扫，二者在 runScore 中处理）。返回 null 或排除原因。 */
export function exclusionReason(repo) {
  if (repo.fork) return 'fork 仓库'
  if (repo.archived) return '已归档'
  if ((repo.sizeKb ?? 0) === 0) return '空仓库（sizeKb=0）'
  if (!repo.description) return '无描述'
  if (PLACEHOLDER_HINTS.test(repo.description)) return '占位/WIP 特征'
  return null
}

/** 读取 scripts/exclude-list.json denylist，返回 fullName(小写) -> reason。文件缺失/损坏时为空清单。 */
export async function loadDenylist() {
  try {
    const list = JSON.parse(await readFile(join(ROOT(), 'scripts', 'exclude-list.json'), 'utf8'))
    const map = new Map()
    for (const e of Array.isArray(list?.entries) ? list.entries : []) {
      if (typeof e?.fullName === 'string' && typeof e?.reason === 'string') {
        map.set(e.fullName.toLowerCase(), e.reason)
      }
    }
    return map
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`exclude-list.json 解析失败：${err.message}`)
    return new Map()
  }
}

/** 读取深扫结果 data/raw/deep-scan.json；返回 fullName(小写) -> { status, signals }。不存在时为空 Map。 */
export async function loadDeepScan() {
  try {
    const scan = JSON.parse(await readFile(join(ROOT(), 'data', 'raw', 'deep-scan.json'), 'utf8'))
    const map = new Map()
    for (const [fullName, info] of Object.entries(scan.results ?? {})) {
      map.set(fullName.toLowerCase(), {
        status: info?.status,
        signals: info?.signals ?? null,
        verification: info?.verification ?? null,
      })
    }
    return { map, summary: scan.summary ?? null }
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`deep-scan.json 读取失败：${err.message}`)
    return { map: new Map(), summary: null }
  }
}

/** 读取 scripts/curated.json 精选认证列表；返回 fullName -> { issue, approvedAt, npmPackage }。 */
/** Read market-run static-security receipts. Missing data means no public label. */
export async function loadVerificationIndex() {
  try {
    const index = JSON.parse(await readFile(join(ROOT(), 'data', 'verification.json'), 'utf8'))
    const plugins = index?.plugins
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return new Map()
    return new Map(Object.entries(plugins).map(([fullName, info]) => [fullName.toLowerCase(), info]))
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`verification.json 解析失败：${err.message}`)
    return new Map()
  }
}

export async function loadCurated() {
  try {
    const curated = JSON.parse(await readFile(join(ROOT(), 'scripts', 'curated.json'), 'utf8'))
    const map = new Map()
    for (const e of Array.isArray(curated?.plugins) ? curated.plugins : []) {
      if (typeof e?.fullName === 'string') {
        map.set(e.fullName, { issue: e.issue ?? null, approvedAt: e.approvedAt ?? null, npmPackage: e.npmPackage ?? null })
      }
    }
    return map
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn('curated.json 不存在（精选认证未启用）')
    } else {
      console.warn(`curated.json 解析失败，按空列表处理：${err.message}`)
    }
    return new Map()
  }
}

/** 读取 data/raw/npm.json npm 下载量；返回 pkg -> { weekly, monthly }。不存在时为空 Map。 */
export async function loadNpmDownloads() {
  try {
    const npm = JSON.parse(await readFile(join(ROOT(), 'data', 'raw', 'npm.json'), 'utf8'))
    return new Map(Object.entries(npm.downloads ?? {}))
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`npm.json 读取失败：${err.message}`)
    return new Map()
  }
}

/** 主入口：读取 raw，写出 registry/rankings/meta。noScan=true 时忽略深扫结果（sync 第一阶段）。 */
export async function runScore(rawDir = join(ROOT(), 'data', 'raw'), outDir = join(ROOT(), 'data'), { noScan = false } = {}) {
  const raw = JSON.parse(await readFile(join(rawDir, 'repos.json'), 'utf8'))
  const denylist = await loadDenylist()
  const { map: scanMap, summary: scanSummary } = noScan ? { map: new Map(), summary: null } : await loadDeepScan()
  const verificationByRepo = await loadVerificationIndex()
  const certifiedBy = await loadCurated()
  const npmByPackage = await loadNpmDownloads()

  // 构建精选集合。注意：hub 目录的 URL 大多是 dsh-external/<name> 镜像地址，
  // 而真实仓库在作者命名空间下（dsh-external/<name> 重定向到 <author>/<name>），
  // 因此 curated 判定按「仓库名（不区分大小写）」匹配，URL 匹配作补充。
  const hubEntries = raw.hubCatalog?.entries ?? []
  const hubNames = new Set(hubEntries.map((e) => e.name.toLowerCase()))
  const hubUrls = new Set(hubEntries.map((e) => e.url.toLowerCase()))
  const hubCategories = new Map()
  for (const e of hubEntries) {
    hubCategories.set(e.name.toLowerCase(), e.category)
  }
  const awesomeRepos = raw.awesomeLists ?? {}

  const registry = []
  let excluded = 0
  let scanCounts = { scanned: 0, verified: 0, unverified: 0, error: 0, skipped: 0 }
  const verificationCounts = { securityPassed: 0, securityWarnings: 0, compatibilityPassed: 0, unavailable: 0 }
  for (const repo of raw.topicRepos ?? []) {
    const nameKey = repo.name.toLowerCase()
    const urlKey = repo.url.toLowerCase()
    const curated = hubNames.has(nameKey) || hubUrls.has(urlKey)
    const awesomeListNames = awesomeRepos[repo.fullName.toLowerCase()] ?? []
    const ecosystem = curated || awesomeListNames.length > 0 ? 1.0 : 0.2
    const { signals, score, daysSincePush } = scoreRepo(repo, ecosystem)

    // 深扫信息（无结果时 skipped）
    const scanInfo = scanMap.get(repo.fullName.toLowerCase())
    const scanStatus = scanInfo?.status ?? 'skipped'
    const scanSignals = scanInfo?.signals ?? null
    const verificationRecord = verificationByRepo.get(repo.fullName.toLowerCase()) ?? null
    const staticSecurity = verificationRecord?.staticSecurity ?? null
    const publisherCompatibility = verificationRecord?.publisherCompatibility ?? scanInfo?.verification?.compatibility ?? null
    if (staticSecurity?.status === 'passed') verificationCounts.securityPassed += 1
    else if (staticSecurity?.status === 'warnings') verificationCounts.securityWarnings += 1
    else verificationCounts.unavailable += 1
    if (publisherCompatibility?.status === 'passed') verificationCounts.compatibilityPassed += 1
    scanCounts[scanStatus] = (scanCounts[scanStatus] ?? 0) + 1

    // 排除原因优先级：denylist（人工权威）> 基础规则 > 深扫未检出
    // 深扫未检出仅在不被人工精选收录时排除：hub 目录 / awesome 列表的人工审核
    // 比文件特征更可信（存在结构特殊的真插件，如纯前端/无 package.json 的），
    // 避免误杀（见 ADR-0004 的 dsh-web-ui 案例）。
    let reason = exclusionReason(repo)
    if (!reason) {
      const denyReason = denylist.get(repo.fullName.toLowerCase())
      if (denyReason) reason = denyReason
    }
    if (!reason && scanStatus === 'unverified' && !curated && awesomeListNames.length === 0) {
      reason = '未检出插件特征（深扫）'
    }

    if (reason) excluded += 1
    const certified = certifiedBy.get(repo.fullName) ?? null
    const npm = certified?.npmPackage ? npmByPackage.get(certified.npmPackage) : null
    registry.push({
      ...repo,
      category: hubCategories.get(nameKey) ?? null,
      curated,
      awesomeLists: awesomeListNames,
      daysSincePush: Math.round(daysSincePush),
      signals,
      score: Math.round(score * 10000) / 10000,
      excluded: reason,
      scanStatus,
      scanSignals,
      // Verification evidence is display-only and never changes score/listing.
      verification: {
        staticSecurity,
        publisherCompatibility,
      },
      // 精选认证（展示层，不进评分；M3）
      certified: Boolean(certified),
      certifiedAt: certified?.approvedAt ?? null,
      curatedIssue: certified?.issue ?? null,
      // npm 下载量（仅精选且声明了包名的插件）
      npmPackage: certified?.npmPackage ?? null,
      npmWeekly: npm?.weekly ?? null,
      npmMonthly: npm?.monthly ?? null,
    })
  }

  const ranked = registry
    .filter((r) => !r.excluded)
    .sort((a, b) => b.score - a.score || b.stars - a.stars)
    .map((r, i) => ({ rank: i + 1, ...r }))

  const hub = raw.hubCatalog ?? {}
  const meta = {
    scoringVersion: SCORING_VERSION,
    weights: WEIGHTS,
    generatedAt: new Date().toISOString(),
    rawFetchedAt: raw.fetchedAt ?? null,
    counts: {
      topicRepos: registry.length,
      excluded,
      ranked: ranked.length,
    },
    signals: {
      hubCatalog: {
        fetchedAt: hub.fetchedAt ?? null,
        entries: hub.entries?.length ?? 0,
        categories: hub.categories?.length ?? 0,
        error: hub.error ?? null,
      },
      fetchOverflow: Array.isArray(raw.overflow) ? raw.overflow : [],
      awesome: {
        hitRepos: Object.values(awesomeRepos).filter((v) => Array.isArray(v) && v.length > 0).length,
      },
      deepScan: scanSummary ?? {
        at: null,
        top: 0,
        scanned: 0,
        verified: 0,
        unverified: 0,
        error: 0,
      },
      scanCounts,
      verification: verificationCounts,
    },
    formula: {
      maintenance: 'exp(-daysSincePush / 180)',
      popularity: 'min(1, log10(stars + 1) / 3)',
      quality: '0.4*hasLicense + 0.3*richDescription(>=40 chars) + 0.3*hasContent(sizeKb>0)',
      ecosystem: 'curated(1.0) | awesome-listed(1.0) | else 0.2',
      score: '0.35*maintenance + 0.30*popularity + 0.20*quality + 0.15*ecosystem',
    },
  }

  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'registry.json'), JSON.stringify({ meta, plugins: registry }, null, 2))
  await writeFile(join(outDir, 'rankings.json'), JSON.stringify({ meta, rankings: ranked }, null, 2))
  await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2))
  return meta
}

function ROOT() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const noScan = process.argv.includes('--no-scan')
  const meta = await runScore(undefined, undefined, { noScan })
  console.log(
    `registry=${meta.counts.topicRepos} 排除=${meta.counts.excluded} 上榜=${meta.counts.ranked} ` +
      `hub=${meta.signals.hubCatalog.entries}/${meta.signals.hubCatalog.categories}` +
      `${meta.signals.hubCatalog.error ? '（hub 抓取失败!）' : ''} ` +
      `深扫=${meta.signals.scanCounts.verified}✓/${meta.signals.scanCounts.unverified}✗/${meta.signals.scanCounts.error}err`,
  )
}
