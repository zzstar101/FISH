/**
 * 契约 `TransactionDto` → 订单卡视图（`OrderCardView`）的**投影**，同 `features/listing/adapt.ts` 的口径。
 *
 * ## 为什么需要这一层
 *
 * 订单页读的是「一张卡要渲染的全部内容」：对方称谓、商品摘要、状态、结果日期。
 * 契约给的字段比这多（buyerId / sellerId / updatedAt / 两侧确认时间戳…），
 * 而**日期文案**这类排版量契约里根本没有。所以在这里做一次显式投影：
 * 契约给得了的用真的，给不了的留 `null` 由页面不渲染。
 *
 * ## 两条铁律（沿用 `listing/adapt.ts`）
 *
 * 1. **绝不编造业务数据。** 契约的 `TransactionUser` 没有 `authStatus`，
 *    所以真实数据下 `verified` 恒为 `false` —— 不显示认证勾，而不是把 mock 时代的
 *    结论当可信依据（同 `toMockSeller` 的处理）。
 * 2. **结果日期只用契约的结果时间。** 已完成取 `completedAt`、已取消取 `cancelledAt`；
 *    拿不到（mock 回退的旧数据）就留 `null`，页面不显示这一行 ——
 *    绝不允许拿 `createdAt` 冒充结果时间。
 *
 * 卡片上**不显示创建时间**（Owner 定版）：一张卡只留一个日期，且那个日期是结果日期。
 */
import type {
  TransactionDto,
  TransactionRole,
  TransactionStatus,
} from '@fish/contracts/transactions/schema'
import type { OrderView } from '@/mock/api'

/**
 * 订单卡的页面视图。
 *
 * `role` / `status` 直接复用契约枚举（`transactions/schema.ts` 是唯一真源，不在这里重抄）。
 */
export type OrderCardView = {
  id: string
  /**
   * 本单的会话。契约 `TransactionDto.conversationId` 是权威值；
   * mock 回退里没有这个字段，按 (listingId, 对方) 解析，解析不到就是 `null`。
   */
  conversationId: string | null
  listingId: string
  /** 我在这笔交易里是买家还是卖家 */
  role: TransactionRole
  amountCents: number
  status: TransactionStatus
  /** 创建时间（ISO）。只用于排序，**不渲染** —— 卡片上不显示创建时间 */
  createdAt: string
  counterpart: {
    nickname: string
    /** 是否画认证勾。见文件头铁律 1：真实数据恒为 false */
    verified: boolean
  }
  listing: {
    title: string
    /** 契约允许无图（`coverUrl` nullable），页面已有空图路径 */
    coverUrl: string | null
  }
  /**
   * 结果日期（`2026-09-14`）。已完成 / 已取消才有；
   * `null` = 拿不到结果时间（PENDING_MEETUP 本来就没有，或 mock 回退里字段缺失）——
   * 页面此时只显示状态说明，不补一个日期。
   */
  settledDate: string | null
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 结果日期：`2026-09-14`（Owner 定版：只留年-月-日，不带时分）。
 *
 * 按**设备本地时区**取日期：用户看到的「9 月 14 日」应该是他自己那天，
 * 而不是 UTC 那天（UTC+8 的凌晨在 UTC 上还是前一天）。
 */
function dateStamp(iso: string): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const d = new Date(at)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 契约 `TransactionDto` → 订单卡视图 */
export function toOrderCard(dto: TransactionDto): OrderCardView {
  // 结果时间：契约保证 COMPLETED 必带 completedAt、CANCELLED 必带 cancelledAt
  // （`transactionDtoSchema` 的两条 refine），其余状态两个字段都是 null
  const settledAt = dto.completedAt ?? dto.cancelledAt
  return {
    id: dto.id,
    conversationId: dto.conversationId,
    listingId: dto.listingId,
    role: dto.role,
    amountCents: dto.amountCents,
    status: dto.status,
    createdAt: dto.createdAt,
    counterpart: {
      nickname: dto.counterpart.nickname,
      // 契约没有认证状态 —— 不显示徽章（铁律 1）
      verified: false,
    },
    listing: {
      title: dto.listing.title,
      coverUrl: dto.listing.coverUrl,
    },
    settledDate: settledAt === null ? null : dateStamp(settledAt),
  }
}

/**
 * mock 回退分支：mock 的 `OrderView` → 同一张卡的视图。
 *
 * `resolveConversationId` 由调用方从 `@/mock/api` 动态引入后传进来（口径同 #72 / PR #82：
 * 会话由 (listingId, 对方) 唯一确定）。做成入参是为了让本模块只依赖 `@/mock/api` 的**类型**，
 * 不产生对 fixture 模块的静态依赖（回退路径的 `await import` 留在 `fetchers.ts` 一处）。
 *
 * mock 的 `MockTransaction` 现在也带 `completedAt` / `cancelledAt`（补齐与契约的落差），
 * 所以 mock 路径的结果日期与真实接口一致；字段缺失时仍留 `null`（铁律 2）。
 */
export function toOrderCardFromMock(
  view: OrderView,
  resolveConversationId: (listingId: string, counterpartId: string) => string | null,
): OrderCardView {
  const { transaction, listing, counterpart } = view
  const settledAt = transaction.completedAt ?? transaction.cancelledAt
  return {
    id: transaction.id,
    conversationId: resolveConversationId(transaction.listingId, transaction.counterpartId),
    listingId: transaction.listingId,
    role: transaction.role,
    amountCents: transaction.amountCents,
    status: transaction.status,
    createdAt: transaction.createdAt,
    counterpart: {
      nickname: counterpart.nickname,
      verified: counterpart.authStatus === 'VERIFIED',
    },
    listing: { title: listing.title, coverUrl: listing.coverUrl },
    settledDate: settledAt === null || settledAt === undefined ? null : dateStamp(settledAt),
  }
}
