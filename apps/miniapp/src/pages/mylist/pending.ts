/**
 * 「待确认」段的数据来源：从**卖家自己的会话**里推导「谁在等我点头」。
 *
 * ## 为什么必须绕这一圈
 *
 * 买家点「我想要」在后端**不是商品状态**：它只往会话写一条 `tx.proposal` SYSTEM 消息
 * （`POST /transactions/proposals`，见 `apps/api/src/modules/transactions/service.ts` 的
 * `propose`），商品仍是 `ACTIVE`；只有**卖家接受**（`POST /transactions` 的 `accept`）
 * 才会创建交易行并把商品置 `RESERVED`。所以：
 *
 * - 商品的读模型（`ListingCardSchema`）**没有任何提案信息** —— 有买家在等与没有，卡片长得一模一样；
 * - 契约也没有「按商品列提案」的端点，`GET /conversations` 只支持 `limit` / `cursor`。
 *
 * 因此这里用**卖家侧会话 + 会话内最后一个交易事件**来判：某商品的最新会话里，最后一个
 * `tx.*` 事件是 `tx.proposal`，就说明有买家在等卖家点头。这与 Web 端会话页
 * `lastTransactionEvent(list)` 的判据同源（`apps/web/src/features/chat/chat-page.tsx`）。
 *
 * 取「最后一个事件」而不是「最后一条消息」：买家提案之后卖家可能先回了句话（TEXT），
 * 申请仍在等点头，只认最后一条消息会漏掉它。
 *
 * ## 已知边界（不隐藏）
 *
 * 1. **只看会话最新一页消息**（契约 `limit` 上限 100 条）：`tx.proposal` 之后若超过 100 条
 *    消息，就翻不到它了。与两端会话页的历史分页同一口径。
 * 2. **会话列表要翻页**（`limit` 上限 50）：翻到 `MAX_CONVERSATION_PAGES` 还没见底、
 *    或服务端游标没有前进时，`complete` 为 false。
 * 3. **消息页请求数有上限**（`MAX_PROPOSAL_SCANS`）：需要拉消息页的会话多到超过它时
 *    `complete: false`。注意判的是**真的发出的请求数**，不是会话条数 ——
 *    命中 `lastMessage` 短路的会话不花请求，不参与这个上限（见 `loadPendingIndex` 里的说明）。
 * 4. **会话级降级**：某条会话的消息读不到时，`complete` 置 false 但这件商品按「不在等」处理
 *    —— 调用方见 `complete: false` 就不再显示分段计数，不会把不完整的推导当结论。
 * 5. 整轮推导失败（会话列表都拉不到）返回 `failed: true` + `complete: false`：**不能**把
 *    「读不到」当成「没有提案」，否则在等的商品会被显示成在售。
 */
import type { ConversationDto, MessageDto } from '@fish/contracts/chat/schema'
import {
  type TransactionSystemEvent,
  transactionSystemEventSchema,
} from '@fish/contracts/transactions/schema'

/** 会话列表最多翻几页（4 × 50 = 200 条会话）；防游标异常死循环，与 `fetchMyListings` 同一用途 */
const MAX_CONVERSATION_PAGES = 4

/** 最多读多少条会话的消息页（每条一次请求）。超出部分不读，`complete` 置 false */
const MAX_PROPOSAL_SCANS = 12

/** 一条在等的提案（够卡片渲染 + 卖家做决定） */
export type PendingProposal = {
  /** 「查看会话」/「拒绝」/「同意」都要它：提案只认会话，不认商品 */
  conversationId: string
  /** 谁在等（会话对面；卖家视角即买家） */
  buyerName: string
  /** 提案金额。接受时按它创建交易（契约：接受以卖家重传的值为准，提案本身不落库） */
  amountCents: number
  /** 提案那条 SYSTEM 消息的时间（「等了多久」的基准） */
  createdAt: string
}

export type PendingIndex = {
  /** 商品 id → 在等的提案（同一商品多条会话时取最新那条有提案的） */
  proposals: Map<string, PendingProposal>
  /** 商品 id → 卖家侧最新的会话 id（「查看会话」精确跳转用） */
  conversationIds: Map<string, string>
  /** 推导**不完整**（会话翻页到上限 / 扫描到上限 / 游标没前进 / 个别会话读不到） */
  complete: boolean
  /** 推导**没读到**（整轮失败）。与 `complete: false` 不是一回事：这是「不知道」 */
  failed: boolean
}

type TxSignal = { event: TransactionSystemEvent; createdAt: string }

/** 一条 SYSTEM 消息的 content 是不是交易事件（`tx.*`）；不是就返回 null */
function txEventOfContent(content: string): TransactionSystemEvent | null {
  try {
    const parsed = transactionSystemEventSchema.safeParse(JSON.parse(content))
    return parsed.success ? parsed.data : null
  } catch {
    // 非 JSON 的 SYSTEM 消息（例如认证通知）：按普通文本看待
    return null
  }
}

/** 一条消息是不是交易 SYSTEM 事件；不是就返回 null（TEXT / 其它系统消息） */
function txSignalOf(message: MessageDto): TxSignal | null {
  if (message.type !== 'SYSTEM') return null
  const event = txEventOfContent(message.content)
  return event ? { event, createdAt: message.createdAt } : null
}

/** 会话里**最后一个**交易事件；一个都没有则 null。消息按 `(createdAt, id)` 升序返回，顺序扫即可 */
export function lastTxSignalOf(messages: readonly MessageDto[]): TxSignal | null {
  let found: TxSignal | null = null
  for (const message of messages) {
    const signal = txSignalOf(message)
    if (signal) found = signal
  }
  return found
}

/**
 * 会话行自带的 `lastMessage` 已经够用时的**短路**（省掉一次消息页请求）：
 *
 * - 最后一条是 `tx.proposal` / `tx.accepted` / `tx.rejected` → 它就是最后一个交易事件，
 *   不必再拉消息页（这是「买家刚点了想要、卖家还没回话」这一常见情形的零成本路径）；
 * - 其余（TEXT / 非交易系统消息 / MEDIA / 空会话）→ **不能**就此断定「没有提案」：买家提案之后
 *   卖家可能先回了句话，提案仍在等点头。这时才去拉消息页找最后一个事件。
 *
 * `lastMessage` 取 `ConversationDto['lastMessage']` 的完整类型（含 `MEDIA` 与 `senderId`，
 * 见 `conversationLastMessageSchema`）：媒体消息不进 `MessageDto`，但会作为会话行摘要出现，
 * 而它同样推导不出交易事件，所以与 TEXT 同路。
 */
function signalFromLastMessage(item: {
  lastMessage: ConversationDto['lastMessage']
}): TxSignal | null | undefined {
  const last = item.lastMessage
  // 空会话：确实没有交易事件可言
  if (!last) return null
  if (last.type !== 'SYSTEM') return undefined
  const event = txEventOfContent(last.content)
  /*
   * 是 SYSTEM 但不是 `tx.*`（例如 seed 里的「买家发起了交易确认。」这类纯文案）：
   * 同样**不能**断定没有提案 —— 它上面可能还压着一条更早的 `tx.proposal`。
   * 与 TEXT 走同一条路：交给调用方拉消息页（`undefined`），别在这里返回 `null`。
   */
  if (!event) return undefined
  return { event, createdAt: last.createdAt }
}

/** 一页会话列表 / 一页消息——与 `features/chat/api.ts` 的两个读取函数同签名，便于测试注入 */
type FetchConversationPage = (cursor?: string) => Promise<{
  items: ConversationDto[]
  nextCursor: string | null
}>
type FetchMessagePage = (conversationId: string) => Promise<{
  items: MessageDto[]
  nextCursor: string | null
}>

const emptyIndex = (over: Partial<PendingIndex> = {}): PendingIndex => ({
  proposals: new Map(),
  conversationIds: new Map(),
  complete: true,
  failed: false,
  ...over,
})

/**
 * 拉一遍卖家侧会话，推导待确认索引。
 *
 * `listingIds` = 自己名下商品 id（含各种状态）：只有自己的商品才可能出现在「我的发布」里，
 * 会话列表里其余会话（我是买家那些）与本页无关。
 *
 * **不抛错**：整轮失败返回 `failed: true`，由调用方决定怎么显示（见文件头第 5 条）。
 */
export async function loadPendingIndex(
  listingIds: ReadonlySet<string>,
  fetchConversationPage: FetchConversationPage,
  fetchMessagePage: FetchMessagePage,
): Promise<PendingIndex> {
  const conversations: {
    id: string
    listingId: string
    buyerName: string
    lastMessage: ConversationDto['lastMessage']
  }[] = []
  let complete = true

  try {
    let cursor: string | undefined
    for (let page = 0; page < MAX_CONVERSATION_PAGES; page += 1) {
      const result = await fetchConversationPage(cursor)
      for (const item of result.items) {
        // 只认卖家视角：买家视角的会话是「我想买别人的东西」，不是本页要处理的申请
        if (item.role !== 'seller' || !listingIds.has(item.listingId)) continue
        conversations.push({
          id: item.id,
          listingId: item.listingId,
          buyerName: item.counterpart.nickname,
          lastMessage: item.lastMessage,
        })
      }
      if (result.nextCursor === null) break
      // 游标没前进 = 服务端在重复给同一页，再翻下去是死循环（`fetchAllTransactions` 同一判据）
      if (result.nextCursor === cursor) {
        complete = false
        break
      }
      cursor = result.nextCursor
      if (page === MAX_CONVERSATION_PAGES - 1) complete = false
    }
  } catch {
    return emptyIndex({ complete: false, failed: true })
  }

  // 会话按 lastMessageAt 降序返回：同一商品第一次出现的那条即最新会话
  const conversationIds = new Map<string, string>()
  for (const item of conversations) {
    if (!conversationIds.has(item.listingId)) conversationIds.set(item.listingId, item.id)
  }

  const proposals = new Map<string, PendingProposal>()

  /*
   * 上限管的是**消息页请求数**，不是会话条数：命中 `lastMessage` 短路的会话零成本，
   * 不该把它们算进来。按会话条数判会让「我的商品多、且大部分会话最后一条就是交易事件」
   * 的卖家永远被判成不完整 —— 分段计数与「已经到底了」会因此整排消失，
   * 而实际上一次消息页都没拉过、推导是完整的。
   */
  let scanned = 0
  for (const item of conversations) {
    if (scanned >= MAX_PROPOSAL_SCANS) {
      // 真的停下没扫完（下面还有会话要看消息页）= 推导不完整
      complete = false
      break
    }
    // 同一商品已经有在等的提案就不再往下扫（已取最新那条会话）
    if (proposals.has(item.listingId)) continue

    const shortcut = signalFromLastMessage(item)
    if (shortcut !== undefined) {
      // 最后一条消息就是交易事件：无需再拉消息页
      if (shortcut?.event.type === 'tx.proposal') {
        proposals.set(item.listingId, {
          conversationId: item.id,
          buyerName: item.buyerName,
          amountCents: shortcut.event.amountCents,
          createdAt: shortcut.createdAt,
        })
      }
      continue
    }

    scanned += 1
    let signal: TxSignal | null
    try {
      signal = lastTxSignalOf((await fetchMessagePage(item.id)).items)
    } catch {
      // 单条会话读不到：整体降级为不完整，但不把「读不到」当成「这件商品没有申请」
      complete = false
      continue
    }
    if (signal?.event.type !== 'tx.proposal') continue
    proposals.set(item.listingId, {
      conversationId: item.id,
      buyerName: item.buyerName,
      amountCents: signal.event.amountCents,
      createdAt: signal.createdAt,
    })
  }

  return { proposals, conversationIds, complete, failed: false }
}
