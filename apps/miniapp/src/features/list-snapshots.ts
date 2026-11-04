// Storage is untrusted input; disable Zod JIT before importing contracts on WeChat.
import '@/lib/zod-jitless'
import { MyFavoritesResponseSchema } from '@fish/contracts/favorites/schema'
import { transactionListResponseSchema } from '@fish/contracts/transactions/schema'
import Taro from '@tarojs/taro'

/** Display-only snapshots: never read by auth or transaction authorization. */
export const SNAPSHOT_TTL_MS = 5 * 60 * 1000
export const SNAPSHOT_MAX_BYTES = 256 * 1024
const SCOPES = ['buyer', 'seller', 'favorites'] as const
export type SnapshotScope = (typeof SCOPES)[number]
type Storage = {
  get: (key: string) => unknown
  set: (key: string, value: string) => void
  remove: (key: string) => void
}
type Owner = { account: string | null | undefined; epoch: number }
export type SnapshotTicket = Owner & { scope: SnapshotScope; revision: number; request: number }

function parseData(scope: SnapshotScope, data: unknown, account: string) {
  if (typeof data !== 'object' || data === null) return null
  const value = data as Record<string, unknown>
  if (!Array.isArray(value.items) || value.items.length > (scope === 'favorites' ? 200 : 500))
    return null
  if (scope === 'favorites') {
    const parsed = MyFavoritesResponseSchema.safeParse({ ...value, nextCursor: null })
    return parsed.success ? { items: parsed.data.items, total: parsed.data.total } : null
  }
  if (typeof value.truncated !== 'boolean') return null
  const parsed = transactionListResponseSchema.safeParse({ items: value.items, nextCursor: null })
  if (
    !parsed.success ||
    parsed.data.items.some(
      (item) =>
        item.role !== scope || (scope === 'buyer' ? item.buyerId : item.sellerId) !== account,
    )
  )
    return null
  return { items: parsed.data.items, truncated: value.truncated }
}

type ParsedData = NonNullable<ReturnType<typeof parseData>>
export type OrdersSnapshot = Extract<ParsedData, { truncated: boolean }>
export type FavoritesSnapshot = Extract<ParsedData, { total: number }>

/** Fixed three keys, only the current account; no tokens, cookies or meetup credentials. */
export function createListSnapshots(storage: Storage, now = Date.now) {
  let account: Owner['account']
  let epoch = 0
  const revisions = { buyer: 0, seller: 0, favorites: 0 }
  const requests = { buyer: 0, seller: 0, favorites: 0 }
  const mutations = { buyer: 0, seller: 0, favorites: 0 }
  const blocked = new Set<SnapshotScope>()
  const key = (scope: SnapshotScope) => `fish:list-snapshot:${scope}`
  const remove = (scope: SnapshotScope) => {
    try {
      storage.remove(key(scope))
    } catch {
      // Some hosts fail removal but still allow replacement. Never let this abort logout.
      try {
        storage.set(key(scope), '')
      } catch {
        /* best effort */
      }
    }
  }
  const owner = (): Owner => ({ account, epoch })
  const isOwner = (value: Owner) =>
    typeof account === 'string' && value.account === account && value.epoch === epoch
  const isCurrent = (ticket: SnapshotTicket) =>
    isOwner(ticket) &&
    mutations[ticket.scope] === 0 &&
    ticket.revision === revisions[ticket.scope] &&
    ticket.request === requests[ticket.scope]

  function syncAccount(next: Owner['account']) {
    if (next === account) return
    const previous = account
    account = next
    epoch += 1
    for (const scope of SCOPES) {
      revisions[scope] += 1
      mutations[scope] = 0
      // On first authoritative restoration retain only that account's valid records.
      if (previous === undefined && typeof next === 'string') {
        read(scope, next)
      } else {
        blocked.add(scope)
        remove(scope)
      }
    }
  }

  function read<S extends SnapshotScope>(
    scope: S,
    userId: string | null,
  ): (S extends 'favorites' ? FavoritesSnapshot : OrdersSnapshot) | null {
    if (!userId || account !== userId || blocked.has(scope)) return null
    try {
      const raw = storage.get(key(scope))
      // 3 bytes per UTF-16 code unit bounds UTF-8 bytes, including surrogate pairs.
      if (typeof raw !== 'string' || raw.length * 3 > SNAPSHOT_MAX_BYTES) {
        remove(scope)
        return null
      }
      const record = JSON.parse(raw)
      if (
        record?.version !== 1 ||
        record.account !== userId ||
        record.scope !== scope ||
        !Number.isFinite(record.savedAt) ||
        now() < record.savedAt ||
        now() - record.savedAt >= SNAPSHOT_TTL_MS
      ) {
        remove(scope)
        return null
      }
      const data = parseData(scope, record.data, userId)
      if (!data) remove(scope)
      return data as (S extends 'favorites' ? FavoritesSnapshot : OrdersSnapshot) | null
    } catch {
      remove(scope)
      return null
    }
  }

  function begin(scope: SnapshotScope, userId: string | null): SnapshotTicket | null {
    if (!userId || account !== userId) return null
    requests[scope] += 1
    return { ...owner(), scope, revision: revisions[scope], request: requests[scope] }
  }

  function write(ticket: SnapshotTicket, value: unknown): boolean {
    if (!isCurrent(ticket) || typeof account !== 'string') return false
    try {
      const data = parseData(ticket.scope, value, account)
      if (!data) return false
      const raw = JSON.stringify({ version: 1, account, scope: ticket.scope, savedAt: now(), data })
      // A larger fresh response must not leave an older, misleading snapshot on disk.
      blocked.add(ticket.scope)
      remove(ticket.scope)
      if (raw.length * 3 > SNAPSHOT_MAX_BYTES) return false
      storage.set(key(ticket.scope), raw)
      blocked.delete(ticket.scope)
      return true
    } catch {
      return false
    }
  }

  function invalidate(value: Owner, scopes: readonly SnapshotScope[]) {
    if (!isOwner(value)) return
    for (const scope of scopes) {
      revisions[scope] += 1
      blocked.add(scope)
      remove(scope)
    }
  }

  /** Fence reads across the entire write, not only its successful response. */
  function startMutation(scopes: readonly SnapshotScope[]) {
    const captured = owner()
    if (!isOwner(captured)) return () => {}
    for (const scope of scopes) mutations[scope] += 1
    invalidate(captured, scopes)
    let finished = false
    return () => {
      if (finished || !isOwner(captured)) return
      finished = true
      for (const scope of scopes) mutations[scope] -= 1
      // Retire requests started during the write, including a failed/ambiguous write.
      invalidate(captured, scopes)
    }
  }

  return {
    syncAccount,
    read,
    begin,
    write,
    owner,
    isOwner,
    isCurrent,
    invalidate,
    startMutation,
    revision: (scope: SnapshotScope) => `${epoch}:${revisions[scope]}`,
  }
}

export const listSnapshots = createListSnapshots({
  get: (key) => Taro.getStorageSync(key),
  set: (key, value) => Taro.setStorageSync(key, value),
  remove: (key) => Taro.removeStorageSync(key),
})
