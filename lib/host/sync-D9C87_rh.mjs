import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
//#region src/host/sync.ts
/** Upstream publishes every five hours; refresh local snapshots no more than once per six hours. */
const DEFAULT_REFRESH_INTERVAL_MS = 216e5;
const activeSyncs = /* @__PURE__ */ new Map();
function companionPath(cachePath, filename) {
	return cachePath.replace(/registry\.json$/, filename);
}
function companionUrl(dataUrl, filename) {
	return dataUrl.replace(/registry\.json(?=$|\?)/, filename);
}
function refreshInterval(config) {
	return config.refreshIntervalMs && config.refreshIntervalMs > 0 ? config.refreshIntervalMs : DEFAULT_REFRESH_INTERVAL_MS;
}
/** Returns true when the cache is absent or older than the configured refresh interval. */
async function isRegistryStale(config, now = Date.now()) {
	try {
		return now - (await stat(config.cachePath)).mtimeMs >= refreshInterval(config);
	} catch {
		return true;
	}
}
/**
* Fetches and validates the shared snapshot once, then updates every available local data file.
* Concurrent callers sharing a cache path await the same request.
*/
function syncRegistry(config) {
	const existing = activeSyncs.get(config.cachePath);
	if (existing) return existing;
	const work = downloadRegistry(config);
	activeSyncs.set(config.cachePath, work);
	work.then(() => {
		if (activeSyncs.get(config.cachePath) === work) activeSyncs.delete(config.cachePath);
	}, () => {
		if (activeSyncs.get(config.cachePath) === work) activeSyncs.delete(config.cachePath);
	});
	return work;
}
/** Refreshes only when no usable cache exists or the local snapshot has reached its TTL. */
async function syncRegistryIfStale(config) {
	if (!await isRegistryStale(config)) return { updated: false };
	return syncRegistry(config);
}
async function downloadRegistry(config) {
	const historyPath = config.historyPath ?? companionPath(config.cachePath, "history.json");
	const trendsPath = config.trendsPath ?? companionPath(config.cachePath, "trends.json");
	const verificationPath = config.verificationPath ?? companionPath(config.cachePath, "verification.json");
	const historyUrl = config.historyUrl ?? companionUrl(config.dataUrl, "history.json");
	const trendsUrl = config.trendsUrl ?? companionUrl(config.dataUrl, "trends.json");
	const verificationUrl = config.verificationUrl ?? companionUrl(config.dataUrl, "verification.json");
	const [registryResult, historyResult, trendsResult, verificationResult] = await Promise.allSettled([
		fetch(config.dataUrl),
		fetch(historyUrl),
		fetch(trendsUrl),
		fetch(verificationUrl)
	]);
	if (registryResult.status === "rejected") throw registryResult.reason;
	const registryResponse = registryResult.value;
	if (!registryResponse.ok) throw new Error(`下载 registry 失败: ${registryResponse.status}`);
	const registryText = await registryResponse.text();
	const registry = JSON.parse(registryText);
	if (!Array.isArray(registry.plugins)) throw new Error("下载的 registry 结构异常");
	await mkdir(dirname(config.cachePath), { recursive: true });
	await writeFile(config.cachePath, registryText, "utf8");
	let historyDays = 0;
	if (historyResult.status === "fulfilled" && historyResult.value.ok) {
		const historyText = await historyResult.value.text();
		try {
			const history = JSON.parse(historyText);
			if (Array.isArray(history.days)) {
				await writeFile(historyPath, historyText, "utf8");
				historyDays = history.days.length;
			}
		} catch {}
	}
	if (trendsResult.status === "fulfilled" && trendsResult.value.ok) {
		const trendsText = await trendsResult.value.text();
		try {
			const trends = JSON.parse(trendsText);
			if (Array.isArray(trends.trends)) await writeFile(trendsPath, trendsText, "utf8");
		} catch {}
	}
	if (verificationResult.status === "fulfilled" && verificationResult.value.ok) {
		const verificationText = await verificationResult.value.text();
		try {
			const verification = JSON.parse(verificationText);
			if (verification.plugins && typeof verification.plugins === "object" && !Array.isArray(verification.plugins)) await writeFile(verificationPath, verificationText, "utf8");
		} catch {}
	}
	return {
		fetchedAt: registry.meta?.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
		count: registry.plugins.length,
		historyDays,
		updated: true
	};
}
/** Reads the current registry after a successful sync for callers that need its metadata. */
async function readSyncedRegistry(cachePath) {
	return JSON.parse(await readFile(cachePath, "utf8"));
}
//#endregion
export { syncRegistry as n, syncRegistryIfStale as r, readSyncedRegistry as t };

//# sourceMappingURL=sync-D9C87_rh.mjs.map