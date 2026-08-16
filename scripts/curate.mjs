/**
 * curate.mjs — 精选认证收录：从 approved issue 提取仓库地址，追加到 curated.json。
 *
 * 由 .github/workflows/curate.yml 调用（监听 issue 被标 approved 标签）：
 *   node scripts/curate.mjs --repo owner/name --issue 123 [--npm dsh-xxx]
 *
 * 零依赖（Node 18+ 内置 API）。校验规则与 AGENTS.md 一致：
 *   - 只接受合法 owner/name 格式，拒绝路径穿越与任意字符串
 *   - 已收录的不重复追加
 *   - 输出写回 scripts/curated.json（保持 JSON 结构，供 score.mjs 消费）
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CURATED_FILE = join(dirname(dirname(fileURLToPath(import.meta.url))), 'scripts', 'curated.json')

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const NPM_PATTERN = /^@?[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/

/**
 * 追加一个通过审核的仓库到精选列表。
 * @param fullName - 'owner/name' 格式。
 * @param issueNumber - 通过审核的 issue 编号。
 * @param npmPackage - 可选：npm 包名（用于下载量榜）。
 * @returns 新增的条目（已存在时返回 null）。
 */
export async function addCurated(fullName, issueNumber, npmPackage = null) {
  const name = fullName.trim()
  if (!REPO_PATTERN.test(name)) {
    throw new Error(`非法仓库名（应为 owner/name）：${fullName}`)
  }
  const pkg = (npmPackage ?? '').trim() || null
  if (pkg && !NPM_PATTERN.test(pkg)) {
    throw new Error(`非法 npm 包名：${npmPackage}`)
  }
  let list
  try {
    list = JSON.parse(await readFile(CURATED_FILE, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    list = { plugins: [] }
  }
  const plugins = Array.isArray(list.plugins) ? list.plugins : []
  if (plugins.some((p) => p.fullName === name)) return null
  const entry = {
    fullName: name,
    issue: Number(issueNumber) || null,
    approvedAt: new Date().toISOString().slice(0, 10),
    ...(pkg ? { npmPackage: pkg } : {}),
  }
  plugins.push(entry)
  await writeFile(CURATED_FILE, JSON.stringify({ note: list.note, plugins }, null, 2) + '\n', 'utf8')
  return entry
}

/**
 * 从 issue body（GitHub 表单渲染的 Markdown）提取仓库地址与 npm 包名。
 * 替代 bash grep：规避 bash 正则引擎差异与反引号命令注入（issue 正文可能含
 * `dsh.bundle` 等反引号内容，bash 展开时会执行命令）。
 * @param body - issue body 原文。
 * @returns { fullName: string, npmPackage: string | null }
 */
export function parseIssueBody(body) {
  const text = String(body ?? '')
  // 仓库地址：github.com/owner/name 或 github:owner/name（取首个）
  const repoMatch = text.match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/)
    || text.match(/github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/)
  const fullName = repoMatch ? repoMatch[1].replace(/[)#.,;]/g, '') : ''
  // npm 包名：表单字段后「反引号包裹」或「换行后短行」的值；
  // 排除含空格/斜杠路径/命令样式的（如 `dsh plugin add ...`）
  let npmPackage = null
  const npmField = text.match(/(?:npm\s*包名|npm\s*package)[^\n`]*\s*`([^`\n]+)`|(?:npm\s*包名|npm\s*package)[^\n]*\n\s*([A-Za-z0-9@_.-]+(?:\/[A-Za-z0-9_.-]+)?)\s*(?:\n|$)/i)
  if (npmField) {
    const candidate = (npmField[1] ?? npmField[2] ?? '').trim()
    // 只接受合法 npm 包名；拒绝含空格/反引号/命令样式（如 `dsh plugin add ...`）
    if (/^@?[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/.test(candidate)) npmPackage = candidate
  }
  return { fullName, npmPackage }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  const repoIndex = argv.indexOf('--repo')
  const issueIndex = argv.indexOf('--issue')
  const npmIndex = argv.indexOf('--npm')
  const bodyIndex = argv.indexOf('--body')
  const repo = repoIndex >= 0 ? argv[repoIndex + 1] : ''
  const issue = issueIndex >= 0 ? argv[issueIndex + 1] : ''
  const npm = npmIndex >= 0 ? argv[npmIndex + 1] : null
  let body = bodyIndex >= 0 ? argv[bodyIndex + 1] : null

  // --body 模式：从 issue body 直接解析（workflow 传入，替代 bash 正则提取）
  if (body !== null) {
    const parsed = parseIssueBody(body)
    if (!parsed.fullName) {
      console.error('未在 issue body 中找到仓库地址，跳过')
      process.exit(0)
    }
    const entry = await addCurated(parsed.fullName, issue, parsed.npmPackage)
    console.log(entry ? `已收录精选：${entry.fullName}（issue #${entry.issue ?? '?'}）` : `已存在，跳过：${parsed.fullName}`)
    process.exit(0)
  }

  if (!repo) {
    console.error('用法：node scripts/curate.mjs --repo owner/name --issue 123 [--npm dsh-xxx] | --body "<issue body>" --issue 123')
    process.exit(2)
  }
  const entry = await addCurated(repo, issue, npm)
  console.log(entry ? `已收录精选：${entry.fullName}（issue #${entry.issue ?? '?'}）` : `已存在，跳过：${repo}`)
}
