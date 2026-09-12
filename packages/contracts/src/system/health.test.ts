import { describe, expect, test } from 'bun:test'
import { HealthResponseSchema } from './health'

const valid = {
  status: 'ok',
  version: '0.0.0',
  timestamp: '2026-01-01T00:00:00.000Z',
  db: { status: 'up', latencyMs: 1.2 },
}

describe('HealthResponseSchema', () => {
  test('accepts a valid health response', () => {
    expect(HealthResponseSchema.safeParse(valid).success).toBe(true)
  })

  test('rejects an unknown status', () => {
    expect(HealthResponseSchema.safeParse({ ...valid, status: 'weird' }).success).toBe(false)
  })
})
