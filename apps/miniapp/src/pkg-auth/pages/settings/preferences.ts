import type { MockSettings, ThemeMode } from '@/mock/types'

/**
 * 设置页偏好项的本机持久化（纯函数部分）。
 *
 * 页面把偏好落 `Taro.setStorageSync`（`BLOCKED: #66`，不写后端），本模块负责
 * **读回**：挂载时把存过的值合并到默认值上，persist 时把存量与增量合并。
 * `Taro.getStorageSync` 只能在端上跑，所以解析/校验抽在这里单测
 * （与 `pages/feedback/draft.ts` 的 `parseFeedbackDraft` 同一口径）。
 *
 * 只认清单内的键与类型：存储损坏、写了垃圾值时**按字段丢弃**、回默认值，
 * 不整份丢（用户改过的开关比整份默认值值钱），也不让垃圾值上屏。
 */

export const SETTINGS_STORAGE_KEY = 'fish:settings'

/** `ThemeMode` 的全部取值（存储里是无类型字符串，读回要认一遍） */
const THEME_KEYS: readonly ThemeMode[] = ['system', 'light', 'dark']

/** 「谁可以给我留言」的三个档位（页面 ActionSheet 的选项与此同源） */
export const COMMENT_POLICIES = ['已认证用户', '所有人', '仅好友'] as const

/** 从存储读出的合法偏好（只含认得出的键） */
export type StoredPrefs = Partial<MockSettings>

const isThemeMode = (value: unknown): value is ThemeMode =>
  typeof value === 'string' && (THEME_KEYS as readonly string[]).includes(value)

const isCommentPolicy = (value: unknown): value is MockSettings['commentPolicy'] =>
  typeof value === 'string' && (COMMENT_POLICIES as readonly string[]).includes(value)

/**
 * 存储原始值 → 合法偏好。
 *
 * weapp 的 `getStorageSync` 原样返回存进去的对象；H5 形态返回 JSON 字符串
 * （同 `parseFeedbackDraft` 的坑）。两形态都收，其余（空串 / null / 数组 /
 * 坏 JSON）一律视为「没存过」。
 */
export function readStoredPrefs(raw: unknown): StoredPrefs {
  let source: unknown = raw
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source)
    } catch {
      return {}
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
  const stored = source as Record<string, unknown>
  const prefs: StoredPrefs = {}
  if (isThemeMode(stored.theme)) prefs.theme = stored.theme
  for (const key of ['notifyChat', 'notifyWish', 'notifyDeal', 'notifyNews'] as const) {
    const value: unknown = stored[key]
    if (typeof value === 'boolean') prefs[key] = value
  }
  if (isCommentPolicy(stored.commentPolicy)) prefs.commentPolicy = stored.commentPolicy
  return prefs
}

/** 挂载时的初始偏好：存量偏好盖在默认值上 */
export function parseStoredPrefs(raw: unknown, defaults: MockSettings): MockSettings {
  return { ...defaults, ...readStoredPrefs(raw) }
}
