import {
  type ListingFeedResponse,
  ListingFeedResponseSchema,
} from '@fish/contracts/listings/schema'
import { USER_ROUTES } from '@fish/contracts/users/routes'
import {
  PublicUserIdSchema,
  type PublicUserProfile,
  PublicUserProfileSchema,
} from '@fish/contracts/users/schema'
import { ApiError, apiRequest } from '../../lib/api-client'

export async function fetchPublicUser(userId: string): Promise<PublicUserProfile | null> {
  if (!PublicUserIdSchema.safeParse(userId).success) return null
  try {
    return PublicUserProfileSchema.parse(await apiRequest(USER_ROUTES.publicProfile(userId)))
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === 'USER_NOT_FOUND') {
      return null
    }
    throw error
  }
}

export async function fetchPublicUserListings(
  userId: string,
  cursor: string | null = null,
): Promise<ListingFeedResponse> {
  const id = PublicUserIdSchema.parse(userId)
  const query = new URLSearchParams({ limit: '20' })
  if (cursor !== null) query.set('cursor', cursor)
  return ListingFeedResponseSchema.parse(
    await apiRequest(`${USER_ROUTES.activeListings(id)}?${query}`),
  )
}
