/**
 * 排行标签组件（M2+）：从 host 半的同源路由加载 registry + history 并渲染排行榜。
 * 数据路径：GET /dsh-recommend/registry.json、GET /dsh-recommend/history.json
 *          （由 dsh-recommend-web 行供给）；刷新走 POST /dsh-recommend/sync。
 *
 * 功能：卡片式榜单（分数条 + 四维信号徽章）、搜索 / 分类 / 四种排序 / 分页、
 *       ⭐ Star 引导、站点链接、安装命令复制、详情展开（主题/许可证/时间/深扫状态）、
 *       近 N 天综合分走势 sparkline、一键刷新数据。
 * 视觉：注入一段 scoped CSS，适配 DSH 亮/暗主题。
 */
import { useEffect, useMemo, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

export interface RankingsTabInjected {
  /** 读取榜单数据（默认走同源路由，可被注入覆盖以便测试）。 */
  loadRankings(): Promise<RegistryDoc>
  /** 读取历史趋势数据（默认走同源路由；缓存缺失时 reject，调用方降级为无趋势）。 */
  loadHistory(): Promise<HistoryDoc>
  /** 触发一次数据刷新（POST 同源 sync 路由，拉最新 registry 覆写缓存）。 */
  refreshRankings(): Promise<{ fetchedAt: string; count: number }>
  /** 读取已安装插件的 moduleName 列表（官方 pluginInventory Remote，M3）。 */
  listInstalled(): Promise<string[]>
  /** 一键安装：POST fullName 给 host 的安装路由，host 构造 spec 并执行 dsh plugin add（M3）。 */
  installPlugin(fullName: string): Promise<InstallResult>
  /** 检查 profile 直接依赖的更新。 */
  loadUpdates(): Promise<UpdateStatus>
  /** 用户确认后更新单个 profile 依赖。 */
  updatePlugin(packageName: string): Promise<UpdateResult>
  /** 保存进阶自动更新策略。 */
  saveUpdatePolicy(policy: UpdatePolicy): Promise<UpdatePolicy>
}

export interface UpdateItem {
  packageName: string
  spec: string
  source: 'github' | 'npm' | 'unknown'
  installed: string | null
  latest: string | null
  updateAvailable: boolean
  error?: string
}

export interface UpdatePolicy {
  mode: 'notify' | 'auto'
  intervalHours: number
  allowlist: string[]
  lastAutoRunAt?: string | null
}

export interface UpdateStatus {
  checkedAt: string
  profile: string
  policy: UpdatePolicy
  updates: UpdateItem[]
}

export interface UpdateResult {
  ok: boolean
  packageName?: string
  restartRequired?: boolean
  message?: string
  stdout?: string
  stderr?: string
  timedOut?: boolean
}

/** host 安装路由的返回结构（与 src/host/web.ts 对齐）。 */
export interface InstallResult {
  ok: boolean
  message?: string
  spec?: string
  profile?: string
  stdout?: string
  stderr?: string
  timedOut?: boolean
}

export type RankingsTabProps = PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'dshRecommend'>
  & RankingsTabInjected

const SIGNAL_LABELS: Record<string, string> = {
  maintenance: 'signalMaintenance',
  popularity: 'signalPopularity',
  quality: 'signalQuality',
  ecosystem: 'signalEcosystem',
}

const SIGNAL_ORDER = ['maintenance', 'popularity', 'quality', 'ecosystem'] as const

const PAGE_SIZE = 50 // 每页条数

/** 分数分级配色。 */
function scoreTier(score: number): string {
  if (score >= 0.85) return 'gold'
  if (score >= 0.65) return 'accent'
  if (score >= 0.5) return 'neutral'
  return 'dim'
}

/** 插件自带静态站 / 主页：补全 scheme；空值或与仓库 URL 相同时返回 null（避免冗余链接）。 */
function normalizeSite(homepage?: string | null, repoUrl?: string): string | null {
  const h = (homepage ?? '').trim()
  if (!h) return null
  const url = h.includes('://') ? h : `https://${h}`
  return url === repoUrl ? null : url
}

/** ISO 时间戳 → 本地可读格式，如 2026-08-14 05:27（UTC+8）。解析失败原样返回，缺省显示 —。 */
function formatTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset() / 60
  const tz = off === 0 ? 'UTC' : `UTC${off > 0 ? '+' : ''}${off}`
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}（${tz}）`
}

/** 复制文本到剪贴板（clipboard API 不可用时降级 textarea）。 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

/** 迷你走势图：近 N 天综合分 polyline。 */
function Sparkline({ series, label }: { series: number[]; label: string }) {
  if (series.length < 2) return null
  const w = 120
  const h = 26
  const pad = 3
  const min = Math.min(...series)
  const max = Math.max(...series)
  const span = max - min || 1
  const step = (w - 2 * pad) / (series.length - 1)
  const pts = series.map((v, i) => {
    const x = pad + i * step
    const y = h - pad - ((v - min) / span) * (h - 2 * pad)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const [lastX, lastY] = pts[pts.length - 1]!.split(',')
  return (
    <svg className="dshr-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r="2.4" fill="currentColor" />
    </svg>
  )
}

/** 一行内的安装状态机（M3）。 */
type InstallState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'installed' }
  | { phase: 'failed'; message: string }

/**
 * 已装匹配：installed moduleName（如 dsh-better-sidebar / @scope/pkg）与 registry
 * fullName（omdsh-dev/DSH-better-sidebar）的 repo 短名做去分隔符小写比较，
 * 尽力而为——匹配不到就当作未安装，不影响功能。
 */
function normalizeKey(name: string): string {
  return name.split('/').pop()!.toLowerCase().replace(/[^a-z0-9]/g, '')
}

const CSS = `
.dshr-wrap {
  --dshr-surface: #ffffff;
  --dshr-surface-muted: #f5f6f7;
  --dshr-text: #0f1115;
  --dshr-text-secondary: #61666b;
  --dshr-text-tertiary: #81858c;
  --dshr-border: rgba(0, 0, 0, .1);
  --dshr-border-hover: rgba(0, 0, 0, .16);
  --dshr-accent: #4176e6;
  --dshr-ok: #1a7f37;
  display: flex; flex-direction: column; gap: 10px;
}
body[data-ds-dark-theme] .dshr-wrap {
  --dshr-surface: var(--dsw-alias-bg-layer-1, #232324);
  --dshr-surface-muted: var(--dsw-alias-bg-layer-2, #2c2c2e);
  --dshr-text: var(--dsw-alias-label-primary, #f9fafb);
  --dshr-text-secondary: var(--dsw-alias-label-secondary, #cfd3d8);
  --dshr-text-tertiary: var(--dsw-alias-label-tertiary, #adb2b8);
  --dshr-border: var(--dsw-alias-border-l2, rgba(255, 255, 255, .12));
  --dshr-border-hover: var(--dsw-alias-border-l3, rgba(255, 255, 255, .16));
  --dshr-accent: var(--dsw-alias-brand-primary-new-colorprimary-new-color, #5690fe);
  --dshr-ok: #3fb950;
}
.dshr-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; }
.dshr-title { margin: 0; font-size: 15px; font-weight: 700; color: var(--dshr-text); }
.dshr-meta { font-size: 11.5px; color: var(--dshr-text-tertiary); }
.dshr-controls { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.dshr-controls input[type="search"] {
  flex: 1 1 200px; min-width: 180px;
  padding: 6px 10px; font-size: 12.5px; color: var(--dshr-text);
  background: var(--dshr-surface);
  border: 1px solid var(--dshr-border); border-radius: 7px; outline: none;
}
.dshr-controls input[type="search"]:focus { border-color: var(--dshr-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dshr-accent) 20%, transparent); }
.dshr-controls select {
  padding: 6px 9px; font-size: 12.5px; color: var(--dshr-text);
  background: var(--dshr-surface);
  border: 1px solid var(--dshr-border); border-radius: 7px; outline: none; cursor: pointer;
}
.dshr-controls select:focus { border-color: var(--dshr-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dshr-accent) 20%, transparent); }
.dshr-refresh {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 11px; font-size: 12.5px; font-family: inherit; cursor: pointer;
  color: var(--dshr-text); background: var(--dshr-surface);
  border: 1px solid var(--dshr-border); border-radius: 7px;
  transition: border-color .15s ease, color .15s ease;
}
.dshr-refresh:hover:not(:disabled) { border-color: var(--dshr-accent); color: var(--dshr-accent); }
.dshr-refresh:disabled { opacity: .55; cursor: wait; }
.dshr-msg { font-size: 12px; color: var(--dshr-text-tertiary); flex-basis: 100%; }
.dshr-updates { border: 1px solid var(--dshr-border); background: var(--dshr-surface-muted); padding: 9px 10px; border-radius: 8px; }
.dshr-update-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.dshr-update-head > div { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dshr-update-head strong { color: var(--dshr-text); font-size: 12px; }
.dshr-update-head span { color: var(--dshr-text-tertiary); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshr-update-check, .dshr-update-run { font: inherit; cursor: pointer; border: 1px solid var(--dshr-border); border-radius: 6px; background: var(--dshr-surface); color: var(--dshr-text); padding: 5px 9px; font-size: 11px; }
.dshr-update-check:hover:not(:disabled), .dshr-update-run:hover:not(:disabled) { border-color: var(--dshr-accent); color: var(--dshr-accent); }
.dshr-update-check:disabled, .dshr-update-run:disabled { opacity: .55; cursor: wait; }
.dshr-update-list { display: grid; gap: 4px; margin-top: 8px; }
.dshr-update-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px dashed var(--dshr-border); padding-top: 5px; }
.dshr-update-package { min-width: 0; display: grid; grid-template-columns: auto auto 1fr; align-items: center; gap: 5px; }
.dshr-update-package code { color: var(--dshr-text); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshr-update-package span, .dshr-update-package small { color: var(--dshr-text-tertiary); font-size: 10px; white-space: nowrap; }
.dshr-update-current { color: var(--dshr-ok); font-size: 11px; white-space: nowrap; }
.dshr-update-error { color: #c62828; font-size: 11px; white-space: nowrap; }
.dshr-update-policy { margin-top: 8px; border-top: 1px dashed var(--dshr-border); padding-top: 6px; }
.dshr-update-policy summary { color: var(--dshr-text-secondary); font-size: 11px; cursor: pointer; }
.dshr-policy-body { display: grid; gap: 7px; padding-top: 8px; color: var(--dshr-text-secondary); font-size: 11px; }
.dshr-policy-body label { display: flex; align-items: center; gap: 6px; }
.dshr-policy-interval input { width: 52px; font: inherit; color: var(--dshr-text); background: var(--dshr-surface); border: 1px solid var(--dshr-border); border-radius: 4px; padding: 3px 5px; }
.dshr-policy-allowlist { display: grid; gap: 4px; }
.dshr-policy-allowlist > span { color: var(--dshr-text-tertiary); }
.dshr-policy-body p { margin: 0; color: var(--dshr-text-tertiary); line-height: 1.45; }
.dshr-update-message { margin: 7px 0 0; color: var(--dshr-text-secondary); font-size: 11px; }
.dshr-list { display: flex; flex-direction: column; gap: 4px; }
.dshr-row {
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px 11px; border: 1px solid var(--dshr-border); border-radius: 8px;
  background: var(--dshr-surface);
  transition: border-color .15s ease;
}
.dshr-row:hover { border-color: var(--dshr-border-hover); }
.dshr-row-top { display: flex; align-items: center; gap: 9px; min-width: 0; }
.dshr-rank {
  flex: 0 0 auto; min-width: 30px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: var(--dshr-text-secondary);
  border-radius: 6px; background: var(--dshr-surface-muted);
}
.dshr-rank.gold { color: #f5c518; }
.dshr-rank.accent { color: var(--dshr-accent); }
.dshr-rank.dim { color: var(--dshr-text-tertiary); }
.dshr-name { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dshr-name a {
  font-size: 13px; font-weight: 600; color: var(--dshr-text);
  text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dshr-name a:hover { color: var(--dshr-accent); }
.dshr-cert { font-size: 11px; }
.dshr-cat { font-size: 10.5px; color: var(--dshr-text-tertiary); }
.dshr-right { margin-left: auto; flex: 0 0 auto; display: flex; align-items: center; gap: 10px; }
.dshr-stars { font-size: 12px; color: var(--dshr-text-secondary); white-space: nowrap; font-variant-numeric: tabular-nums; }
.dshr-score { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.dshr-score .num { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
.dshr-score .num.gold { color: #f5c518; }
.dshr-score .num.accent { color: var(--dshr-accent); }
.dshr-score .num.neutral { color: var(--dshr-text-secondary); }
.dshr-score .num.dim { color: var(--dshr-text-tertiary); }
.dshr-desc {
  font-size: 12px; line-height: 1.5; color: var(--dshr-text-secondary);
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.dshr-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.dshr-pills { display: flex; flex-wrap: wrap; gap: 4px; }
.dshr-pill {
  font-size: 10px; line-height: 1; padding: 3px 7px; border-radius: 999px;
  color: var(--dshr-text-secondary);
  background: var(--dshr-surface-muted);
  border: 1px solid var(--dshr-border);
}
.dshr-pill b { font-weight: 600; color: var(--dshr-text); }
.dshr-trend { display: flex; align-items: center; gap: 5px; color: var(--dshr-text-tertiary); }
.dshr-spark { color: var(--dshr-accent); flex: 0 0 auto; }
.dshr-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.dshr-act {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11.5px; line-height: 1; text-decoration: none; border-radius: 999px;
  padding: 5px 10px; border: 1px solid var(--dshr-border);
  color: var(--dshr-text-secondary); background: var(--dshr-surface);
  transition: border-color .15s ease, color .15s ease;
  font-family: inherit; cursor: pointer;
}
.dshr-act:hover:not(:disabled) { border-color: var(--dshr-accent); color: var(--dshr-accent); }
.dshr-act:disabled { opacity: .55; cursor: not-allowed; }
.dshr-act.dshr-install { color: var(--dshr-accent); border-color: color-mix(in srgb, var(--dshr-accent) 45%, transparent); font-weight: 600; }
.dshr-act.dshr-install:hover:not(:disabled) { background: color-mix(in srgb, var(--dshr-accent) 8%, transparent); }
.dshr-act.dshr-installed { color: var(--dshr-ok); border-color: color-mix(in srgb, var(--dshr-ok) 45%, transparent); font-weight: 600; }
.dshr-act.dshr-installing { color: var(--dshr-text-tertiary); }
.dshr-act.dshr-failed { color: #c62828; border-color: color-mix(in srgb, #c62828 45%, transparent); }
body[data-ds-dark-theme] .dshr-act.dshr-failed { color: #f97583; }
.dshr-act.dshr-star { color: #b8860b; border-color: #e6c25e; background: #fffaf0; font-weight: 600; }
.dshr-act.dshr-star:hover:not(:disabled) { color: #8a6a00; background: #fff3d6; border-color: #b8860b; }
body[data-ds-dark-theme] .dshr-act.dshr-star { color: #f5c518; background: rgba(245, 197, 24, .12); border-color: rgba(245, 197, 24, .45); }
body[data-ds-dark-theme] .dshr-act.dshr-star:hover:not(:disabled) { color: #ffd84d; background: rgba(245, 197, 24, .2); border-color: #f5c518; }
.dshr-act.dshr-repo { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11.5px; }
.dshr-act.dshr-copy { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11.5px; }
.dshr-act.dshr-copied { border-color: #2e9e5b; color: #2e9e5b; }
body[data-ds-dark-theme] .dshr-act.dshr-copied { border-color: #4cc38a; color: #4cc38a; }
.dshr-name .dshr-repo-addr {
  font-size: 10.5px; font-weight: 400;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  color: var(--dshr-text-tertiary); text-decoration: none;
}
.dshr-name .dshr-repo-addr:hover { color: var(--dshr-accent); text-decoration: underline; }
.dshr-install-msg { font-size: 11px; color: var(--dshr-text-tertiary); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshr-install-msg.ok { color: var(--dshr-ok); }
.dshr-install-msg.bad { color: #c62828; }
body[data-ds-dark-theme] .dshr-install-msg.bad { color: #f97583; }
.dshr-details { border-top: 1px dashed var(--dshr-border); padding-top: 7px; font-size: 12px; color: var(--dshr-text-secondary); }
.dshr-details summary { cursor: pointer; color: var(--dshr-text-tertiary); font-size: 12px; user-select: none; }
.dshr-details summary:hover { color: var(--dshr-accent); }
.dshr-details dl { display: grid; grid-template-columns: max-content 1fr; gap: 5px 14px; margin: 8px 0 0; }
.dshr-details dt { color: var(--dshr-text-tertiary); white-space: nowrap; }
.dshr-details dd { margin: 0; overflow-wrap: anywhere; }
.dshr-details .dshr-topics { display: flex; flex-wrap: wrap; gap: 4px; }
.dshr-details .dshr-topic {
  font-size: 11px; line-height: 1; padding: 3px 7px; border-radius: 999px;
  color: var(--dshr-text-secondary); background: var(--dshr-surface-muted); border: 1px solid var(--dshr-border);
}
.dshr-pager { display: flex; align-items: center; justify-content: center; gap: 8px; }
.dshr-pager button {
  padding: 5px 11px; font-size: 12px; font-family: inherit; color: var(--dshr-text);
  background: var(--dshr-surface); border: 1px solid var(--dshr-border);
  border-radius: 7px; cursor: pointer;
}
.dshr-pager button:hover:not(:disabled) { border-color: var(--dshr-accent); color: var(--dshr-accent); }
.dshr-pager button:disabled { opacity: .45; cursor: not-allowed; }
.dshr-pager-info { font-size: 12px; color: var(--dshr-text-tertiary); }
.dshr-note { font-size: 11.5px; color: var(--dshr-text-tertiary); }
`

export function RankingsTab({ t, loadRankings, loadHistory, refreshRankings, listInstalled, installPlugin, loadUpdates, updatePlugin, saveUpdatePolicy }: RankingsTabProps): JSX.Element {
  const [doc, setDoc] = useState<RegistryDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryDoc | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [view, setView] = useState<'score' | 'stars' | 'updated' | 'newest'>('score')
  const [page, setPage] = useState(1)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [installState, setInstallState] = useState<Record<string, InstallState>>({})
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [updateLoading, setUpdateLoading] = useState(false)
  const [updatingPackage, setUpdatingPackage] = useState<string | null>(null)
  const [updateMessage, setUpdateMessage] = useState<string | null>(null)
  const [policyDraft, setPolicyDraft] = useState<UpdatePolicy | null>(null)

  useEffect(() => {
    let alive = true
    loadRankings()
      .then((d) => { if (alive) setDoc(d) })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : String(err)) })
    return () => { alive = false }
  }, [loadRankings])

  useEffect(() => {
    let alive = true
    loadHistory()
      .then((h) => { if (alive) setHistory(h) })
      .catch(() => { if (alive) setHistory(null) }) // 历史缓存缺失 → 无趋势，不影响榜单
    return () => { alive = false }
  }, [loadHistory])

  useEffect(() => {
    const style = document.getElementById('dshr-rankings-css') ?? document.createElement('style')
    style.id = 'dshr-rankings-css'
    style.textContent = CSS
    if (!style.parentNode) document.head.appendChild(style)
  }, [])

  // 已装检测：尽力匹配，失败静默降级（不影响榜单与安装功能）
  useEffect(() => {
    let alive = true
    listInstalled()
      .then((names) => {
        if (!alive) return
        setInstalled(new Set(names.map(normalizeKey)))
      })
      .catch(() => { /* pluginInventory 不可用时静默跳过 */ })
    return () => { alive = false }
  }, [listInstalled])

  // 更新检查默认只读：初始加载一次，用户可点「检查更新」手动刷新。
  useEffect(() => {
    let alive = true
    loadUpdates()
      .then((status) => {
        if (!alive) return
        setUpdateStatus(status)
        setPolicyDraft(status.policy)
      })
      .catch(() => { /* 更新检查不可用不影响排行榜 */ })
    return () => { alive = false }
  }, [loadUpdates])

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const p of doc?.plugins ?? []) if (p.category) set.add(p.category)
    return [...set].sort()
  }, [doc])

  const rows = useMemo(() => {
    if (!doc) return []
    const q = query.toLowerCase()
    const list = doc.plugins
      .filter((p) => !p.excluded)
      .filter((p) => !category || p.category === category)
      .filter((p) => `${p.fullName} ${p.description ?? ''} ${p.category ?? ''}`.toLowerCase().includes(q))
    list.sort((a, b) => {
      if (view === 'stars') return b.stars - a.stars
      if (view === 'updated') return (b.pushedAt ?? '').localeCompare(a.pushedAt ?? '')
      if (view === 'newest') return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
      return b.score - a.score
    })
    return list
  }, [doc, query, category, view])

  /** fullName(小写) -> 每日分数序列（按日期升序）。 */
  const trendSeries = useMemo(() => {
    const map = new Map<string, number[]>()
    if (!history) return map
    const days = [...history.days].sort((a, b) => a.date.localeCompare(b.date))
    for (const day of days) {
      for (const entry of day.top) {
        const key = entry.fullName.toLowerCase()
        const list = map.get(key) ?? []
        list.push(entry.score)
        map.set(key, list)
      }
    }
    return map
  }, [history])

  const onRefresh = async () => {
    setRefreshing(true)
    setRefreshMsg(null)
    try {
      const r = await refreshRankings()
      const fresh = await loadRankings()
      setDoc(fresh)
      setError(null)
      setRefreshMsg(t('refreshDone', { time: formatTime(r.fetchedAt) }))
    } catch (err) {
      setRefreshMsg(t('refreshFail', { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      setRefreshing(false)
    }
  }

  const onCopy = async (fullName: string) => {
    const cmd = `dsh plugin --profile web add github:${fullName}`
    try {
      await copyText(cmd)
      setCopied(fullName)
      window.setTimeout(() => setCopied((cur) => (cur === fullName ? null : cur)), 1800)
    } catch {
      setRefreshMsg(t('copyFail'))
    }
  }

  const doInstall = async (fullName: string): Promise<void> => {
    setInstallState((s) => ({ ...s, [fullName]: { phase: 'running' } }))
    try {
      const result = await installPlugin(fullName)
      if (result.ok) {
        setInstallState((s) => ({ ...s, [fullName]: { phase: 'installed' } }))
        // 本会话内视为已装（重启后 pluginInventory 会确认）
        setInstalled((prev) => new Set(prev).add(normalizeKey(fullName)))
      } else {
        setInstallState((s) => ({ ...s, [fullName]: { phase: 'failed', message: result.message ?? t('installFail') } }))
      }
    } catch (err) {
      setInstallState((s) => ({ ...s, [fullName]: { phase: 'failed', message: err instanceof Error ? err.message : String(err) } }))
    }
  }

  const onCheckUpdates = async (): Promise<void> => {
    setUpdateLoading(true)
    setUpdateMessage(null)
    try {
      const status = await loadUpdates()
      setUpdateStatus(status)
      setPolicyDraft(status.policy)
      const count = status.updates.filter((u) => u.updateAvailable).length
      setUpdateMessage(count > 0 ? t('updateFound', { count: String(count) }) : t('updateNone'))
    } catch (error) {
      setUpdateMessage(t('updateCheckFail', { message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setUpdateLoading(false)
    }
  }

  const doUpdate = async (packageName: string): Promise<void> => {
    setUpdatingPackage(packageName)
    setUpdateMessage(null)
    try {
      const result = await updatePlugin(packageName)
      if (result.ok) {
        // 更新后刷新状态，但保留「请重启」提示，不能被检查结果覆盖。
        try {
          const status = await loadUpdates()
          setUpdateStatus(status)
          setPolicyDraft(status.policy)
        } catch { /* 更新已成功，刷新状态失败不影响重启提示 */ }
        setUpdateMessage(t('updateDone', { packageName }))
      } else {
        setUpdateMessage(t('updateFail', { packageName, message: result.message ?? t('unknownError') }))
      }
    } catch (error) {
      setUpdateMessage(t('updateFail', { packageName, message: error instanceof Error ? error.message : String(error) }))
    } finally {
      setUpdatingPackage(null)
    }
  }

  const onSavePolicy = async (): Promise<void> => {
    if (!policyDraft) return
    try {
      const policy = await saveUpdatePolicy(policyDraft)
      setPolicyDraft(policy)
      setUpdateStatus((current) => current ? { ...current, policy } : current)
      setUpdateMessage(policy.mode === 'auto' ? t('autoUpdateEnabled') : t('autoUpdateDisabled'))
    } catch (error) {
      setUpdateMessage(t('updatePolicyFail', { message: error instanceof Error ? error.message : String(error) }))
    }
  }

  if (error) {
    return (
      <div className="dshr-wrap">
        <p role="alert">{t('loadError', { message: error })}</p>
        <button type="button" className="dshr-refresh" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? t('refreshing') : t('refresh')}
        </button>
      </div>
    )
  }
  if (!doc) {
    return <p role="status">{t('loading')}</p>
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const start = (safePage - 1) * PAGE_SIZE
  const pageRows = rows.slice(start, start + PAGE_SIZE)
  const historyDays = history?.days.length ?? 0

  return (
    <div className="dshr-wrap">
      <div className="dshr-head">
        <h2 className="dshr-title">{t('tab')}</h2>
        <span className="dshr-meta">
          {t('meta', {
            count: String(doc.plugins.filter((p) => !p.excluded).length),
            time: formatTime(doc.meta.generatedAt),
            version: String(doc.meta.scoringVersion ?? '?'),
          })}
          {historyDays > 0 ? t('historyMeta', { days: String(historyDays) }) : null}
        </span>
      </div>

      <section className="dshr-updates" aria-label={t('updateSectionTitle')}>
        <div className="dshr-update-head">
          <div>
            <strong>{t('updateSectionTitle')}</strong>
            <span>{updateStatus ? t('updateCheckedAt', { time: formatTime(updateStatus.checkedAt) }) : t('updateCheckingInitial')}</span>
          </div>
          <button type="button" className="dshr-update-check" onClick={() => { void onCheckUpdates() }} disabled={updateLoading || updatingPackage !== null}>
            {updateLoading ? t('updateChecking') : t('updateCheck')}
          </button>
        </div>
        {updateStatus ? (
          <>
            <div className="dshr-update-list">
              {updateStatus.updates.map((item) => (
                <div className="dshr-update-row" key={item.packageName}>
                  <div className="dshr-update-package">
                    <code>{item.packageName}</code>
                    <span>{item.source === 'github' ? t('updateSourceGit') : item.source === 'npm' ? t('updateSourceNpm') : t('updateSourceUnknown')}</span>
                    <small>{(item.installed ?? '—').slice(0, 12)} → {(item.latest ?? '—').slice(0, 12)}</small>
                  </div>
                  {item.error ? <span className="dshr-update-error" title={item.error}>{t('updateUnavailable')}</span> : item.updateAvailable ? (
                    <button type="button" className="dshr-update-run" onClick={() => { void doUpdate(item.packageName) }} disabled={updatingPackage !== null}>
                      {updatingPackage === item.packageName ? t('updating') : t('updateNow')}
                    </button>
                  ) : <span className="dshr-update-current">{t('updateCurrent')}</span>}
                </div>
              ))}
            </div>
            {policyDraft ? (
              <details className="dshr-update-policy">
                <summary>{t('updatePolicyTitle')}</summary>
                <div className="dshr-policy-body">
                  <label>
                    <input type="checkbox" checked={policyDraft.mode === 'auto'} onChange={(e) => setPolicyDraft({ ...policyDraft, mode: e.target.checked ? 'auto' : 'notify' })} />
                    {t('autoUpdateLabel')}
                  </label>
                  <label className="dshr-policy-interval">
                    {t('autoUpdateInterval')}
                    <input type="number" min="1" max="168" value={policyDraft.intervalHours} onChange={(e) => setPolicyDraft({ ...policyDraft, intervalHours: Math.min(168, Math.max(1, Number(e.target.value) || 1)) })} />
                    {t('hourUnit')}
                  </label>
                  {policyDraft.mode === 'auto' ? (
                    <div className="dshr-policy-allowlist">
                      <span>{t('autoUpdateAllowlist')}</span>
                      {updateStatus.updates.map((item) => (
                        <label key={item.packageName}>
                          <input type="checkbox" checked={policyDraft.allowlist.includes(item.packageName)} onChange={(e) => setPolicyDraft({ ...policyDraft, allowlist: e.target.checked ? [...policyDraft.allowlist, item.packageName] : policyDraft.allowlist.filter((p) => p !== item.packageName) })} />
                          <code>{item.packageName}</code>
                        </label>
                      ))}
                    </div>
                  ) : null}
                  <button type="button" className="dshr-update-check" onClick={() => { void onSavePolicy() }}>{t('saveUpdatePolicy')}</button>
                  <p>{t('autoUpdateNotice')}</p>
                </div>
              </details>
            ) : null}
          </>
        ) : null}
        {updateMessage ? <p className="dshr-update-message" role="status">{updateMessage}</p> : null}
      </section>

      <div className="dshr-controls">
        <input
          type="search"
          placeholder={t('searchPlaceholder')}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(1) }}
          aria-label={t('searchPlaceholder')}
        />
        <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1) }} aria-label={t('allCategories')}>
          <option value="">{t('allCategories')}</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={view} onChange={(e) => { setView(e.target.value as typeof view); setPage(1) }} aria-label={t('sortScore')}>
          <option value="score">{t('sortScore')}</option>
          <option value="stars">{t('sortStars')}</option>
          <option value="updated">{t('sortUpdated')}</option>
          <option value="newest">{t('sortNewest')}</option>
        </select>
        <button type="button" className="dshr-refresh" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? t('refreshing') : t('refresh')}
        </button>
      </div>
      {refreshMsg ? <p className="dshr-msg" role="status">{refreshMsg}</p> : null}

      <div className="dshr-list">
        {pageRows.map((p, i) => {
          const tier = scoreTier(p.score)
          const medal = start + i === 0 ? '🥇' : start + i === 1 ? '🥈' : start + i === 2 ? '🥉' : `#${start + i + 1}`
          const series = trendSeries.get(p.fullName.toLowerCase())
          const site = normalizeSite(p.homepage, p.url)
          const scanLabel = !p.scanStatus || p.scanStatus === 'skipped'
            ? t('scanSkipped')
            : p.scanStatus === 'verified' ? t('scanVerified')
            : p.scanStatus === 'unverified' ? t('scanUnverified') : t('scanError')
          return (
            <article className="dshr-row" key={p.fullName}>
              <div className="dshr-row-top">
                <span className={`dshr-rank ${tier}`}>{medal}</span>
                <div className="dshr-name">
                  <a href={p.url} target="_blank" rel="noreferrer" title={p.fullName}>{p.fullName}{p.certified ? <span className="dshr-cert" title={t('certifiedTitle')}> 🏅</span> : null}</a>
                  {p.category ? <span className="dshr-cat">{p.category}</span> : null}
                  <a className="dshr-repo-addr" href={p.url} target="_blank" rel="noreferrer" title={`github.com/${p.fullName}`}>github.com/{p.fullName}</a>
                </div>
                <div className="dshr-right">
                  <span className="dshr-stars">★ {p.stars}</span>
                  <span className="dshr-score">
                    <span className={`num ${tier}`}>{p.score.toFixed(3)}</span>
                  </span>
                </div>
              </div>

              {p.description ? <p className="dshr-desc">{p.description}</p> : null}

              <div className="dshr-foot">
                <span className="dshr-pills">
                  {SIGNAL_ORDER.map((k) => {
                    const v = p.signals?.[k]
                    return v === undefined ? null : (
                      <span className="dshr-pill" key={k}>
                        {t(SIGNAL_LABELS[k] as Parameters<typeof t>[0])} <b>{v.toFixed(2)}</b>
                      </span>
                    )
                  })}
                </span>
                {series && series.length >= 2 ? (
                  <span className="dshr-trend" title={t('trendTitle', { days: String(series.length) })}>
                    <Sparkline series={series} label={t('trendTitle', { days: String(series.length) })} />
                  </span>
                ) : null}
              </div>

              {/* Star / 站点 / 一键安装 / 复制命令；被排除（占位/WIP）仓库不引导 Star 与安装 */}
              {p.excluded ? null : (
                <div className="dshr-actions">
                  {(() => {
                    const st = installState[p.fullName] ?? { phase: 'idle' }
                    const isInstalled = installed.has(normalizeKey(p.fullName)) || st.phase === 'installed'
                    if (st.phase === 'failed') {
                      return <span className="dshr-install-msg bad" title={st.message}>{t('installFail')}</span>
                    }
                    if (st.phase === 'running') {
                      return <span className="dshr-act dshr-installing" title={t('installingTitle')}>{t('installing')}</span>
                    }
                    if (isInstalled) {
                      return <span className="dshr-act dshr-installed" title={t('installedTitle')}>✓ {t('installed')}</span>
                    }
                    return (
                      <button
                        type="button"
                        className="dshr-act dshr-install"
                        title={t('installTitle')}
                        onClick={() => { void doInstall(p.fullName) }}
                      >
                        ⬇ {t('install')}
                      </button>
                    )
                  })()}
                  <a
                    className="dshr-act dshr-star"
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    title={t('starTitle')}
                  >
                    {t('starSupport')}
                  </a>
                  {site ? (
                    <a className="dshr-act dshr-site" href={site} target="_blank" rel="noreferrer" title={t('siteTitle')}>
                      {t('site')}
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className={`dshr-act dshr-copy${copied === p.fullName ? ' dshr-copied' : ''}`}
                    title={t('copyTitle')}
                    onClick={() => void onCopy(p.fullName)}
                  >
                    {copied === p.fullName ? t('copied') : t('copyCommand')}
                  </button>
                </div>
              )}

              <details className="dshr-details">
                <summary>{t('details')}</summary>
                <dl>
                  {p.category ? (
                    <><dt>{t('fieldCategory')}</dt><dd>{p.category}</dd></>
                  ) : null}
                  {Array.isArray(p.topics) && p.topics.length > 0 ? (
                    <><dt>{t('fieldTopics')}</dt><dd><span className="dshr-topics">{p.topics.map((tp) => <span className="dshr-topic" key={tp}>{tp}</span>)}</span></dd></>
                  ) : null}
                  {p.license ? <><dt>{t('fieldLicense')}</dt><dd>{p.license}</dd></> : null}
                  {p.createdAt ? <><dt>{t('fieldCreated')}</dt><dd>{formatTime(p.createdAt)}</dd></> : null}
                  {p.pushedAt ? <><dt>{t('fieldPushed')}</dt><dd>{formatTime(p.pushedAt)}</dd></> : null}
                  {site ? <><dt>{t('fieldHomepage')}</dt><dd>{site}</dd></> : null}
                  <><dt>{t('fieldScan')}</dt><dd>{scanLabel}</dd></>
                  {p.excluded ? <><dt>{t('excludedReason')}</dt><dd>{p.excluded}</dd></> : null}
                </dl>
              </details>
            </article>
          )
        })}
      </div>

      <div className="dshr-pager">
        <button type="button" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>{t('prevPage')}</button>
        <span className="dshr-pager-info">{t('pageInfo', { page: String(safePage), totalPages: String(totalPages) })}</span>
        <button type="button" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>{t('nextPage')}</button>
      </div>

      <p className="dshr-note">
        {t('scoreNote', { page: String(safePage), totalPages: String(totalPages), count: String(rows.length) })}
      </p>
    </div>
  )
}

export interface RegistryDoc {
  meta: { generatedAt?: string; scoringVersion?: number }
  plugins: Array<{
    fullName: string
    url: string
    description: string | null
    stars: number
    score: number
    category: string | null
    excluded: string | null
    pushedAt: string | null
    createdAt: string | null
    homepage?: string | null
    license?: string | null
    topics?: string[]
    scanStatus?: 'verified' | 'unverified' | 'skipped' | 'error' | null
    certified?: boolean
    signals: Record<string, number>
  }>
}

export interface HistoryDoc {
  meta?: { updatedAt?: string }
  days: Array<{
    date: string
    total: number
    ranked: number
    excluded: number
    top: Array<{ fullName: string; rank: number; score: number; stars: number; category: string | null }>
  }>
}
