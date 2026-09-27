import type { ListingCreateInput } from '@fish/contracts/listings/schema'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createListing, fetchPolishCandidates } from './api'

export function useCreateListing() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ input, signal }: { input: ListingCreateInput; signal?: AbortSignal }) =>
      createListing(input, signal),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pc', 'listings'] })
    },
  })
}

export function usePolishCandidates() {
  return useMutation({
    mutationFn: ({
      input,
      signal,
    }: {
      input: Parameters<typeof fetchPolishCandidates>[0]
      signal?: AbortSignal
    }) => fetchPolishCandidates(input, signal),
  })
}
