/* dsh-recommend 静态站：零构建，直接消费 data/registry.json + data/history.json */

const SIGNAL_LABELS = { maintenance: '维护性', popularity: '热度', quality: '质量', ecosystem: '生态' }
const SIGNAL_ORDER = ['maintenance', 'popularity', 'quality', 'ecosystem']
const SCAN_LABELS = { verified: '检出 DSH 插件特征', unverified: '未检出插件特征（已排除出榜）', skipped: '未深扫', error: '深扫失败' }

/** ISO 时间戳 → 本地可读格式，如 2026-08-14 05:27（UTC+8）。解析失败原样返回，缺省显示 —。 */
function formatTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset() / 60
  const tz = off === 0 ? 'UTC' : `UTC${off > 0 ? '+' : ''}${off}`
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}（${tz}）`
}

let doc = null // { meta, plugins }（registry）
let history = null // { days: [...] }（每日快照）

const PAGE_SIZE = 50 // 每页条数
let page = 1 // 当前页（1 起）

function scoreTier(score) {
  if (score >= 0.85) return 'gold'
  if (score >= 0.65) return 'accent'
  if (score >= 0.5) return 'neutral'
  return 'dim'
}

/** HTML 转义：homepage / description 等来自 GitHub API 的文本，避免破坏布局或注入。 */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/** 插件自带静态站 / 主页链接：补全 scheme，空值或与仓库 URL 相同时不展示（避免冗余）。 */
function siteLink(p) {
  const h = String(p.homepage ?? '').trim()
  if (!h) return ''
  const url = h.includes('://') ? h : `https://${h}`
  if (url === p.url) return ''
  return `<a class="act site" href="${esc(url)}" target="_blank" rel="noopener" title="插件静态站 / 文档">🌐 站点</a>`
}

/** 安装命令。 */
function installCmd(p) {
  return `dsh plugin --profile web add github:${p.fullName}`
}

/** 近 N 天综合分序列（按日期升序）。 */
function trendSeries(fullName) {
  if (!history?.days) return []
  const days = [...history.days].sort((a, b) => a.date.localeCompare(b.date))
  const out = []
  for (const day of days) {
    const hit = day.top.find((x) => x.fullName.toLowerCase() === fullName.toLowerCase())
    if (hit) out.push(hit.score)
  }
  return out
}

/** 迷你走势图 SVG。 */
function sparkline(series) {
  if (series.length < 2) return ''
  const w = 120, h = 26, pad = 3
  const min = Math.min(...series), max = Math.max(...series)
  const span = max - min || 1
  const step = (w - 2 * pad) / (series.length - 1)
  const pts = series.map((v, i) => {
    const x = pad + i * step
    const y = h - pad - ((v - min) / span) * (h - 2 * pad)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const [lx, ly] = pts[pts.length - 1].split(',')
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="近 ${series.length} 天综合分走势"><polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${lx}" cy="${ly}" r="2.4" fill="currentColor"/></svg>`
}

async function load() {
  try {
    const reg = await fetch('../data/registry.json').then((r) => r.json())
    doc = reg
    const cats = new Set(doc.plugins.map((p) => p.category).filter(Boolean))
    const sel = document.getElementById('category')
    for (const c of [...cats].sort()) {
      const opt = document.createElement('option')
      opt.value = c
      opt.textContent = c
      sel.append(opt)
    }
    const exc = doc.plugins.filter((p) => p.excluded).length
    const hub = reg.meta?.signals?.hubCatalog
    document.getElementById('meta').textContent =
      `数据 ${formatTime(reg.meta.generatedAt)} · 全量 ${reg.meta.counts.topicRepos} · 上榜 ${reg.meta.counts.ranked} · 排除 ${exc} · 分类 ${hub ? `${hub.entries} 条 / ${hub.categories} 类` : '—'} · 评分模型 v${reg.meta.scoringVersion}`
  } catch (err) {
    document.getElementById('meta').textContent = `加载失败：${err.message}（先跑 node scripts/sync.mjs 生成数据）`
  }
  // 历史趋势：可选，失败不阻塞榜单
  try {
    history = await fetch('../data/history.json').then((r) => r.json())
  } catch { history = null }
  // 支持 ?q= 查询参数（邀请落地页「查找插件」跳转用）：自动填入搜索框并筛选
  const urlQ = new URLSearchParams(location.search).get('q')
  if (urlQ) {
    const searchInput = document.getElementById('search')
    if (searchInput) {
      searchInput.value = urlQ
      document.getElementById('count').textContent = `正在查找「${urlQ}」…`
    }
  }
  renderCertified()
  render()
}

/* ===== 精选认证侧栏 ===== */

/** 侧栏默认显示的认证插件数（其余折叠，避免挤占主榜；4 卡片 + 1 展开按钮视觉平衡）。 */
const CERT_TOP = 4

/** 渲染「精选认证」推荐列表。无认证插件时隐藏整区；超出 CERT_TOP 个折叠。 */
function renderCertified() {
  const wrap = document.getElementById('certified-showcase')
  const list = document.getElementById('cert-list')
  const count = document.getElementById('cert-count')
  if (!wrap || !list) return

  const certified = (doc?.plugins ?? [])
    .filter((p) => p.certified && !p.excluded)
    .sort((a, b) => b.score - a.score)
  if (certified.length === 0) {
    wrap.hidden = true
    return
  }
  wrap.hidden = false
  if (count) count.textContent = `${certified.length} 个`

  const showAll = wrap.dataset.expanded === '1'
  const visible = showAll ? certified : certified.slice(0, CERT_TOP)
  const hiddenCount = certified.length - visible.length

  list.innerHTML = visible.map((p) => {
    const tier = scoreTier(p.score)
    return `
      <article class="cert-card">
        <div class="cert-card-head">
          <div class="cert-info">
            <span class="cert-label">${esc(p.category || '精选插件')}</span>
            <a class="cert-name" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.fullName)}</a>
          </div>
          <span class="cert-mark" aria-hidden="true">✓</span>
        </div>
        ${p.description ? `<p class="cert-desc">${esc(p.description)}</p>` : ''}
        <div class="cert-stats">
          <span><b>★ ${p.stars}</b> Stars</span>
          <span><b class="num ${tier}">${p.score.toFixed(3)}</b> 综合分</span>
        </div>
        <a class="cert-open" href="${esc(p.url)}" target="_blank" rel="noopener">
          查看仓库 <span aria-hidden="true">↗</span>
        </a>
      </article>`
  }).join('')

  // 展开/收起按钮：超过 CERT_TOP 个时显示
  const existing = list.querySelector('.cert-more')
  if (existing) existing.remove()
  if (hiddenCount > 0) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'cert-more'
    btn.textContent = showAll ? '收起 ▲' : `展开全部（${hiddenCount} 个）▼`
    btn.addEventListener('click', () => {
      wrap.dataset.expanded = showAll ? '0' : '1'
      renderCertified()
    })
    list.append(btn)
  }
}


function currentRows() {
  const q = document.getElementById('search').value.toLowerCase()
  const view = document.getElementById('view').value
  const cat = document.getElementById('category').value
  const showExcluded = document.getElementById('showExcluded').checked
  const rows = doc.plugins
    .filter((p) => showExcluded || !p.excluded)
    .filter((p) => !cat || p.category === cat)
    .filter((p) => `${p.fullName} ${p.description ?? ''} ${p.category ?? ''}`.toLowerCase().includes(q))
  const sorters = {
    score: (a, b) => b.score - a.score,
    stars: (a, b) => b.stars - a.stars,
    updated: (a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''),
    newest: (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
  }
  rows.sort(sorters[view])
  return rows
}

async function copyText(text, btn) {
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
  const prev = btn.textContent
  btn.textContent = '已复制 ✓'
  btn.classList.add('copied')
  setTimeout(() => { btn.textContent = prev; btn.classList.remove('copied') }, 1600)
}

function render() {
  const all = currentRows()
  const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE))
  if (page > totalPages) page = totalPages
  const start = (page - 1) * PAGE_SIZE
  const rows = all.slice(start, start + PAGE_SIZE)

  const list = document.getElementById('list')
  list.replaceChildren()
  for (const [i, p] of rows.entries()) {
    const tier = scoreTier(p.score)
    const medal = start + i === 0 ? '🥇' : start + i === 1 ? '🥈' : start + i === 2 ? '🥉' : `#${start + i + 1}`
    const el = document.createElement('article')
    el.className = 'row' + (p.excluded ? ' excluded' : '')
    const pills = SIGNAL_ORDER
      .filter((k) => p.signals?.[k] !== undefined)
      .map((k) => `<span class="pill">${SIGNAL_LABELS[k]} <b>${p.signals[k].toFixed(2)}</b></span>`)
      .join('')
    const series = trendSeries(p.fullName)
    const trend = series.length >= 2
      ? `<span class="trend" title="近 ${series.length} 天综合分走势">${sparkline(series)}</span>`
      : ''
    const repoLabel = `github.com/${esc(p.fullName)}`
    const site = siteLink(p)
    // 被排除（占位/WIP）仓库不引导 Star / 安装，避免把用户导去空仓库
    const actions = p.excluded ? '' : `
      <div class="actions">
        <a class="act star" href="${esc(p.url)}" target="_blank" rel="noopener" title="打开仓库，点右上角 ⭐ Star 支持作者 —— 免费，却是对作者最好的感谢">⭐ Star 支持作者</a>
        ${site}
        <button type="button" class="act copy" data-cmd="${esc(installCmd(p))}" title="复制安装命令：dsh plugin --profile web add github:${esc(p.fullName)}">复制安装命令</button>
        <button type="button" class="act comment-btn" data-plugin="${esc(p.fullName)}" title="加载该插件的 GitHub 评论（基于 issue）">💬 评论</button>
      </div>`
    const details = `
      <details class="details">
        <summary>展开详情</summary>
        <dl>
          ${p.category ? `<dt>分类</dt><dd>${esc(p.category)}</dd>` : ''}
          ${Array.isArray(p.topics) && p.topics.length ? `<dt>主题标签</dt><dd><span class="topics">${p.topics.map((x) => `<span class="topic">${esc(x)}</span>`).join('')}</span></dd>` : ''}
          ${p.license ? `<dt>许可证</dt><dd>${esc(p.license)}</dd>` : ''}
          ${p.createdAt ? `<dt>首次发布</dt><dd>${formatTime(p.createdAt)}</dd>` : ''}
          ${p.pushedAt ? `<dt>最近更新</dt><dd>${formatTime(p.pushedAt)}</dd>` : ''}
          ${p.homepage && site ? `<dt>站点</dt><dd><a href="${esc(site)}" target="_blank" rel="noopener">${esc(site)}</a></dd>` : ''}
          <dt>深扫验证</dt><dd>${SCAN_LABELS[p.scanStatus] ?? '未深扫'}</dd>
          ${p.excluded ? `<dt>排除原因</dt><dd class="reason">${esc(p.excluded)}</dd>` : ''}
        </dl>
      </details>`
    el.innerHTML = `
      <div class="row-top">
        <span class="rank ${tier}">${medal}</span>
        <div class="name">
          <div class="name-title">
            <a class="repo-name" href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.fullName)}">${esc(p.fullName)}</a>
            ${p.certified ? '<span class="badge-cert" title="精选认证（issue 审核通过）" aria-label="精选认证">🏅 精选</span>' : ''}
          </div>
          ${p.excluded ? `<span class="reason">${esc(p.excluded)}</span>` : ''}
          ${p.category ? `<span class="cat">${esc(p.category)}</span>` : ''}
          <a class="repo-addr" href="${esc(p.url)}" target="_blank" rel="noopener" title="仓库地址（打开即可 Star）">${repoLabel}</a>
        </div>
        <div class="right">
          <span class="stars">★ ${p.stars}</span>
          <span class="score"><span class="num ${tier}">${p.score.toFixed(3)}</span></span>
        </div>
      </div>
      ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
      <div class="foot">
        <span class="pills">${pills}</span>
        ${trend}
      </div>
      ${actions}
      ${details}
      <div class="comment-box" data-plugin="${esc(p.fullName)}" hidden></div>`
    list.append(el)
  }

  // 复制安装命令按钮事件
  list.querySelectorAll('button.copy').forEach((btn) => {
    btn.addEventListener('click', () => { void copyText(btn.dataset.cmd, btn) })
  })

  // 评论按钮事件：点击才加载 utterances（懒加载，避免每行都注入 script）
  list.querySelectorAll('button.comment-btn').forEach((btn) => {
    btn.addEventListener('click', () => { loadComments(btn.dataset.plugin, btn) })
  })

  // 分页控制
  const pager = document.getElementById('pager')
  pager.replaceChildren()
  const prev = document.createElement('button')
  prev.type = 'button'
  prev.textContent = '« 上一页'
  prev.disabled = page <= 1
  prev.addEventListener('click', () => { page -= 1; render() })
  const next = document.createElement('button')
  next.type = 'button'
  next.textContent = '下一页 »'
  next.disabled = page >= totalPages
  next.addEventListener('click', () => { page += 1; render() })
  const info = document.createElement('span')
  info.className = 'pager-info'
  info.textContent = `第 ${page} / ${totalPages} 页`
  pager.append(prev, info, next)

  const total = all.length
  document.getElementById('count').textContent = total === 0
    ? '没有匹配的插件'
    : `显示第 ${start + 1}–${start + rows.length} 条 / 共 ${total} 条`
}

/** 筛选/排序变化时回到第一页。 */
function resetAndRender() {
  page = 1
  render()
}

/** 评论懒加载：点击「💬 评论」后注入 utterances 脚本（issue-term = 插件名）。 */
function loadComments(fullName, btn) {
  const box = document.querySelector(`.comment-box[data-plugin="${CSS.escape(fullName)}"]`)
  if (!box) return
  // 已加载过则只切换显隐
  if (box.dataset.loaded === '1') {
    box.hidden = !box.hidden
    btn.textContent = box.hidden ? '💬 评论' : '💬 收起'
    return
  }
  box.hidden = false
  btn.textContent = '💬 加载中…'
  box.dataset.loaded = '1'

  const s = document.createElement('script')
  s.src = 'https://utteranc.es/client.js'
  s.setAttribute('repo', 'zp-home/dsh-recommend')
  // 每个插件一个 issue：issue-term 用插件名（owner/name），utternaces 自动创建/查找
  s.setAttribute('issue-term', fullName)
  s.setAttribute('theme', 'github-light')
  s.setAttribute('label', 'comment')
  s.setAttribute('crossorigin', 'anonymous')
  s.async = true
  s.onload = () => { btn.textContent = '💬 收起' }
  s.onerror = () => {
    btn.textContent = '💬 评论'
    box.hidden = true
    box.dataset.loaded = '0'
    box.textContent = '评论加载失败（请先授权 utterances app：github.com/apps/utterances）'
    box.style.display = 'block'
  }
  box.appendChild(s)
}

document.getElementById('search').addEventListener('input', resetAndRender)
document.getElementById('view').addEventListener('change', resetAndRender)
document.getElementById('category').addEventListener('change', resetAndRender)
document.getElementById('showExcluded').addEventListener('change', resetAndRender)

load()
