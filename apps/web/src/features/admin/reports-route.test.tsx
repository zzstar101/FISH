import { expect, test } from 'bun:test'
import { reportsQueueForSearch } from './reports-queue-page'

test('URL back/forward remounts pagination for a changed filter without remounting the same filter', () => {
  const pending = { status: 'PENDING', targetType: 'LISTING' }
  const handled = { status: 'HANDLED', targetType: 'LISTING' }
  const first = reportsQueueForSearch(pending)
  const second = reportsQueueForSearch(handled)
  const back = reportsQueueForSearch(pending)
  expect(first.key).not.toBe(second.key)
  expect(back.key).toBe(first.key)
  expect(reportsQueueForSearch({ ...pending, reason: 'FRAUD' }).key).not.toBe(first.key)
  expect(reportsQueueForSearch({ ...pending, status: 'PENDING' }).key).toBe(first.key)
})
