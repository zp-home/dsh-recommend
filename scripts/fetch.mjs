/**
 * fetch.mjs — 数据采集
 *
 * 从公开数据源抓取 DSH 插件生态的原始数据，写入 data/raw/：
 *   1. GitHub Search API：topic:dsh-plugin 的全部公开仓库（含元数据：stars/forks/
 *      pushed_at/license/size/描述等，一次请求内返回，无需逐仓再查）。
 *      注意：Search API 单个查询最多返回 1000 条（10 页 × 100），第 11 页起恒为空，
 *      且 repository 搜索不支持按 created 排序；全量通过 created 日期区间分桶 +
 *      递归拆分实现（见 fetchTopicRepos）。单日仓库数 ≥1000 时溢出部分 Search 永远
 *      取不到，由 scripts/manual-repos.json 手动收录清单兜底（/repos 接口单独抓取）。
 *   2. dsh-external/hub 精选目录的公开镜像（0xsline/awesome-deepseek-harness 的
 *      CATALOG.md）：官方精选目录（分类映射 + 精选信号）。
 *   3. 三个 awesome 精选列表：人工精选信号（被收录 = 生态信号加分）。
 *
 * 全部使用 Node 18+ 内置 fetch，零依赖。未认证时 GitHub Search API 限额
 * 10 次/分钟；话题仓库数 >1000 后全量请求数会到百级，**必须设置 GITHUB_TOKEN**
 * （30 次/分钟）才能完整跑完，CI 已注入 github.token。
 *
 * 用法：node scripts/fetch.mjs [--out data/raw]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RAW_DIR = join(ROOT, 'data', 'raw')
/** 手动收录清单（人工验证、Search API 无法自动发现的插件，见文件内 note）。 */
const MANUAL_FILE = join(ROOT, 'scripts', 'manual-repos.json')
/** 精选认证列表（issue 审核通过，M3；其 npmPackage 用于下载量抓取）。 */
const CURATED_FILE = join(ROOT, 'scripts', 'curated.json')

const GITHUB_API = 'https://api.github.com'
const token = process.env.GITHUB_TOKEN ?? ''
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'dsh-recommend',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
}

/** GitHub Search API 硬上限：单个查询最多返回 1000 条（10 页 × 100）。 */
const SEARCH_RESULTS_CAP = 1000
const SEARCH_PER_PAGE = 100
/** 单个查询最多可翻的页数（超过也是空数组，不用再试）。 */
const SEARCH_PAGES_PER_QUERY = SEARCH_RESULTS_CAP / SEARCH_PER_PAGE
/** 一次运行的总页数安全阀（按年分桶后请求数随仓库数增长），防失控请求。
 *  注意：话题仓库数超过 1000 且存在单日密集簇时，拆分树会吃掉大量页数
 *  （单日簇的定位过程会重复翻页），全量请配 GITHUB_TOKEN（未认证 10 次/分
 *  撑不住百级请求，会 403 限流）。 */
const MAX_PAGES_DEFAULT = 200
/** created 分桶下界：dsh-plugin 话题不可能早于 2008。 */
const CREATED_FLOOR = '2008-01-01'

/** 'YYYY-MM-DD' 的 UTC 毫秒值。 */
function dayMs(dateStr) {
  return Date.parse(`${dateStr}T00:00:00Z`)
}

/** 'YYYY-MM-DD' ± n 天（UTC，与 GitHub 的 created_at 时区一致）。 */
function addDays(dateStr, days) {
  const d = new Date(dayMs(dateStr))
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function gh(url, retries = 3) {
  let res
  try {
    res = await fetch(url, { headers })
  } catch (err) {
    // 网络层错误（ECONNRESET / ETIMEDOUT / ENOTFOUND 等）：指数退避重试
    if (retries <= 0) throw err
    const wait = 3000 * (4 - retries)
    console.warn(`网络错误（${err.message}），${wait / 1000}s 后重试（剩余 ${retries} 次）: ${url}`)
    await new Promise((r) => setTimeout(r, wait))
    return gh(url, retries - 1)
  }
  if (res.status === 403 || res.status === 429) {
    if (retries <= 0) throw new Error(`GitHub API ${res.status} ${res.statusText}（重试耗尽）: ${url}`)
    const retryAfter = Number(res.headers.get('retry-after')) || 10
    console.warn(`GitHub API ${res.status}：${retryAfter}s 后重试（剩余 ${retries} 次）: ${url}`)
    await new Promise((r) => setTimeout(r, retryAfter * 1000))
    return gh(url, retries - 1)
  }
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} ${res.statusText}: ${url}`)
  }
  return res.json()
}

async function text(url) {
  // raw.githubusercontent 等辅助源：网络层错误同样重试，避免瞬时抖动把 hub/awesome 信号打成「抓取失败」
  for (let attempt = 0; ; attempt += 1) {
    let res
    try {
      res = await fetch(url, { headers: { 'User-Agent': 'dsh-recommend' } })
    } catch (err) {
      if (attempt >= 2) throw err
      console.warn(`网络错误（${err.message}），3s 后重试（第 ${attempt + 1} 次）: ${url}`)
      await new Promise((r) => setTimeout(r, 3000))
      continue
    }
    if (!res.ok) throw new Error(`GET ${res.status}: ${url}`)
    return res.text()
  }
}

/**
 * 抓取 topic:dsh-plugin 全量公开仓库。
 *
 * Search API 单个查询最多返回 1000 条（10 页 × 100），第 11 页恒为空数组；且
 * repository 搜索不支持按 created 排序（sort=created 会被静默忽略、按相关度返回），
 * 所以「全量」不能用游标推进，只能按 created 日期区间分桶 + 递归拆分：
 *   1. 按 `created:lo..hi` 区间分桶查询（区间含两端，日期粒度精确到天，桶间无重叠、
 *      不依赖任何排序），桶内 ≤1000 条时翻 10 页即可全部取完（顺序无关）；
 *   2. 某桶取满 1000 条（10 页）说明桶内可能更多，从中间日期拆成两个子桶重抓，
 *      直到子桶不足 1000 条，或拆到单日（单日 ≥1000 条是 Search API 无法绕过的
 *      极限——created 只精确到天，此时告警截断）；
 *   3. 桶间无重叠，重复仅为翻页漂移，仍按 full_name 去重兜底。
 *
 * maxPages 是本次运行的总页数预算（--limit N 冒烟测试传小值）；默认给足一轮全量，
 * 预算耗尽且最后处理的桶仍是满的（或桶内抓取被打断）时打警告。
 */
export async function fetchTopicRepos(maxPages = MAX_PAGES_DEFAULT) {
  const repos = []
  const seen = new Set()
  let pagesUsed = 0
  let truncatedByBudget = false // 桶内翻页时预算耗尽（有仓库没取完）
  let lastBucketFull = false // 最后一个桶取满了 10 页（可能还有仓库没取完）
  const overflowDays = [] // 单日超 Search 上限被截断的日期与漏抓数
  const bucketTotals = new Map() // 日期 → 当日仓库总数（溢出统计用）

  /** 记录并返回某日期桶的仓库总数（带 1 次轻量查询缓存）。 */
  async function bucketTotalOf(date) {
    if (bucketTotals.has(date)) return bucketTotals.get(date)
    const url = `${GITHUB_API}/search/repositories?q=topic%3Adsh-plugin%20created%3A${date}..${date}&per_page=1`
    try {
      const body = await gh(url)
      const total = body.total_count ?? 0
      bucketTotals.set(date, total)
      return total
    } catch {
      return SEARCH_RESULTS_CAP // 查询失败时保守假设为上限
    }
  }

  /** 抓取一个 created:[lo,hi] 区间桶；返回该桶是否「满」（可能更大需要拆）。 */
  async function fetchBucket(lo, hi) {
    let rawItems = 0
    let bucketTotal = Infinity
    for (let page = 1; page <= SEARCH_PAGES_PER_QUERY; page += 1) {
      if (pagesUsed >= maxPages) {
        truncatedByBudget = true
        break
      }
      const url = `${GITHUB_API}/search/repositories?q=topic%3Adsh-plugin%20created%3A${lo}..${hi}&sort=stars&order=desc&per_page=${SEARCH_PER_PAGE}&page=${page}`
      const body = await gh(url)
      const items = body.items ?? []
      bucketTotal = body.total_count ?? bucketTotal
      rawItems += items.length
      for (const item of items) {
        // 翻页期间结果集可能变化导致同一仓库重复出现：按 full_name 去重，保留首个
        if (seen.has(item.full_name)) continue
        seen.add(item.full_name)
        repos.push(item)
      }
      pagesUsed += 1
      if (items.length === 0 || rawItems >= bucketTotal) break
      // 未认证 Search 限额 10/min（页间间隔 6.5s）；带 token 30/min（2s 足够）
      await new Promise((r) => setTimeout(r, token ? 2000 : 6500))
    }
    return rawItems >= SEARCH_RESULTS_CAP && rawItems < bucketTotal
  }

  // 分桶：从最近一年往早排（--limit 冒烟时先抓最新的仓库）
  const today = new Date().toISOString().slice(0, 10)
  const thisYear = Number(today.slice(0, 4))
  const ranges = [[`${thisYear}-01-01`, today]]
  for (let y = thisYear - 1; y >= Number(CREATED_FLOOR.slice(0, 4)); y -= 1) {
    ranges.push([`${y}-01-01`, `${y}-12-31`])
  }

  while (ranges.length > 0 && pagesUsed < maxPages) {
    const [lo, hi] = ranges.shift()
    lastBucketFull = await fetchBucket(lo, hi)
    if (!lastBucketFull) continue
    if (lo === hi) {
      // 拆到单日仍满：created 只精确到天，超出部分 API 永远拿不到。
      // 记录溢出数量（当日总数 - 1000），供 meta 展示与人工补录参考。
      const total = await bucketTotalOf(lo)
      const overflow = Math.max(0, total - SEARCH_RESULTS_CAP)
      overflowDays.push({ date: lo, total, missed: overflow })
      console.warn(
        `日期 ${lo} 单日仓库数 ${total} ≥ ${SEARCH_RESULTS_CAP} 条，` +
          `约 ${overflow} 个仓库超出 Search API 上限被截断（建议补录 manual-repos.json）`,
      )
      continue
    }
    // 桶可能更大：从中间日期拆成 [lo,mid] + [mid+1,hi]（无重叠、必前进）
    const mid = addDays(lo, Math.floor((dayMs(hi) - dayMs(lo)) / 86400000 / 2))
    const next = addDays(mid, 1)
    ranges.unshift([lo, mid])
    if (next <= hi) ranges.unshift([next, hi])
  }

  if (pagesUsed >= maxPages && (lastBucketFull || truncatedByBudget)) {
    console.warn(
      `页预算 ${maxPages} 页已耗尽但仍有仓库未取完（话题仓库数可能超过 ` +
        `${maxPages * SEARCH_PER_PAGE} 条）：请调大 MAX_PAGES_DEFAULT 或设置 GITHUB_TOKEN 提速`,
    )
  }
  return { repos, overflow: overflowDays }
}

/**
 * 解析 dsh-external/hub 精选目录的公开镜像（0xsline/awesome-deepseek-harness 的
 * CATALOG.md，由 GitHub Actions 每日从 hub 的 catalog.json 自动生成）：
 * `## <emoji> <分类名>（N）` 小节 + `| [name](url) | 描述 |` 表格行。
 * 注意：hub 组织仓库本身是私有的（需 org 权限），不要直接抓 dsh-external/hub。
 * 「公开插件 Topic」小节是话题原始转储而非人工精选，不计入 curated 信号。
 * 返回 { entries, categories, fetchedAt, error }：抓取失败时 entries/categories 为空，
 * 但 **error 与 fetchedAt 一并返回并写进 raw**——降级不再无声（validate.mjs 会据此红）。
 */
export async function fetchHubCatalog() {
  const url = 'https://raw.githubusercontent.com/0xsline/awesome-deepseek-harness/main/CATALOG.md'
  let md
  try {
    md = await text(url)
  } catch (err) {
    console.error(`⚠ hub 目录镜像抓取失败（生态精选/分类信号缺失，validate 将红）：${err.message}`)
    return { entries: [], categories: [], fetchedAt: null, error: String(err.message) }
  }
  const entries = []
  const categories = []
  let category = '未分类'
  for (const line of md.split('\n')) {
    const head = /^## (.+?)（(\d+)）$/.exec(line.trim())
    if (head) {
      category = head[1]
      categories.push(category)
      continue
    }
    // 话题原始转储不算人工精选
    if (/Topic|公开插件/.test(category)) continue
    const row = /^\| \[([^\]]+)\]\((https:\/\/github\.com\/[^)]+)\) \| (.*) \|$/.exec(line.trim())
    if (row) {
      entries.push({ name: row[1], url: row[2], category, description: row[3] })
    }
  }
  return { entries, categories, fetchedAt: new Date().toISOString(), error: null }
}

/** github.com 链接中不能当作仓库解析的路径段（topic/头像/动作等）。 */
const NON_REPO_SEGMENTS = new Set([
  'topics', 'avatars', 'actions', 'orgs', 'marketplace', 'sponsors', 'settings',
  'notifications', 'features', 'collections', 'events', 'explore', 'pulls', 'issues',
])

/**
 * 从 markdown 中提取形如 github.com/owner/repo 的仓库引用（纯函数，可单测）。
 * 排除 topic 链接（github.com/topics/xxx）、徽章/动作等非仓库 URL，键统一小写
 * （score.mjs 按小写 fullName 匹配，原实现大小写不一致会漏掉精选信号）。
 */
export function extractRepoRefs(md) {
  const refs = new Set()
  for (const m of md.matchAll(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g)) {
    const owner = m[1].toLowerCase()
    const name = m[2].toLowerCase().replace(/[)#.,;]/g, '')
    if (NON_REPO_SEGMENTS.has(owner)) continue
    if (!owner || !name) continue
    refs.add(`${owner}/${name}`)
  }
  return [...refs]
}

/** 抓取三个 awesome 精选列表，提取其中出现的 GitHub 仓库（owner/repo，键小写）。 */
export async function fetchAwesomeLists() {
  const urls = [
    'https://raw.githubusercontent.com/0xsline/awesome-deepseek-harness/main/README.md',
    'https://raw.githubusercontent.com/awesome-dsh-plugin/awesome-dsh-plugin/main/README.md',
    'https://raw.githubusercontent.com/Alex-Yanggg/awesome-DSH-plugin/main/README.md',
  ]
  const mentioned = new Map() // 'owner/repo'(小写) -> Set<listName>
  for (const url of urls) {
    const listName = new URL(url).pathname.split('/')[1]
    try {
      const md = await text(url)
      for (const full of extractRepoRefs(md)) {
        if (!mentioned.has(full)) mentioned.set(full, new Set())
        mentioned.get(full).add(listName)
      }
    } catch (err) {
      console.warn(`awesome 列表 ${listName} 抓取失败：${err.message}`)
    }
  }
  return Object.fromEntries([...mentioned].map(([k, v]) => [k, [...v]]))
}

/** 归一化 GitHub API 仓库对象为精简的注册表输入行。 */
export function toRepoRecord(repo) {
  return {
    name: repo.name,
    owner: repo.owner?.login ?? '',
    fullName: repo.full_name,
    url: repo.html_url,
    description: (repo.description ?? '').trim(),
    stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0,
    openIssues: repo.open_issues_count ?? 0,
    sizeKb: repo.size ?? 0,
    language: repo.language ?? null,
    license: repo.license?.spdx_id ?? null,
    archived: repo.archived ?? false,
    fork: repo.fork ?? false,
    createdAt: repo.created_at ?? null,
    pushedAt: repo.pushed_at ?? null,
    updatedAt: repo.updated_at ?? null,
    homepage: repo.homepage ?? null,
    topics: repo.topics ?? [],
  }
}

/**
 * 读取 scripts/manual-repos.json 手动收录清单，用 /repos 接口逐仓抓取。
 * 用于兜底 Search API 永远取不到的仓库（单日仓库数 ≥1000 的溢出区）；
 * /repos 是 core API（无单查询 1000 上限），返回结构与 search items 同构，
 * 直接 toRepoRecord。清单缺失/仓库不存在时降级跳过，不影响主流程。
 */
export async function fetchManualRepos() {
  let list
  try {
    list = JSON.parse(await readFile(MANUAL_FILE, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`manual-repos.json 解析失败：${err.message}`)
    return []
  }
  const fullNames = Array.isArray(list?.repos) ? list.repos : []
  const records = []
  for (const fullName of fullNames) {
    if (typeof fullName !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
      console.warn(`manual-repos.json 非法条目，跳过：${JSON.stringify(fullName)}`)
      continue
    }
    try {
      const repo = await gh(`${GITHUB_API}/repos/${fullName}`)
      records.push(toRepoRecord(repo))
    } catch (err) {
      console.warn(`手动收录仓库抓取失败，跳过：${fullName}（${err.message}）`)
    }
  }
  return records
}

/**
 * 抓取精选插件的 npm 下载量（api.npmjs.org 公开端点，无鉴权，M3）。
 * 读取 scripts/curated.json 中声明了 npmPackage 的条目，按包名抓 last-week /
 * last-month 下载量，写入 data/raw/npm.json（score 阶段消费）。失败单包跳过
 * （npm 包可能未发布/改名），不影响主流程。
 * @returns {{ downloads: Record<string, {weekly: number|null, monthly: number|null}> }}
 */
export async function fetchNpmDownloads() {
  let curated = []
  try {
    curated = JSON.parse(await readFile(CURATED_FILE, 'utf8')).plugins ?? []
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`curated.json 读取失败：${err.message}`)
    return { downloads: {} }
  }
  const packages = curated.map((e) => e.npmPackage).filter((p) => typeof p === 'string' && p.length > 0)
  const downloads = {}
  for (const pkg of packages) {
    try {
      const [weekly, monthly] = await Promise.all([
        npmPoint(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(pkg)}`),
        npmPoint(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(pkg)}`),
      ])
      downloads[pkg] = { weekly: weekly?.downloads ?? null, monthly: monthly?.downloads ?? null }
      console.log(`npm ${pkg}: weekly=${downloads[pkg].weekly} monthly=${downloads[pkg].monthly}`)
    } catch (err) {
      console.warn(`npm 下载量抓取失败，跳过：${pkg}（${err.message}）`)
      downloads[pkg] = { weekly: null, monthly: null }
    }
  }
  return { downloads }
}

/** npm 下载量点查询（公开 JSON 端点）。 */
async function npmPoint(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`npm API ${res.status}: ${url}`)
  return res.json()
}

const argv = process.argv.slice(2)
const out = argv.includes('--dry') ? null : RAW_DIR
const limitIndex = argv.indexOf('--limit')
const maxPages = limitIndex >= 0 ? Number(argv[limitIndex + 1]) || MAX_PAGES_DEFAULT : MAX_PAGES_DEFAULT
/** --skip-topic：复用现有 data/raw/repos.json 的 topicRepos，只刷新 hub 目录/awesome/手动清单（本地快速重建，省掉百级 Search 请求）。 */
const skipTopic = argv.includes('--skip-topic')
/** 单日超 Search 上限被截断的日期与漏抓数（全量抓取时由 fetchTopicRepos 填充）。 */
let overflowDays = []

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let repos = []
  if (skipTopic) {
    try {
      const prev = JSON.parse(await readFile(join(RAW_DIR, 'repos.json'), 'utf8'))
      repos = Array.isArray(prev.topicRepos) ? prev.topicRepos : []
      console.log(`--skip-topic：复用现有 topic 数据 ${repos.length} 个（仅刷新目录/awesome/手动清单）`)
    } catch (err) {
      console.error(`--skip-topic 但 data/raw/repos.json 不可用（${err.message}），回退为全量抓取`)
    }
  }
  if (repos.length === 0 && !skipTopic) {
    const result = await fetchTopicRepos(maxPages)
    repos = result.repos
    overflowDays = result.overflow
  }
  const catalog = await fetchHubCatalog()
  const awesome = await fetchAwesomeLists()
  // 手动收录清单与 topic 结果按 full_name 合并去重（手动条目优先，它是人工验证过的）。
  // 注意：全量抓取返回的是原始 API item（full_name），须经 toRepoRecord 归一化；
  // skip-topic 复用已有 raw（已是 record 结构）则无需再转换。
  const manual = await fetchManualRepos()
  const topicRecords = skipTopic ? repos : repos.map(toRepoRecord)
  const merged = new Map(manual.map((r) => [r.fullName, r]))
  for (const r of topicRecords) if (!merged.has(r.fullName)) merged.set(r.fullName, r)
  const topicRepos = [...merged.values()]
  const npm = await fetchNpmDownloads()
  const payload = {
    fetchedAt: new Date().toISOString(),
    topicRepos,
    hubCatalog: catalog,
    awesomeLists: awesome,
    npm,
    overflow: overflowDays,
  }
  if (out) {
    await mkdir(out, { recursive: true })
    await writeFile(join(out, 'repos.json'), JSON.stringify(payload, null, 2))
    await writeFile(join(out, 'npm.json'), JSON.stringify(npm, null, 2))
    console.log(
      `已写入 ${join(out, 'repos.json')}（topic 仓库 ${topicRecords.length} 个` +
        `${manual.length ? ` + 手动收录 ${manual.length} 个` : ''} = ${topicRepos.length} 个；` +
        `hub 目录 ${catalog.entries.length} 条${catalog.error ? `（抓取失败: ${catalog.error}）` : ''}；` +
        `npm 下载量 ${Object.keys(npm.downloads).length} 个包）`,
    )
  } else {
    console.log(JSON.stringify(payload, null, 2))
  }
}
