import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { accountDeletionKeys } from '../auth/queries'
import { AccountDeletionCard } from './account-deletion-card'

const OWNER_ID = 'usr_01jc000000e00800000000000a'

function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

function render(seed: (client: QueryClient) => void): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  seed(queryClient)
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(AccountDeletionCard, { ownerId: OWNER_ID }),
    ),
  )
}

/*
 * 三个状态分支必须互斥：注销入口只有一个，且**只在服务端说 ACTIVE 时**才给「申请注销」。
 * 端上不在本地记「我点过申请了」——同一账号可能在另一台设备申请或撤回。
 */
test('ACTIVE 时给出申请入口，不出现撤回按钮', () => {
  const text = textOf(
    render((client) => {
      client.setQueryData(accountDeletionKeys.status(OWNER_ID), {
        status: 'ACTIVE',
        requestedAt: null,
        purgeScheduledAt: null,
      })
    }),
  )

  expect(text).toContain('注销账号')
  expect(text).toContain('申请注销')
  expect(text).toContain('7 天冷静期')
  expect(text).not.toContain('撤回注销申请')
})

test('冷静期内只给撤回入口，倒计时取服务端的 purgeScheduledAt', () => {
  const text = textOf(
    render((client) => {
      client.setQueryData(accountDeletionKeys.status(OWNER_ID), {
        status: 'DELETION_REQUESTED',
        requestedAt: '2026-10-01T00:00:00.000Z',
        purgeScheduledAt: '2099-10-08T00:00:00.000Z',
      })
    }),
  )

  expect(text).toContain('注销申请已提交')
  expect(text).toContain('冷静期剩余')
  expect(text).toContain('撤回注销申请')
  expect(text).not.toContain('申请注销')
})

/*
 * 读不到状态时**一个动作都不给**：本地猜一个「未申请」会让冷静期内的用户看到假的申请按钮，
 * 点下去只会拿到 200 + 既有状态（幂等），用户以为自己重新申请了、计时重置了。
 *
 * 读取失败（网络/500）与读取中同属「状态未知」，共用这条断言；错误分支本身渲染不出静态
 * 字符串（SSR 下 `useQuery` 的错误态会被挂载即重取覆盖成 pending），所以不在这里单独钉。
 */
test('状态未知时不给任何注销动作，只报读取中', () => {
  const text = textOf(render(() => {}))

  expect(text).toContain('正在读取账号状态')
  expect(text).not.toContain('申请注销')
  expect(text).not.toContain('撤回注销申请')
})
