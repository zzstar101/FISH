import { describe, expect, test } from 'bun:test'
import { pendingSectionMode } from './pending-view'

const base = {
  isError: false,
  failed: false,
  isPending: false,
  proposalCount: 0,
  hasNotice: false,
}

describe('pendingSectionMode', () => {
  test('hides the section when there is nothing to show or say', () => {
    expect(pendingSectionMode(base)).toBe('hidden')
  })

  test('keeps the section alive to finish the sentence after a decision', () => {
    // 同意之后这一件会从列表消失；若整段不渲染，「已同意…去我卖出的出示交易码」就没了
    expect(pendingSectionMode({ ...base, hasNotice: true })).toBe('list')
    expect(pendingSectionMode({ ...base, proposalCount: 2 })).toBe('list')
  })

  test('reports "could not read" instead of pretending nothing is waiting', () => {
    expect(pendingSectionMode({ ...base, isError: true })).toBe('error')
    expect(pendingSectionMode({ ...base, failed: true })).toBe('error')
  })

  test('an unreadable list does not swallow the decision the user just made', () => {
    // 决定已写进服务端，而随后这次重读失败是另一件事：错误态优先于提示，
    // 但组件必须能在错误卡片里继续渲染 notice（由 hasNotice 保留渲染义务）
    expect(pendingSectionMode({ ...base, isError: true, hasNotice: true })).toBe('error')
  })

  test('an unreadable list beats the loading state', () => {
    expect(pendingSectionMode({ ...base, isPending: true })).toBe('loading')
    expect(pendingSectionMode({ ...base, isPending: true, isError: true })).toBe('error')
  })
})
