import { describe, expect, mock, test } from 'bun:test'
import type { AdminMeResponse } from '@fish/contracts/admin/schema'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError } from '../../lib/api-client'

/**
 * AdminShell 的四个分支只看 `useAdminMe` 的返回值（本仓测试惯例：静态渲染 + 桩掉 router 上下文）：
 * pending → 校验中；403 FORBIDDEN → 整页无权限态（不给假重试）；其它错误 → ErrorState 可重试；
 * **成功 → 后台骨架**（导航 / 昵称 / 能力）。
 *
 * 最后一条是 bb5f34ae 的回归护栏：修之前 `outcome` 只在 `isError` 时才有值，
 * 成功路径因此落进 `ErrorState('管理身份校验失败')`——把 `useAdminMe` 返回成功态即可复现。
 */
let meResult: Record<string, unknown>

mock.module('./admin-queries', () => ({
  useAdminMe: () => meResult,
}))

void mock.module('@tanstack/react-router', () => ({
  Link: (props: { to?: string; children?: ReactNode }) =>
    createElement('a', { href: props.to ?? '#' }, props.children),
  Outlet: () => createElement('div', { 'data-testid': 'outlet' }),
}))

const { AdminShell } = await import('./admin-shell')

const textOf = (html: string) => html.replace(/<[^>]*>/g, '')

const ADMIN_ME: AdminMeResponse = {
  admin: {
    id: 'usr_01jc000000e00800000000000a',
    nickname: '管理员甲',
    avatarUrl: null,
    authStatus: 'VERIFIED',
    verifiedAt: '2026-01-01T00:00:00.000Z',
    phoneBound: true,
    maskedPhone: '138****8000',
    signature: null,
    role: 'ADMIN',
  },
  capabilities: ['OVERVIEW_READ', 'MODERATION_WRITE'],
}

function render(mockResult: Record<string, unknown>): string {
  meResult = mockResult
  return renderToStaticMarkup(createElement(AdminShell, {}))
}

const okResult = (data: unknown, overrides: Record<string, unknown> = {}) => ({
  isPending: false,
  isError: false,
  data,
  error: null,
  refetch: () => undefined,
  ...overrides,
})

describe('AdminShell（#467 验收 1：管理壳四分支）', () => {
  test('成功态渲染后台骨架而不是校验失败', () => {
    const html = render(okResult(ADMIN_ME))
    const text = textOf(html)

    expect(text).not.toContain('管理身份校验失败')
    expect(text).not.toContain('无管理权限')
    expect(text).toContain('管理后台')
    expect(text).toContain('管理员甲')
    expect(text).toContain('管理员')
    expect(text).toContain('已开通能力')
    expect(text).toContain('平台概览')
    expect(text).toContain('人工审核')
    // 八项导航齐备，且 /admin 概览排第一。
    expect(text).toContain('概览')
    expect(text).toContain('推荐指标')
    expect((html.match(/aria-label="管理导航"/g) ?? []).length).toBe(1)
    expect((html.match(/href="\/admin"/g) ?? []).length).toBeGreaterThan(0)
  })

  test('403 FORBIDDEN 给整页无权限态、不给重试假动作', () => {
    const text = textOf(
      render(
        okResult(undefined, {
          isError: true,
          error: new ApiError('FORBIDDEN', 403, '无权访问'),
        }),
      ),
    )

    expect(text).toContain('无管理权限')
    expect(text).toContain('当前账号不是管理员')
    expect(text).toContain('返回前台')
    expect(text).not.toContain('重试')
    expect(text).not.toContain('管理导航')
  })

  test('非权限错误给可重试的错误态', () => {
    const text = textOf(
      render(okResult(undefined, { isError: true, error: new Error('socket hang up') })),
    )

    expect(text).toContain('网络异常，请稍后重试')
    expect(text).toContain('重试')
    expect(text).not.toContain('无管理权限')
  })

  test('校验中给加载态', () => {
    const text = textOf(render(okResult(undefined, { isPending: true })))

    expect(text).toContain('正在校验管理身份…')
    expect(text).not.toContain('管理导航')
  })
})
