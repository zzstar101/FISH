/**
 * 会话页要的那一笔交易（#522）。
 *
 * 契约把终态（COMPLETED / CANCELLED）明确排除在 SYSTEM 消息之外
 * （`transactions/schema.ts` 的 `transactionSystemEventSchema` 注释：前端以交易详情 /
 * 列表为终态来源），所以会话页**必须自己查交易域**，只看聊天记录永远停在
 * 「已接受交易，待面交」。
 *
 * 取数口径与会话列表页一致：`GET /transactions?role=` 按视角取，再用
 * `transactionsByConversation` 挑最新一笔 —— 同一会话可以有多笔历史交易（取消后重新
 * 接受会再建一笔），「最新」才是当前那笔。
 */
import type { TransactionDto, TransactionRole } from '@fish/contracts/transactions/schema'
import { transactionsByConversation } from '@/features/chat/capsule'
import { fetchAllTransactions } from './api'

/** `conversationId` 当前对应的交易；`null` = 这条会话还没有被接受过的交易。 */
export async function fetchConversationTransaction(
  conversationId: string,
  role: TransactionRole,
): Promise<TransactionDto | null> {
  const page = await fetchAllTransactions(role)
  return transactionsByConversation(page.items, []).get(conversationId) ?? null
}
