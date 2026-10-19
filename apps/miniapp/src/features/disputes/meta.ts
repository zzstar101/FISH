/**
 * 交易争议的展示文案与视觉基调（#497）。
 *
 * 契约枚举 → 中文标签用 `Record<契约联合, …>` 钉住完整性：契约加一种状态而这里漏写，
 * typecheck 会直接报错，不会在端上显示成空白。
 */
import type {
  DisputeErrorCode,
  DisputeEvidenceMessage,
  DisputeResolution,
  DisputeStatus,
  DisputeType,
} from '@fish/contracts/disputes/schema'
import type { TransactionStatus } from '@fish/contracts/transactions/schema'

/** 卡片胶囊的三种基调：warn（处理中）/ ok（已处理）/ off（已撤回、不成立）。 */
export type DisputeTone = 'warn' | 'ok' | 'off'

type DisputeTypeMeta = {
  label: string
  /** 选中后给用户的一句话说明，帮他确认自己选对了。 */
  hint: string
  /** 说明输入框的占位文案。 */
  placeholder: string
}

export const DISPUTE_TYPE_META: Record<DisputeType, DisputeTypeMeta> = {
  ITEM_MISMATCH: {
    label: '物品与描述不符',
    hint: '收到的物品与商品页、聊天里说好的不一致。',
    placeholder: '哪里不符？比如型号、成色、数量、配件…',
  },
  NOT_COMPLETED: {
    label: '交易未完成',
    hint: '付了钱没拿到东西，或约好面交对方没出现。',
    placeholder: '写下约定的时间、地点，以及当时的情况。',
  },
  PAYMENT_ISSUE: {
    label: '款项问题',
    hint: '金额、找零、退款等与钱有关的争议。',
    placeholder: '写明约定金额、实际支付金额与差额。',
  },
  OTHER: {
    label: '其他',
    hint: '不属于上面三类，需要管理员介入的其他交易纠纷。',
    placeholder: '请具体说明发生了什么（选「其他」时必填）。',
  },
}

/** 发起页的类型顺序（从最常见的开始）。 */
export const DISPUTE_TYPE_ORDER: readonly DisputeType[] = [
  'ITEM_MISMATCH',
  'NOT_COMPLETED',
  'PAYMENT_ISSUE',
  'OTHER',
]

type DisputeStatusMeta = {
  label: string
  tone: DisputeTone
  /** 状态胶囊旁边的一行说明。 */
  note: string
}

export const DISPUTE_STATUS_META: Record<DisputeStatus, DisputeStatusMeta> = {
  PENDING: { label: '处理中', tone: 'warn', note: '等待管理员处理' },
  RESOLVED: { label: '已处理', tone: 'ok', note: '该结论为最终结论' },
  WITHDRAWN: { label: '已撤回', tone: 'off', note: '发起人已撤回争议' },
}

type DisputeResolutionMeta = {
  label: string
  tone: DisputeTone
  note: string
}

export const DISPUTE_RESOLUTION_META: Record<DisputeResolution, DisputeResolutionMeta> = {
  UPHELD: { label: '争议成立', tone: 'ok', note: '管理员认定本次争议成立。' },
  DISMISSED: { label: '争议不成立', tone: 'off', note: '管理员未认定本次争议。' },
  INCONCLUSIVE: { label: '无法认定', tone: 'warn', note: '现有材料不足以判断责任归属。' },
}

export const TRANSACTION_STATUS_LABEL: Record<TransactionStatus, string> = {
  PENDING_MEETUP: '待面交',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
}

export const EVIDENCE_TYPE_LABEL: Record<DisputeEvidenceMessage['type'], string> = {
  TEXT: '文字',
  SYSTEM: '系统',
  MEDIA: '图片',
  LISTING: '商品卡片',
}

/**
 * 错误码 → 端上文案。键集合与契约 `DisputeErrorCodeSchema` 完全一致（多一个少一个都编译不过），
 * 契约新增错误码时这里必须补文案，否则端上会掉进兜底句。
 */
export const DISPUTE_ERROR_COPY: Record<DisputeErrorCode, string> = {
  DISPUTE_TRANSACTION_NOT_FOUND: '这笔交易不存在，或你不是交易参与人',
  DISPUTE_NOT_FOUND: '这条争议不存在，或你无权查看',
  DISPUTE_MESSAGE_NOT_FOUND: '这条消息不存在，或不属于这笔交易的会话',
  DISPUTE_CONFLICT: '争议状态刚被改变，请刷新后再试',
  DISPUTE_WINDOW_CLOSED: '交易结束已超过 30 天，无法再发起争议',
  DISPUTE_ATTACHMENT_LIMIT: '附件最多 6 张，已达上限',
  DISPUTE_ATTACHMENT_INVALID: '图片没上传成功，请重新选择',
  DISPUTE_NOT_PENDING: '争议已处理或已撤回，不能再补充材料',
}

/** 撤回场景的 NOT_PENDING：撤回按钮上「不能再补充材料」读着别扭，单独一句。 */
export const DISPUTE_NOT_PENDING_WITHDRAW_COPY = '争议已被处理或撤回，请刷新查看'

/** `scene` 只影响 `DISPUTE_NOT_PENDING` 的措辞，其余错误码两边一致。 */
export type DisputeFailureScene = 'material' | 'withdraw'

/** 契约错误码 → 中文；未知码/无码给通用兜底句（绝不把服务端 message 直接甩给用户）。 */
export function disputeFailureText(
  code: string | null,
  scene: DisputeFailureScene = 'material',
): string {
  if (code === null) return '操作没成功，请稍后再试'
  if (code === 'DISPUTE_NOT_PENDING' && scene === 'withdraw') {
    return DISPUTE_NOT_PENDING_WITHDRAW_COPY
  }
  return DISPUTE_ERROR_COPY[code as DisputeErrorCode] ?? '操作没成功，请稍后再试'
}

/** `dsp_01J8ZQ3XK7M2` → `dsp_01J8…K7M2`：列表里给一个能对照工单的短号。 */
export function shortDisputeId(id: string): string {
  if (id.length <= 14) return id
  return `${id.slice(0, 9)}…${id.slice(-4)}`
}
