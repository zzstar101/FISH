import { describe, expect, mock, test } from 'bun:test'

let account: { miniProgram: { envVersion: string; version: string } } | undefined
let throws = false
mock.module('@tarojs/taro', () => ({
  default: {
    getAccountInfoSync: () => {
      if (throws) throw new Error('unavailable')
      return account
    },
  },
}))
const { readAppVersion } = await import('../src/lib/app-meta')

describe('实际小程序版本', () => {
  test('正式版随微信运行时版本变化，不绑定发版常量', () => {
    account = { miniProgram: { envVersion: 'release', version: '0.0.6' } }
    expect(readAppVersion()).toBe('v0.0.6')
    account.miniProgram.version = '0.0.7'
    expect(readAppVersion()).toBe('v0.0.7')
  })
  test('体验版有版本则显示，没有则明确标识体验版', () => {
    account = { miniProgram: { envVersion: 'trial', version: '0.0.6' } }
    expect(readAppVersion()).toBe('v0.0.6（体验版）')
    account.miniProgram.version = ''
    expect(readAppVersion()).toBe('体验版')
  })
  test('开发版不冒充线上版本', () => {
    account = { miniProgram: { envVersion: 'develop', version: '' } }
    expect(readAppVersion()).toBe('开发版')
  })
  test('平台缺少信息或 API 抛错时不伪造版本且不崩溃', () => {
    account = undefined
    expect(readAppVersion()).toBe('版本未知')
    account = { miniProgram: { envVersion: 'release', version: '' } }
    expect(readAppVersion()).toBe('版本未知')
    throws = true
    try {
      expect(readAppVersion()).toBe('版本未知')
    } finally {
      throws = false
    }
  })
})
