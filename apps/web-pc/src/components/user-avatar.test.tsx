import { describe, expect, test } from 'bun:test'
import defaultAvatarSrc from '@fish/ui/assets/avatar-default.png'
import { UserAvatar } from '@fish/ui/user-avatar'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * `packages/ui/src/user-avatar.tsx` 的兜底判据（#618）。
 *
 * 为什么放在 web-pc 而不是 `packages/ui`：仓库没有 jsdom，组件只能静态渲染
 * （`renderToStaticMarkup`），而 `react-dom` 只装在 web-pc（见 `apps/web-pc/package.json`）。
 *
 * 断言的是这次改动的行为：`avatarUrl` 为空时头像位的兜底里画的是**默认头像插画**，
 * 而不是旧实现的「昵称首字母 + 色块」（旧版 fallback 里是一个装着字母的 `<span>`）。
 * 静态渲染下 radix `AvatarImage` 还没 loaded，所以真实 URL 也走 fallback；
 * 「真图优先」由 radix 的 loaded 状态在浏览器里保证，不在本用例覆盖范围。
 */
const DEFAULT_IMG = `<img alt="" class="size-full object-cover" src="${defaultAvatarSrc}"/>`

function html(avatarUrl: string | null | undefined, size?: 'sm' | 'default' | 'lg' | 'xl'): string {
  return renderToStaticMarkup(createElement(UserAvatar, { avatarUrl, size }))
}

describe('UserAvatar / 无头像时落统一默认头像', () => {
  test('null → 兜底里画的是默认头像插画，不再是昵称首字母', () => {
    const markup = html(null)
    expect(markup).toContain(DEFAULT_IMG)
    // 旧实现的 fallback 里是文字节点（装一个字母的 <span>），改后是这张图 —— 这一条改前会红
    expect(markup).toMatch(/data-slot="avatar-fallback"[^>]*><img /)
  })

  test('undefined / 空串 / 纯空白 → 同样落默认头像', () => {
    for (const avatarUrl of [undefined, '', '   ']) {
      expect(html(avatarUrl)).toContain(DEFAULT_IMG)
    }
  })

  test('尺寸档位仍透传到 Avatar 根节点（版式不变）', () => {
    expect(html(null, 'xl')).toContain('data-size="xl"')
  })
})
