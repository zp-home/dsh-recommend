# 路线图

> 状态标注：✅ 已落地 · 🔨 进行中 · ⏳ 未开始。当前阶段：**M1.5 完成，M3 进行中**。

## M1 — 数据层与静态站 ✅

- ✅ 数据管道 v0（fetch / score / validate / sync，零依赖）
- ✅ 排除规则（占位/空仓库/fork/归档 + 官方 denylist + 深扫插件性验证）
- ✅ 评分模型 v2 + 文档 + meta 快照（含信号源健康度）
- ✅ `data/registry.json` / `rankings.json` / `history.json` / `badges/` 全量生成
- ✅ GitHub Actions：每 5 小时 cron 同步（sync.yml，含深扫与月报）+ PR 校验（validate.yml，含冒烟测试）
- ✅ 静态排行站 site/（榜单卡片 + 搜索 + 分类筛选 + 多视图 + 分页 + 详情展开 + 趋势 + 安装/徽章复制）
- ✅ 发布动作：打 `dsh-plugin` 话题、awesome 列表 PR、hub 收录、npm 发布（0.3.0）
- ✅ 提交插件 Issue 表单上线（`.github/ISSUE_TEMPLATE/submit-plugin.yml`）

**M1 验收**：打开网站能看到 1900+ 插件带分数与排名；`data/` 每 5 小时自动更新。

## M1.5 — 深扫与信号增强 ✅

- ✅ 逐仓库深扫（榜单前 200）：检测 `dsh.bundle` 声明 / `@deepseek-ai/*` 依赖 / cordis 配置 / skills 特征，未检出出榜（`scripts/scan.mjs`，两阶段评分并入 sync）
- ✅ 官方本体/非插件 denylist（`scripts/exclude-list.json`，透明可审计）
- ✅ hub 目录健康度可见化：失败不再静默，`meta.signals.hubCatalog` + validate 门禁
- ✅ awesome 链接提取修复（不再误抓 topics 链接；大小写统一）
- ✅ 历史快照 `data/history.json`（每日 top100 + 总量，同天幂等，366 天滚动）
- ✅ shields 徽章生成（`data/badges/`，作者 README 可挂）
- ⏳ npm registry 下载量信号（生态信号或 popularity 修正项）
- ⏳ 联动兼容性雷达：把 AdamPlatin123/awesome-dsh-plugins 的兼容性结论作为独立信号（或展示列）
- ⏳ 联动 hub：双向「收录状态」展示与同步

## M2 — DSH bundle 插件 ✅ 已完成（真机验证通过）

- ✅ 插件实现（仓库根即 bundle：`src/` → `lib/`）：
  - host 半：`rank_plugins` / `recommend_plugins` / `search_plugins` / `sync_registry` 四工具（输出含安装命令；recommend 带中英同义扩展与 keywords 参数）
  - web 半：同源路由 `/dsh-recommend/registry.json` + `/dsh-recommend/history.json` + `POST /dsh-recommend/sync`（设置页一键刷新）
  - browser 半：设置页「插件排行」标签（刷新按钮 / 安装命令复制 / 详情展开 / 趋势 sparkline / 全量 i18n）
- ✅ 验证项全部落地（结论回填 [ADR-0003](decisions/0003-single-package-dual-half.md)）

**M2 验收**：装完插件，设置页出现排行标签，agent 能调用四个工具并给出有据可查的推荐。

## M3 — 推荐逻辑 v1 🔨

- 🔨 `recommend_plugins` v2 规则式：中英同义词组扩展 + `keywords` 参数 + 公式文档化（0.6 匹配度 + 0.4 综合分）
- ⏳ 结合用户工作区特征（语言/描述）的加权推荐
- ⏳ 人工精选层：每月 Top 榜 + 编辑推荐（与自动榜分开展示）
- ⏳ 用户反馈通道（👍/👎 → 修正推荐，隐私默认关）

## M4 — 生态运营

- ✅ 徽章（`data/badges/`，插件作者可挂 README，静态站/设置页可复制链接）
- ✅ 月度生态报告（`scripts/report.mjs`，sync.yml 月末自动生成 `docs/reports/`）
- ⏳ 与 WhaleHub / awesome 列表 / hub 互相导流
- ⏳ 安装量遥测（可选、默认关闭、只上报聚合计数）

## 长期候选

- 多语言榜单站、历史趋势曲线（数据已含时间戳，天然支持——sparkline 已落地，完整趋势页待做）
- 质量分级徽章（类似 AdamPlatin 的 兼容/关注/需适配）
- 插件 AI 分析（参考 skillhub 模式：对榜单插件做语义摘要/能力画像/风险提示）——**待评估 ROI**，先观察社区需求与调用成本再决定
