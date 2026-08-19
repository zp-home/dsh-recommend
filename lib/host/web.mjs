import { n as syncRegistry, r as syncRegistryIfStale } from "./sync-D9C87_rh.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
//#region src/host/web.ts
/**
* dsh-recommend web 半：把本地缓存的 registry.json / history.json 以同源路由供给浏览器，
* 提供 POST /dsh-recommend/sync 供设置页「刷新数据」按钮触发更新，
* 并提供 POST /dsh-recommend/install 供设置页「一键安装」按钮触发 `dsh plugin add`（M3）。
*
* 独立成行（而非并入 host 工具半）是因为 cordis 的 inject 是强依赖：
* webServer 只在 web profile 存在，headless 下挂载本行会永远 PENDING。
* 所以 tools 半（main）不带 webServer，本半（./web）带，由 patch 分两行挂载。
*
* 安装安全边界：
*   1. 客户端只能按 fullName 安装，spec 由服务端从缓存 registry 构造
*      （`github:owner/repo`），绝不接受客户端传来的任意字符串 —— 防注入；
*   2. Origin 校验：仅接受同源（或空 Origin，如 curl 本机）请求 —— 防 CSRF
*      （恶意网页让本地 DSH 装任意插件）；
*   3. 安装命令交给官方 `dsh plugin --profile <name> add <spec>`，由它完成
*      profile 初始化、pnpm 安装与 bundles 对账，本行只转发输出。
*/
const name = "dsh-recommend-web";
const inject = ["webServer"];
/** 安装/更新超时：pnpm 拉取 git 依赖可能很慢，给足 10 分钟。 */
const INSTALL_TIMEOUT_MS = 6e5;
const UPDATE_TIMER_MS = 9e5;
const PACKAGE_NAME_PATTERN = /^@?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/;
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SITE_DIR = join(PACKAGE_ROOT, "site");
const SITE_ASSETS = [
	{
		route: "/dsh-recommend/site/",
		file: "index.html",
		type: "text/html; charset=utf-8"
	},
	{
		route: "/dsh-recommend/site/index.html",
		file: "index.html",
		type: "text/html; charset=utf-8"
	},
	{
		route: "/dsh-recommend/site/rankings.html",
		file: "rankings.html",
		type: "text/html; charset=utf-8"
	},
	{
		route: "/dsh-recommend/site/style.css",
		file: "style.css",
		type: "text/css; charset=utf-8"
	},
	{
		route: "/dsh-recommend/site/app.js",
		file: "app.js",
		type: "text/javascript; charset=utf-8"
	},
	{
		route: "/dsh-recommend/site/rankings.js",
		file: "rankings.js",
		type: "text/javascript; charset=utf-8"
	}
];
function profileDirFromCache(cachePath, profile) {
	const dshHome = dirname(dirname(cachePath));
	return join(dshHome, "profiles", profile);
}
function updatePolicyPath(cachePath) {
	return join(dirname(cachePath), "update-policy.json");
}
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function parseGithubSpec(spec) {
	const match = spec.match(/^(?:github:|https?:\/\/github\.com\/|git\+https:\/\/github\.com\/)([^/]+)\/([^/#]+)(?:#.*)?$/i);
	const owner = match?.[1];
	const repo = match?.[2];
	return owner && repo ? {
		owner,
		repo: repo.replace(/\.git$/, "")
	} : null;
}
function isLocalSpec(spec) {
	return /^(?:link:|file:|\.{1,2}(?:[\\/]|$)|[A-Za-z]:[\\/]|[\\/])/.test(spec);
}
function compareSemver(a, b) {
	const parse = (value) => {
		const m = value?.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
		return m ? m.slice(1).map(Number) : null;
	};
	const left = parse(a ?? "");
	const right = parse(b ?? "");
	if (!left || !right) return null;
	for (let i = 0; i < 3; i += 1) {
		const lv = left[i] ?? 0;
		const rv = right[i] ?? 0;
		if (lv !== rv) return lv > rv ? 1 : -1;
	}
	return 0;
}
async function readJsonFile(file, fallback) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return fallback;
	}
}
async function loadUpdatePolicy(cachePath) {
	const policy = await readJsonFile(updatePolicyPath(cachePath), {});
	return {
		mode: policy.mode === "auto" ? "auto" : "notify",
		intervalHours: Math.min(168, Math.max(1, Number(policy.intervalHours) || 24)),
		allowlist: Array.isArray(policy.allowlist) ? policy.allowlist.filter((p) => PACKAGE_NAME_PATTERN.test(p)) : [],
		lastAutoRunAt: policy.lastAutoRunAt ?? null
	};
}
async function saveUpdatePolicy(cachePath, policy) {
	await mkdir(dirname(cachePath), { recursive: true });
	await writeFile(updatePolicyPath(cachePath), JSON.stringify(policy, null, 2), "utf8");
}
async function readProfileManifest(profileDir) {
	return readJsonFile(join(profileDir, "package.json"), {});
}
async function installedPackageVersion(profileDir, packageName) {
	return (await readJsonFile(join(profileDir, "node_modules", packageName, "package.json"), {})).version ?? null;
}
async function lockGitCommit(profileDir, owner, repo) {
	try {
		return (await readFile(join(profileDir, "pnpm-lock.yaml"), "utf8")).match(new RegExp(`https://codeload\\.github\\.com/${escapeRegExp(owner)}/${escapeRegExp(repo)}/tar\\.gz/([0-9a-f]{7,40})`, "i"))?.[1] ?? null;
	} catch {
		return null;
	}
}
async function latestGithubCommit(owner, repo) {
	const headers = { "user-agent": "dsh-recommend-update-check" };
	const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
	if (!repoRes.ok) throw new Error(`GitHub repo ${repoRes.status}`);
	const branch = (await repoRes.json()).default_branch ?? "main";
	const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`, { headers });
	if (!commitRes.ok) throw new Error(`GitHub commit ${commitRes.status}`);
	return (await commitRes.json()).sha;
}
async function latestNpmVersion(packageName) {
	const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, { headers: { "user-agent": "dsh-recommend-update-check" } });
	if (!res.ok) throw new Error(`npm ${res.status}`);
	return (await res.json()).version;
}
async function checkProfileUpdates(profileDir) {
	const manifest = await readProfileManifest(profileDir);
	const dependencies = Object.entries(manifest.dependencies ?? {}).filter(([name]) => !name.startsWith("@deepseek-ai/"));
	const result = [];
	for (const [packageName, spec] of dependencies) {
		const git = parseGithubSpec(spec);
		const installed = await installedPackageVersion(profileDir, packageName);
		try {
			if (git) {
				const [latest, installedCommit] = await Promise.all([latestGithubCommit(git.owner, git.repo), lockGitCommit(profileDir, git.owner, git.repo)]);
				result.push({
					packageName,
					spec,
					source: "github",
					installed: installedCommit ?? installed,
					latest,
					updateAvailable: Boolean(installedCommit && latest !== installedCommit)
				});
			} else if (isLocalSpec(spec)) result.push({
				packageName,
				spec,
				source: "unknown",
				installed,
				latest: null,
				updateAvailable: false,
				error: "local linked package"
			});
			else {
				const latest = await latestNpmVersion(packageName);
				result.push({
					packageName,
					spec,
					source: "npm",
					installed,
					latest,
					updateAvailable: compareSemver(installed, latest) === -1
				});
			}
		} catch (error) {
			result.push({
				packageName,
				spec,
				source: git ? "github" : "unknown",
				installed,
				latest: null,
				updateAvailable: false,
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}
	return result;
}
async function readBodyJson(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(Buffer.from(chunk));
	const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	return value && typeof value === "object" ? value : {};
}
function sameOrigin(req) {
	const origin = req.headers.origin;
	return !origin || origin === `http://${req.headers.host}`;
}
function apply(ctx, config) {
	const historyPath = config.historyPath ?? config.cachePath.replace(/registry\.json$/, "history.json");
	const profile = config.installProfile ?? "web";
	const profileDir = profileDirFromCache(config.cachePath, profile);
	const verificationPath = config.verificationPath ?? config.cachePath.replace(/registry\.json$/, "verification.json");
	let updateBusy = false;
	/** Manual refresh always downloads; automatic refresh only runs after the cache TTL expires. */
	async function refresh(force) {
		return force ? syncRegistry(config) : syncRegistryIfStale(config);
	}
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-recommend/registry.json",
		async handler(_req, res) {
			try {
				const body = await readFile(config.cachePath);
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store"
				});
				res.end(body);
			} catch {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				res.end("registry cache missing — run sync_registry first");
			}
		}
	}), "dsh-recommend: registry route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-recommend/history.json",
		async handler(_req, res) {
			try {
				const body = await readFile(historyPath);
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store"
				});
				res.end(body);
			} catch {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				res.end("history cache missing — run sync_registry first");
			}
		}
	}), "dsh-recommend: history route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-recommend/verification.json",
		async handler(_req, res) {
			try {
				const body = await readFile(verificationPath);
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store"
				});
				res.end(body);
			} catch {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				res.end("verification cache missing — refresh marketplace data first");
			}
		}
	}), "dsh-recommend: verification route");
	for (const asset of SITE_ASSETS) ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: asset.route,
		async handler(req, res) {
			if (req.method !== "GET") {
				res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
				res.end("method not allowed");
				return;
			}
			try {
				const body = await readFile(join(SITE_DIR, asset.file));
				res.writeHead(200, {
					"content-type": asset.type,
					"cache-control": "no-store"
				});
				res.end(body);
			} catch {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				res.end(`static site asset missing: ${asset.file}`);
			}
		}
	}), `dsh-recommend: static ${asset.file}`);
	for (const [route, filePath] of [["/dsh-recommend/data/registry.json", config.cachePath], ["/dsh-recommend/data/history.json", historyPath]]) ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: route,
		async handler(_req, res) {
			try {
				const body = await readFile(filePath);
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store"
				});
				res.end(body);
			} catch {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				res.end("data cache missing — run sync_registry first");
			}
		}
	}), `dsh-recommend: static data ${route}`);
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-recommend/sync",
		async handler(req, res) {
			if (req.method !== "POST") {
				res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
				res.end("method not allowed — use POST");
				return;
			}
			try {
				const result = await refresh(new URL(req.url ?? "/dsh-recommend/sync", "http://localhost").searchParams.get("force") === "1");
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({
					ok: true,
					...result
				}));
			} catch (err) {
				res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({
					ok: false,
					error: err instanceof Error ? err.message : String(err)
				}));
			}
		}
	}), "dsh-recommend: sync route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-recommend/install",
		async handler(req, res) {
			const json = (code, body) => {
				res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify(body));
			};
			try {
				if (req.method !== "POST") return json(405, {
					ok: false,
					error: "method not allowed"
				});
				const origin = req.headers.origin;
				if (origin && origin !== `http://${req.headers.host}`) return json(403, {
					ok: false,
					error: "cross-origin install rejected"
				});
				const chunks = [];
				for await (const chunk of req) chunks.push(chunk);
				const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
				const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
				if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) return json(400, {
					ok: false,
					error: `illegal fullName: ${fullName}`
				});
				let registry;
				try {
					registry = JSON.parse(await readFile(config.cachePath, "utf8"));
				} catch {
					return json(409, {
						ok: false,
						error: "registry cache missing — run sync_registry first"
					});
				}
				const entry = registry.plugins?.find((p) => p.fullName === fullName);
				if (!entry) return json(404, {
					ok: false,
					error: `not in registry: ${fullName}`
				});
				if (entry.excluded) return json(400, {
					ok: false,
					error: `excluded plugin: ${fullName}（${entry.excluded}）`
				});
				const spec = `github:${fullName}`;
				const result = await runInstall(config.installProfile ?? "web", spec);
				json(200, {
					ok: result.exitCode === 0,
					spec,
					profile: config.installProfile ?? "web",
					...result
				});
			} catch (err) {
				json(500, {
					ok: false,
					error: err instanceof Error ? err.message : String(err)
				});
			}
		}
	}), "dsh-recommend: install route");
	async function updateStatus() {
		const policy = await loadUpdatePolicy(config.cachePath);
		const updates = await checkProfileUpdates(profileDir);
		return {
			checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
			profile,
			policy,
			updates
		};
	}
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-recommend/updates",
		async handler(req, res) {
			const json = (code, body) => {
				res.writeHead(code, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store"
				});
				res.end(JSON.stringify(body));
			};
			try {
				if (req.method !== "GET" && req.method !== "POST") return json(405, {
					ok: false,
					error: "method not allowed"
				});
				return json(200, {
					ok: true,
					...await updateStatus()
				});
			} catch (error) {
				return json(500, {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
	}), "dsh-recommend: updates route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-recommend/update",
		async handler(req, res) {
			const json = (code, body) => {
				res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify(body));
			};
			try {
				if (req.method !== "POST") return json(405, {
					ok: false,
					error: "method not allowed"
				});
				if (!sameOrigin(req)) return json(403, {
					ok: false,
					error: "cross-origin update rejected"
				});
				const body = await readBodyJson(req);
				const packageName = typeof body.packageName === "string" ? body.packageName.trim() : "";
				if (!PACKAGE_NAME_PATTERN.test(packageName)) return json(400, {
					ok: false,
					error: "illegal packageName"
				});
				const manifest = await readProfileManifest(profileDir);
				if (!Object.prototype.hasOwnProperty.call(manifest.dependencies ?? {}, packageName)) return json(403, {
					ok: false,
					error: "only direct profile dependencies can be updated"
				});
				if (updateBusy) return json(409, {
					ok: false,
					error: "another plugin operation is running"
				});
				updateBusy = true;
				try {
					const result = await runDsh(profile, ["update", packageName]);
					return json(200, {
						ok: result.exitCode === 0,
						packageName,
						profile,
						restartRequired: result.exitCode === 0,
						...result
					});
				} finally {
					updateBusy = false;
				}
			} catch (error) {
				return json(500, {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
	}), "dsh-recommend: update route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-recommend/update-policy",
		async handler(req, res) {
			const json = (code, body) => {
				res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify(body));
			};
			try {
				if (req.method !== "GET" && req.method !== "POST") return json(405, {
					ok: false,
					error: "method not allowed"
				});
				if (req.method === "GET") return json(200, {
					ok: true,
					policy: await loadUpdatePolicy(config.cachePath)
				});
				if (!sameOrigin(req)) return json(403, {
					ok: false,
					error: "cross-origin policy change rejected"
				});
				const body = await readBodyJson(req);
				const mode = body.mode === "auto" ? "auto" : "notify";
				const intervalHours = Math.min(168, Math.max(1, Number(body.intervalHours) || 24));
				const allowlist = Array.isArray(body.allowlist) ? body.allowlist.filter((p) => typeof p === "string" && PACKAGE_NAME_PATTERN.test(p)) : [];
				const manifest = await readProfileManifest(profileDir);
				const direct = new Set(Object.keys(manifest.dependencies ?? {}));
				const policy = {
					mode,
					intervalHours,
					allowlist: allowlist.filter((p) => direct.has(p)),
					lastAutoRunAt: null
				};
				await saveUpdatePolicy(config.cachePath, policy);
				return json(200, {
					ok: true,
					policy
				});
			} catch (error) {
				return json(500, {
					ok: false,
					error: error instanceof Error ? error.message : String(error)
				});
			}
		}
	}), "dsh-recommend: update policy route");
	const autoTimer = setInterval(() => {
		runAutoUpdate(config.cachePath, profileDir, profile, () => updateBusy, (value) => {
			updateBusy = value;
		});
	}, UPDATE_TIMER_MS);
	ctx.effect(() => () => clearInterval(autoTimer), "dsh-recommend: update timer");
	runAutoUpdate(config.cachePath, profileDir, profile, () => updateBusy, (value) => {
		updateBusy = value;
	});
}
/** 执行 `dsh plugin --profile <p> <verb> <package>`，收集输出，超时杀进程。 */
function runDsh(profile, args) {
	return new Promise((resolve, reject) => {
		const child = spawn("dsh", [
			"plugin",
			"--profile",
			profile,
			...args
		], {
			shell: process.platform === "win32",
			windowsHide: true
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		const timer = setTimeout(() => {
			child.kill();
			resolve({
				exitCode: -1,
				stdout,
				stderr: `${stderr}\n[dsh-recommend] 操作超时（${INSTALL_TIMEOUT_MS / 6e4} 分钟），已终止`,
				timedOut: true
			});
		}, INSTALL_TIMEOUT_MS);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				exitCode: code ?? 1,
				stdout,
				stderr,
				timedOut: false
			});
		});
	});
}
function runInstall(profile, spec) {
	return runDsh(profile, ["add", spec]);
}
async function runAutoUpdate(cachePath, profileDir, profile, isBusy, setBusy) {
	if (isBusy()) return;
	const policy = await loadUpdatePolicy(cachePath);
	if (policy.mode !== "auto" || policy.allowlist.length === 0) return;
	const last = policy.lastAutoRunAt ? Date.parse(policy.lastAutoRunAt) : 0;
	if (last && Date.now() - last < policy.intervalHours * 36e5) return;
	const targets = (await checkProfileUpdates(profileDir)).filter((item) => item.updateAvailable && policy.allowlist.includes(item.packageName));
	setBusy(true);
	try {
		for (const item of targets) await runDsh(profile, ["update", item.packageName]);
		policy.lastAutoRunAt = (/* @__PURE__ */ new Date()).toISOString();
		await saveUpdatePolicy(cachePath, policy);
	} finally {
		setBusy(false);
	}
}
//#endregion
export { apply, inject, name };

//# sourceMappingURL=web.mjs.map