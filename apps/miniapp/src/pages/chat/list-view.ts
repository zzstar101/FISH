import type { ConversationDto } from '@fish/contracts/chat/schema'
import { formatAmount } from '@/lib/money'
import { localDayIndex, WEEKDAY } from '@/lib/time'

/**
 * 会话列表的取数与渲染逻辑（#89：Chat 页从 fixture 改为真实 `GET /conversations`）。
 *
 * 为什么抽成纯函数：首页那套状态机（`pages/home/list-state.ts`）因为「失败假空态」
 * 一类缺陷被独立审查连续抓到三次，抽出来之后每种组合都有用例锁住。会话列表有同一类
 * 风险 —— 「没读到」与「恰好没有会话」在界面上长得一样 —— 所以用同一手法：
 * 判定只看事实，组件只做渲染。
 */

/** 会话列表该渲染哪一种形态 */
export type ChatListState = 'loading' | 'error' | 'empty' | 'list'

/**
 * 当前该渲染哪种形态。优先级（与组件 render 分支一致）：
 * 1. `failed` → 错误态。「加载不出来」不是「恰好没有会话」，必须先于一切；
 * 2. `!ready` → 加载态。首次进页 / 重试在途都还没拿到结果，此时显示空态等于
 *    在说「你没有会话」；
 * 3. 会话数为 0 → 空态。只有**成功拿到空列表**才能下这个结论。
 */
export function chatListState(input: {
  /** 是否已经拿到过一次结果（成功或失败都算「有结果」） */
  ready: boolean
  /** 生产口径的真实接口失败（且没有回退 mock） */
  failed: boolean
  itemCount: number
}): ChatListState {
  if (input.failed) return 'error'
  if (!input.ready) return 'loading'
  return input.itemCount === 0 ? 'empty' : 'list'
}

/** 会话还没有任何消息时的预览占位（契约：此时 `lastMessage` 为 null） */
export const EMPTY_PREVIEW = '还没有消息，打个招呼吧'

/**
 * 角标数字的显示上限：超过 99 一律显示 `99+`。
 *
 * 1版稿的角标是窄胶囊，三四位数字会把行高与宽度撑变形；而且未读本来就是「有多少」
 * 的提示而非精确账目。注意这只是**显示**口径 —— 求和本身是多少仍然照算。
 */
const BADGE_MAX = 99

export function badgeText(count: number): string {
  return count > BADGE_MAX ? '99+' : String(count)
}

/**
 * 会话行的消息预览。
 *
 * 交易类 SYSTEM 消息的 `content` 是契约里的 JSON 原文
 * （`{"type":"tx.proposal","amountCents":15000}` / `tx.accepted` / `tx.rejected`），
 * 列表里必须翻成中文，不能把 JSON 直接显示出来；解析失败（普通文本的系统消息，
 * 例如「你的学号认证已通过…」）按原文降级。
 */
export function previewOf(item: ConversationDto): string {
  const last = item.lastMessage
  if (!last) return EMPTY_PREVIEW
  if (last.type !== 'SYSTEM') return last.content

  try {
    const event: unknown = JSON.parse(last.content)
    if (event && typeof event === 'object' && 'type' in event) {
      const type = (event as { type: unknown }).type
      if (type === 'tx.proposal') {
        const amount = (event as { amountCents?: unknown }).amountCents
        return typeof amount === 'number'
          ? `买家发起交易确认 · ¥${formatAmount(amount)}，待确认`
          : '买家发起交易确认，待确认'
      }
      if (type === 'tx.accepted') return '交易已确认 · 约定面交中'
      if (type === 'tx.rejected') return '卖家已拒绝本次议价'
    }
  } catch {
    // 不是 JSON：按普通文本渲染
  }
  return last.content
}

/**
 * 会话行的时间文案。口径对齐 1版稿 fixture 里出现过的词表：
 * 刚刚 / N 分钟前 / 今天 / 昨天 / 周X / M 月 D 日。
 *
 * `nowMs` 由调用方传入（不在这里取 `Date.now()`）：否则这个函数没法测，
 * 而且同一屏里每行取一次「现在」会算出互相矛盾的结果。
 */
export function conversationTimeLabel(iso: string, nowMs: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''

  const diff = Math.max(0, nowMs - then)
  // 未来时间戳（两端时钟偏差）被夹到 0 → 走「刚刚」，不会出现「-3 分钟前」
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`

  const days = localDayIndex(nowMs) - localDayIndex(then)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `周${WEEKDAY[new Date(then).getDay()]}`

  const date = new Date(then)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/** `loadConversations` 一页的形态（与 `@/features/fetchers` 的 `LoadedConversations` 同形） */
export type LoadedConversationPage = {
  items: ConversationDto[]
  /** null = 已经到底 */
  nextCursor: string | null
  failed: boolean
}

/** 返回刷新取到的窗口。三种结局分开，因为调用方对它们的处置完全不同。 */
export type RefreshedConversationWindow =
  /** 窗口完整取到（或服务端已经到底） */
  | { kind: 'ok'; items: ConversationDto[]; nextCursor: string | null }
  /** 第一页就没拿到：按「整页重载失败」处理 —— 清屏进错误态 */
  | { kind: 'first-page-failed' }
  /** 第一页拿到了、更早的页失败：已刷新的部分可用，只在尾部提示重试 */
  | { kind: 'tail-failed'; items: ConversationDto[]; nextCursor: string | null }

/**
 * 从会话页返回时的刷新窗口（#67 第三步）：**重取已经加载过的那几页**。
 *
 * 为什么抽成纯函数：这里是「重取几页 + 第一页失败与后续页失败处置不同」的分支逻辑，
 * 而组件本身没有渲染基建可测 —— 与上面几个判定同一个理由。取数由调用方注入，
 * 所以这里不依赖 `@/features/fetchers`。
 *
 * 目标是**刷新**而不是**换一批数据**：翻到第 N 页的用户从会话页返回时，只该看到
 * 内容变新（角标清零、`lastMessage` 更新、顺序按服务端重排），不该被打回第一页。
 * 所以按已加载条数续取，直到覆盖住原有窗口。
 *
 * 注意 `loadedCount` 是「返回前屏幕上有多少条」，不是「要多少条」—— 只有它大于一页
 * 时才真的会多取几页。
 */
export async function refreshConversationWindow(
  /** 取一页（不传游标 = 第一页） */
  loadPage: (cursor?: string) => Promise<LoadedConversationPage>,
  /** 返回前屏幕上已有的条数 */
  loadedCount: number,
): Promise<RefreshedConversationWindow> {
  const items: ConversationDto[] = []
  let cursor: string | undefined
  // 至少取一页：loadedCount 为 0（空列表 / 首屏还没加载完）时也要拿到最新的第一页
  for (;;) {
    const page = await loadPage(cursor)
    if (page.failed) {
      if (items.length === 0) return { kind: 'first-page-failed' }
      // `cursor` 仍指向失败的那一页 —— 尾部重试从这里续上
      return { kind: 'tail-failed', items, nextCursor: cursor ?? null }
    }
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
    if (!cursor || items.length >= loadedCount) break
  }
  return { kind: 'ok', items, nextCursor: cursor ?? null }
}

/**
 * 底栏「会话未读」分量的取值（#67 R5）。
 *
 * 三种输入必须区分开，混起来就是一次误熄红点：
 * - `aggregate` 有值 → 服务端全量聚合，权威，直接用；
 * - `aggregate` 为 `null`（请求失败 / 还没回来）→ 只能退回本页求和，而本页可能**只加载了
 *   一页**（`windowComplete === false`）：
 *   - 求和 > 0 → 是**下界**，足以点亮红点，照发；
 *   - 求和 = 0 且窗口完整（服务端已到底）→ 0 是**确定结论**，可以发；
 *   - 求和 = 0 但窗口不完整 → 第 51 条会话可能还有未读，这时发 0 会覆盖掉上一份正确的
 *     正数、把底栏红点熄灭 —— 发 `null`（「不知道」），订阅方按规则保持上一帧。
 *
 * 修复前的写法是 `unreadTotal ?? conversationUnread`：聚合一失败就退回求和，求和恰好是 0
 * 时就发布了 `conversations: 0`，把已知的未读抹掉。
 */
export function conversationUnreadForBadge(input: {
  /** 服务端聚合值；`null` = 还不知道 */
  aggregate: number | null
  /** 当前已加载窗口的未读求和（下界） */
  windowSum: number
  /** 已加载窗口是否已覆盖到服务端末尾（`nextCursor === null`） */
  windowComplete: boolean
}): number | null {
  if (input.aggregate !== null) return input.aggregate
  if (input.windowSum > 0) return input.windowSum
  return input.windowComplete ? 0 : null
}

/**
 * 「全部已读」的结果归并（#67 R4）。
 *
 * 只把**服务端真的标成功**的那些会话在本地清零：`POST /conversations/:id/read` 是逐条的，
 * 部分失败时把整批都清零就是谎报已读。`missed` 用于如实提示还差几个。
 *
 * 为什么抽出来：这是「哪些 id 算已读」的判据，留在 `index.tsx` 里就没有用例能变红
 * —— 与 `refreshConversationWindow` 同一个理由。
 */
export function markAllReadOutcome(input: {
  unreadIds: readonly string[]
  results: readonly PromiseSettledResult<unknown>[]
}): { readIds: ReadonlySet<string>; missed: number } {
  const readIds = new Set(
    input.unreadIds.filter((_, index) => input.results[index]?.status === 'fulfilled'),
  )
  return { readIds, missed: input.unreadIds.length - readIds.size }
}

/**
 * 一次未读聚合取数的结果是否还该落地（#67 R4）。
 *
 * 重取（进页 / 从会话页返回 / 已读落定后）与身份切换都会让代次前进；旧响应迟到时
 * 必须**整份丢弃**：一份「标记已读之前」发出的响应会把刚拿到的 0 盖回旧的正数，
 * 底栏红点明明该熄却又亮起来（反之也会把刚涨上去的数字盖回旧值）。
 */
export function isLatestUnreadFetch(token: number, latest: number): boolean {
  return token === latest
}
