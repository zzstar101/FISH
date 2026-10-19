import {
  type DisputeResolution,
  type DisputeStatus,
  type DisputeType,
  MAX_DISPUTE_ATTACHMENTS,
  MAX_DISPUTE_DETAIL_LENGTH,
} from '@fish/contracts/disputes/schema'

/**
 * 争议域的文案与展示元数据（发起弹窗 / 列表 / 详情共用）。
 *
 * **枚举顺序与取值只来自 `@fish/contracts/disputes/schema`**：这里只补 label / hint / hint，
 * 并用 `Record<契约联合, …>` 兜住完整性 —— 契约加了枚举值而这里没补文案，`tsc` 当场报错，
 * 而不是线上渲染出一个空胶囊（与 `features/reports/meta.ts` 同一纪律）。
 */

export type DisputeTypeOption = {
  key: DisputeType
  label: string
  /** 选中后的补充说明 placeholder：点名要「可核查的交易过程」。 */
  hint: string
}

const DISPUTE_TYPE_COPY: Record<DisputeType, { label: string; hint: string }> = {
  ITEM_MISMATCH: {
    label: '商品与描述不符',
    hint: '请说明商品与描述具体哪里不同（成色 / 型号 / 功能…），以及你查验的时间',
  },
  NOT_COMPLETED: {
    label: '交易未完成',
    hint: '请说明交易进行到哪一步、对方如何没有按约定完成面交',
  },
  PAYMENT_ISSUE: {
    label: '支付问题',
    hint: '请说明金额、支付方式与出现问题的环节（多付 / 少付 / 要求私下转账…）',
  },
  OTHER: {
    label: '其他',
    hint: '请描述这笔交易的问题，包含具体经过与时间',
  },
}

/** 发起弹窗的类型选项；顺序由契约枚举顺序决定。 */
export const DISPUTE_TYPE_OPTIONS: DisputeTypeOption[] = (
  ['ITEM_MISMATCH', 'NOT_COMPLETED', 'PAYMENT_ISSUE', 'OTHER'] as const
).map((key) => ({ key, ...DISPUTE_TYPE_COPY[key] }))

export function disputeTypeLabel(type: DisputeType): string {
  return DISPUTE_TYPE_COPY[type].label
}

/**
 * 状态三态。`variant` 直接给 `@fish/ui/badge` 的柔和色变体：
 * 处理中=warn、已处理=success、已撤回=secondary（终态但不是失败）。
 */
export const DISPUTE_STATUS_META: Record<
  DisputeStatus,
  { label: string; variant: 'warn' | 'success' | 'secondary' }
> = {
  PENDING: { label: '处理中', variant: 'warn' },
  RESOLVED: { label: '已处理', variant: 'success' },
  WITHDRAWN: { label: '已撤回', variant: 'secondary' },
}

/**
 * 处理结论。只描述「本次反馈是否成立」，不等同于处罚，也不改变成交事实
 * （契约注释边界：不封禁、不下架、不退款）。
 */
export const DISPUTE_RESOLUTION_META: Record<
  DisputeResolution,
  { label: string; variant: 'success' | 'danger' | 'secondary'; description: string }
> = {
  UPHELD: {
    label: '反馈成立',
    variant: 'success',
    description: '平台核查后认定你反映的问题成立。',
  },
  DISMISSED: {
    label: '反馈不成立',
    variant: 'danger',
    description: '平台核查后认为本次反映的问题不成立。',
  },
  INCONCLUSIVE: {
    label: '无法认定',
    variant: 'secondary',
    description: '现有材料不足以认定责任，平台已记录本次反馈。',
  },
}

/** 结论标签；未处理（`resolution === null`）时返回 null。 */
export function disputeResolutionLabel(resolution: DisputeResolution | null): string | null {
  return resolution === null ? null : DISPUTE_RESOLUTION_META[resolution].label
}

/** 「我的争议」空态：列表确实接的是 `GET /disputes/mine`，空就是「还没有争议」。 */
export const DISPUTE_EMPTY_COPY = {
  title: '还没有交易争议',
  text: '在本人订单详情点击「发起交易争议」，处理进度与结论会出现在这里。',
}

/** 补充说明上限（契约 `MAX_DISPUTE_DETAIL_LENGTH`，trim 后 1..1000）。 */
export { MAX_DISPUTE_ATTACHMENTS, MAX_DISPUTE_DETAIL_LENGTH }
