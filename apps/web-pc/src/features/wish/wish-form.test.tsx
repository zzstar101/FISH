import { describe, expect, mock, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import type { WishDto } from '@fish/contracts/wishes/schema'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * 许愿门禁（#514）：新建愿望（`POST /wishes`）在未绑定手机号时字段位换成绑定引导；
 * 编辑已有愿望走 PATCH，不在门禁内。radix 弹窗静态渲染为空，桩成直出子节点。
 */
let me: Me

mock.module('../auth/auth-provider', () => ({
  useAuth: () => ({ me, refetch: () => undefined }),
}))

mock.module('./queries', () => ({
  useCreateWish: () => ({ isPending: false, mutateAsync: async () => undefined }),
  useUpdateWish: () => ({ isPending: false, mutateAsync: async () => undefined }),
  wishKeys: { all: () => ['wishes'] },
}))

const passthrough = ({ children }: { children?: ReactNode }) => createElement('div', null, children)
mock.module('@fish/ui/dialog', () => ({
  Dialog: passthrough,
  DialogContent: passthrough,
  DialogDescription: passthrough,
  DialogFooter: passthrough,
  DialogHeader: passthrough,
  DialogTitle: passthrough,
}))

const { WishFormDialog } = await import('./wish-form')

const UNBOUND_ME: Me = {
  id: 'usr_01jc000000e00800000000000a',
  nickname: '阿岚',
  avatarUrl: null,
  authStatus: 'VERIFIED',
  verifiedAt: '2026-01-01T00:00:00.000Z',
  phoneBound: false,
  maskedPhone: null,
  signature: null,
}

const WISH: WishDto = {
  id: 'wsh_01jc000000e00800000000003t',
  userId: UNBOUND_ME.id,
  keyword: '考研数学书',
  category: 'BOOKS',
  budgetMinCents: 1000,
  budgetMaxCents: 5000,
  description: '整套即可',
  acceptSimilar: true,
  status: 'ACTIVE',
  matchCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function render(wish?: WishDto): string {
  const queryClient = new QueryClient()
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(WishFormDialog, {
        open: true,
        onOpenChange: () => undefined,
        ownerId: UNBOUND_ME.id,
        wish,
      }),
    ),
  )
  return html.replace(/<[^>]*>/g, '')
}

describe('WishFormDialog 手机号门禁（#514）', () => {
  test('新建 + 未绑定：只给绑定引导，不渲染可提交字段', () => {
    me = UNBOUND_ME
    const text = render()
    expect(text).toContain('需要先绑定手机号')
    expect(text).not.toContain('关键词')
    expect(text).not.toContain('预算区间')
  })

  test('新建 + 已绑定：照常渲染表单', () => {
    me = { ...UNBOUND_ME, phoneBound: true, maskedPhone: '138****0000' }
    const text = render()
    expect(text).toContain('关键词')
    expect(text).not.toContain('需要先绑定手机号')
  })

  test('编辑已有愿望不拦，即使未绑定', () => {
    me = UNBOUND_ME
    const text = render(WISH)
    expect(text).toContain('编辑愿望')
    expect(text).toContain('保存修改')
    expect(text).not.toContain('需要先绑定手机号')
  })
})
