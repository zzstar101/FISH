import { describe, expect, test } from 'bun:test'
import { normalizeScanResult } from './scanner'

describe('normalizeScanResult', () => {
  test('trims and returns opaque scan content', () => {
    expect(normalizeScanResult('  fish://meetup/v1/token  ')).toEqual({
      rawValue: 'fish://meetup/v1/token',
    })
  })

  test('rejects empty scan content', () => {
    expect(normalizeScanResult('   ')).toBeNull()
  })
})
