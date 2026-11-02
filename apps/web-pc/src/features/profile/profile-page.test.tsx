import { describe, expect, mock, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * 「我的」页手机号行（#514）：未绑定时不只是死文案，旁边给「如何绑定」入口（弹层内是同一张
 * 去小程序绑定的引导卡）；已绑定照旧只展示脱敏号码。页面只读 useProfile 的 user，其余依赖桩掉。
 */
let user: Me

mock.module('../auth/auth-provider', () => ({
  useAuth: () => ({ me: user }),
}))

mock.module('../auth/queries', () => ({
  useLogout: () => ({ isPending: false, mutateAsync: async () => undefined }),
}))

mock.module('./queries', () => ({
  useProfile: () => ({
    isPending: false,
    isError: false,
    data: {
      user,
      stats: {
        activeListings: 0,
        activeWishes: 0,
        completedTransactions: 0,
        followingCount: 0,
      },
    },
  }),
}))

mock.module('../favorites/queries', () => ({
  useFavoritesTotal: () => ({ isError: false, data: 0 }),
}))

mock.module('../view-history/queries', () => ({
  useViewHistoryTotal: () => ({ isError: false, data: 0 }),
}))

mock.module('./account-deletion-card', () => ({ AccountDeletionCard: () => null }))
mock.module('./profile-edit', () => ({ ProfileEditDialog: () => null }))

mock.module('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) =>
    createElement('a', { href: to }, children),
}))

const { ProfilePage } = await import('./profile-page')

const BASE_USER: Me = {
  id: 'usr_01jc000000e00800000000000a',
  nickname: '阿岚',
  avatarUrl: null,
  authStatus: 'VERIFIED',
  verifiedAt: '2026-01-01T00:00:00.000Z',
  phoneBound: false,
  maskedPhone: null,
  signature: null,
}

function render(): string {
  return renderToStaticMarkup(createElement(ProfilePage)).replace(/<[^>]*>/g, '')
}

describe('ProfilePage 手机号行（#514）', () => {
  test('未绑定：给出「如何绑定」入口', () => {
    user = BASE_USER
    const text = render()
    expect(text).toContain('未绑定手机号')
    expect(text).toContain('如何绑定')
  })

  test('已绑定：只展示脱敏号码，不给绑定入口', () => {
    user = { ...BASE_USER, phoneBound: true, maskedPhone: '138****0000' }
    const text = render()
    expect(text).toContain('手机号 138****0000')
    expect(text).not.toContain('如何绑定')
  })
})
