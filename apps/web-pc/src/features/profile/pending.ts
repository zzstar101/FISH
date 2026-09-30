/**
 * 我的发布「待确认」段的数据来源：从**卖家自己的会话**里推导「谁在等我点头」。
 *
 * ## 为什么绕这一圈
 *
 * 买家「我想要」在后端**不是商品状态**：它只往会话写一条 `tx.proposal` SYSTEM 消息
 * （`POST /transactions/proposals`），商品仍是 `ACTIVE`；只有卖家接受才创建交易行并置
 * `RESERVED`。所以商品读模型（`ListingCardSchema`）**没有任何提案字段**，契约也没有
 * 「按商品列提案」的端点 —— 只能拿卖家侧会话 + 会话内最后一个交易事件来判。
 *
 * 取「最后一个**交易事件**」而不是「最后一条消息」：买家提案后卖家可能先回了句话，
 * 申请仍在等点头，只看最后一条消息会漏掉它。
 *
 * ## 已知边界（不隐藏）
 *
 * 1. 只看会话最新一页消息（契约 `limit` 上限 100）：`tx.proposal` 之后超过 100 条消息就翻不到。
 * 2. 会话列表要翻页（`limit` 上限 50）：翻到 `MAX_CONVERSATION_PAGES` 仍未见底，`complete = false`。
 * 3. 消息页请求数有上限；判的是**真的发出的请求数**（命中 `lastMessage` 短路的会话零成本）。
 * 4. 单条会话消息读不到：`complete = false`，但这件商品按「不在等」处理。
 * 5. 整轮失败返回 `failed: true` —— **不能**把「读不到」当成「没有提案」，
 *    否则在等的商品会被显示成普通在售。
 * 6. `listingIds` 由调用方给，且只应包含**仍可交易（`ACTIVE`）**的商品：接受与拒绝在
 *    服务端都要求商品是 `ACTIVE`，非 ACTIVE 只会 409。调用方取 id 时自己也受
 *    「我的发布」的 `limit=50` 约束 —— 卖家商品超过 50 件时，第 51 件起的申请推导不到。
 */
import type { ConversationDto, MessageDto } from '@fish/contracts/chat/schema'
import type { ConversationId, ListingId } from '@fish/contracts/system/public-id'
import {
  type TransactionSystemEvent,
  transactionSystemEventSchema,
} from '@fish/contracts/transactions/schema'

/** 会话列表最多翻几页（4 × 50 = 200 条会话）；防游标异常死循环。 */
const MAX_CONVERSATION_PAGES = 4

/** 最多读多少条会话的消息页（每条一次请求）。超出部分不读，`complete` 置 false。 */
const MAX_PROPOSAL_SCANS = 12

/** 一条在等的提案（够卡片渲染 + 卖家做决定） */
export type PendingProposal = {
  /** 「查看会话」/「拒绝」/「同意」都要它：提案只认会话，不认商品 */
  conversationId: ConversationId
  /** 谁在等（会话对面；卖家视角即买家） */
  buyerName: string
  /** 提案金额。接受时按它创建交易（契约：接受以卖家重传的值为准，提案本身不落库） */
  amountCents: number
  /** 提案那条 SYSTEM 消息的时间（「等了多久」的基准） */
  createdAt: string
}

export type PendingIndex = {
  /**
   * 商品 id → 在等的提案。会话按 `lastMessageAt` 降序扫，取**第一条**仍停在
   * `tx.proposal` 的会话：同一商品可能有多个买家会话，其中一条被拒（`tx.rejected`）
   * 不该把另一条仍在等的申请一起盖掉。
   */
  proposals: Map<ListingId, PendingProposal>
  /** 推导**不完整**（翻页到上限 / 扫描到上限 / 游标没前进 / 个别会话读不到） */
  complete: boolean
  /** 推导**没读到**（整轮失败）。与 `complete: false` 不是一回事：这是「不知道」 */
  failed: boolean
}

type TxSignal = { event: TransactionSystemEvent; createdAt: string }

/** 一条 SYSTEM 消息的 content 是不是交易事件（`tx.*`）；不是就返回 null。 */
function txEventOfContent(content: string): TransactionSystemEvent | null {
  try {
    const parsed = transactionSystemEventSchema.safeParse(JSON.parse(content))
    return parsed.success ? parsed.data : null
  } catch {
    // 非 JSON 的 SYSTEM 消息（例如认证通知）：按普通文本看待
    return null
  }
}

/** 一条消息是不是交易 SYSTEM 事件；不是则 null（TEXT / 其它系统消息）。 */
function txSignalOf(message: MessageDto): TxSignal | null {
  if (message.type !== 'SYSTEM') return null
  const event = txEventOfContent(message.content)
  return event ? { event, createdAt: message.createdAt } : null
}

/** 会话里**最后一个**交易事件；一个都没有则 null。消息按 `(createdAt, id)` 升序返回，顺序扫即可。 */
export function lastTxSignalOf(messages: readonly MessageDto[]): TxSignal | null {
  let found: TxSignal | null = null
  for (const message of messages) {
    const signal = txSignalOf(message)
    if (signal) found = signal
  }
  return found
}

/**
 * 会话行自带的 `lastMessage` 已经够用时的**短路**（省掉一次消息页请求）。
 *
 * - 最后一条是 `tx.*` → 它就是最后一个交易事件，不必再拉消息页（「买家刚点了想要、卖家
 *   还没回话」这一常见情形的零成本路径）；
 * - 其余（TEXT / 非交易系统消息 / 空会话）→ **不能**断定没有提案，交回调用方拉消息页。
 *   返回 `null` 才是真的没有，`undefined` 表示「说不准」。
 */
function signalFromLastMessage(item: {
  lastMessage: ConversationDto['lastMessage']
}): TxSignal | null | undefined {
  const last = item.lastMessage
  // 空会话：确实没有交易事件可言
  if (!last) return null
  if (last.type !== 'SYSTEM') return undefined
  const event = txEventOfContent(last.content)
  // 是 SYSTEM 但不是 `tx.*`（例如 seed 里的纯文案）：它上面可能还压着更早的 `tx.proposal`
  if (!event) return undefined
  return { event, createdAt: last.createdAt }
}

/** 一页会话 / 一页消息——与 `features/chat/api.ts` 的两个读取函数同签名，便于测试注入。 */
type FetchConversationPage = (cursor?: string) => Promise<{
  items: ConversationDto[]
  nextCursor: string | null
}>
type FetchMessagePage = (conversationId: ConversationId) => Promise<{
  items: MessageDto[]
  nextCursor: string | null
}>

const emptyIndex = (over: Partial<PendingIndex> = {}): PendingIndex => ({
  proposals: new Map(),
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
  listingIds: ReadonlySet<ListingId>,
  fetchConversationPage: FetchConversationPage,
  fetchMessagePage: FetchMessagePage,
): Promise<PendingIndex> {
  const conversations: {
    id: ConversationId
    listingId: ListingId
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
      // 游标没前进 = 服务端在重复给同一页，再翻下去是死循环
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

  const proposals = new Map<ListingId, PendingProposal>()

  /*
   * 上限管的是**消息页请求数**，不是会话条数：命中 `lastMessage` 短路的会话零成本。
   * 按会话条数判会让「我的商品多、且大部分会话最后一条就是交易事件」的卖家永远被
   * 判成不完整 —— 分段计数与「已经到底了」会因此整排消失，而推导实际是完整的。
   */
  let scanned = 0
  for (const item of conversations) {
    if (scanned >= MAX_PROPOSAL_SCANS) {
      complete = false
      break
    }
    // 同一商品已经有在等的提案就不再往下扫（已取最新那条会话）
    if (proposals.has(item.listingId)) continue

    const shortcut = signalFromLastMessage(item)
    if (shortcut !== undefined) {
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

  return { proposals, complete, failed: false }
}
