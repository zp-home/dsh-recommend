/**
 * fetch.mjs — 数据采集
 *
 * 从公开数据源抓取 DSH 插件生态的原始数据，写入 data/raw/：
 *   1. GitHub Search API：topic:dsh-plugin 的全部公开仓库（含元数据：stars/forks/
 *      pushed_at/license/size/描述等，一次请求内返回，无需逐仓再查）。
 *      注意：Search API 单个查询最多返回 1000 条（10 页 × 100），第 11 页起恒为空，
 *      且 repository 搜索不支持按 created 排序；全量通过 created 日期区间分桶，单日
 *      溢出时再按 size/stars 无重叠闭区间递归拆分（见 fetchTopicRepos）。每轮都写出
 *      topic-coverage.json；任何无法安全拆分或分页不完整都会中止全量发布。
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
/** 单个叶子查询因索引翻页漂移不完整时，最多从第一页重试一次。 */
const MAX_LEAF_ATTEMPTS = 2
/** 一次运行的总页数安全阀。自适应分片会额外消耗父节点探测页，全量请配 token。 */
const MAX_PAGES_DEFAULT = 200
/** created 分桶下界：dsh-plugin 话题不可能早于 2008。 */
const CREATED_FLOOR = '2008-01-01'
const NUMERIC_DIMENSIONS = ['size', 'stars']

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
 * GitHub Search 的查询描述符。日期是主分片；单日饱和后仅使用数值范围继续切分。
 * 不使用 language：GitHub 无法可靠表达「所有其余/未识别语言」的完备补集，不能据此
 * 宣称采集完整。
 */
function initialTopicShard(createdFrom, createdTo) {
  return { createdFrom, createdTo, numeric: {}, depth: 0 }
}

function numericQualifier(name, bounds) {
  if (!bounds) return null
  if (bounds.min === bounds.max) return `${name}:${bounds.min}`
  if (bounds.max === null) return `${name}:>=${bounds.min}`
  return `${name}:${bounds.min}..${bounds.max}`
}

/** 生成稳定、可审计的 GitHub Search 查询。 */
export function topicQueryForShard(shard) {
  const terms = ['topic:dsh-plugin', `created:${shard.createdFrom}..${shard.createdTo}`]
  for (const dimension of NUMERIC_DIMENSIONS) {
    const qualifier = numericQualifier(dimension, shard.numeric?.[dimension])
    if (qualifier) terms.push(qualifier)
  }
  return terms.join(' ')
}

function cloneWithNumericBounds(shard, dimension, bounds) {
  return {
    ...shard,
    numeric: { ...shard.numeric, [dimension]: bounds },
    depth: shard.depth + 1,
  }
}

function apiNumericValue(item, dimension) {
  const value = dimension === 'size' ? item.size : item.stargazers_count
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * 把当前数值区间切为闭区间 [min,pivot] 和 [pivot+1,max]，两侧无重叠也无缺口。
 * 样本没有分布时仍可把集中值与其余值拆开，例如 stars:0 / stars:>=1。
 */
function numericSplit(shard, dimension, sample) {
  const bounds = shard.numeric?.[dimension] ?? { min: 0, max: null }
  const values = sample
    .map((item) => apiNumericValue(item, dimension))
    .filter((value) => value !== null && value >= bounds.min && (bounds.max === null || value <= bounds.max))
    .sort((a, b) => a - b)
  if (values.length === 0 || (bounds.max !== null && bounds.min === bounds.max)) return null

  const unique = [...new Set(values)]
  let pivot = unique[Math.floor((unique.length - 1) / 2)]
  if (pivot === undefined || pivot < bounds.min || (bounds.max !== null && pivot >= bounds.max)) {
    const only = unique[0]
    if (only === undefined) return null
    if (only > bounds.min) pivot = only - 1
    else if (bounds.max === null || only < bounds.max) pivot = only
    else return null
  }
  if (pivot < bounds.min || (bounds.max !== null && pivot >= bounds.max)) return null

  const lowerCount = values.filter((value) => value <= pivot).length
  const upperCount = values.length - lowerCount
  const lower = cloneWithNumericBounds(shard, dimension, { min: bounds.min, max: pivot })
  const upper = cloneWithNumericBounds(shard, dimension, { min: pivot + 1, max: bounds.max })
  return { dimension, score: Math.min(lowerCount, upperCount) / values.length, children: [lower, upper] }
}

/**
 * 返回不重叠的子查询。优先日期，再选择样本区分度最高的数值字段；没有分布时
 * 仍尝试把一个集中值拆出，随后可由另一数值字段继续拆分。
 */
export function splitTopicShard(shard, sample = []) {
  if (shard.createdFrom !== shard.createdTo) {
    const mid = addDays(shard.createdFrom, Math.floor((dayMs(shard.createdTo) - dayMs(shard.createdFrom)) / 86_400_000 / 2))
    const next = addDays(mid, 1)
    return {
      dimension: 'created',
      children: [
        { ...shard, createdTo: mid, depth: shard.depth + 1 },
        { ...shard, createdFrom: next, depth: shard.depth + 1 },
      ],
    }
  }

  const candidates = NUMERIC_DIMENSIONS
    .map((dimension) => numericSplit(shard, dimension, sample))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || NUMERIC_DIMENSIONS.indexOf(a.dimension) - NUMERIC_DIMENSIONS.indexOf(b.dimension))
  return candidates[0] ?? null
}

function addUnique(target, items) {
  for (const item of items ?? []) {
    if (typeof item?.full_name !== 'string') continue
    target.set(item.full_name.toLowerCase(), item)
  }
}

/**
 * 抓取 topic:dsh-plugin 的全部公开仓库。
 *
 * 每个 Search 叶子查询必须 <= 1000 条、未触发 incomplete_results，且分页去重数等于
 * total_count，才视为完整。父查询只取第一页以决定是否继续分片，不会误当作结果。
 * 返回的 audit 是「相对于该次 GitHub Search 响应」的完整性证明；GitHub 索引在运行中
 * 变化时会造成叶子计数不一致，届时明确报不完整而不静默发布部分 registry。
 */
export async function fetchTopicRepos(maxPages = MAX_PAGES_DEFAULT) {
  const completeItems = new Map()
  const partialItems = new Map()
  const queue = []
  const today = new Date().toISOString().slice(0, 10)
  const thisYear = Number(today.slice(0, 4))
  queue.push(initialTopicShard(`${thisYear}-01-01`, today))
  for (let year = thisYear - 1; year >= Number(CREATED_FLOOR.slice(0, 4)); year -= 1) {
    queue.push(initialTopicShard(`${year}-01-01`, `${year}-12-31`))
  }

  let pagesUsed = 0
  let lastRequestAt = 0
  const audit = {
    generatedAt: new Date().toISOString(),
    rootQuery: 'topic:dsh-plugin',
    searchResultCap: SEARCH_RESULTS_CAP,
    maxPages,
    pagesUsed: 0,
    branches: [],
    leaves: [],
    overflow: [],
    incomplete: [],
    expectedLeafResults: 0,
    fetchedLeafResults: 0,
    uniqueItems: 0,
    duplicateItems: 0,
    complete: false,
  }

  async function requestPage(shard, page) {
    if (pagesUsed >= maxPages) return null
    const delay = token ? 2000 : 6500
    const wait = lastRequestAt + delay - Date.now()
    if (lastRequestAt > 0 && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    const query = topicQueryForShard(shard)
    const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&per_page=${SEARCH_PER_PAGE}&page=${page}`
    const body = await gh(url)
    pagesUsed += 1
    lastRequestAt = Date.now()
    return body
  }

  async function fetchLeaf(shard, firstPage) {
    let last = null
    for (let attempt = 1; attempt <= MAX_LEAF_ATTEMPTS; attempt += 1) {
      const first = attempt === 1 ? firstPage : await requestPage(shard, 1)
      if (!first) return { complete: false, reason: 'page-budget-exhausted', totalCount: null, fetched: 0, attempts: attempt - 1, items: [] }
      const totalCount = Number(first.total_count)
      if (first.incomplete_results) return { complete: false, reason: 'github-incomplete-results', totalCount, fetched: 0, attempts: attempt, items: [] }
      if (!Number.isSafeInteger(totalCount) || totalCount < 0) return { complete: false, reason: 'invalid-total-count', totalCount: null, fetched: 0, attempts: attempt, items: [] }
      if (totalCount > SEARCH_RESULTS_CAP) return { complete: false, reason: 'leaf-became-saturated', totalCount, fetched: 0, attempts: attempt, items: [] }

      const local = new Map()
      addUnique(local, first.items)
      let reason = null
      for (let page = 2; page <= Math.ceil(totalCount / SEARCH_PER_PAGE); page += 1) {
        const body = await requestPage(shard, page)
        if (!body) {
          reason = 'page-budget-exhausted'
          break
        }
        if (body.incomplete_results) {
          reason = 'github-incomplete-results'
          break
        }
        addUnique(local, body.items)
      }
      if (!reason && local.size === totalCount) {
        return { complete: true, reason: null, totalCount, fetched: local.size, attempts: attempt, items: [...local.values()] }
      }
      last = { complete: false, reason: reason ?? 'page-count-mismatch', totalCount, fetched: local.size, attempts: attempt, items: [...local.values()] }
      if (reason === 'page-budget-exhausted' || reason === 'github-incomplete-results') break
    }
    return last
  }

  while (queue.length > 0) {
    const shard = queue.shift()
    const query = topicQueryForShard(shard)
    const firstPage = await requestPage(shard, 1)
    if (!firstPage) {
      audit.incomplete.push({ query, shard, reason: 'page-budget-exhausted' })
      break
    }
    addUnique(partialItems, firstPage.items)
    const totalCount = Number(firstPage.total_count)
    if (firstPage.incomplete_results) {
      audit.incomplete.push({ query, shard, reason: 'github-incomplete-results', totalCount })
      continue
    }
    if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
      audit.incomplete.push({ query, shard, reason: 'invalid-total-count' })
      continue
    }

    if (totalCount > SEARCH_RESULTS_CAP) {
      const split = shard.depth >= 32 ? null : splitTopicShard(shard, firstPage.items ?? [])
      audit.branches.push({ query, shard, totalCount, splitBy: split?.dimension ?? null })
      if (!split) {
        audit.overflow.push({ query, shard, totalCount, reason: shard.depth >= 32 ? 'max-shard-depth' : 'no-safe-numeric-discriminator' })
        continue
      }
      queue.unshift(...split.children)
      continue
    }

    const leaf = await fetchLeaf(shard, firstPage)
    audit.leaves.push({ query, shard, totalCount: leaf.totalCount, fetched: leaf.fetched, attempts: leaf.attempts, complete: leaf.complete, reason: leaf.reason })
    if (!leaf.complete) {
      audit.incomplete.push({ query, shard, reason: leaf.reason, totalCount: leaf.totalCount, fetched: leaf.fetched })
      addUnique(partialItems, leaf.items)
      continue
    }
    audit.expectedLeafResults += leaf.totalCount
    audit.fetchedLeafResults += leaf.fetched
    addUnique(completeItems, leaf.items)
  }

  if (queue.length > 0 && pagesUsed >= maxPages) audit.incomplete.push({ reason: 'page-budget-exhausted', pendingShards: queue.length })
  audit.pagesUsed = pagesUsed
  audit.uniqueItems = completeItems.size
  audit.duplicateItems = audit.fetchedLeafResults - completeItems.size
  if (audit.incomplete.length === 0 && audit.overflow.length === 0 && audit.uniqueItems !== audit.expectedLeafResults) {
    audit.incomplete.push({ reason: 'global-leaf-count-mismatch', expected: audit.expectedLeafResults, unique: audit.uniqueItems })
  }
  audit.complete = audit.incomplete.length === 0 && audit.overflow.length === 0 && audit.uniqueItems === audit.expectedLeafResults
  const items = audit.complete ? [...completeItems.values()] : [...completeItems.values(), ...partialItems.values()].filter((item, index, all) => all.findIndex((other) => other.full_name?.toLowerCase() === item.full_name?.toLowerCase()) === index)
  return { items, audit }
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
 * 用于兜底已经由 topic-coverage 审计标出的极端不可分溢出叶子；
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
const limitedRun = limitIndex >= 0
/** --skip-topic：复用现有 data/raw/repos.json 的 topicRepos，只刷新 hub 目录/awesome/手动清单（本地快速重建，省掉百级 Search 请求）。 */
const skipTopic = argv.includes('--skip-topic')

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let repos = []
  let topicCoverage = null
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
    repos = result.items
    topicCoverage = { ...result.audit, limitedRun }
    if (out) {
      await mkdir(out, { recursive: true })
      await writeFile(join(out, 'topic-coverage.json'), JSON.stringify(topicCoverage, null, 2))
    }
    console.log(`topic 查询：${topicCoverage.uniqueItems} 个唯一仓库，${topicCoverage.pagesUsed}/${topicCoverage.maxPages} 页，${topicCoverage.complete ? '完整' : '不完整'}`)
    if (!topicCoverage.complete && !limitedRun) {
      const report = out ? join(out, 'topic-coverage.json') : '（--dry 未写入报告）'
      throw new Error(
        `topic 采集不完整：overflow=${topicCoverage.overflow.length} incomplete=${topicCoverage.incomplete.length}；` +
          `详情见 ${report}`,
      )
    }
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
