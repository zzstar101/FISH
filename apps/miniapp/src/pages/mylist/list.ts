/**
 * 「我的发布」的纯判定（无 Taro、无 mock 依赖：`tests/mylist-list.test.ts` 直接 import）。
 *
 * 分段由**商品状态 + 审核态 + 治理标记**决定，外加一个由会话侧推导出来的「有买家在等」：
 *
 * - 「审核」= 库里 `status = OFFLINE` 且 `moderationStatus` 是 `REVIEW`（审核中）或
 *   `BLOCKED`（不过审）的商品。**Owner 2026-09-28 拍板**：发布后的审核阶段要有自己的分段
 *   （取代 2026-09-24「审核态不参与这一页」的旧口径）——审核中的卡片不给编辑 / 下架，
 *   不过审的卡片只给编辑 / 删除（删除是物理删除，见 `features/listing/api.ts` 的
 *   `deleteListing` 与后端 `store.deleteListingAtomic` 的口径注释）。
 *   同一段装两种子状态，胶囊文案分开说（`cardLabel`），与「待确认」段的做法一致。
 * - **治理下架（`governanceDelisted`）不算「审核」**：管理员下架的商品在库里的形态与
 *   「内容被拒」完全相同（`OFFLINE` + `BLOCKED`，见 `governance/service.ts` 的 delist），
 *   但它的出路是**找平台**（可申诉、可由管理员恢复），不是改内容重审。所以它按「已下架」
 *   归段、胶囊另说「平台下架」，并且**不给编辑 / 重新上架 / 删除** —— 那三个动作在服务端
 *   都会被 `LISTING_GOVERNANCE_BLOCKED` / `LISTING_NOT_DELETABLE` 拒掉。
 * - 「待确认」= 有买家在等（`ACTIVE` + 未回应的 `tx.proposal`）**或**已同意待面交（`RESERVED`）。
 *   前者不是商品状态：买家点「我想要」只往会话写一条 SYSTEM 消息，商品仍是 `ACTIVE`
 *   （见 `./pending.ts` 与页头说明），所以这一半事实由调用方从会话侧推导后传进来。
 * - 其余照旧：`SOLD` → 已售出；`OFFLINE` 且审核态是 `APPROVED` / `null` → 已下架。
 *   这里的 `null` 只可能来自**非本人视角**（契约里 `moderationStatus` 只在查自己时非 null），
 *   本页走的是本人查询，所以实际拿到的是三档枚举之一；判 `null` 归「已下架」是取最保守的落点。
 */
import type { ListingModerationStatus, ListingStatus } from '@fish/contracts/listings/schema'

export type MyListSegment = 'sale' | 'review' | 'pending' | 'sold' | 'off'

/** 分段顺序：审核紧跟在售（发布后先过审，阅读顺序 = 商品生命周期），交易段在其后。 */
export const SEGMENTS: { key: MyListSegment; label: string }[] = [
  { key: 'sale', label: '在售' },
  { key: 'review', label: '审核' },
  { key: 'pending', label: '待确认' },
  { key: 'sold', label: '已售出' },
  { key: 'off', label: '已下架' },
]

type CardLike = {
  id: string
  status: ListingStatus
  moderationStatus: ListingModerationStatus | null
  /** 平台（治理）下架标记；非本人视角 / 老客户端不带时为 `null` / `undefined` */
  governanceDelisted?: boolean | null
}

/** 卡片 → 分段。`awaiting` = 这件商品有买家在等（会话侧推导出来的，见 `./pending.ts`）。 */
export function segmentOf(card: CardLike, awaiting: boolean): MyListSegment {
  switch (card.status) {
    case 'ACTIVE':
      return awaiting ? 'pending' : 'sale'
    case 'RESERVED':
      return 'pending'
    case 'SOLD':
      return 'sold'
    default:
      // OFFLINE：审核阶段（审核中 / 不过审）自成一档；治理下架与「自己下架的」都读作已下架
      if (card.governanceDelisted === true) return 'off'
      return card.moderationStatus === 'REVIEW' || card.moderationStatus === 'BLOCKED'
        ? 'review'
        : 'off'
  }
}

/** `awaitingIds` 是「有买家在等」的商品 id 集合（缺省空集 = 只看商品状态分档）。 */
export function countBySegment(
  cards: readonly CardLike[],
  awaitingIds: ReadonlySet<string> = new Set(),
): Record<MyListSegment, number> {
  const counts: Record<MyListSegment, number> = {
    sale: 0,
    review: 0,
    pending: 0,
    sold: 0,
    off: 0,
  }
  for (const card of cards) counts[segmentOf(card, awaitingIds.has(card.id))] += 1
  return counts
}

/** 状态胶囊文案 = 分段自己的名字（几处子状态在 `cardLabel` 里分开说）。 */
export function segmentLabel(segment: MyListSegment): string {
  return SEGMENTS.find((seg) => seg.key === segment)?.label ?? ''
}

/**
 * **卡片胶囊**文案：多数段与分段同名，几处子状态要分开说。
 *
 * - 「审核」段：`REVIEW` → 审核中，`BLOCKED` → 不过审。胶囊若都顶「审核」，
 *   不过审的卡就说不清自己错在哪一档（两种子状态的动作完全不同）。
 * - 「已下架」段里的**平台下架**：胶囊写「平台下架」。它落在「已下架」是因为商品确实不在架上了，
 *   但卖家能做的是找平台，与「自己下架、随时可重新上架」不是一回事，所以名字要分开。
 * - 「待确认」段：有买家在等你点头（`awaiting`）→ 待确认；已同意、等面交（`RESERVED`）→
 *   待面交（与订单页 `PENDING_MEETUP` 同名，一个状态一个名字）。
 */
export function cardLabel(
  segment: MyListSegment,
  awaiting: boolean,
  moderationStatus: ListingModerationStatus | null,
  governanceDelisted = false,
): string {
  if (segment === 'review') return moderationStatus === 'BLOCKED' ? '不过审' : '审核中'
  if (segment === 'off' && governanceDelisted) return '平台下架'
  if (segment === 'pending' && !awaiting) return '待面交'
  return segmentLabel(segment)
}

/**
 * 状态胶囊配色（在售浅蓝 / 审核中中性灰 / 不过审描红 / 平台下架描红 / 待确认 warn /
 * 已售出灰 / 已下架描边）。
 *
 * 审核中用中性墨色（进行中、**不需要卖家操作**，不用 warn 的「要你处理」色）；
 * 不过审与平台下架共用 danger 红系（都是「被平台拦下了」，出路不同由文案与可用动作表达）。
 */
export function pillClassOf(
  segment: MyListSegment,
  moderationStatus: ListingModerationStatus | null,
  governanceDelisted = false,
): string {
  if (segment === 'review') return moderationStatus === 'BLOCKED' ? 'is-blocked' : 'is-review'
  if (segment === 'off' && governanceDelisted) return 'is-blocked'
  const PILL_CLASS: Record<Exclude<MyListSegment, 'review'>, string> = {
    sale: 'is-sale',
    pending: 'is-pending',
    sold: 'is-sold',
    off: 'is-off',
  }
  return PILL_CLASS[segment]
}

/**
 * 行内动作区开头的锁定说明（1版稿 ⑥ 的 `LOCK` 表）。
 *
 * - 「已售出」：成交记录本身就是凭据，价与文案都不能再改。
 * - 「审核中」：审核结论出来前不给编辑 / 下架（Owner 2026-09-28 拍板），这行解释按钮为什么缺席。
 *   不写「通过后自动上架」——编辑再审的商品通过后恢复的是**原来的**状态（可能是已下架），
 *   客户端无从分辨，那就只说恒成立的一半。
 * - 「平台下架」：不给任何动作，这行说清出路是找平台。
 * - 「待确认」刻意不挂锁：那一段的「先别改」由「谁在等」那一行与决策按钮表达（稿 ⑥ 的原话），
 *   挂个锁图标只会跟旁边的按钮打架。
 */
export function lockNote(
  segment: MyListSegment,
  moderationStatus: ListingModerationStatus | null = null,
  governanceDelisted = false,
): string {
  if (segment === 'sold') return '已成交锁定 · 不可改'
  if (segment === 'review' && moderationStatus === 'REVIEW') return '审核期间暂不可修改'
  if (segment === 'off' && governanceDelisted) return '平台下架 · 暂不可修改或上架'
  return ''
}

/**
 * 能不能编辑（进出物页改这一条）。
 *
 * 在售 / 已下架可改；不过审也可改（改完重新送审）。**审核中不给**（等结论，拍板口径），
 * **平台下架不给**（服务端 `LISTING_GOVERNANCE_BLOCKED`），待确认 / 已售出不给。
 *
 * 抽成函数而不是把条件散在 JSX 里：本页三个动作（编辑 / 下架 / 删除）共用同一批状态判据，
 * 各写一份就会出现「按钮在、按下去必然 409」这类自相矛盾的卡面（审核中的商品一度如此）。
 */
export function canEdit(
  segment: MyListSegment,
  moderationStatus: ListingModerationStatus | null,
  governanceDelisted = false,
): boolean {
  if (governanceDelisted) return false
  if (segment === 'sale' || segment === 'off') return true
  return segment === 'review' && moderationStatus === 'BLOCKED'
}

/** 能不能下架：只有在售可下架（已下架 / 审核中 / 平台下架都无从「再下架」）。 */
export function canOffline(segment: MyListSegment, governanceDelisted = false): boolean {
  return segment === 'sale' && !governanceDelisted
}

/**
 * 能不能物理删除：只有**不过审**可删（Owner 2026-09-28 拍板）。
 *
 * 审核中的出路是等结论 + 改内容重审；平台下架是治理证据（服务端同样拒），都不给。
 * 「已下架」不给删除（拍板只说了不过审），它有自己的「重新上架」。
 */
export function canDelete(
  segment: MyListSegment,
  moderationStatus: ListingModerationStatus | null,
  governanceDelisted = false,
): boolean {
  return !governanceDelisted && segment === 'review' && moderationStatus === 'BLOCKED'
}

/** 空态标题：每一段说清「这里会出现什么」，不复用同一句。 */
export function emptyTitle(segment: MyListSegment): string {
  switch (segment) {
    case 'sale':
      return '还没有在售的商品'
    case 'review':
      return '还没有在审核的商品'
    case 'pending':
      return '还没有待确认的申请'
    case 'sold':
      return '还没有卖出的商品'
    default:
      return '这个状态下还没有东西'
  }
}

/** 空态说明（1版稿 `EMPTY` 表；「审核」段按 2026-09-28 新拍板补写）。 */
export function emptyText(segment: MyListSegment): string {
  switch (segment) {
    case 'sale':
      return '发布一件闲置，它就会出现在这里'
    case 'review':
      // 「通过后进入在售」只对**新发布**成立；编辑再审的通过后回原状态（可能是已下架），
      // 那种情况由卡片自己的状态说话，空态不替它下结论
      return '新发布的商品会先进入审核，通过后出现在「在售」里'
    case 'pending':
      return '买家点「我想要」之后，会停在这里等你确认'
    case 'sold':
      return '完成面交的商品会归档到这里'
    default:
      return '被下架的商品会出现在这里，可随时重新上架'
  }
}
