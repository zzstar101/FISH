import { useCallback, useState } from 'react'

/**
 * 本地隐藏名单（#323 R1）。
 *
 * R1 **没有**服务端隐藏接口（持久化归后续 R），所以「不感兴趣」只做本地过滤：
 * 再次加载 feed 时把名单里的 listing 从列表里去掉。TTL 180 天，和会话标识一致。
 */
const HIDDEN_STORAGE_KEY = 'fish.recommendation.hiddenListings'
const HIDDEN_TTL_MS = 180 * 24 * 60 * 60 * 1_000

type HiddenStore = { ids: string[]; expiresAt: number }

function readStore(): HiddenStore | null {
  try {
    const raw = window.localStorage.getItem(HIDDEN_STORAGE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    if (!('ids' in parsed) || !('expiresAt' in parsed)) return null
    const { ids, expiresAt } = parsed
    if (!Array.isArray(ids) || typeof expiresAt !== 'number' || expiresAt <= Date.now()) return null
    return { ids: ids.filter((id): id is string => typeof id === 'string'), expiresAt }
  } catch {
    return null
  }
}

/** 读取本地隐藏名单；没有或已过期就是空集合。 */
export function readHiddenListingIds(): ReadonlySet<string> {
  return new Set(readStore()?.ids ?? [])
}

/** 把商品加入本地隐藏名单。 */
export function hideListingLocally(listingId: string): void {
  const existing = readStore()?.ids ?? []
  if (existing.includes(listingId)) return

  try {
    const value: HiddenStore = {
      ids: [...existing, listingId],
      expiresAt: Date.now() + HIDDEN_TTL_MS,
    }
    window.localStorage.setItem(HIDDEN_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // 写不进去只影响下次加载的过滤，本次仍会立刻从列表移除。
  }
}

/** 隐藏名单 + 隐藏动作；隐藏后状态立刻更新，不用等接口返回。 */
export function useHiddenListings(): {
  hiddenIds: ReadonlySet<string>
  hideListing: (listingId: string) => void
} {
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => readHiddenListingIds())

  const hideListing = useCallback((listingId: string) => {
    hideListingLocally(listingId)
    setHiddenIds((current) => new Set(current).add(listingId))
  }, [])

  return { hiddenIds, hideListing }
}
