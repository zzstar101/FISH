import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createListing, fetchListing, type ListingDraft, updateListing } from '../../lib/mock/store'

/**
 * #6 的数据入口（前端部分）。
 * 真实链路是 presign → 直传 S3 → `POST /listings`（编辑为 `PATCH /listings/:id`）；
 * Mock 阶段只保留「提交草稿」这一层，字段名与契约保持一致（priceCents 等）。
 */
export function useCreateListing() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (draft: ListingDraft) => createListing(draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['feed'] })
      void queryClient.invalidateQueries({ queryKey: ['profile'] })
      void queryClient.invalidateQueries({ queryKey: ['mylist'] })
    },
  })
}

export function useUpdateListing() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: ListingDraft }) => updateListing(id, draft),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['listing', variables.id] })
      void queryClient.invalidateQueries({ queryKey: ['mylist'] })
      void queryClient.invalidateQueries({ queryKey: ['feed'] })
    },
  })
}

/** 编辑模式：按 id 取回原商品，未传 id 时不请求。 */
export function useListingForEdit(id?: string) {
  return useQuery({
    queryKey: ['listing', id, 'edit'],
    queryFn: () => fetchListing(id ?? ''),
    enabled: Boolean(id),
  })
}
