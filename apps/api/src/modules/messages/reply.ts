import { type MessageReply, messageReplySchema } from '@fish/contracts/chat/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { ReplyTargetRow } from './store'

/**
 * 引用（#359 3b）的共享内核：`messages` 域的文本/商品卡路径与 `media` 域的图片/语音
 * 路径都要做同一件事 —— 校验被引用行可用、把它压成一段可读摘引。两处各写一份必然漂移
 * （比如一边放行已撤回目标、另一边截断长度不同），所以判据只在这里。
 */

/** 引用摘要的长度上限（契约 `messageReplySchema.excerpt` 的 max）。 */
export const REPLY_EXCERPT_MAX = 120

/**
 * 被引用行的可读摘要。与会话行摘要（`conversations/store.ts` 的 `lastMessageContent`）
 * 同一套口径：TEXT 原文截断、MEDIA/LISTING 用方括号占位、已撤回统一 `[消息已撤回]`。
 */
export function replyExcerpt(target: ReplyTargetRow): string {
  if (target.recalled_at) return '[消息已撤回]'
  if (target.type === 'MEDIA') return '[媒体]'
  if (target.type === 'LISTING') return '[商品]'
  const text = target.content.trim()
  if (text.length === 0) return '[消息]'
  // 截断留出省略号一位：`excerpt` 的契约上限含省略号，121 字会被 schema 拒掉。
  return text.length > REPLY_EXCERPT_MAX ? `${text.slice(0, REPLY_EXCERPT_MAX - 1)}…` : text
}

/** 引用块 → 契约投射。 */
export function toReply(target: ReplyTargetRow): MessageReply {
  return messageReplySchema.parse({
    id: encodePublicId(PUBLIC_ID_PREFIX.message, target.id),
    senderId: target.sender_id ? encodePublicId(PUBLIC_ID_PREFIX.user, target.sender_id) : null,
    excerpt: replyExcerpt(target),
  })
}

/** 引用目标不可用的统一信号；两域各自翻译成自己的错误码（同为 422）。 */
export class ReplyTargetInvalidError extends Error {
  constructor() {
    super('被引用的消息不可引用')
    this.name = 'ReplyTargetInvalidError'
  }
}

export type ReplyTargetLookup = (ids: string[]) => Promise<Map<string, ReplyTargetRow>>

/**
 * 校验并返回可落库的被引用 id（`undefined` = 本次没有引用）。
 *
 * 判据：必须存在、必须在**本会话**内（跨会话的合法 id 一律拒绝，不泄漏其它会话的
 * 消息是否存在）、不是 SYSTEM（服务端写入的交易事实不能被挂到用户消息上）、且未撤回。
 * 四类原因统一抛 `ReplyTargetInvalidError`，不给状态空间开探针。
 */
export async function resolveReplyTarget(
  lookup: ReplyTargetLookup,
  conversationId: string,
  replyToId: string | undefined,
): Promise<string | null> {
  if (!replyToId) return null
  const target = (await lookup([replyToId])).get(replyToId)
  if (!target) throw new ReplyTargetInvalidError()
  if (target.conversation_id !== conversationId) throw new ReplyTargetInvalidError()
  if (target.type === 'SYSTEM' || target.recalled_at) throw new ReplyTargetInvalidError()
  return replyToId
}
