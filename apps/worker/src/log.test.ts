import { expect, test } from 'bun:test'
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

test('errorMessage 只取 message，elapsedMs 取整数毫秒', () => {
  expect(errorMessage(new Error('上游超时'))).toBe('上游超时')
  expect(errorMessage('裸字符串')).toBe('裸字符串')

  const startedAt = Bun.nanoseconds()
  expect(elapsedMs(startedAt)).toBeGreaterThanOrEqual(0)
  expect(Number.isInteger(elapsedMs(startedAt))).toBe(true)
})
