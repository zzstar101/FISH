/**
 * 「不感兴趣」的本地隐藏名单（Issue #323 R1 §3.6）。
 *
 * R1 **没有**服务端隐藏接口（本期的范围是归因与埋点契约），所以隐藏只做两件事：
 * 立刻从当前列表移除、把 id 记进本地名单，下次加载 Feed 时过滤掉。
 * 不假装有服务端状态，也就不会出现「下次刷新又冒出来」的观感落差。
 */
import Taro from '@tarojs/taro'

/** 存储 key：规格固定值，不要改名 */
const HIDDEN_KEY = 'fish.recommendation.hiddenListings'

/** 名单有效期：180 天，与匿名会话同量级；过期自动失效，不让本地无限长胖 */
const HIDDEN_TTL_MS = 180 * 24 * 60 * 60 * 1000

type StoredHidden = { ids: string[]; expiresAt: number }

function readStoredHidden(): string[] {
  try {
    const raw: unknown = Taro.getStorageSync(HIDDEN_KEY)
    if (typeof raw !== 'object' || raw === null) return []
    const candidate = raw as { ids?: unknown; expiresAt?: unknown }
    if (!Array.isArray(candidate.ids)) return []
    if (typeof candidate.expiresAt !== 'number' || candidate.expiresAt <= Date.now()) return []
    return candidate.ids.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

function writeStoredHidden(ids: string[]): void {
  const stored: StoredHidden = { ids, expiresAt: Date.now() + HIDDEN_TTL_MS }
  try {
    Taro.setStorageSync(HIDDEN_KEY, stored)
  } catch {
    /* 存储失败不致命：本次列表内的移除已经生效 */
  }
}

/** 当前隐藏名单（加载 Feed 时用它过滤） */
export function readHiddenListingIds(): string[] {
  return readStoredHidden()
}

/** 记一次「不感兴趣」；重复隐藏同一件商品只保留一份 */
export function hideListing(listingId: string): void {
  const ids = readStoredHidden()
  if (ids.includes(listingId)) return
  writeStoredHidden([...ids, listingId])
}
