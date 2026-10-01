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
 * 端上重算「现在」的间隔（#376 审查回合，P2）：`PRESENCE_ONLINE_TTL_MS / 2`。
 *
 * 为什么必须有这个时钟：上面那段本地过期判据只在**重算的那一刻**才成立。他人主页与
 * 商品详情都是「进页拉一次资料」，之后没有任何请求能让页面重新渲染 —— `Date.now()`
 * 只在首帧被求值一次，对方断线后绿点会一直挂着。这两页又没有别的时钟可搭车
 * （会话页有 20s 轮询，不进这个 hook），所以间隔本身就是「陈旧绿点能存活多久」的上界。
 *
 * 为什么是 TTL 的一半而不是随便定一个 30s：取半之后，绿点最多比真实过期晚**半个
 * TTL**熄灭（`PRESENCE_ONLINE_TTL_MS = 60s` → 30s）；再密一档买不到更多正确性 —— 离线
 * 文案的粒度是分钟（`relativeTimeOf`），这三处展示位也没有别的状态要跟着走；再疏一档
 * 则会让绿点比 TTL 晚一整个窗口以上才灭。常量与 TTL **同源**而不是各写一遍，TTL 若被
 * 契约调整时两边不会漂成「端上比服务端早 / 晚一个窗口」。
 *
 * 注意这里**不发任何请求**：服务端的那次判定不可能比 TTL 活得更久，端上只要把
 * 「现在」重新算一遍就能自己推翻它（见 `use-presence-now.ts`）。
 */
export const PRESENCE_TICK_MS = PRESENCE_ONLINE_TTL_MS / 2

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
