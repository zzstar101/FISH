import type { ReportCreateInput } from '@fish/contracts/reports/schema'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/auth-provider'
import { fetchMyReports, submitReport } from './api'

const mineKey = ['reports', 'mine'] as const

export function useMyReports() {
  const { me } = useAuth()
  return useInfiniteQuery({
    queryKey: [...mineKey, me?.id ?? null],
    queryFn: ({ pageParam }) => fetchMyReports(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: me !== null,
  })
}

export function useSubmitReport() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ReportCreateInput) => submitReport(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: mineKey }),
  })
}
