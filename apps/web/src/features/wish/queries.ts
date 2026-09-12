import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { closeWish, createWish, fetchWishes } from '../../lib/mock/store'

/**
 * #7 的数据入口。
 * 契约已合并（`@fish/contracts/wishes/*`），但 `app.ts` 尚未挂载 wishes router（待协调项 ⑤），
 * 因此这里先走 Mock；#13 再切真实 API。
 */
export function useWishes() {
  return useQuery({ queryKey: ['wishes'], queryFn: fetchWishes })
}

export function useCreateWish() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ keyword, budgetCents }: { keyword: string; budgetCents: number }) =>
      createWish(keyword, budgetCents),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['wishes'] }),
  })
}

export function useCloseWish() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => closeWish(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['wishes'] }),
  })
}
