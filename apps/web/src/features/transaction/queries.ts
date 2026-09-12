import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  acceptOrder,
  cancelOrder,
  fetchOrders,
  finishOrder,
  openConversationWith,
  rejectOrder,
  requestOrder,
} from '../../lib/mock/store'

/** #11 的数据入口：交易状态机的读写都在这里（真实实现由 #11 后端提供）。 */
export function useOrders(role: 'buy' | 'sell') {
  return useQuery({ queryKey: ['orders', role], queryFn: () => fetchOrders(role) })
}

function useOrderAction(action: (orderId: string) => Promise<void>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: action,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
      void queryClient.invalidateQueries({ queryKey: ['listing'] })
    },
  })
}

export function useAcceptOrder() {
  return useOrderAction(acceptOrder)
}

export function useCancelOrder() {
  return useOrderAction(cancelOrder)
}

export function useFinishOrder() {
  return useOrderAction(finishOrder)
}

export function useRejectOrder() {
  return useOrderAction(rejectOrder)
}

/** 买家发起交易确认：创建 REQUESTED 订单（#11 的第一步写操作）。 */
export function useRequestOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (listingId: string) => requestOrder(listingId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
  })
}

export function useContactCounterpart() {
  return useMutation({
    mutationFn: ({ peerId, listingId }: { peerId: string; listingId: string }) =>
      openConversationWith(peerId, listingId),
  })
}
