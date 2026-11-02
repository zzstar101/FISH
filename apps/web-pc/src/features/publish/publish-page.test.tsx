import { describe, expect, mock, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * 发布门禁（#514）：未绑定手机号的账号进 /publish 只看到绑定引导，不给可填表单；
 * 已绑定照常渲染表单。页面只读 `useAuth().me`，其余依赖桩掉。
 */
let me: Me

mock.module('../auth/auth-provider', () => ({
  useAuth: () => ({ me, refetch: () => undefined }),
}))

mock.module('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children?: ReactNode }) =>
    createElement('a', { href: to }, children),
  useNavigate: () => () => undefined,
}))

mock.module('./queries', () => ({
  useCreateListing: () => ({ mutateAsync: async () => undefined }),
  usePolishCandidates: () => ({ mutate: () => undefined }),
}))

const { PublishPage } = await import('./publish-page')

const BASE_ME: Me = {
  id: 'usr_01jc000000e00800000000000a',
  nickname: '阿岚',
  avatarUrl: null,
  authStatus: 'VERIFIED',
  verifiedAt: '2026-01-01T00:00:00.000Z',
  phoneBound: false,
  maskedPhone: null,
  signature: null,
}

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

function render(): string {
  return textOf(renderToStaticMarkup(createElement(PublishPage)))
}

describe('PublishPage 手机号门禁（#514）', () => {
  test('未绑定手机号：渲染绑定引导，不渲染可填表单', () => {
    me = { ...BASE_ME, phoneBound: false, maskedPhone: null }
    const text = render()
    expect(text).toContain('需要先绑定手机号')
    expect(text).toContain('「鱼小应」→「我的」→「设置」→「手机号」')
    expect(text).not.toContain('商品信息')
    expect(text).not.toContain('发布检查')
  })

  test('已绑定手机号：照常渲染表单', () => {
    me = { ...BASE_ME, phoneBound: true, maskedPhone: '138****0000' }
    const text = render()
    expect(text).toContain('商品信息')
    expect(text).toContain('发布检查')
    expect(text).not.toContain('需要先绑定手机号')
  })
})
