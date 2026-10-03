import { describe, expect, test } from 'bun:test'
import { DrizzleQueryError } from 'drizzle-orm'
import { createVisualMaintenance } from './maintenance'

/** 真实的 Bun 驱动错误形状：SQLSTATE 在 `errno`（与 `log.test.ts` 的探针同形状）。 */
function postgresError(message: string, errno: string): Error {
  return Object.assign(new Error(message), {
    name: 'PostgresError',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    severity: 'ERROR',
    errno,
  })
}

/** 收集维护上报的行，避免测试真的往 stdout/stderr 写。 */
function collect() {
  const reported: string[] = []
  const failures: string[] = []
  return { reported, failures }
}

describe('视觉维护的一轮执行', () => {
  test('成功一轮：回填与清理的进度行只在有条目时上报，顺序为回填→清理', async () => {
    const { reported, failures } = collect()
    const calls: string[] = []
    const run = createVisualMaintenance({
      backfill: async () => {
        calls.push('backfill')
        return { enqueued: 2 }
      },
      cleanup: async (now) => {
        calls.push(`cleanup:${now.toISOString()}`)
        return { deleted: 1 }
      },
      report: (line) => reported.push(line),
      reportFailure: (line) => failures.push(line),
    })

    await run(new Date('2026-10-03T00:00:00.000Z'))

    expect(failures).toEqual([])
    expect(reported).toEqual(['[worker] 视觉回填投递 2 条', '[worker] 清理到期查询图 1 个'])
    expect(calls).toEqual(['backfill', 'cleanup:2026-10-03T00:00:00.000Z'])
  })

  test('维护失败只上报脱敏摘要：SQL 文本与绑定参数值不得写进 stderr', async () => {
    const { reported, failures } = collect()
    const run = createVisualMaintenance({
      // 回填与清理都查库，任一处失败都走同一个 catch。
      backfill: async () => {
        throw new DrizzleQueryError(
          'select $1::int',
          ['PRIVATE_WISH_TEXT'],
          postgresError('boom', '22P02'),
        )
      },
      cleanup: async () => ({ deleted: 0 }),
      report: (line) => reported.push(line),
      reportFailure: (line) => failures.push(line),
    })

    await run(new Date())

    expect(reported).toEqual([])
    expect(failures).toHaveLength(1)
    const line = failures[0] ?? ''
    // 仍可诊断：类别 + SQLSTATE。
    expect(line).toContain('database query failed (SQLSTATE 22P02)')
    // 但不得带 SQL 文本或绑定参数值（drizzle 的 message 两者都有）。
    expect(line).not.toContain('select $1::int')
    expect(line).not.toContain('PRIVATE_WISH_TEXT')
  })

  test('清理失败同样不把主循环带走，也不泄漏 SQL', async () => {
    const { reported, failures } = collect()
    const run = createVisualMaintenance({
      backfill: async () => ({ enqueued: 0 }),
      cleanup: async () => {
        throw new DrizzleQueryError(
          'delete from media_objects where id = $1',
          ['PRIVATE_MEDIA_ID'],
          postgresError('boom', '42P01'),
        )
      },
      report: (line) => reported.push(line),
      reportFailure: (line) => failures.push(line),
    })

    await run(new Date())

    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('SQLSTATE 42P01')
    expect(failures[0]).not.toContain('PRIVATE_MEDIA_ID')
    expect(failures[0]).not.toContain('delete from media_objects')
  })

  test('非数据库错误仍保留可读原因（不因为脱敏把运维信息一起丢掉）', async () => {
    const { failures } = collect()
    const run = createVisualMaintenance({
      backfill: async () => {
        throw new Error('磁盘只读')
      },
      cleanup: async () => ({ deleted: 0 }),
      reportFailure: (line) => failures.push(line),
    })

    await run(new Date())

    expect(failures).toEqual(['[worker] 视觉维护失败：磁盘只读'])
  })
})
