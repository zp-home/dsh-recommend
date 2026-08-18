# 数据管道（scripts/）

零依赖（Node 18+ 内置 API）。流水线：

```
fetch.mjs ──► data/raw/{repos,topic-coverage}.json  采集 + topic 完整性审计（GitHub topic + hub 目录镜像 + awesome 列表 + 手动收录）
score.mjs ──► data/{registry,rankings,meta}.json   过滤 + 评分（两阶段：--no-scan / 默认合并深扫）
scan.mjs  ──► data/raw/deep-scan.json    深扫插件性验证（榜单前 N 名，检测 dsh 声明/@deepseek-ai 依赖/cordis/skills）
history.mjs ─► data/history.json         每日历史快照（top100 + 总量，同天幂等，保留 366 天）
badge.mjs  ──► data/badges/*.json         shields endpoint 徽章（前 200 名）
report.mjs ──► docs/reports/<月>.md       月度生态报告（新秀/涨幅/下滑榜）
smoke.mjs     零依赖冒烟测试（评分/排除/链接提取/徽章，CI 用）
validate.mjs  校验门禁（CI 用，失败 exit 1；含 hub/awesome 信号源健康度）
sync.mjs      总入口：fetch → score(--no-scan) → scan(有 token) → score → history → badge → validate
```

## 用法

```sh
node scripts/sync.mjs                  # 全量（话题仓库数 >1000 后必须配 GITHUB_TOKEN，见下）
node scripts/sync.mjs --limit 1        # 冒烟：只抓 1 页（~7s）
node scripts/sync.mjs --skip-topic     # 本地快速重建：复用现有 raw topic，只刷新目录/awesome/手动清单
node scripts/sync.mjs --no-scan        # 跳过深扫（本地无 token 时自动跳过）
node scripts/fetch.mjs --dry           # 只打印原始 JSON 不落盘（调试）
node scripts/scan.mjs --top 200        # 单独跑深扫（需 GITHUB_TOKEN）
node scripts/history.mjs               # 单独生成当日快照
node scripts/badge.mjs --top 200       # 生成徽章
node scripts/report.mjs --stdout       # 月度报告打印到终端；--out docs/reports 写文件
node scripts/smoke.mjs                 # 冒烟测试
node scripts/validate.mjs              # 只校验
GITHUB_TOKEN=xxx node scripts/sync.mjs # 带 token：30 次/分，快很多（深扫 core API 5000/小时）
```

> ⚠️ 未认证限额只有 10 次/分（Search）：话题仓库数 ≤1000 时全量 ~1 分钟没问题；超过 1000 后
> 分桶/拆分会使请求数到百级，未认证会被 403 限流跑不完——**请配 `GITHUB_TOKEN`**
> （CI 已注入 github.token，不受影响）。深扫是 core API（未认证 60/小时），无 token 只适合
> `--top 3` 冒烟。

## 约定与铁律

- **主入口检测**：`import.meta.url === pathToFileURL(process.argv[1]).href`（Windows 路径安全）
- **改评分 = 三处同步**：`docs/scoring.md` → `score.mjs`（`SCORING_VERSION`/`WEIGHTS`）→ 重新生成 `data/`
- **数据源白名单**：见 `fetch.mjs` 头部注释；新增源先走 ADR
- **topic 完整性审计**：`fetch.mjs` 把超 1000 条的查询先按 `created` 日期、再按 `size`/`stars` 的无重叠闭区间递归拆分；每轮写 `data/raw/topic-coverage.json`。全量运行只要存在不可拆分溢出、Search `incomplete_results`、分页漂移或页预算耗尽就失败，不发布部分数据
- **手动收录清单**：`scripts/manual-repos.json` 仅兜底已知的极端不可分溢出叶子；按 `owner/repo` 填写，fetch 用 `/repos` 接口抓取合并，不改变 registry 结构
- **排除清单**：`scripts/exclude-list.json` 登记官方本体/非插件仓库（denylist），score 排除出榜、registry 保留原因；深扫未检出的仓库自动排除，无需手动登记
- **失败策略**：主数据源（GitHub Search）失败即红；辅助源（目录镜像/awesome/手动清单单仓）降级警告——**hub 目录降级会写进 meta 并被 validate 拦红**（不再无声）
- **限额**：未认证 Search 10 次/分（页间已加 6.5s 退避 + 403/429 Retry-After 重试 ×3）；深扫 core API 有 token 30/min 间隔 2s

## 已踩过的坑（2026-08 实测）

1. **dsh-external/hub 是私有组织仓库**（API/raw 全部 404）——目录走 0xsline 的每日公开镜像 CATALOG.md
2. **Search API 翻页会重复返回仓库**（结果集翻页期间漂移）——fetch 内按 full_name 去重
3. **话题仓库水分大**：2200 个里 256 个被排除（202 个无描述、48 个空仓库、1 官方本体），排除原因透明展示
4. **部分仓库描述是 mojibake**（GBK 误存进 GitHub 元数据，如 `鈥?`）——原样保留，不做猜测性修复
5. **Search API 单个查询最多返回 1000 条**（10 页 × 100，第 11 页恒为空数组；且 repository
   搜索不支持按 created 排序，sort=created 会被静默忽略）——`fetchTopicRepos` 先按 `created`
   日期区间拆分；单日仍超过 1000 时，再以 `size`、`stars` 的闭区间分片，范围无重叠且无缺口。
   每个叶子都要求 `uniqueCount === total_count` 且 `incomplete_results=false`；无法安全继续切分时
   写入 `topic-coverage.json` 并让全量同步失败，而不是静默截断。拆桶后请求数会增长，建议配
   `GITHUB_TOKEN`（30 次/分）。
6. **hub 目录镜像可能失败且曾被静默降级**：0 分类/0 curated 但 CI 全绿——v2 起 `meta.signals.hubCatalog`
   记录 `fetchedAt/error`，validate 对空目录直接红。
7. **awesome README 里的 topic 链接会被误抓成仓库**（`github.com/topics/dsh-plugin` → 假条目
   `topics/dsh-plugin`）——`extractRepoRefs` 显式排除非仓库段；键统一小写（原实现大小写不一致
   导致部分精选信号漏匹配）。
