import { describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * 黑名单页页头文案的静态渲染（web-pc 没有 jsdom，与 `block-button.test.tsx` 同款桩法：
 * `renderToStaticMarkup` + `mock.module` 替掉路由/数据钩子）。
 *
 * 钉的是 #466 增量复审改过的那句口径：拉黑是**双向**生效、解除是**单方**动作。
 * 旧文案「解除后立即恢复」把单方解除说成无条件恢复，与 `apps/api/src/modules/blocks/store.ts`
 * 里双向 OR 谓词的行为不符——被拉黑的那一方自己点解除不会恢复互发。
 */
mock.module('../auth/auth-provider', () => ({
  useAuth: () => ({ me: { id: 'usr_01jc000000e0080000000000a1' } }),
}))

mock.module('./queries', () => ({
  // 空列表：只要页头那一段文案，行内 `Link`（需要 router context）不会被渲染到。
  useMyBlocks: () => ({
    data: { pages: [{ items: [] }] },
    fetchNextPage: () => undefined,
    hasNextPage: false,
    isError: false,
    isFetchNextPageError: false,
    isFetchingNextPage: false,
    isPending: false,
    isSuccess: true,
    refetch: () => undefined,
  }),
  useUnblockUser: () => ({
    data: undefined,
    isPending: false,
    mutateAsync: () => undefined,
    reset: () => undefined,
  }),
}))

const { BlockedPage } = await import('./blocked-page')

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

const NOTICE = textOf(renderToStaticMarkup(<BlockedPage />))

describe('BlockedPage 页头文案（#466 增量复审）', () => {
  test('解除口径写成单方动作，不再承诺「解除后立即恢复」', () => {
    expect(NOTICE).toContain('拉黑后你们双方都无法互发消息、也无法新建会话')
    expect(NOTICE).toContain('解除是单方的')
    expect(NOTICE).toContain('对方若也拉黑了你，需对方一并解除后才恢复')
    expect(NOTICE).not.toContain('解除后立即恢复')
  })

  test('页头仍在（渲染桩没把页面整体打空，避免上一条断言假通过）', () => {
    expect(NOTICE).toContain('黑名单')
  })
})
