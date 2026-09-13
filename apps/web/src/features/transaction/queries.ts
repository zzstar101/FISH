import type { TransactionRole } from '@fish/contracts/transactions/schema'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  acceptTransaction,
  cancelTransaction,
  confirmTransaction,
  fetchTransactions,
  proposeTransaction,
  rejectTransaction,
} from './api'

/**
 * #11 的数据入口：交易状态机的读写全部走真实 API（#41）。
 * 提案/接受/拒绝以 SYSTEM 消息进会话；列表只含已创建的交易行
 * （PENDING_MEETUP / COMPLETED / CANCELLED）。
 */
export function useTransactions(role?: TransactionRole) {
  return useQuery({
    queryKey: ['transactions', role ?? 'all'],
    queryFn: () => fetchTransactions(role),
  })
}

function useInvalidatingMutation<TVariables, TResult>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    // 终态影响交易列表、交易详情、商品状态（RESERVED/SOLD/ACTIVE 联动）与
    // 聊天消息流（accept/reject 会写入 SYSTEM 消息，同时刷新消息查询）。
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['transactions'] })
      void queryClient.invalidateQueries({ queryKey: ['chat'] })
      void queryClient.invalidateQueries({ queryKey: ['listing'] })
      void queryClient.invalidateQueries({ queryKey: ['profile'] })
    },
  })
}

export function useAcceptTransaction() {
  return useInvalidatingMutation((input: { conversationId: string; amountCents: number }) =>
    acceptTransaction(input.conversationId, input.amountCents),
  )
}

export function useRejectTransaction() {
  return useInvalidatingMutation((conversationId: string) => rejectTransaction(conversationId))
}

export function useConfirmTransaction() {
  return useInvalidatingMutation((id: string) => confirmTransaction(id))
}

export function useCancelTransaction() {
  return useInvalidatingMutation((id: string) => cancelTransaction(id))
}

/** 买家发起交易确认：往会话写 tx.proposal SYSTEM 消息（刷新消息流即可见）。 */
export function useProposeTransaction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { conversationId: string; amountCents: number }) =>
      proposeTransaction(input.conversationId, input.amountCents),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['chat'] }),
  })
}
