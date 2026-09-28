/**
 * 「未通过原因」的呈现判定（无 Taro，`tests/mylist-list.test.ts` 直接 import）。
 *
 * 服务端的 `moderationReason` 是**原始文本**，两种来源混在一个字段里（见契约
 * `ListingCardSchema.moderationReason`）：
 *
 * - 机器判定 → 规则码（`PROHIBITED_CONTENT` / `CONTENT_REQUIRES_REVIEW` /
 *   `LOCAL_IMAGE_NOT_AUDITED`），卖家看不懂；
 * - 人工终审 → 管理员填的原因原文（1–500 字自由文本），本来就是给人看的。
 *
 * 所以这里要做的只有两件事：**把认得的规则码翻成人话**，以及**把结果截断到能显示的长度**。
 * 不认识的码原样透出（宁可是个英文码，也不要编一句可能不对的"原因"）。
 */

/**
 * 规则码 → 一句人话。只列服务端**现在真的会写**的码（`moderation/rules.ts` 与
 * `providers/local.ts`）；漏了也不会错，只是没翻译。
 */
const REASON_TEXT: Record<string, string> = {
  // 文本命中阻断词表（`moderation/rules.ts` 的 PROHIBITED_CONTENT 规则）
  PROHIBITED_CONTENT: '标题或描述里含平台禁止发布的内容',
  // 本地 transport 不审图片内容，图片一律进人工队列（`providers/local.ts`）
  LOCAL_IMAGE_NOT_AUDITED: '图片需要人工复核',
  // 机器只能判到「要人看」这一档，不是拒绝理由；正常不会出现在 BLOCKED 上
  CONTENT_REQUIRES_REVIEW: '内容需要人工复核',
}

/**
 * 展示用的一句话。
 *
 * **截断是必须的**：人工终审的原因上限 500 字，而这里只有卡片上的一行。
 * 截断在**字符**上做（中文一个字算一个），不是字节 —— 卡片的宽度约束本来就是按字算的。
 * 超出时补省略号，让用户知道还有下文（详情页/管理端才是全文的出处）。
 */
export function moderationReasonText(
  reason: string | null | undefined,
  maxChars = 40,
): string | null {
  if (reason === null || reason === undefined) return null
  const trimmed = reason.trim()
  if (trimmed.length === 0) return null
  const text = REASON_TEXT[trimmed] ?? trimmed
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…`
}

/**
 * 卡片上那句红字的完整文案（含前缀）。
 *
 * 前缀「未通过原因：」不是废话：卡片上还有「审核中」「平台下架」等别的说明，
 * 单独一句「标题或描述里含平台禁止发布的内容」看不出它是**为什么**被摆在这里的。
 */
export function rejectionNote(reason: string | null | undefined): string | null {
  const text = moderationReasonText(reason)
  return text === null ? null : `未通过原因：${text}`
}
