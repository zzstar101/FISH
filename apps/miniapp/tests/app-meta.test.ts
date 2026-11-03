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
const { readAppMeta } = await import('../src/lib/app-meta')

describe('实际版本与独立环境标记', () => {
  test('微信实际版本优先于构建版本，正式版无胶囊', () => {
    account = { miniProgram: { envVersion: 'release', version: '0.0.7' } }
    expect(readAppMeta('0.0.6')).toEqual({ version: '0.0.7', environment: null })
  })
  test.each([
    ['develop', '开发版'],
    ['trial', '体验版'],
  ])('%s 缺少微信版本时仍显示本次构建版本并另带胶囊', (envVersion, environment) => {
    account = { miniProgram: { envVersion, version: '' } }
    expect(readAppMeta('0.0.6')).toEqual({ version: '0.0.6', environment })
    account.miniProgram.version = '0.0.8'
    expect(readAppMeta('0.0.6')).toEqual({ version: '0.0.8', environment })
  })
  test('没有任何版本来源时不伪造版本', () => {
    account = { miniProgram: { envVersion: 'develop', version: '' } }
    expect(readAppMeta('')).toEqual({ version: '版本未知', environment: '开发版' })
  })
  test('API 不可用时仍可显示构建版本，环境未知不冒充正式版', () => {
    account = undefined
    expect(readAppMeta('0.0.6')).toEqual({ version: '0.0.6', environment: null })
    throws = true
    try {
      expect(readAppMeta('')).toEqual({ version: '版本未知', environment: null })
    } finally {
      throws = false
    }
  })
})
