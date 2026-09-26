import { expect, test } from 'bun:test'
import type { AdminAuditLogPage } from '@fish/contracts/admin/schema'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { AuditLogsPage } from './audit-logs-page'
import { adminKeys } from './queries'

test('审计目标无法解析时只显示类型，不显示空编号', () => {
  const client = new QueryClient()
  const body = {
    items: [
      {
        id: 'aud_01jc000000e00800000000000a',
        actor: null,
        action: 'REPORT_DECISION',
        targetType: 'USER',
        targetId: null,
        before: null,
        after: null,
        reason: null,
        requestId: null,
        createdAt: '2026-09-26T00:00:00.000Z',
      },
    ],
    nextCursor: null,
  } satisfies AdminAuditLogPage
  client.setQueryData(
    adminKeys.auditLogs({
      action: undefined,
      targetType: undefined,
      cursor: undefined,
      limit: 20,
    }),
    body,
  )

  const html = renderToString(
    createElement(QueryClientProvider, { client }, createElement(AuditLogsPage)),
  )
  const visibleText = html.replaceAll('<!-- -->', '')
  expect(visibleText).toContain('目标：用户')
  expect(visibleText).not.toContain('目标：用户（')
})
