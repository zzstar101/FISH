import { PRESENCE_ONLINE_TTL_MS, type UserPresence } from '@fish/contracts/users/schema'
import { relativeTimeOf } from '@/lib/time'

/**
 * 在线态的展示口径（#359 第五点）—— 三处展示位（他人主页 / 聊天页顶部栏 / 商品详情卖家行）
 * 共用这一份，避免三处各写一套「在线 / 刚刚活跃 / 离线」的判据。
 *
 * ## 为什么端上还要自己判一次 TTL
 *
 * 服务端的 `online` 是**读取那一刻**的判定（口径：最近一次已认证活动在
 * `PRESENCE_ONLINE_TTL_MS` 窗口内）。页面拿到它之后可能一直挂在屏幕上不再请求
 * （他人主页、商品详情都是进页拉一次），几分钟后那个 `online: true` 就成了过期结论。
 * 契约明确要求客户端用**同一个常量**在本地过期，这里就是那一处实现：
 * `lastActiveAt` 越出窗口即按离线渲染，与服务端下一次读取的结论一致。
 *
 * ## 为什么返回 `null` 而不是兜底文案
 *
 * `presence` 缺失（老服务端 / fixture 兜底）时返回 `null`，由调用方**整块不渲染**——
 * 与「字段到位才渲染」的既有口径一致。把「拿不到」画成「离线」是在编造一个结论。
 */
export type PresenceView = {
  /** 这一刻是否按在线渲染（服务端判定 + 端上 TTL 过期后的结论） */
  online: boolean
  /** 绿点旁的文案：`在线` / `刚刚活跃` / `12 分钟前活跃` / `昨天活跃` / `离线` */
  text: string
}

/**
 * `nowMs` 由调用方传入（同 `lib/time.ts` 的约定）：同一屏多处渲染必须共用同一个「现在」，
 * 否则同一帧里两处会算出矛盾的结论。
 */
export function presenceView(
  presence: UserPresence | null | undefined,
  nowMs: number,
): PresenceView | null {
  if (!presence) return null

  if (presence.online) {
    // 有活动时刻才能判过期；缺失时刻（契约允许）时信服务端那一次判定，不自作主张翻成离线。
    const activeAt = presence.lastActiveAt === null ? null : Date.parse(presence.lastActiveAt)
    if (activeAt === null || Number.isNaN(activeAt)) return { online: true, text: '在线' }
    if (nowMs - activeAt < PRESENCE_ONLINE_TTL_MS) return { online: true, text: '在线' }
  }

  if (presence.lastActiveAt === null) return { online: false, text: '离线' }

  // `relativeTimeOf` 对非法时间戳返回空串：此时宁可说「离线」，也不拼出「活跃」这种半句话。
  const relative = relativeTimeOf(presence.lastActiveAt, nowMs)
  return relative === ''
    ? { online: false, text: '离线' }
    : { online: false, text: `${relative}活跃` }
}
