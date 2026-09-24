/**
 * 实时通道的纯函数部分（#67 第三步）：地址推导、重连退避、断档补齐。
 *
 * 与 `realtime.ts`（持有 socket / 定时器的有状态客户端）分开，是为了让这些判据
 * 能在 bun 测试里直接跑，不必 mock `@tarojs/taro`。
 */
import { REALTIME_WS_PATH } from '@fish/contracts/chat/routes'
import type { MessageDto } from '@fish/contracts/chat/schema'

/** 重连退避上限（与 Web 端 `apps/web/src/features/chat/realtime.ts` 同值） */
export const MAX_BACKOFF_MS = 30_000

/** 第 `attempt` 次重连前该等多久（attempt 从 0 起：1s、2s、4s… 封顶 30s） */
export function reconnectDelayMs(attempt: number): number {
  const step = Math.max(0, Math.floor(attempt))
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** step)
}

/**
 * 由 API 基地址推出 WS 地址。
 *
 * 小程序没有 Vite 那层代理，`API_BASE` 是绝对地址（`lib/api-base.ts`），
 * 协议按 http→ws / https→wss 换；末尾多余的 `/` 要去掉，否则会拼出 `//ws/chat`。
 */
export function realtimeUrl(apiBase: string): string {
  const wsBase = apiBase.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  return `${wsBase.replace(/\/+$/, '')}${REALTIME_WS_PATH}`
}

/** `loadMessagePage` 里补齐断档需要的三个字段 */
export type GapPage = {
  items: MessageDto[]
  nextCursor: string | null
  failed: boolean
}

/**
 * 重连后把断档补回来。
 *
 * 契约明确「推送不保证不重不漏，离线端重连后用历史端点补齐」，所以**不能只重取最新
 * 一页**就认为消息完整：断线时间一长，错过的消息会超过一页（契约单页上限 100 条），
 * 只取一页会在中间留一段永远补不上的空洞。
 *
 * 做法是从最新一页**往回翻**，直到某一页里出现了本地已有的消息 id —— 那说明已经
 * 接到本地窗口的前沿，再往前的内容本地本来就有。三个终止条件：
 * - 与 `knownIds` 有交集（接上了）；
 * - `nextCursor === null`（翻到了最早）；
 * - 页数到 `maxPages`（防止服务端游标异常时无限翻页）。
 *
 * `knownIds` 为空（首次加载、换号刚清完场）时只取一页：本地一条都没有，往回翻等于
 * 把整段历史重拉一遍，而首屏本来就只加载一页。
 *
 * 返回**升序**的合并结果（服务端每页内部升序、页与页之间越翻越早，所以反转页序拼起来
 * 就是全局升序）。不在这里排序：排序规则是契约的 `(createdAt, id)`，重复实现一份容易
 * 与 `pages/conversation/view.ts` 的 `sortMessages` 走样。
 */
export async function backfillMessageGap(
  loadPage: (before?: string) => Promise<GapPage>,
  knownIds: ReadonlySet<string>,
  options?: { maxPages?: number },
): Promise<MessageDto[]> {
  const maxPages = options?.maxPages ?? 10
  const pages: MessageDto[][] = []
  let cursor: string | undefined

  for (let index = 0; index < maxPages; index += 1) {
    const page = await loadPage(cursor)
    pages.push(page.items)
    // 这一页没读到：拿不到游标，继续翻只会把「没读到」当成「还有更早的」
    if (page.failed) break
    // 接上本地窗口的前沿：更早的历史本地已有，不必再翻
    if (knownIds.size > 0 && page.items.some((item) => knownIds.has(item.id))) break
    if (page.nextCursor === null) break
    // 本地一条都没有：取最新一页就够（见上方说明）
    if (knownIds.size === 0) break
    cursor = page.nextCursor
  }

  const out: MessageDto[] = []
  const seen = new Set<string>()
  for (const page of pages.reverse()) {
    for (const item of page) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      out.push(item)
    }
  }
  return out
}
