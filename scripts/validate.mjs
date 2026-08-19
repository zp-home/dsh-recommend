/**
 * validate.mjs — 数据校验（CI 门禁）
 *
 * 校验 data/registry.json 与 data/rankings.json 的结构完整性 + 信号源健康度：
 *   - meta 齐全（版本/时间/数量）
 *   - registry 无重复 fullName
 *   - 分数在 [0,1]，排名严格降序
 *   - rankings 中的条目都未排除，registry 中的排除条目带 reason
 *   - hub 目录信号非空（fetch 静默降级会在这里红）
 *   - awesome 精选信号有命中
 *   - 深扫一致性：unverified 条目必须被排除，rankings 不得混入
 *   - curated.json 认证列表与 registry 一致性（M3）
 *   - data/trends.json 结构合法（M3）
 * 任何一项失败都以非零码退出（GitHub Actions 会红）。
 *
 * 用法：node scripts/validate.mjs [--skip-badges]
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA_DIR = join(ROOT, 'data')

const errors = []
const infos = []
const skipBadges = process.argv.includes('--skip-badges')
function check(ok, message) {
  if (!ok) errors.push(message)
}

const registry = JSON.parse(await readFile(join(DATA_DIR, 'registry.json'), 'utf8'))
const rankings = JSON.parse(await readFile(join(DATA_DIR, 'rankings.json'), 'utf8'))

check(typeof registry.meta?.scoringVersion === 'number', 'registry.meta.scoringVersion 缺失')
check(Number.isFinite(registry.meta?.counts?.topicRepos), 'registry.meta.counts 缺失')
check(registry.meta.scoringVersion === rankings.meta?.scoringVersion, 'registry/rankings 评分版本不一致')

// 信号源健康度：hub 目录（分类 + curated 信号的来源）不能静默为空
const hub = registry.meta?.signals?.hubCatalog
check(hub && typeof hub === 'object', 'meta.signals.hubCatalog 缺失（fetch 未记录目录状态）')
if (hub) {
  check(hub.fetchedAt, 'hub 目录未抓取成功（fetchedAt 缺失，fetch 已降级）')
  check(hub.entries >= 10, `hub 目录条目过少（${hub.entries}，正常应有 200+），分类/精选信号失效`)
  check(!hub.error, `hub 目录抓取失败：${hub.error}`)
}
// topic 采集完整性：全量 fetch 写出的原始审计不能含溢出、预算截断或分页漂移。
// --limit 冒烟运行会显式标为 limitedRun，不把其故意的部分数据当作生产数据门禁。
try {
  const coverage = JSON.parse(await readFile(join(DATA_DIR, 'raw', 'topic-coverage.json'), 'utf8'))
  if (!coverage.limitedRun) {
    check(coverage.complete === true, `topic 采集不完整：overflow=${coverage.overflow?.length ?? 0} incomplete=${coverage.incomplete?.length ?? 0}`)
    check((coverage.overflow?.length ?? 0) === 0, `topic 存在不可拆分溢出叶子：${coverage.overflow?.length ?? 0}`)
    check((coverage.incomplete?.length ?? 0) === 0, `topic 存在未完成查询叶子：${coverage.incomplete?.length ?? 0}`)
    check(coverage.uniqueItems === coverage.expectedLeafResults, `topic 去重计数不一致：unique=${coverage.uniqueItems} expected=${coverage.expectedLeafResults}`)
  } else {
    console.warn('[warn] topic-coverage.json 来自 --limit 冒烟运行，跳过全量完整性门禁')
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err
  console.warn('[warn] topic-coverage.json 不存在（旧数据或尚未运行 fetch），跳过 topic 完整性门禁')
}

// awesome 精选信号不能为空
const awesomeHits = registry.meta?.signals?.awesome?.hitRepos
check(Number.isFinite(awesomeHits) && awesomeHits > 0, `awesome 精选信号 0 命中（${awesomeHits}），请检查 fetch`)

const seen = new Set()
let categoryCovered = 0
let curatedCount = 0
for (const p of registry.plugins ?? []) {
  check(typeof p.fullName === 'string' && p.fullName.length > 0, 'registry 存在无 fullName 的条目')
  check(!seen.has(p.fullName), `registry 重复条目: ${p.fullName}`)
  seen.add(p.fullName)
  check(p.score >= 0 && p.score <= 1, `分数越界: ${p.fullName} score=${p.score}`)
  if (p.excluded) check(typeof p.excluded === 'string', `${p.fullName} excluded 应为原因字符串`)
  if (p.category) categoryCovered += 1
  if (p.curated) curatedCount += 1
  // M3：认证与下载量字段
  if (p.certified) {
    check(typeof p.certifiedAt === 'string', `${p.fullName} certified 但缺 certifiedAt`)
  }
  if (p.npmMonthly !== null && p.npmMonthly !== undefined) {
    check(Number.isFinite(p.npmMonthly), `${p.fullName} npmMonthly 应为数字`)
  }
  // 深扫一致性：unverified 必须被排除——除非被人工精选（hub/awesome）收录（人工审核优先，见 score.mjs）
  if (p.scanStatus === 'unverified' && !p.excluded && !p.curated && (p.awesomeLists ?? []).length === 0) {
    check(false, `深扫未检出插件特征但未排除: ${p.fullName}`)
  }
}

let prev = Number.POSITIVE_INFINITY
for (const r of rankings.rankings ?? []) {
  check(!r.excluded, `rankings 混入排除条目: ${r.fullName}`)
  check(r.score <= prev, `排名未降序: rank=${r.rank} ${r.fullName}`)
  prev = r.score
  check(r.rank > 0, 'rank 应从 1 开始')
  // 深扫未检出但被人工精选保留的条目允许上榜（与 registry 循环规则一致）
  check(
    r.scanStatus !== 'unverified' || r.curated || (r.awesomeLists ?? []).length > 0,
    `rankings 混入深扫未检出条目: ${r.fullName}`,
  )
}

// 分数徽章是 rankings 的完整投影。缺一个文件就会使 Shields 端点返回 resource not found。
if (skipBadges) {
  console.warn('[warn] --skip-badges：跳过限量冒烟运行的徽章完整性门禁')
} else {
  try {
    const badgeDir = join(DATA_DIR, 'badges')
    const badgeIndex = JSON.parse(await readFile(join(badgeDir, 'index.json'), 'utf8'))
    const badgeFiles = new Set(await readdir(badgeDir))
    const missing = (rankings.rankings ?? []).filter((r) => {
      const file = `${r.fullName.replace(/\//g, '__')}.json`
      return badgeIndex.entries?.[r.fullName]?.file !== file || !badgeFiles.has(file)
    })
    check(
      missing.length === 0,
      `分数徽章不完整：缺少 ${missing.length}/${rankings.rankings.length} 个（如 ${missing.slice(0, 5).map((r) => r.fullName).join(', ')}）`,
    )
  } catch (err) {
    check(false, `分数徽章读取失败：${err.message}`)
  }
}

// M3：curated.json 认证列表与 registry 的一致性。
// 注意：旧 registry 或极端不可分的 Search 溢出叶子可能暂时缺少 curated 插件，
// 缺失仅告警；但 registry 里已有的认证插件必须带 certified 标记。
try {
  const curated = JSON.parse(await readFile(join(ROOT, 'scripts', 'curated.json'), 'utf8'))
  const registryNames = new Set(registry.plugins.map((p) => p.fullName))
  for (const c of curated.plugins ?? []) {
    if (!registryNames.has(c.fullName)) {
      console.warn(`[warn] curated.json 认证插件暂不在 registry（可能被 Search 上限截断）: ${c.fullName}`)
      continue
    }
    const reg = registry.plugins.find((p) => p.fullName === c.fullName)
    if (reg) check(reg.certified === true, `registry 中 ${c.fullName} 未标记 certified（应来自 curated.json）`)
  }
} catch (err) {
  if (err.code === 'ENOENT') {
    console.warn('[warn] curated.json 不存在（精选认证未启用，跳过一致性校验）')
  } else {
    console.warn(`[warn] curated.json 解析失败，跳过一致性校验：${err.message}`)
  }
}

// M3：trends.json 结构（历史产物；无历史时不强制）
try {
  const trends = JSON.parse(await readFile(join(DATA_DIR, 'trends.json'), 'utf8'))
  check(Array.isArray(trends.trends), 'trends.trends 缺失')
  check(typeof trends.rankings === 'object' && trends.rankings !== null, 'trends.rankings 缺失')
  for (const t of trends.trends ?? []) {
    check(typeof t.fullName === 'string', 'trends 条目缺 fullName')
    check(Array.isArray(t.sparkline), `${t.fullName} sparkline 应为数组`)
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err
}

infos.push(`分类覆盖 ${categoryCovered}/${registry.plugins?.length ?? 0} · curated ${curatedCount}`)
infos.push(`深扫状态：${JSON.stringify(registry.meta?.signals?.scanCounts ?? '（未记录）')}`)

if (errors.length > 0) {
  for (const e of errors) console.error(`✗ ${e}`)
  console.error(`校验失败：${errors.length} 处`)
  process.exit(1)
}
for (const i of infos) console.log(`ℹ ${i}`)
console.log(
  `✓ 校验通过：registry=${registry.plugins.length} rankings=${rankings.rankings.length} ` +
    `hub=${hub?.entries}/${hub?.categories} curated=${curatedCount}`,
)
