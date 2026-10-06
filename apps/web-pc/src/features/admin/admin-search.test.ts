import { describe, expect, test } from 'bun:test'
import { UserRoleSchema } from '@fish/contracts/admin/schema'
import {
  cursorSearch,
  dayRangeSearch,
  optionalSearch,
  trimmedSearch,
  withoutCursor,
} from './admin-search'

describe('trimmedSearch', () => {
  test('trim 后非空才采纳', () => {
    expect(trimmedSearch('  自行车  ')).toBe('自行车')
    expect(trimmedSearch('   ')).toBeUndefined()
    expect(trimmedSearch(42)).toBeUndefined()
    expect(trimmedSearch(undefined)).toBeUndefined()
  })

  test('超长丢弃（与服务端 max(50) 同口径）', () => {
    expect(trimmedSearch('a'.repeat(50))).toBe('a'.repeat(50))
    expect(trimmedSearch('a'.repeat(51))).toBeUndefined()
  })
})

describe('optionalSearch / cursorSearch', () => {
  test('非法枚举丢弃', () => {
    expect(optionalSearch(UserRoleSchema, 'ADMIN')).toBe('ADMIN')
    expect(optionalSearch(UserRoleSchema, 'FOO')).toBeUndefined()
    expect(optionalSearch(UserRoleSchema, undefined)).toBeUndefined()
  })

  test('cursor 任意非空串原样回传（不透明，只校验形态在服务端）', () => {
    expect(cursorSearch('abc.def')).toBe('abc.def')
    expect(cursorSearch('')).toBeUndefined()
    expect(cursorSearch(123)).toBeUndefined()
  })
})

describe('dayRangeSearch（左闭右开）', () => {
  test('至某天换算为次日零点（排他）', () => {
    const range = dayRangeSearch('2026-10-01', '2026-10-03')
    expect(range.createdFrom).toBe(new Date(2026, 9, 1).toISOString())
    expect(range.createdTo).toBe(new Date(2026, 9, 4).toISOString())
  })

  test('只传一端时另一端省略', () => {
    expect(dayRangeSearch('2026-10-01', undefined)).toEqual({
      createdFrom: new Date(2026, 9, 1).toISOString(),
    })
    expect(dayRangeSearch(undefined, '2026-10-03')).toEqual({
      createdTo: new Date(2026, 9, 4).toISOString(),
    })
  })

  test('非法日期整体省略（不发送半截条件）', () => {
    expect(dayRangeSearch('2026-13-01', 'not-a-day')).toEqual({})
    expect(dayRangeSearch('2026-02-30', undefined)).toEqual({})
  })
})

describe('withoutCursor', () => {
  test('剥掉 cursor、保留其余条件', () => {
    expect(withoutCursor({ q: '自行车', status: 'ACTIVE', cursor: 'abc' })).toEqual({
      q: '自行车',
      status: 'ACTIVE',
    })
    const noCursor = { q: 'x' }
    expect(withoutCursor(noCursor)).toEqual({ q: 'x' })
  })
})
