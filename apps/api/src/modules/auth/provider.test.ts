import { describe, expect, test } from 'bun:test'
import { createMockCampusVerificationProvider } from './provider'

const provider = createMockCampusVerificationProvider()

describe('Mock CampusVerificationProvider', () => {
  test('判定 12 位 20xx 级学号为已认证', async () => {
    expect(await provider.verify({ studentNo: '202101000001' })).toEqual({ status: 'VERIFIED' })
  })

  test('非 20xx 级学号判定为未认证', async () => {
    expect(await provider.verify({ studentNo: '199901000001' })).toEqual({ status: 'UNVERIFIED' })
  })

  test('位数不符或含非数字判定为未认证', async () => {
    for (const studentNo of ['20210100001', '2021010000001', '20210100000a']) {
      expect(await provider.verify({ studentNo })).toEqual({ status: 'UNVERIFIED' })
    }
  })
})
