/**
 * 评价配图表单的**纯逻辑**（#475 小程序半边）。
 *
 * 与 PC 端 `apps/web-pc/src/features/profile/review-images.tsx` 同一套状态机语义：
 * 槽位上限（`MAX_REVIEW_IMAGES` = 3）、每张图独立的上传状态（uploading / uploaded /
 * failed）、提交闸门（还有在途或失败的图就不许提交 —— 不允许静默丢弃，用户以为带图
 * 提交、实际没有）。
 *
 * 单独成文件的原因与 `../upload/mime.ts` 同款：这里不 import 任何 Taro 模块，
 * `bun test` 可以直接加载（组件层在 `components/review-dialog`，那边才碰 Taro）。
 */
import { MAX_REVIEW_IMAGES } from '@fish/contracts/transaction-reviews/schema'
import type { AllowedImageMime } from '@/features/upload/mime'

/** 单张配图的表单条目。`path` 是本地临时文件，只用于预览与（重试）上传，不落任何后端字段。 */
export type ReviewImageSlot = {
  id: string
  path: string
  mime: AllowedImageMime
  sizeBytes: number
  status: 'uploading' | 'uploaded' | 'failed'
  /** 上传确认后的 final 键（`reviews/…`）；未成功时为 null。 */
  objectKey: string | null
  /** 失败原因（网络 / 校验 / 服务端文案）；成功为 null。 */
  error: string | null
}

/**
 * 原子槽位预留（PC #483 审查响应的同款）：满槽返回 `null`，调用方**不得**创建条目或发起上传。
 *
 * 并发两次选图在同一渲染窗内读到的还是同一个列表，靠「事后」挡人会让已 confirm 的
 * 上传对象没有任何表单条目可挂 —— 孤儿对象。JS 单线程下「读-判-写」全同步的这段
 * 不会被交错，配合弹层的同步权威 `imagesRef`（每次增删改先写 ref 再进 state）即可不超订。
 */
export function appendWithinLimit(
  slots: readonly ReviewImageSlot[],
  entry: ReviewImageSlot,
  maxImages: number,
): ReviewImageSlot[] | null {
  if (slots.length >= maxImages) return null
  return [...slots, entry]
}

/**
 * 提交闸门（纯函数）：返回 `null` 表示可以提交，否则是给用户看的一句 toast 文案。
 * - 还有图片在上传中 → 等一等（提交载荷会缺键，服务端不会补）；
 * - 有失败图片 → 重试或移除，不允许静默丢弃；
 * - 超限兜底：并发选图窗口里可能比上限多（room 是按进入时的长度算的），宁可挡住，
 *   也不让服务端 422 变成用户看不懂的失败。
 */
export function reviewSubmitBlockedReason(
  slots: readonly ReviewImageSlot[],
  maxImages: number = MAX_REVIEW_IMAGES,
): string | null {
  if (slots.length > maxImages) return `最多 ${maxImages} 张配图，请先移除多余的`
  if (slots.some((slot) => slot.status === 'uploading')) return '还有图片正在上传，请稍候'
  if (slots.some((slot) => slot.status === 'failed')) {
    return '有图片未上传成功，请重试或移除后再提交'
  }
  return null
}

/** 提交给 `POST /transactions/:id/review` 的 `imageObjectKeys`：只收 uploaded 的键，槽位序即 sort_order。 */
export function uploadedObjectKeys(slots: readonly ReviewImageSlot[]): string[] {
  const keys: string[] = []
  for (const slot of slots) {
    if (slot.status === 'uploaded' && slot.objectKey !== null) keys.push(slot.objectKey)
  }
  return keys
}
