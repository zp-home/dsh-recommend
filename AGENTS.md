# AGENTS.md — 给 AI 协作代理的说明

本文件帮助 AI 代理（或人类）快速、安全地在本仓库工作。

## 项目速览

- **定位**：DSH 插件生态的透明评分/排行/推荐。数据管道是核心资产，插件与网站是消费端。
- **命令**：
  - `node scripts/sync.mjs` —— 全量重算（fetch → score → validate）。**本地需配 GITHUB_TOKEN**（未认证在仓库数 >1000 后会被限流，见 scripts/README.md）。
  - `node scripts/sync.mjs --limit 1` —— 冒烟测试（只抓 1 页，~5 秒）。
  - `node scripts/validate.mjs` —— 只校验 data/。
- **零依赖铁律**：scripts/ 只能用 Node 18+ 内置 API。不要引入 npm 依赖。
- **主入口约定**：脚本用 `import.meta.url === pathToFileURL(process.argv[1]).href` 判断 CLI 执行；不要改回字符串拼接（Windows 路径会断）。

## 改动规则

1. **改评分 = 三处同步**：`docs/scoring.md`（含变更记录）→ `scripts/score.mjs`（`SCORING_VERSION`/`WEIGHTS`）→ 重新生成 `data/`。CI 校验版本一致性。
2. **改数据格式** = 破坏性变更：`data/` 的 JSON 结构是公共契约（网站、插件、外部消费者都在读），必须同步更新所有消费端并走 ADR。
3. **双语文档**：README/CONTRIBUTING 等用户可见文档必须有中英两份，内容同步。
4. **提交信息**：`<type>(<scope>): <summary>`，type ∈ {feat, fix, docs, data, chore}。

## 已知事实（2026-08 调研结论）

- GitHub `dsh-plugin` 话题仓库数已远超 1000（2026-08-14 单日新增簇就有 1474 个），含大量占位/WIP（排除规则在 score.mjs）。全量抓取受 Search API 单查询 1000 条限制，fetch 以 `created` 后接 `size`/`stars` 无重叠闭区间递归拆分并产出 topic-coverage 审计；全量请求数达百级，**本地全量必须配 GITHUB_TOKEN**（CI 已注入）；见 scripts/fetch.mjs 与 scripts/README.md。
- 竞争/协作关系：WhaleHub（网站，Stars 排序）、dsh-find-plugins（技能，语义发现）、AdamPlatin123/awesome-dsh-plugins 与 dsh-plugin-radar（兼容性雷达）——我们的差异化是「评分+排行+推荐」且公式公开可复算。
- 上游官方仓库：`deepseek-ai/deepseek-harness`。官方插件契约：`dsh.bundle`（配置层 patch）+ `dsh.client`（浏览器半 manifest），安装走 `dsh plugin --profile <name> add <spec>`。
- 官方机制会变（如 2026-08 删除 repository 插件机制）：涉及插件契约的改动前，先查上游最新文档/发布。

## 不要做

- 不要在 data/ 里手改数据（一切由管道生成；手改会被下次 sync 覆盖）
- 不要引入网络请求到未经列出的数据源（先走 ADR）
- 不要执行/安装被收录插件仓库的任何代码（安全边界，见 SECURITY.md）
