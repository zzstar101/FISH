import { expect, test } from 'bun:test'
import { DrizzleQueryError } from 'drizzle-orm'
import { elapsedMs, errorMessage, logErrorEvent, logEvent } from './log'

/** 临时接住 console 输出：断言"一行 JSON"这件事必须看真实写出去的那一行。 */
function capture(run: () => void): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args: unknown[]) => {
    stdout.push(args.map((arg) => String(arg)).join(' '))
  }
  console.error = (...args: unknown[]) => {
    stderr.push(args.map((arg) => String(arg)).join(' '))
  }
  try {
    run()
  } finally {
    console.log = originalLog
    console.error = originalError
  }
  return { stdout, stderr }
}

test('正常事件写 stdout：一行 JSON，带 ts 与全部字段', () => {
  const { stdout, stderr } = capture(() => {
    logEvent({ event: 'job.settled', jobType: 'EMBED_WISH', status: 'DONE', durationMs: 12 })
  })

  expect(stderr).toEqual([])
  expect(stdout).toHaveLength(1)
  const line = stdout[0] ?? ''
  expect(line.includes('\n')).toBe(false)
  const parsed = JSON.parse(line) as Record<string, unknown>
  expect(parsed.event).toBe('job.settled')
  expect(parsed.jobType).toBe('EMBED_WISH')
  expect(parsed.status).toBe('DONE')
  expect(parsed.durationMs).toBe(12)
  expect(typeof parsed.ts).toBe('string')
  expect(parsed.level).toBeUndefined()
})

test('失败事件写 stderr 且带 level=error', () => {
  const { stdout, stderr } = capture(() => {
    logErrorEvent({ event: 'job.settled', status: 'FAILED', lastError: '上游超时' })
  })

  expect(stdout).toEqual([])
  const parsed = JSON.parse(stderr[0] ?? '') as Record<string, unknown>
  expect(parsed.level).toBe('error')
  expect(parsed.status).toBe('FAILED')
  expect(parsed.lastError).toBe('上游超时')
})

/** 真实的 Bun 驱动错误形状（`bun run probe-errshape` 实测）：SQLSTATE 在 `errno`。 */
function postgresError(message: string, errno: string): Error {
  return Object.assign(new Error(message), {
    name: 'PostgresError',
    code: 'ERR_POSTGRES_SERVER_ERROR',
    severity: 'ERROR',
    errno,
  })
}

test('数据库错误只保留类别/SQLSTATE，不把 SQL 参数里的私密描述或向量写入 stderr', () => {
  const cause = postgresError('DETAIL PRIVATE_DESCRIPTION', '23514')
  const error = new DrizzleQueryError(
    'INSERT PRIVATE_QUERY',
    ['PRIVATE_DESCRIPTION', '[0.125,-0.5]'],
    cause,
  )
  const output = capture(() =>
    logErrorEvent({ event: 'embed.entity.failed', error: errorMessage(error) }),
  )
  const line = output.stderr[0] ?? ''
  expect(line).toContain('23514')
  expect(line).not.toContain('PRIVATE_DESCRIPTION')
  expect(line).not.toContain('PRIVATE_QUERY')
  expect(line).not.toContain('[0.125,-0.5]')
  expect(errorMessage(error)).toBe('database query failed (SQLSTATE 23514)')
})

test('没有 Drizzle 包装的裸驱动错误同样默认拒绝 message', () => {
  const cause = postgresError('invalid input syntax for type integer: "PRIVATE_WISH_TEXT"', '22P02')
  expect(errorMessage(cause)).toBe('database query failed (SQLSTATE 22P02)')
  expect(errorMessage(cause)).not.toContain('PRIVATE_WISH_TEXT')

  // 连接类失败没有 SQLSTATE，但 message 可能带含口令的连接串：宁可丢诊断也不回传。
  const connection = Object.assign(new Error('failed postgres://fish:PRIVATE_PASSWORD@localhost'), {
    name: 'PostgresError',
    code: 'ERR_POSTGRES_CONNECTION_CLOSED',
  })
  expect(errorMessage(connection)).toBe('database query failed')
})

test('pg 风格驱动错误把 SQLSTATE 放在 code（无 errno/severity）时也要取到', () => {
  // 与 `queue.test.ts` 的 `DrizzleQueryError(query, params, Object.assign(new Error(), {code}))` 同形状：
  // 只有 5 位 SQLSTATE 的 code，没有 Bun 的 errno/severity。
  const error = new DrizzleQueryError(
    'INSERT PRIVATE_QUERY',
    ['PRIVATE_DESCRIPTION'],
    Object.assign(new Error('PRIVATE_DETAIL'), { code: '23514' }),
  )
  expect(errorMessage(error)).toBe('database query failed (SQLSTATE 23514)')
  expect(errorMessage(error)).not.toContain('PRIVATE_DETAIL')
})

test('非 DB 错误不被误判：Node 系统错误（数字 errno + syscall/path）与 6 位 code', () => {
  const systemError = Object.assign(new Error('operation not permitted'), {
    code: 'EPERM',
    errno: -1,
    syscall: 'open',
    path: '/tmp/x',
  })
  expect(errorMessage(systemError)).toBe('operation not permitted')
  expect(errorMessage(Object.assign(new Error('no such file'), { code: 'ENOENT' }))).toBe(
    'no such file',
  )
})

test('errorMessage 只取 message，elapsedMs 取整数毫秒', () => {
  expect(errorMessage(new Error('上游超时'))).toBe('上游超时')
  expect(errorMessage('裸字符串')).toBe('裸字符串')

  const startedAt = Bun.nanoseconds()
  expect(elapsedMs(startedAt)).toBeGreaterThanOrEqual(0)
  expect(Number.isInteger(elapsedMs(startedAt))).toBe(true)
})
