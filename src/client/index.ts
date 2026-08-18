/**
 * dsh-recommend browser 半：设置页「插件排行」标签（M2 已接入数据供给，M3 增加
 * 历史趋势 + 一键刷新 + 一键安装 + 已装检测）。
 *
 * 装载链（M2 实测结论，回填 ADR-0003）：第三方 bundle 声明 dsh.client 后，
 * 官方 client-modules 的 node 半扫描 loader 条目中的 dsh.client 声明，把
 * exports["./client"] 的构建产物以 /plugins/<id>/client.js 动态供给浏览器；
 * 数据经 host 半注册的同源路由拉取（registry.json / history.json，无跨域、
 * 无 Remote 白名单依赖）；「刷新数据」走同源 POST /dsh-recommend/sync；
 * 「一键安装」走同源 POST /dsh-recommend/install（spec 由 host 构造）；
 * 已装检测经官方 pluginInventory Remote（ctx.remote.pluginInventory.list()）。
 */
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { RankingsTab, type HistoryDoc, type InstallResult, type RankingsTabInjected, type RegistryDoc, type UpdatePolicy, type UpdateResult, type UpdateStatus } from './RankingsTab.tsx'
import { en, zh, type RankingsLocaleKey } from './locales.ts'

export type { HistoryDoc, InstallResult, RankingsTabInjected, RankingsTabProps, RegistryDoc, UpdatePolicy, UpdateResult, UpdateStatus } from './RankingsTab.tsx'
export type { RankingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-recommend 排行标签文案。 */
    'dshRecommend': RankingsLocaleKey
  }
}

/** 本插件拥有的字典命名空间。 */
export const NS = 'dshRecommend'

/** 设置页注册所需的客户端服务（remote 用于已装检测）。 */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginInventory']

/** 向「插件」设置分区贡献「插件排行」标签。 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-recommend: dictionaries')

  const t = ctx.locale.bind(NS)
  const injected = (): RankingsTabInjected => ({
    loadRankings: async (): Promise<RegistryDoc> => {
      const res = await fetch('/dsh-recommend/registry.json', { cache: 'no-store' })
      if (!res.ok) {
        throw new Error(`registry 路由 ${res.status}（先调用 sync_registry）`)
      }
      return res.json()
    },
    loadHistory: async (): Promise<HistoryDoc> => {
      const res = await fetch('/dsh-recommend/history.json', { cache: 'no-store' })
      if (!res.ok) {
        throw new Error(`history 路由 ${res.status}`)
      }
      return res.json()
    },
    refreshRankings: async (): Promise<{ fetchedAt: string; count: number }> => {
      const res = await fetch('/dsh-recommend/sync', { method: 'POST' })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.ok) {
        throw new Error(body?.error ?? `sync 路由 ${res.status}`)
      }
      return { fetchedAt: body.fetchedAt, count: body.count }
    },
    listInstalled: async (): Promise<string[]> => {
      const result = await ctx.remote.pluginInventory.list()
      if (!result.ok) {
        throw new Error(`pluginInventory.list failed: ${result.error.code}: ${result.error.message}`)
      }
      // moduleName 形如 dsh-better-sidebar 或 @scope/pkg；返回裸名供模糊匹配
      return result.value.entries.map((e) => e.moduleName)
    },
    installPlugin: async (fullName: string): Promise<InstallResult> => {
      const res = await fetch('/dsh-recommend/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fullName }),
      })
      const data = (await res.json()) as InstallResult & { error?: string }
      if (!res.ok) return { ok: false, message: data.error ?? `HTTP ${res.status}` }
      return data
    },
    loadUpdates: async (): Promise<UpdateStatus> => {
      const res = await fetch('/dsh-recommend/updates', { cache: 'no-store' })
      const data = (await res.json()) as UpdateStatus & { ok?: boolean; error?: string }
      if (!res.ok || data.ok === false) throw new Error(data.error ?? `updates 路由 ${res.status}`)
      return data
    },
    updatePlugin: async (packageName: string): Promise<UpdateResult> => {
      const res = await fetch('/dsh-recommend/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packageName }),
      })
      const data = (await res.json()) as UpdateResult & { error?: string }
      if (!res.ok) return { ok: false, message: data.error ?? `HTTP ${res.status}` }
      return data
    },
    saveUpdatePolicy: async (policy: UpdatePolicy): Promise<UpdatePolicy> => {
      const res = await fetch('/dsh-recommend/update-policy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(policy),
      })
      const data = (await res.json()) as { ok?: boolean; policy?: UpdatePolicy; error?: string }
      if (!res.ok || !data.ok || !data.policy) throw new Error(data.error ?? `update-policy 路由 ${res.status}`)
      return data.policy
    },
  })

  ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'rankings',
    order: 20,
    label: () => t('tab'),
    locale: NS,
    inject: injected,
  }, RankingsTab))
}
