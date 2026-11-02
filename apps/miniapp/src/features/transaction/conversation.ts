/**
 * 会话页要的那一笔交易（#522）。
 *
 * 契约把终态（COMPLETED / CANCELLED）明确排除在 SYSTEM 消息之外
 * （`transactions/schema.ts` 的 `transactionSystemEventSchema` 注释：前端以交易详情 /
 * 列表为终态来源），所以会话页**必须自己查交易域**，只看聊天记录永远停在
 * 「已接受交易，待面交」。
 *
 * 取数顺序：
 * 1. 消息里有 `tx.accepted` 的 id 时先**按 id 精确查**——列表接口最多翻
 *    `MAX_PAGES × PAGE_SIZE` 条，老用户的交易可能被截断；按 id 查还省掉最多 10 个
 *    串行请求。查回的行必须属于本会话（防止消息里的脏 id 串到别的会话）；
 * 2. 按 id 查失败 / 没有 id 时，回退到与会话列表页同一口径：`GET /transactions?role=`
 *    再用 `transactionsByConversation` 挑最新一笔 —— 同一会话可以有多笔历史交易
 *    （取消后重新接受会再建一笔），「最新」才是当前那笔。
 */
import type { TransactionDto, TransactionRole } from '@fish/contracts/transactions/schema'
import { transactionsByConversation } from '@/features/chat/capsule'
import { fetchAllTransactions, fetchTransaction } from './api'

/** `conversationId` 当前对应的交易；`null` = 这条会话还没有被接受过的交易。 */
export async function fetchConversationTransaction(
  conversationId: string,
  role: TransactionRole,
  preferredTxId?: string | null,
): Promise<TransactionDto | null> {
  if (preferredTxId) {
    try {
      const tx = await fetchTransaction(preferredTxId)
      if (tx.conversationId === conversationId) return tx
    } catch (error) {
      console.warn('[miniapp] 会话交易按 id 查询失败，回退列表', error)
    }
  }
  const page = await fetchAllTransactions(role)
  return transactionsByConversation(page.items, []).get(conversationId) ?? null
}
