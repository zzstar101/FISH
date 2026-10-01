/**
 * 「我的关注」的取数口径与列表行形状（纯函数，不读构建开关之外的运行时、不 import Taro）。
 *
 * ## 两种构建，两条路
 *
 * - `demo`（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`）：照设计稿摆演示名单
 *   （`./demo.ts`），页面上另有「演示数据」说明行，用户能辨认这不是 TA 的真实关注。
 *   只看 `MOCK_FALLBACK_ENABLED` 会把 `dev:weapp` 的日常开发也顶成演示态，所以必须两个都开。
 * - `live`（其它一切情况，含 `dev:weapp` 与生产）：`GET /me/following` 真接口。
 *   真实有数据 → 列表；真实无数据 → 空态；请求失败 → 错误态 + 重试。**生产不退演示**。
 *
 * 本模块只放**纯**的部分（模式判定、行映射、翻页合并），请求在 `./api.ts`、状态机在页面里。
 * 这样「哪种开关得到哪条路」「两页怎么合并」能被 `bun test` 直接锁住，不需要渲染组件。
 */
import type { FollowedUser, MyFollowingResponse } from '@fish/contracts/follows/schema'
import { FOLLOW_DEMO, type FollowingPerson } from './demo'
import { followingStatsOf } from './stats'

/**
 * 列表行：页面渲染的**唯一**形状，演示态与真实态都映射到它。
 *
 * 演示稿里的 `bio`（个性签名）与 `seenLabel`（最近活跃）在真实数据面**没有来源**：
 * - 签名由 #179 承接，follows 的公开投影（#188）只出 `昵称 / 头像 / 认证状态`，没有签名字段；
 * - 「最近活跃」没有已冻结的服务端口径（Owner 未拍板），本单**不做**这一行。
 * 所以真实行这两项恒为空串、页面整行不渲染 —— 用字段存在与否表达「有没有这个数据」，
 * 而不是渲染一句占位文案。
 */
export type FollowingRow = {
  id: string
  nickname: string
  /** 真实头像 URL；`null` = 没有图（退昵称首字）。 */
  avatarUrl: string | null
  /** 演示占位色块（data URI）。真实行恒为空串（它与首字是两层，见 `demo.ts` 的说明）。 */
  placeholderBlock: string
  /** 已认证：行内渲染认证勾，未认证整块不占位。 */
  verified: boolean
  /** 互相关注（双向关系）；服务端真值。 */
  mutual: boolean
  /** 个性签名（演示稿字段）；真实行空串。 */
  bio: string
  /** 最近活跃（演示稿字段）；真实行空串。 */
  seenLabel: string
}

/** 真实行：公开投影只有 `id / nickname / avatarUrl / authStatus`，`mutual` 是服务端真值。 */
export function dtoRow(dto: FollowedUser): FollowingRow {
  return {
    id: dto.id,
    nickname: dto.nickname,
    avatarUrl: dto.avatarUrl,
    placeholderBlock: '',
    verified: dto.authStatus === 'VERIFIED',
    mutual: dto.mutual,
    bio: '',
    seenLabel: '',
  }
}

/** 演示行：稿里的三样（色块 / 签名 / 最近活跃）都在，`avatarUrl` 空着（它只是占位色块）。 */
export function demoRow(person: FollowingPerson): FollowingRow {
  return {
    id: person.id,
    nickname: person.nickname,
    avatarUrl: null,
    placeholderBlock: person.placeholderBlock,
    verified: person.verified,
    mutual: person.mutual,
    bio: person.bio,
    seenLabel: person.seenLabel,
  }
}

/** 是否演示构建。两个开关缺一不可（口径与「我的」页 `loadProfile` 的回退一致）。 */
export function isFollowingDemo(mockFallback: boolean, demoAuth: boolean): boolean {
  return mockFallback && demoAuth
}

/** 取数模式：演示构建摆 fixture，其余一律真接口（**含生产**）。 */
export function followingMode(mockFallback: boolean, demoAuth: boolean): 'demo' | 'live' {
  return isFollowingDemo(mockFallback, demoAuth) ? 'demo' : 'live'
}

/** 加载完成后的列表状态（页面据此渲染列表 / 空态 / 分页脚）。 */
export type FollowingReady = {
  kind: 'ready'
  rows: FollowingRow[]
  /** 我关注的总人数（服务端全量计数；演示态取 fixture 现算）。 */
  total: number
  /** 互关人数（同上）。 */
  mutualTotal: number
  /** 服务端游标：`null` 才是到底（不能用「这一页不满」推断）。 */
  nextCursor: string | null
  /** 演示态标记：页面据此显示演示说明行，并据此决定行点击走演示 toast 还是真实导航。 */
  demo: boolean
}

/** 演示态：照稿的 5 个人；计数由同一份列表现算（不另写死 5 / 2）。 */
export function demoReady(): FollowingReady {
  const stats = followingStatsOf(FOLLOW_DEMO)
  return {
    kind: 'ready',
    rows: FOLLOW_DEMO.map(demoRow),
    total: stats.count,
    mutualTotal: stats.mutual,
    nextCursor: null,
    demo: true,
  }
}

/**
 * 追加一页。**按 id 去重**：翻页期间如果有人排到了列表前面，朴素 concat 会让同一行出现两次
 * （游标分页按 `(created_at, id)` 取，新关注的人是插在最前面、不会挤进已取过的区间，
 * 但去重是不用推理游标语义也成立的那道保险）。
 *
 * `nextCursor` / 计数取**服务端最新的一次**，不沿用上一页：关注 / 取关之后计数会变，
 * 沿用旧值会让页面顶部显示一个过期的人数。
 */
export function mergeFollowingPage(
  current: FollowingReady,
  page: MyFollowingResponse,
): FollowingReady {
  const seen = new Set(current.rows.map((row) => row.id))
  const fresh = page.items.map(dtoRow).filter((row) => !seen.has(row.id))
  return {
    ...current,
    rows: [...current.rows, ...fresh],
    nextCursor: page.nextCursor,
    total: page.total,
    mutualTotal: page.mutualTotal,
  }
}

/**
 * 从列表里移除一个人后的状态（本人关注页上的「取关」成功后调用）。
 *
 * `total` 减一，`mutualTotal` 按被移除那行的 `mutual` 决定要不要减 —— 这两个数字在
 * 页面上就是「关注 N 人 · 互粉 M 人」，本地删除后不跟着改就会当场自相矛盾。
 */
export function removeFollowingRow(current: FollowingReady, id: string): FollowingReady {
  const target = current.rows.find((row) => row.id === id)
  if (!target) return current
  return {
    ...current,
    rows: current.rows.filter((row) => row.id !== id),
    total: Math.max(0, current.total - 1),
    mutualTotal: target.mutual ? Math.max(0, current.mutualTotal - 1) : current.mutualTotal,
  }
}

/**
 * 演示态读取的模拟延迟（毫秒），与 `src/mock/api.ts` 的 `LATENCY` 同口径。
 *
 * 只用于演示分支：那里的数据本来就是 fixture，走一点延迟才能让骨架屏（稿第 04 帧）
 * 在评审时看得见。**真实分支不加延迟** —— 那是在演一个不存在的读取过程。
 */
export const FOLLOW_DEMO_LATENCY_MS = 120
