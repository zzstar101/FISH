import { describe, expect, test } from 'bun:test'
import type { ProfileResponse } from '@fish/contracts/profile/schema'
import { Hono } from 'hono'
import { createProfileRouter } from './router'
import type { ProfileService } from './service'

const profile = {
  user: {
    id: 'user-1',
    nickname: '小明',
    avatarUrl: null,
    campus: '肇庆',
    authStatus: 'VERIFIED',
    verifiedAt: '2026-09-12T00:00:00.000Z',
  },
  stats: { activeListings: 1, activeWishes: 1, completedTransactions: 1 },
  listings: [],
  wishes: [],
  transactions: [],
} as unknown as ProfileResponse

describe('profile router', () => {
  test('GET /profile returns the aggregate for the authenticated user', async () => {
    const service: ProfileService = { getProfile: async () => profile }
    const root = new Hono<{ Variables: { userId: string; me: unknown } }>()
    root.use('/profile/*', async (c, next) => {
      c.set('userId', 'user-1')
      c.set('me', profile.user)
      await next()
    })
    root.route(
      '/profile',
      createProfileRouter({
        service,
        requireAuth: async (_c, next) => {
          await next()
        },
      }),
    )

    const response = await root.request('/profile')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(profile)
  })

  test('passes the context Me to the service (user 块不重复查库)', async () => {
    let received: unknown
    const service: ProfileService = {
      getProfile: async (me) => {
        received = me
        return profile
      },
    }
    const root = new Hono<{ Variables: { userId: string; me: unknown } }>()
    root.use('/profile/*', async (c, next) => {
      c.set('userId', 'user-1')
      c.set('me', profile.user)
      await next()
    })
    root.route(
      '/profile',
      createProfileRouter({
        service,
        requireAuth: async (_c, next) => {
          await next()
        },
      }),
    )

    await root.request('/profile')
    expect(received).toEqual(profile.user)
  })
})
