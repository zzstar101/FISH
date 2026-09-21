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
