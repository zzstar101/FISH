import type { ListingUpdateInput } from '@fish/contracts/listings/schema'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createListing, fetchListingDetail, updateListing } from '../listing/api'

/**
 * #6 的写路径数据入口（前端部分）。
 * 真实链路是 presign → 直传 S3 → `POST /listings`（编辑为 `PATCH /listings/:id`），
 * 图片上传在 `sell/api.ts`。发布成功返回 ListingDetail，供成功页渲染商品卡。
 */
export function useCreateListing() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createListing,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['feed'] })
      void queryClient.invalidateQueries({ queryKey: ['category'] })
      void queryClient.invalidateQueries({ queryKey: ['search'] })
      void queryClient.invalidateQueries({ queryKey: ['profile'] })
      void queryClient.invalidateQueries({ queryKey: ['mylist'] })
    },
  })
}

export function useUpdateListing() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ListingUpdateInput }) =>
      updateListing(id, input),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['listing', variables.id] })
      void queryClient.invalidateQueries({ queryKey: ['mylist'] })
      void queryClient.invalidateQueries({ queryKey: ['feed'] })
      void queryClient.invalidateQueries({ queryKey: ['profile'] })
    },
  })
}

/** 编辑模式：按 id 取回原商品，未传 id 时不请求。 */
export function useListingForEdit(id?: string) {
  return useQuery({
    queryKey: ['listing', id, 'edit'],
    queryFn: () => fetchListingDetail(id ?? ''),
    enabled: Boolean(id),
  })
}
