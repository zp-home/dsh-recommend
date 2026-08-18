window.__ModuleLoader__.load({
	id: "dsh-recommend",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/RankingsTab.tsx
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
		const SIGNAL_LABELS = {
			maintenance: "signalMaintenance",
			popularity: "signalPopularity",
			quality: "signalQuality",
			ecosystem: "signalEcosystem"
		};
		const SIGNAL_ORDER = [
			"maintenance",
			"popularity",
			"quality",
			"ecosystem"
		];
		const PAGE_SIZE = 50;
		/** 分数分级配色。 */
		function scoreTier(score) {
			if (score >= .85) return "gold";
			if (score >= .65) return "accent";
			if (score >= .5) return "neutral";
			return "dim";
		}
		/** 插件自带静态站 / 主页：补全 scheme；空值或与仓库 URL 相同时返回 null（避免冗余链接）。 */
		function normalizeSite(homepage, repoUrl) {
			const h = (homepage ?? "").trim();
			if (!h) return null;
			const url = h.includes("://") ? h : `https://${h}`;
			return url === repoUrl ? null : url;
		}
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
		/** 复制文本到剪贴板（clipboard API 不可用时降级 textarea）。 */
		async function copyText(text) {
			try {
				await navigator.clipboard.writeText(text);
			} catch {
				const ta = document.createElement("textarea");
				ta.value = text;
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				ta.remove();
			}
		}
		/** 迷你走势图：近 N 天综合分 polyline。 */
		function Sparkline({ series, label }) {
			if (series.length < 2) return null;
			const w = 120;
			const h = 26;
			const pad = 3;
			const min = Math.min(...series);
			const span = Math.max(...series) - min || 1;
			const step = 114 / (series.length - 1);
			const pts = series.map((v, i) => {
				const x = pad + i * step;
				const y = 23 - (v - min) / span * 20;
				return `${x.toFixed(1)},${y.toFixed(1)}`;
			});
			const [lastX, lastY] = pts[pts.length - 1].split(",");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				className: "dshr-spark",
				width: w,
				height: h,
				viewBox: `0 0 ${w} ${h}`,
				role: "img",
				"aria-label": label,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("polyline", {
					points: pts.join(" "),
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.6",
					strokeLinejoin: "round",
					strokeLinecap: "round"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: lastX,
					cy: lastY,
					r: "2.4",
					fill: "currentColor"
				})]
			});
		}
		/**
		* 已装匹配：installed moduleName（如 dsh-better-sidebar / @scope/pkg）与 registry
		* fullName（omdsh-dev/DSH-better-sidebar）的 repo 短名做去分隔符小写比较，
		* 尽力而为——匹配不到就当作未安装，不影响功能。
		*/
		function normalizeKey(name) {
			return name.split("/").pop().toLowerCase().replace(/[^a-z0-9]/g, "");
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
`;
		function RankingsTab({ t, loadRankings, loadHistory, refreshRankings, listInstalled, installPlugin, loadUpdates, updatePlugin, saveUpdatePolicy }) {
			const [doc, setDoc] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [history, setHistory] = (0, react.useState)(null);
			const [query, setQuery] = (0, react.useState)("");
			const [category, setCategory] = (0, react.useState)("");
			const [view, setView] = (0, react.useState)("score");
			const [page, setPage] = (0, react.useState)(1);
			const [refreshing, setRefreshing] = (0, react.useState)(false);
			const [refreshMsg, setRefreshMsg] = (0, react.useState)(null);
			const [copied, setCopied] = (0, react.useState)(null);
			const [installed, setInstalled] = (0, react.useState)(/* @__PURE__ */ new Set());
			const [installState, setInstallState] = (0, react.useState)({});
			const [updateStatus, setUpdateStatus] = (0, react.useState)(null);
			const [updateLoading, setUpdateLoading] = (0, react.useState)(false);
			const [updatingPackage, setUpdatingPackage] = (0, react.useState)(null);
			const [updateMessage, setUpdateMessage] = (0, react.useState)(null);
			const [policyDraft, setPolicyDraft] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				let alive = true;
				loadRankings().then((d) => {
					if (alive) setDoc(d);
				}).catch((err) => {
					if (alive) setError(err instanceof Error ? err.message : String(err));
				});
				return () => {
					alive = false;
				};
			}, [loadRankings]);
			(0, react.useEffect)(() => {
				let alive = true;
				loadHistory().then((h) => {
					if (alive) setHistory(h);
				}).catch(() => {
					if (alive) setHistory(null);
				});
				return () => {
					alive = false;
				};
			}, [loadHistory]);
			(0, react.useEffect)(() => {
				const style = document.getElementById("dshr-rankings-css") ?? document.createElement("style");
				style.id = "dshr-rankings-css";
				style.textContent = CSS;
				if (!style.parentNode) document.head.appendChild(style);
			}, []);
			(0, react.useEffect)(() => {
				let alive = true;
				listInstalled().then((names) => {
					if (!alive) return;
					setInstalled(new Set(names.map(normalizeKey)));
				}).catch(() => {});
				return () => {
					alive = false;
				};
			}, [listInstalled]);
			(0, react.useEffect)(() => {
				let alive = true;
				loadUpdates().then((status) => {
					if (!alive) return;
					setUpdateStatus(status);
					setPolicyDraft(status.policy);
				}).catch(() => {});
				return () => {
					alive = false;
				};
			}, [loadUpdates]);
			const categories = (0, react.useMemo)(() => {
				const set = /* @__PURE__ */ new Set();
				for (const p of doc?.plugins ?? []) if (p.category) set.add(p.category);
				return [...set].sort();
			}, [doc]);
			const rows = (0, react.useMemo)(() => {
				if (!doc) return [];
				const q = query.toLowerCase();
				const list = doc.plugins.filter((p) => !p.excluded).filter((p) => !category || p.category === category).filter((p) => `${p.fullName} ${p.description ?? ""} ${p.category ?? ""}`.toLowerCase().includes(q));
				list.sort((a, b) => {
					if (view === "stars") return b.stars - a.stars;
					if (view === "updated") return (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "");
					if (view === "newest") return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
					return b.score - a.score;
				});
				return list;
			}, [
				doc,
				query,
				category,
				view
			]);
			/** fullName(小写) -> 每日分数序列（按日期升序）。 */
			const trendSeries = (0, react.useMemo)(() => {
				const map = /* @__PURE__ */ new Map();
				if (!history) return map;
				const days = [...history.days].sort((a, b) => a.date.localeCompare(b.date));
				for (const day of days) for (const entry of day.top) {
					const key = entry.fullName.toLowerCase();
					const list = map.get(key) ?? [];
					list.push(entry.score);
					map.set(key, list);
				}
				return map;
			}, [history]);
			const onRefresh = async () => {
				setRefreshing(true);
				setRefreshMsg(null);
				try {
					const r = await refreshRankings();
					const fresh = await loadRankings();
					setDoc(fresh);
					setError(null);
					setRefreshMsg(t("refreshDone", { time: formatTime(r.fetchedAt) }));
				} catch (err) {
					setRefreshMsg(t("refreshFail", { message: err instanceof Error ? err.message : String(err) }));
				} finally {
					setRefreshing(false);
				}
			};
			const onCopy = async (fullName) => {
				const cmd = `dsh plugin --profile web add github:${fullName}`;
				try {
					await copyText(cmd);
					setCopied(fullName);
					window.setTimeout(() => setCopied((cur) => cur === fullName ? null : cur), 1800);
				} catch {
					setRefreshMsg(t("copyFail"));
				}
			};
			const doInstall = async (fullName) => {
				setInstallState((s) => ({
					...s,
					[fullName]: { phase: "running" }
				}));
				try {
					const result = await installPlugin(fullName);
					if (result.ok) {
						setInstallState((s) => ({
							...s,
							[fullName]: { phase: "installed" }
						}));
						setInstalled((prev) => new Set(prev).add(normalizeKey(fullName)));
					} else setInstallState((s) => ({
						...s,
						[fullName]: {
							phase: "failed",
							message: result.message ?? t("installFail")
						}
					}));
				} catch (err) {
					setInstallState((s) => ({
						...s,
						[fullName]: {
							phase: "failed",
							message: err instanceof Error ? err.message : String(err)
						}
					}));
				}
			};
			const onCheckUpdates = async () => {
				setUpdateLoading(true);
				setUpdateMessage(null);
				try {
					const status = await loadUpdates();
					setUpdateStatus(status);
					setPolicyDraft(status.policy);
					const count = status.updates.filter((u) => u.updateAvailable).length;
					setUpdateMessage(count > 0 ? t("updateFound", { count: String(count) }) : t("updateNone"));
				} catch (error) {
					setUpdateMessage(t("updateCheckFail", { message: error instanceof Error ? error.message : String(error) }));
				} finally {
					setUpdateLoading(false);
				}
			};
			const doUpdate = async (packageName) => {
				setUpdatingPackage(packageName);
				setUpdateMessage(null);
				try {
					const result = await updatePlugin(packageName);
					if (result.ok) {
						try {
							const status = await loadUpdates();
							setUpdateStatus(status);
							setPolicyDraft(status.policy);
						} catch {}
						setUpdateMessage(t("updateDone", { packageName }));
					} else setUpdateMessage(t("updateFail", {
						packageName,
						message: result.message ?? t("unknownError")
					}));
				} catch (error) {
					setUpdateMessage(t("updateFail", {
						packageName,
						message: error instanceof Error ? error.message : String(error)
					}));
				} finally {
					setUpdatingPackage(null);
				}
			};
			const onSavePolicy = async () => {
				if (!policyDraft) return;
				try {
					const policy = await saveUpdatePolicy(policyDraft);
					setPolicyDraft(policy);
					setUpdateStatus((current) => current ? {
						...current,
						policy
					} : current);
					setUpdateMessage(policy.mode === "auto" ? t("autoUpdateEnabled") : t("autoUpdateDisabled"));
				} catch (error) {
					setUpdateMessage(t("updatePolicyFail", { message: error instanceof Error ? error.message : String(error) }));
				}
			};
			if (error) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dshr-wrap",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					role: "alert",
					children: t("loadError", { message: error })
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dshr-refresh",
					onClick: onRefresh,
					disabled: refreshing,
					children: refreshing ? t("refreshing") : t("refresh")
				})]
			});
			if (!doc) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				role: "status",
				children: t("loading")
			});
			const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
			const safePage = Math.min(page, totalPages);
			const start = (safePage - 1) * PAGE_SIZE;
			const pageRows = rows.slice(start, start + PAGE_SIZE);
			const historyDays = history?.days.length ?? 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dshr-wrap",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshr-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							className: "dshr-title",
							children: t("tab")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dshr-meta",
							children: [t("meta", {
								count: String(doc.plugins.filter((p) => !p.excluded).length),
								time: formatTime(doc.meta.generatedAt),
								version: String(doc.meta.scoringVersion ?? "?")
							}), historyDays > 0 ? t("historyMeta", { days: String(historyDays) }) : null]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						className: "dshr-updates",
						"aria-label": t("updateSectionTitle"),
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dshr-update-head",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("updateSectionTitle") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: updateStatus ? t("updateCheckedAt", { time: formatTime(updateStatus.checkedAt) }) : t("updateCheckingInitial") })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dshr-update-check",
									onClick: () => {
										onCheckUpdates();
									},
									disabled: updateLoading || updatingPackage !== null,
									children: updateLoading ? t("updateChecking") : t("updateCheck")
								})]
							}),
							updateStatus ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dshr-update-list",
								children: updateStatus.updates.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshr-update-row",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dshr-update-package",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: item.packageName }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: item.source === "github" ? t("updateSourceGit") : item.source === "npm" ? t("updateSourceNpm") : t("updateSourceUnknown") }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [
												(item.installed ?? "—").slice(0, 12),
												" → ",
												(item.latest ?? "—").slice(0, 12)
											] })
										]
									}), item.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshr-update-error",
										title: item.error,
										children: t("updateUnavailable")
									}) : item.updateAvailable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dshr-update-run",
										onClick: () => {
											doUpdate(item.packageName);
										},
										disabled: updatingPackage !== null,
										children: updatingPackage === item.packageName ? t("updating") : t("updateNow")
									}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dshr-update-current",
										children: t("updateCurrent")
									})]
								}, item.packageName))
							}), policyDraft ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
								className: "dshr-update-policy",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: t("updatePolicyTitle") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dshr-policy-body",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: policyDraft.mode === "auto",
											onChange: (e) => setPolicyDraft({
												...policyDraft,
												mode: e.target.checked ? "auto" : "notify"
											})
										}), t("autoUpdateLabel")] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: "dshr-policy-interval",
											children: [
												t("autoUpdateInterval"),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "number",
													min: "1",
													max: "168",
													value: policyDraft.intervalHours,
													onChange: (e) => setPolicyDraft({
														...policyDraft,
														intervalHours: Math.min(168, Math.max(1, Number(e.target.value) || 1))
													})
												}),
												t("hourUnit")
											]
										}),
										policyDraft.mode === "auto" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dshr-policy-allowlist",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("autoUpdateAllowlist") }), updateStatus.updates.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "checkbox",
												checked: policyDraft.allowlist.includes(item.packageName),
												onChange: (e) => setPolicyDraft({
													...policyDraft,
													allowlist: e.target.checked ? [...policyDraft.allowlist, item.packageName] : policyDraft.allowlist.filter((p) => p !== item.packageName)
												})
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: item.packageName })] }, item.packageName))]
										}) : null,
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dshr-update-check",
											onClick: () => {
												onSavePolicy();
											},
											children: t("saveUpdatePolicy")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("autoUpdateNotice") })
									]
								})]
							}) : null] }) : null,
							updateMessage ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: "dshr-update-message",
								role: "status",
								children: updateMessage
							}) : null
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshr-controls",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "search",
								placeholder: t("searchPlaceholder"),
								value: query,
								onChange: (e) => {
									setQuery(e.target.value);
									setPage(1);
								},
								"aria-label": t("searchPlaceholder")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								value: category,
								onChange: (e) => {
									setCategory(e.target.value);
									setPage(1);
								},
								"aria-label": t("allCategories"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: t("allCategories")
								}), categories.map((c) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: c,
									children: c
								}, c))]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								value: view,
								onChange: (e) => {
									setView(e.target.value);
									setPage(1);
								},
								"aria-label": t("sortScore"),
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "score",
										children: t("sortScore")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "stars",
										children: t("sortStars")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "updated",
										children: t("sortUpdated")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "newest",
										children: t("sortNewest")
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: "dshr-refresh",
								onClick: onRefresh,
								disabled: refreshing,
								children: refreshing ? t("refreshing") : t("refresh")
							})
						]
					}),
					refreshMsg ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dshr-msg",
						role: "status",
						children: refreshMsg
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dshr-list",
						children: pageRows.map((p, i) => {
							const tier = scoreTier(p.score);
							const medal = start + i === 0 ? "🥇" : start + i === 1 ? "🥈" : start + i === 2 ? "🥉" : `#${start + i + 1}`;
							const series = trendSeries.get(p.fullName.toLowerCase());
							const site = normalizeSite(p.homepage, p.url);
							const scanLabel = !p.scanStatus || p.scanStatus === "skipped" ? t("scanSkipped") : p.scanStatus === "verified" ? t("scanVerified") : p.scanStatus === "unverified" ? t("scanUnverified") : t("scanError");
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
								className: "dshr-row",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dshr-row-top",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: `dshr-rank ${tier}`,
												children: medal
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dshr-name",
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
														href: p.url,
														target: "_blank",
														rel: "noreferrer",
														title: p.fullName,
														children: [p.fullName, p.certified ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
															className: "dshr-cert",
															title: t("certifiedTitle"),
															children: " 🏅"
														}) : null]
													}),
													p.category ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "dshr-cat",
														children: p.category
													}) : null,
													/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
														className: "dshr-repo-addr",
														href: p.url,
														target: "_blank",
														rel: "noreferrer",
														title: `github.com/${p.fullName}`,
														children: ["github.com/", p.fullName]
													})
												]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dshr-right",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													className: "dshr-stars",
													children: ["★ ", p.stars]
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dshr-score",
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: `num ${tier}`,
														children: p.score.toFixed(3)
													})
												})]
											})
										]
									}),
									p.description ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: "dshr-desc",
										children: p.description
									}) : null,
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dshr-foot",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dshr-pills",
											children: SIGNAL_ORDER.map((k) => {
												const v = p.signals?.[k];
												return v === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													className: "dshr-pill",
													children: [
														t(SIGNAL_LABELS[k]),
														" ",
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: v.toFixed(2) })
													]
												}, k);
											})
										}), series && series.length >= 2 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dshr-trend",
											title: t("trendTitle", { days: String(series.length) }),
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Sparkline, {
												series,
												label: t("trendTitle", { days: String(series.length) })
											})
										}) : null]
									}),
									p.excluded ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dshr-actions",
										children: [
											(() => {
												const st = installState[p.fullName] ?? { phase: "idle" };
												const isInstalled = installed.has(normalizeKey(p.fullName)) || st.phase === "installed";
												if (st.phase === "failed") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dshr-install-msg bad",
													title: st.message,
													children: t("installFail")
												});
												if (st.phase === "running") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dshr-act dshr-installing",
													title: t("installingTitle"),
													children: t("installing")
												});
												if (isInstalled) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													className: "dshr-act dshr-installed",
													title: t("installedTitle"),
													children: ["✓ ", t("installed")]
												});
												return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
													type: "button",
													className: "dshr-act dshr-install",
													title: t("installTitle"),
													onClick: () => {
														doInstall(p.fullName);
													},
													children: ["⬇ ", t("install")]
												});
											})(),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
												className: "dshr-act dshr-star",
												href: p.url,
												target: "_blank",
												rel: "noreferrer",
												title: t("starTitle"),
												children: t("starSupport")
											}),
											site ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
												className: "dshr-act dshr-site",
												href: site,
												target: "_blank",
												rel: "noreferrer",
												title: t("siteTitle"),
												children: t("site")
											}) : null,
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: `dshr-act dshr-copy${copied === p.fullName ? " dshr-copied" : ""}`,
												title: t("copyTitle"),
												onClick: () => void onCopy(p.fullName),
												children: copied === p.fullName ? t("copied") : t("copyCommand")
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
										className: "dshr-details",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: t("details") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", { children: [
											p.category ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("fieldCategory") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: p.category })] }) : null,
											Array.isArray(p.topics) && p.topics.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("fieldTopics") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dshr-topics",
												children: p.topics.map((tp) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: "dshr-topic",
													children: tp
												}, tp))
											}) })] }) : null,
											p.license ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("fieldLicense") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: p.license })] }) : null,
											p.createdAt ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("fieldCreated") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: formatTime(p.createdAt) })] }) : null,
											p.pushedAt ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("fieldPushed") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: formatTime(p.pushedAt) })] }) : null,
											site ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("fieldHomepage") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: site })] }) : null,
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("fieldScan") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: scanLabel })] }),
											p.excluded ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("excludedReason") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: p.excluded })] }) : null
										] })]
									})
								]
							}, p.fullName);
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dshr-pager",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: safePage <= 1,
								onClick: () => setPage(safePage - 1),
								children: t("prevPage")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dshr-pager-info",
								children: t("pageInfo", {
									page: String(safePage),
									totalPages: String(totalPages)
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: safePage >= totalPages,
								onClick: () => setPage(safePage + 1),
								children: t("nextPage")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: "dshr-note",
						children: t("scoreNote", {
							page: String(safePage),
							totalPages: String(totalPages),
							count: String(rows.length)
						})
					})
				]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/** dsh-recommend 排行标签的本地化文案（zh/en 全量）。 */
		const zh = {
			tab: "插件排行",
			meta: "共 {count} 个插件 · 数据 {time} · 评分模型 v{version}",
			historyMeta: "· 历史 {days} 天",
			searchPlaceholder: "搜索名称 / 描述 / 分类…",
			allCategories: "全部分类",
			sortScore: "按综合分",
			sortStars: "按热度（★）",
			sortUpdated: "按最近更新",
			sortNewest: "按最新发布",
			refresh: "刷新数据",
			refreshing: "刷新中…",
			refreshDone: "已刷新（{time}）",
			refreshFail: "刷新失败：{message}",
			loading: "正在加载插件榜单…",
			loadError: "榜单数据加载失败：{message}（可点「刷新数据」，或先调用 sync_registry 工具）",
			signalMaintenance: "维护性",
			signalPopularity: "热度",
			signalQuality: "质量",
			signalEcosystem: "生态",
			scoreNote: "第 {page} / {totalPages} 页 · 共 {count} 条 · 综合分 = 0.35 维护性 + 0.30 热度 + 0.20 质量 + 0.15 生态 · 收录 ≠ 安全背书",
			prevPage: "« 上一页",
			nextPage: "下一页 »",
			pageInfo: "第 {page} / {totalPages} 页",
			starSupport: "⭐ Star 支持作者",
			starTitle: "打开仓库，点右上角 ⭐ Star 支持作者 —— 免费，却是对作者最好的感谢",
			site: "🌐 站点",
			siteTitle: "插件静态站 / 文档",
			install: "安装",
			installTitle: "一键安装到当前 profile（dsh plugin add）",
			installing: "安装中…",
			installingTitle: "正在执行 dsh plugin add（首次拉取可能较慢）",
			installed: "已安装",
			installedTitle: "已安装到当前 profile（重启 DSH 后生效）",
			installFail: "安装失败",
			copyCommand: "复制命令",
			copyTitle: "复制 dsh plugin add 安装命令到剪贴板",
			copied: "已复制 ✓",
			copyFail: "复制失败，请手动复制",
			certifiedTitle: "精选认证（issue 审核通过）",
			details: "展开详情",
			detailsClose: "收起详情",
			detailsTitle: "更多信息（分类 / 主题标签 / 许可证 / 时间 / 深扫状态）",
			fieldCategory: "分类",
			fieldTopics: "主题标签",
			fieldLicense: "许可证",
			fieldCreated: "首次发布",
			fieldPushed: "最近更新",
			fieldHomepage: "站点",
			fieldScan: "深扫验证",
			scanVerified: "检出 DSH 插件特征",
			scanUnverified: "未检出插件特征（已排除出榜）",
			scanSkipped: "未深扫",
			scanError: "深扫失败",
			excludedReason: "排除原因",
			trendTitle: "近 {days} 天综合分走势",
			noTrend: "暂无历史数据（数据同步满 2 天后出现）",
			emptySearch: "没有匹配的插件",
			updateSectionTitle: "插件更新",
			updateCheckedAt: "检查于 {time}",
			updateCheckingInitial: "加载更新状态…",
			updateCheck: "检查更新",
			updateChecking: "检查中…",
			updateFound: "发现 {count} 个可更新插件",
			updateNone: "所有已安装插件都是最新版本",
			updateCheckFail: "更新检查失败：{message}",
			updateSourceGit: "Git",
			updateSourceNpm: "npm",
			updateSourceUnknown: "未知来源",
			updateNow: "更新",
			updating: "更新中…",
			updateCurrent: "已是最新",
			updateUnavailable: "暂不可查",
			updateDone: "{packageName} 已更新，请重启 DSH 后生效",
			updateFail: "{packageName} 更新失败：{message}",
			unknownError: "未知错误",
			updatePolicyTitle: "进阶：自动更新策略",
			autoUpdateLabel: "定时自动更新已勾选插件",
			autoUpdateInterval: "检查间隔",
			hourUnit: "小时",
			autoUpdateAllowlist: "允许自动更新：",
			saveUpdatePolicy: "保存策略",
			autoUpdateEnabled: "自动更新已启用（仅更新白名单中的插件）",
			autoUpdateDisabled: "已切换为仅提醒，不会自动更新",
			updatePolicyFail: "保存更新策略失败：{message}",
			autoUpdateNotice: "自动更新默认关闭。开启后仅在 DSH Web 正在运行时检查，更新完成仍需手动重启 DSH。"
		};
		const en = {
			tab: "Plugin rankings",
			meta: "{count} plugins · data {time} · scoring v{version}",
			historyMeta: "· {days} days of history",
			searchPlaceholder: "Search name / description / category…",
			allCategories: "All categories",
			sortScore: "By score",
			sortStars: "By stars (★)",
			sortUpdated: "Recently updated",
			sortNewest: "Newest",
			refresh: "Refresh data",
			refreshing: "Refreshing…",
			refreshDone: "Refreshed ({time})",
			refreshFail: "Refresh failed: {message}",
			loading: "Loading plugin rankings…",
			loadError: "Failed to load rankings: {message} (click \"Refresh data\", or run the sync_registry tool first)",
			signalMaintenance: "Maintenance",
			signalPopularity: "Popularity",
			signalQuality: "Quality",
			signalEcosystem: "Ecosystem",
			scoreNote: "Page {page} / {totalPages} · {count} entries · score = 0.35 maintenance + 0.30 popularity + 0.20 quality + 0.15 ecosystem · listing ≠ endorsement",
			prevPage: "« Prev",
			nextPage: "Next »",
			pageInfo: "Page {page} / {totalPages}",
			starSupport: "⭐ Star this plugin",
			starTitle: "Open the repo and hit ⭐ to thank the author — free, but means a lot",
			site: "🌐 Site",
			siteTitle: "Plugin site / docs",
			install: "Install",
			installTitle: "One-click install into the current profile (dsh plugin add)",
			installing: "Installing…",
			installingTitle: "Running dsh plugin add (first fetch may be slow)",
			installed: "Installed",
			installedTitle: "Installed into the current profile (restart DSH to activate)",
			installFail: "Install failed",
			copyCommand: "Copy cmd",
			copyTitle: "Copy the dsh plugin add command to clipboard",
			copied: "Copied ✓",
			copyFail: "Copy failed — copy manually",
			certifiedTitle: "Certified (reviewed via issue)",
			details: "Show details",
			detailsClose: "Hide details",
			detailsTitle: "More info (category / topics / license / dates / scan status)",
			fieldCategory: "Category",
			fieldTopics: "Topics",
			fieldLicense: "License",
			fieldCreated: "Created",
			fieldPushed: "Last push",
			fieldHomepage: "Site",
			fieldScan: "Deep scan",
			scanVerified: "DSH plugin traits detected",
			scanUnverified: "No DSH plugin traits (excluded from rankings)",
			scanSkipped: "Not scanned",
			scanError: "Scan failed",
			excludedReason: "Exclusion reason",
			trendTitle: "Score trend, last {days} days",
			noTrend: "No history yet (appears after 2+ days of sync)",
			emptySearch: "No matching plugins",
			updateSectionTitle: "Plugin updates",
			updateCheckedAt: "Checked {time}",
			updateCheckingInitial: "Loading update status…",
			updateCheck: "Check updates",
			updateChecking: "Checking…",
			updateFound: "{count} update(s) available",
			updateNone: "All installed plugins are up to date",
			updateCheckFail: "Update check failed: {message}",
			updateSourceGit: "Git",
			updateSourceNpm: "npm",
			updateSourceUnknown: "Unknown source",
			updateNow: "Update",
			updating: "Updating…",
			updateCurrent: "Up to date",
			updateUnavailable: "Unavailable",
			updateDone: "{packageName} updated; restart DSH to activate",
			updateFail: "Failed to update {packageName}: {message}",
			unknownError: "Unknown error",
			updatePolicyTitle: "Advanced: automatic update policy",
			autoUpdateLabel: "Automatically update checked plugins",
			autoUpdateInterval: "Check interval",
			hourUnit: "hours",
			autoUpdateAllowlist: "Allowed automatic updates:",
			saveUpdatePolicy: "Save policy",
			autoUpdateEnabled: "Automatic updates enabled (allowlist only)",
			autoUpdateDisabled: "Notify-only mode enabled",
			updatePolicyFail: "Failed to save update policy: {message}",
			autoUpdateNotice: "Automatic updates are off by default. When enabled, checks run only while DSH Web is running; restart DSH manually after updates."
		};
		//#endregion
		//#region src/client/index.ts
		/** 本插件拥有的字典命名空间。 */
		const NS = "dshRecommend";
		/** 设置页注册所需的客户端服务（remote 用于已装检测）。 */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.pluginInventory"
		];
		/** 向「插件」设置分区贡献「插件排行」标签。 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-recommend: dictionaries");
			const t = ctx.locale.bind(NS);
			const injected = () => ({
				loadRankings: async () => {
					const res = await fetch("/dsh-recommend/registry.json", { cache: "no-store" });
					if (!res.ok) throw new Error(`registry 路由 ${res.status}（先调用 sync_registry）`);
					return res.json();
				},
				loadHistory: async () => {
					const res = await fetch("/dsh-recommend/history.json", { cache: "no-store" });
					if (!res.ok) throw new Error(`history 路由 ${res.status}`);
					return res.json();
				},
				refreshRankings: async () => {
					const res = await fetch("/dsh-recommend/sync", { method: "POST" });
					const body = await res.json().catch(() => null);
					if (!res.ok || !body?.ok) throw new Error(body?.error ?? `sync 路由 ${res.status}`);
					return {
						fetchedAt: body.fetchedAt,
						count: body.count
					};
				},
				listInstalled: async () => {
					const result = await ctx.remote.pluginInventory.list();
					if (!result.ok) throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`);
					return result.value.entries.map((e) => e.moduleName);
				},
				installPlugin: async (fullName) => {
					const res = await fetch("/dsh-recommend/install", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ fullName })
					});
					const data = await res.json();
					if (!res.ok) return {
						ok: false,
						message: data.error ?? `HTTP ${res.status}`
					};
					return data;
				},
				loadUpdates: async () => {
					const res = await fetch("/dsh-recommend/updates", { cache: "no-store" });
					const data = await res.json();
					if (!res.ok || data.ok === false) throw new Error(data.error ?? `updates 路由 ${res.status}`);
					return data;
				},
				updatePlugin: async (packageName) => {
					const res = await fetch("/dsh-recommend/update", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ packageName })
					});
					const data = await res.json();
					if (!res.ok) return {
						ok: false,
						message: data.error ?? `HTTP ${res.status}`
					};
					return data;
				},
				saveUpdatePolicy: async (policy) => {
					const res = await fetch("/dsh-recommend/update-policy", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(policy)
					});
					const data = await res.json();
					if (!res.ok || !data.ok || !data.policy) throw new Error(data.error ?? `update-policy 路由 ${res.status}`);
					return data.policy;
				}
			});
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "rankings",
				order: 20,
				label: () => t("tab"),
				locale: NS,
				inject: injected
			}, RankingsTab));
		}
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map