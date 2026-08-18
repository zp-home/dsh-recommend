import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/host/index.ts
/**
* dsh-recommend host 半：四个模型可用工具。
*
* 契约：@deepseek-ai/dsh-tools 的 defineTool（官方 cookbook：adding-a-tool）。
* 数据：只读 registry.json + history.json（config.dataUrl/historyUrl 指向数据仓库产物），
* 本地缓存于 config.cachePath / config.historyPath（默认 $DSH_HOME/dsh-recommend/ 下），
* sync_registry 负责更新两者。本插件从不执行任何被收录插件的代码（见 SECURITY.md）。
*/
const name = "dsh-recommend";
const inject = ["tools"];
/** ISO 时间戳 → 本地可读格式，如 2026-08-14 05:27（UTC+8）。解析失败原样返回，缺省显示 —。 */
function formatTime(iso) {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const p = (n) => String(n).padStart(2, "0");
	const off = -d.getTimezoneOffset() / 60;
	const tz = off === 0 ? "UTC" : `UTC${off > 0 ? "+" : ""}${off}`;
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}（${tz}）`;
}
/** 安装命令（DSH 官方插件安装语法）。 */
function installCommand(fullName) {
	return `dsh plugin --profile web add github:${fullName}`;
}
function apply(ctx, config) {
	const cachePath = config.cachePath;
	const historyPath = config.historyPath ?? config.cachePath.replace(/registry\.json$/, "history.json");
	const historyUrl = config.historyUrl ?? config.dataUrl.replace(/registry\.json$/, "history.json");
	const trendsPath = config.trendsPath ?? config.cachePath.replace(/registry\.json$/, "trends.json");
	const trendsUrl = config.trendsUrl ?? config.dataUrl.replace(/registry\.json$/, "trends.json");
	/** 读缓存；缺失/损坏时返回 null（工具层提示先 sync）。 */
	async function loadRegistry() {
		try {
			const raw = await readFile(cachePath, "utf8");
			const doc = JSON.parse(raw);
			if (!Array.isArray(doc.plugins)) throw new Error("registry 结构异常");
			return doc;
		} catch {
			return null;
		}
	}
	/** 读趋势缓存；缺失/损坏时返回 null（trend_plugins 提示先 sync）。 */
	async function loadTrends() {
		try {
			const raw = await readFile(trendsPath, "utf8");
			const doc = JSON.parse(raw);
			if (!Array.isArray(doc.trends) || typeof doc.rankings !== "object") throw new Error("trends 结构异常");
			return doc;
		} catch {
			return null;
		}
	}
	ctx.tools.register(defineTool({
		name: "sync_registry",
		description: "下载最新插件 registry（含历史趋势数据）到本地缓存，并报告数据源健康度。数据源：dsh-recommend 数据仓库（每 5 小时自动重算）。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					fetchedAt: { type: "string" },
					count: { type: "number" },
					excluded: { type: "number" },
					hubCatalog: {
						type: "object",
						additionalProperties: false,
						properties: {
							entries: { type: "number" },
							categories: { type: "number" },
							error: { oneOf: [{ type: "string" }, { type: "null" }] }
						}
					},
					deepScan: {
						type: "object",
						additionalProperties: false,
						properties: {
							verified: { type: "number" },
							unverified: { type: "number" },
							error: { type: "number" }
						}
					},
					historyDays: { type: "number" }
				}
			},
			render: (_args, value) => {
				const hub = value.hubCatalog;
				const hubLine = hub ? hub.error ? `⚠ hub 目录缺失（${hub.error}）` : `hub 目录 ${hub.entries} 条 / ${hub.categories} 类` : "hub 目录信息未知";
				const scan = value.deepScan;
				const scanLine = scan ? `深扫 ${scan.verified}✓/${scan.unverified}✗/${scan.error}err` : "深扫未运行";
				return [{
					type: "text",
					text: `registry 已更新：${value.count} 个仓库（${formatTime(value.fetchedAt)}）· ${hubLine} · ${scanLine} · 历史 ${value.historyDays ?? 0} 天`
				}];
			}
		},
		async execute() {
			const [regRes, hisRes, trendRes] = await Promise.all([
				fetch(config.dataUrl),
				fetch(historyUrl),
				fetch(trendsUrl)
			]);
			if (!regRes.ok) throw new Error(`下载 registry 失败: ${regRes.status}`);
			const text = await regRes.text();
			const doc = JSON.parse(text);
			if (!Array.isArray(doc.plugins)) throw new Error("下载的 registry 结构异常");
			await mkdir(dirname(cachePath), { recursive: true });
			await writeFile(cachePath, text, "utf8");
			let historyDays = 0;
			if (hisRes.ok) {
				const hisText = await hisRes.text();
				try {
					const his = JSON.parse(hisText);
					if (Array.isArray(his.days)) {
						await writeFile(historyPath, hisText, "utf8");
						historyDays = his.days.length;
					}
				} catch {}
			}
			if (trendRes.ok) {
				const tText = await trendRes.text();
				try {
					const tDoc = JSON.parse(tText);
					if (Array.isArray(tDoc.trends)) await writeFile(trendsPath, tText, "utf8");
				} catch {}
			}
			const meta = doc.meta;
			return {
				fetchedAt: meta.generatedAt,
				count: doc.plugins.length,
				excluded: doc.plugins.filter((p) => p.excluded).length,
				hubCatalog: meta.signals?.hubCatalog ?? void 0,
				deepScan: meta.signals?.scanCounts ?? void 0,
				historyDays
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "rank_plugins",
		description: "查询 DSH 插件榜单：按综合分排序，可过滤分类/维度，返回 top N。",
		parameters: {
			limit: {
				type: "number",
				description: "返回条数，默认 10，最大 50"
			},
			category: {
				type: "string",
				description: "按 hub 分类过滤，如「UI 增强」「技能」"
			},
			sortBy: {
				type: "string",
				enum: [
					"score",
					"stars",
					"updated"
				],
				description: "排序维度，默认 score"
			},
			includeExcluded: {
				type: "boolean",
				description: "是否包含被排除（占位/空仓库/非插件）条目，默认 false"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { rankings: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							rank: { type: "number" },
							fullName: { type: "string" },
							url: { type: "string" },
							install: { type: "string" },
							description: { type: "string" },
							stars: { type: "number" },
							score: { type: "number" },
							signals: {
								type: "object",
								additionalProperties: false,
								properties: {
									maintenance: { type: "number" },
									popularity: { type: "number" },
									quality: { type: "number" },
									ecosystem: { type: "number" }
								}
							},
							pushedAt: { oneOf: [{ type: "string" }, { type: "null" }] },
							excluded: { oneOf: [{ type: "string" }, { type: "null" }] }
						}
					}
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: (value.rankings ?? []).map((r) => `#${r.rank} ${r.fullName}（score ${r.score}，★${r.stars}）${r.excluded ? ` [${r.excluded}]` : ""}\n  ${r.description}\n  安装：${r.install}`).join("\n")
			}]
		},
		async execute(args) {
			const doc = await loadRegistry();
			if (!doc) throw new Error("本地缓存缺失，请先调用 sync_registry");
			const limit = Math.min(args.limit ?? 10, 50);
			let rows = doc.plugins.filter((p) => args.includeExcluded || !p.excluded).filter((p) => !args.category || (p.category ?? "").includes(args.category)).map((p) => ({
				rank: 0,
				fullName: p.fullName,
				url: p.url,
				install: installCommand(p.fullName),
				description: p.description,
				stars: p.stars,
				score: p.score,
				signals: p.signals,
				pushedAt: p.pushedAt,
				excluded: p.excluded
			}));
			rows.sort((a, b) => {
				if (args.sortBy === "stars") return b.stars - a.stars;
				if (args.sortBy === "updated") return (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "");
				return b.score - a.score;
			});
			rows = rows.slice(0, limit).map((r, i) => ({
				...r,
				rank: i + 1
			}));
			return { rankings: rows };
		}
	}));
	ctx.tools.register(defineTool({
		name: "search_plugins",
		description: "在插件 registry 中按名称/描述/分类检索（包含被排除条目并标注原因）。",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "检索词"
			},
			limit: {
				type: "number",
				description: "返回条数，默认 10，最大 50"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { results: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							fullName: { type: "string" },
							url: { type: "string" },
							install: { type: "string" },
							description: { type: "string" },
							stars: { type: "number" },
							score: { type: "number" },
							excluded: { oneOf: [{ type: "string" }, { type: "null" }] }
						}
					}
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: (value.results ?? []).length === 0 ? "无匹配结果" : (value.results ?? []).map((r) => `${r.fullName}（score ${r.score}，★${r.stars}）${r.excluded ? ` [${r.excluded}]` : ""}\n  ${r.description}\n  安装：${r.install}`).join("\n")
			}]
		},
		async execute(args) {
			const doc = await loadRegistry();
			if (!doc) throw new Error("本地缓存缺失，请先调用 sync_registry");
			const query = normalizeText(args.query);
			if (!query) return { results: [] };
			const queryTokens = tokenize(query);
			return { results: doc.plugins.map((p) => {
				const fields = searchableFields(p);
				return {
					p,
					match: scoreSearchMatch(query, queryTokens, fields)
				};
			}).filter(({ match }) => match.matched).sort((a, b) => b.match.relevance - a.match.relevance || b.p.score - a.p.score).slice(0, Math.min(args.limit ?? 10, 50)).map(({ p }) => ({
				fullName: p.fullName,
				url: p.url,
				install: installCommand(p.fullName),
				description: p.description,
				stars: p.stars,
				score: p.score,
				excluded: p.excluded
			})) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "recommend_plugins",
		description: "按用户目标描述推荐插件。公式：relevance = 0.6×匹配度 + 0.4×综合分，其中匹配度 = 0.5×直接关键词命中率 + 0.5×同义扩展命中率（内置中英同义词组：记忆/搜索/UI/技能/MCP/工具/TUI/通知/自动化/数据/视觉/语音/研究/翻译/代码/Git/会话/安全/浏览器/游戏 等）。可传 keywords 显式补充检索词。",
		parameters: {
			goal: {
				type: "string",
				required: true,
				description: "用户想做的事，如「给 Web 界面加侧边栏」"
			},
			keywords: {
				type: "array",
				items: { type: "string" },
				description: "可选：显式补充检索关键词（中英均可），与 goal 一起参与匹配"
			},
			limit: {
				type: "number",
				description: "返回条数，默认 5，最大 20"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { recommendations: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							fullName: { type: "string" },
							url: { type: "string" },
							install: { type: "string" },
							description: { type: "string" },
							score: { type: "number" },
							reason: { type: "string" }
						}
					}
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: (value.recommendations ?? []).length === 0 ? "没有找到明显匹配的插件，试试 search_plugins 换关键词，或加 keywords 参数" : (value.recommendations ?? []).map((r) => `${r.fullName}（score ${r.score}）\n  理由：${r.reason}\n  ${r.description}\n  安装：${r.install}`).join("\n")
			}]
		},
		async execute(args) {
			const doc = await loadRegistry();
			if (!doc) throw new Error("本地缓存缺失，请先调用 sync_registry");
			const tokens = unique([...tokenize(args.goal), ...(args.keywords ?? []).flatMap((k) => tokenize(k))]);
			if (tokens.length === 0) return { recommendations: [] };
			const touchedGroups = /* @__PURE__ */ new Set();
			for (const t of tokens) for (const [gid, syns] of Object.entries(SYNONYM_GROUPS)) if (syns.some((s) => normalizeText(s).includes(t) || t.includes(normalizeText(s)))) touchedGroups.add(gid);
			const expanded = [...touchedGroups].flatMap((g) => SYNONYM_GROUPS[g] ?? []).map(normalizeText);
			return { recommendations: doc.plugins.filter((p) => !p.excluded).map((p) => {
				const fields = searchableFields(p);
				const directHits = tokens.filter((t) => fields.search.includes(t)).length;
				const groupMatched = [...touchedGroups].filter((g) => (SYNONYM_GROUPS[g] ?? []).some((s) => fields.search.includes(normalizeText(s)))).length;
				const expandedHits = expanded.filter((s) => fields.search.includes(s)).length;
				const tokenRatio = directHits / tokens.length;
				const groupRatio = touchedGroups.size === 0 ? 0 : groupMatched / touchedGroups.size;
				const expandedRatio = expanded.length === 0 ? 0 : expandedHits / expanded.length;
				return {
					p,
					relevance: (.5 * tokenRatio + .35 * groupRatio + .15 * expandedRatio) * .7 + p.score * .3,
					directHits,
					groupMatched,
					expandedHits
				};
			}).sort((a, b) => b.relevance - a.relevance || b.p.score - a.p.score).slice(0, Math.min(args.limit ?? 5, 20)).map(({ p, directHits, groupMatched, expandedHits }) => ({
				fullName: p.fullName,
				url: p.url,
				install: installCommand(p.fullName),
				description: p.description,
				score: p.score,
				reason: `命中关键词 ${directHits}/${tokens.length}、同义组 ${groupMatched}/${touchedGroups.size}（扩展命中 ${expandedHits} 词）；综合分 ${p.score}`
			})) };
		}
	}));
	ctx.tools.register(defineTool({
		name: "trend_plugins",
		description: "查询插件发展趋势榜：star 增长最快 / 排名上升最快 / 下载量最多 / 本周新上榜 / 精选认证。数据来自每日历史快照。",
		parameters: {
			board: {
				type: "string",
				required: true,
				enum: [
					"starsGain7d",
					"starsGain30d",
					"starsGain90d",
					"rankGain30d",
					"downloads30d",
					"newlyListed",
					"certified"
				],
				description: "榜单：starsGain7d/30d/90d 各窗口 star 增长；rankGain30d 排名上升；downloads30d npm 月下载量；newlyListed 本周新上榜；certified 精选认证"
			},
			limit: {
				type: "number",
				description: "返回条数，默认 10，最大 50"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					board: { type: "string" },
					historyDays: { type: "number" },
					items: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								fullName: { type: "string" },
								stars: { type: "number" },
								score: { type: "number" },
								delta: {
									oneOf: [{ type: "number" }, { type: "null" }],
									description: "该榜的排序指标（star 增量 / 排名上升 / 下载量等）"
								},
								note: {
									type: "string",
									description: "人话解释这一条为什么上榜"
								},
								certified: { type: "boolean" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				const items = value.items ?? [];
				return [{
					type: "text",
					text: items.length === 0 ? `「${value.board}」暂无数据（历史快照需积累数天）` : `「${value.board}」Top ${items.length}（历史 ${value.historyDays} 天）\n` + items.map((r, i) => `${i + 1}. ${r.fullName}${r.certified ? " 🏅" : ""} — ${r.note}`).join("\n")
				}];
			}
		},
		async execute(args) {
			const doc = await loadTrends();
			if (!doc) throw new Error("趋势数据缺失，请先调用 sync_registry（若仍失败，说明数据仓库还未积累历史快照）");
			const list = doc.rankings?.[args.board] ?? [];
			const limit = Math.min(args.limit ?? 10, 50);
			const items = list.slice(0, limit).map((t) => describeTrend(t, args.board));
			return {
				board: args.board,
				historyDays: doc.meta?.historyDays ?? 0,
				items
			};
		}
	}));
}
/** 把一条趋势记录翻译成人话（按榜单类型解释上榜理由）。 */
function describeTrend(t, board) {
	const base = {
		fullName: t.fullName,
		certified: t.current?.certified ?? false
	};
	switch (board) {
		case "starsGain7d":
		case "starsGain30d":
		case "starsGain90d": {
			const w = board.replace("starsGain", "");
			const delta = t.deltas?.[`${w}d`]?.stars;
			return {
				...base,
				stars: t.current?.stars ?? 0,
				score: t.current?.score ?? 0,
				delta: delta ?? null,
				note: `${w} 天 star ${delta != null ? `+${delta}` : "—"}（现 ${t.current?.stars ?? "—"} ★）`
			};
		}
		case "rankGain30d": {
			const delta = t.deltas?.["30d"]?.rank;
			return {
				...base,
				stars: t.current?.stars ?? 0,
				score: t.current?.score ?? 0,
				delta: delta ?? null,
				note: `30 天排名上升 ${delta ?? "—"} 名（现第 ${t.current?.rank ?? "—"} 名）`
			};
		}
		case "downloads30d": return {
			...base,
			stars: t.current?.stars ?? 0,
			score: t.current?.score ?? 0,
			delta: t.current?.npmMonthly ?? null,
			note: `npm 月下载 ${fmtNum(t.current?.npmMonthly)} 次（周 ${fmtNum(t.current?.npmWeekly)}）`
		};
		case "newlyListed": return {
			...base,
			stars: t.current?.stars ?? 0,
			score: t.current?.score ?? 0,
			delta: t.current?.stars ?? null,
			note: `上榜于 ${t.firstSeen}（现第 ${t.current?.rank ?? "—"} 名）`
		};
		case "certified": return {
			...base,
			stars: t.current?.stars ?? 0,
			score: t.current?.score ?? 0,
			delta: t.current?.score ?? null,
			note: `精选认证 · 综合分 ${t.current?.score ?? "—"}`
		};
		default: return {
			...base,
			stars: t.current?.stars ?? 0,
			score: t.current?.score ?? 0,
			delta: null,
			note: t.fullName
		};
	}
}
function fmtNum(n) {
	if (n === null || n === void 0) return "—";
	return Number(n).toLocaleString("en-US");
}
/**
* 同义扩展组：goal 里的词命中某组任一同义词时，整组同义词参与检索。
* 覆盖 DSH 插件生态的高频语义（中英 + 常见别名）。
*/
const SYNONYM_GROUPS = {
	memory: [
		"记忆",
		"memory",
		"回忆",
		"长期记忆",
		"claude-mem",
		"mem0",
		"知识库",
		"knowledge"
	],
	search: [
		"搜索",
		"search",
		"检索",
		"查询",
		"workspace search"
	],
	ui: [
		"界面",
		"ui",
		"皮肤",
		"theme",
		"主题",
		"侧边栏",
		"sidebar",
		"输入框",
		"布局",
		"组件",
		"样式"
	],
	skill: [
		"技能",
		"skill",
		"skills",
		"提示词",
		"prompt",
		"模板",
		"prompt 库"
	],
	mcp: [
		"mcp",
		"模型上下文",
		"上下文协议",
		"server"
	],
	tool: [
		"工具",
		"tool",
		"tools",
		"工具集",
		"工具箱"
	],
	tui: [
		"tui",
		"终端",
		"terminal",
		"命令行",
		"cli"
	],
	notify: [
		"通知",
		"notification",
		"推送",
		"提醒",
		"消息",
		"webhook"
	],
	automate: [
		"自动化",
		"automation",
		"工作流",
		"workflow",
		"ci",
		"定时",
		"schedule",
		"pipeline"
	],
	data: [
		"数据",
		"data",
		"表格",
		"excel",
		"csv",
		"数据库",
		"database",
		"分析"
	],
	vision: [
		"视觉",
		"vision",
		"图像",
		"图片",
		"ocr",
		"截图",
		"screenshot"
	],
	voice: [
		"语音",
		"voice",
		"语音输入",
		"asr",
		"录音"
	],
	research: [
		"研究",
		"research",
		"深度研究",
		"deep-research",
		"deep research",
		"报告"
	],
	translate: [
		"翻译",
		"translate",
		"translation",
		"本地化",
		"i18n",
		"多语言"
	],
	code: [
		"代码",
		"code",
		"编码",
		"编程",
		"ide",
		"编辑器",
		"diff",
		"重构"
	],
	git: [
		"git",
		"版本控制",
		"提交",
		"commit",
		"分支"
	],
	session: [
		"会话",
		"session",
		"对话",
		"历史",
		"聊天记录"
	],
	security: [
		"安全",
		"security",
		"审计",
		"audit",
		"供应链",
		"风险"
	],
	browser: [
		"浏览器",
		"browser",
		"网页",
		"web",
		"抓取"
	],
	game: [
		"游戏",
		"game",
		"小游戏",
		"娱乐"
	],
	pet: [
		"宠物",
		"pet",
		"桌宠",
		"陪伴"
	],
	chat: [
		"聊天",
		"chat",
		"对话增强",
		"回复"
	]
};
/** v0 分词：英文词 + CJK 字符二元组。 */
function normalizeText(input) {
	return input.normalize("NFKC").toLowerCase().replace(/[._/\\:]+/g, " ");
}
function unique(values) {
	return [...new Set(values.filter(Boolean))];
}
/** 统一把 registry 的所有可发现字段纳入检索；字段权重由 scoreSearchMatch 控制。 */
function searchableFields(p) {
	const name = normalizeText(p.fullName);
	const description = normalizeText(p.description ?? "");
	const category = normalizeText(p.category ?? "");
	const topics = (p.topics ?? []).map(normalizeText).join(" ");
	return {
		name,
		description,
		category,
		topics,
		search: `${name} ${description} ${category} ${topics}`
	};
}
function scoreSearchMatch(query, queryTokens, fields) {
	const phrase = fields.search.includes(query) ? 1 : 0;
	const tokenHits = queryTokens.filter((token) => fields.search.includes(token)).length;
	const tokenRatio = queryTokens.length === 0 ? 0 : tokenHits / queryTokens.length;
	const nameHits = queryTokens.filter((token) => fields.name.includes(token)).length;
	const topicHits = queryTokens.filter((token) => fields.topics.includes(token)).length;
	const fieldBoost = Math.min(1, (nameHits * .35 + topicHits * .2) / Math.max(1, queryTokens.length));
	return {
		matched: phrase > 0 || tokenHits > 0,
		relevance: phrase * .45 + tokenRatio * .4 + fieldBoost * .15
	};
}
/** 分词：英文词、CJK 单字与二元组，兼容中文短语与中英混写。 */
function tokenize(input) {
	const s = normalizeText(input);
	const tokens = [...s.match(/[a-z0-9-]+/g) ?? []];
	for (const char of s) if (/\p{Script=Han}/u.test(char)) tokens.push(char);
	for (let i = 0; i < s.length - 1; i += 1) {
		const a = s[i] ?? "";
		const b = s[i + 1] ?? "";
		if (/\p{Script=Han}/u.test(a) && /\p{Script=Han}/u.test(b)) tokens.push(a + b);
	}
	return unique(tokens);
}
//#endregion
export { SYNONYM_GROUPS, apply, inject, name };

//# sourceMappingURL=index.mjs.map