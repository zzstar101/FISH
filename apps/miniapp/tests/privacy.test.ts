import { beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * 隐私授权闸的行为（#516）。
 *
 * 这里只替换 Taro 的隐私接口，验证三种结局：
 * - 不需要授权 / 用户同意 → 放行；
 * - 用户拒绝 → 拒绝；
 * - 授权状态查询失败或异常 → 拒绝（不能把未知状态当成已授权）。
 */

type PrivacySetting = { needAuthorization: boolean }
type GetPrivacySettingOptions = {
  success?: (setting: PrivacySetting) => void
  fail?: (error: { errMsg: string }) => void
}
type AuthorizeOptions = {
  success?: () => void
  fail?: (error: { errMsg: string }) => void
}

let needAuthorization = false
let getFails = false
let getThrows = false
let authorizeFails = false

mock.module('@tarojs/taro', () => ({
  default: {
    getPrivacySetting: (options: GetPrivacySettingOptions) => {
      if (getThrows) throw new Error('getPrivacySetting boom')
      if (getFails) {
        options.fail?.({ errMsg: 'getPrivacySetting:fail' })
        return
      }
      options.success?.({ needAuthorization })
    },
    requirePrivacyAuthorize: (options: AuthorizeOptions) => {
      if (authorizeFails) {
        options.fail?.({ errMsg: 'requirePrivacyAuthorize:fail' })
        return
      }
      options.success?.()
    },
  },
}))

const { ensurePrivacyAuthorized } = await import('../src/lib/privacy')

beforeEach(() => {
  needAuthorization = false
  getFails = false
  getThrows = false
  authorizeFails = false
})

describe('ensurePrivacyAuthorized —— 授权状态未知时不放行（#516）', () => {
  test('平台说不需要授权：直接放行', async () => {
    await expect(ensurePrivacyAuthorized()).resolves.toBe(true)
  })

  test('需要授权且用户同意：放行', async () => {
    needAuthorization = true
    await expect(ensurePrivacyAuthorized()).resolves.toBe(true)
  })

  test('用户拒绝：拒绝', async () => {
    needAuthorization = true
    authorizeFails = true
    await expect(ensurePrivacyAuthorized()).resolves.toBe(false)
  })

  test('查询失败：拒绝，不把未知状态当成已授权', async () => {
    getFails = true
    await expect(ensurePrivacyAuthorized()).resolves.toBe(false)
  })

  test('查询异常：拒绝', async () => {
    getThrows = true
    await expect(ensurePrivacyAuthorized()).resolves.toBe(false)
  })
})
