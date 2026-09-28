import { describe, expect, test } from 'bun:test'
import { isForeignKeyViolation } from './pg-errors'

/**
 * SQLSTATE 谓词的走链判定。
 *
 * 形状照抄真实链路：Bun 的 `PostgresError` 把 SQLSTATE 放在 `errno` 上，Drizzle 再包一层
 * `{ query, params, cause }`。这里造的就是那一层包装 —— 少了走链逻辑，所有判定都会漏。
 */
const fkError = () =>
  Object.assign(new Error('violates foreign key constraint'), { errno: '23503' })
const uniqueError = () => Object.assign(new Error('duplicate key value'), { errno: '23505' })

describe('isForeignKeyViolation', () => {
  test('裸的 23503 认出，别的 SQLSTATE 不认', () => {
    expect(isForeignKeyViolation(fkError())).toBe(true)
    expect(isForeignKeyViolation(uniqueError())).toBe(false)
  })

  test('Drizzle 包装过的（cause 链）也认', () => {
    // DrizzleQueryError 的形态：外层只带 query/params，真正的 PG 错误在 cause 上
    const wrapped = Object.assign(new Error('Failed query: insert into conversations …'), {
      query: 'insert into conversations …',
      params: [],
      cause: fkError(),
    })
    expect(isForeignKeyViolation(wrapped)).toBe(true)
  })

  test('非 Error、空值、无 errno 的普通错误一律判否（不误报成外键冲突）', () => {
    expect(isForeignKeyViolation(null)).toBe(false)
    expect(isForeignKeyViolation(undefined)).toBe(false)
    expect(isForeignKeyViolation('23503')).toBe(false)
    expect(isForeignKeyViolation(new Error('普通错误'))).toBe(false)
    // 数字形式的 SQLSTATE（有的驱动会这样给）：不认，宁可判否也不要误翻成 404
    expect(
      isForeignKeyViolation(Object.assign(new Error('x'), { errno: 23503 as unknown as string })),
    ).toBe(false)
  })
})
