import { beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * 隐私授权闸的行为（#516）。
 *
 * 两套投影共用一次查询：
 * - `ensurePrivacyAuthorized` 是 #86 头像页的历史契约，查询失败 fail-open；
 * - `ensurePrivacyAuthorizedStrict` 是语音路径，查询失败 fail-closed。
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
let authorizeThrows = false
let authorizeMissing = false

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
    get requirePrivacyAuthorize() {
      if (authorizeMissing) return undefined
      return (options: AuthorizeOptions) => {
        if (authorizeThrows) throw new Error('requirePrivacyAuthorize boom')
        if (authorizeFails) {
          options.fail?.({ errMsg: 'requirePrivacyAuthorize:fail' })
          return
        }
        options.success?.()
      }
    },
  },
}))

const { ensurePrivacyAuthorized, ensurePrivacyAuthorizedStrict } = await import(
  '../src/lib/privacy'
)

beforeEach(() => {
  needAuthorization = false
  getFails = false
  getThrows = false
  authorizeFails = false
  authorizeThrows = false
  authorizeMissing = false
})

describe('ensurePrivacyAuthorized —— #86 头像页的 fail-open 契约', () => {
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

  test('查询失败：放行（不误伤头像页，平台会在真正调用接口时拦）', async () => {
    getFails = true
    await expect(ensurePrivacyAuthorized()).resolves.toBe(true)
  })

  test('查询异常：放行', async () => {
    getThrows = true
    await expect(ensurePrivacyAuthorized()).resolves.toBe(true)
  })
})

describe('ensurePrivacyAuthorizedStrict —— 语音路径未知状态不放行', () => {
  test('平台说不需要授权：放行', async () => {
    await expect(ensurePrivacyAuthorizedStrict()).resolves.toBe(true)
  })

  test('需要授权且用户同意：放行', async () => {
    needAuthorization = true
    await expect(ensurePrivacyAuthorizedStrict()).resolves.toBe(true)
  })

  test('用户拒绝：拒绝', async () => {
    needAuthorization = true
    authorizeFails = true
    await expect(ensurePrivacyAuthorizedStrict()).resolves.toBe(false)
  })

  test('查询失败：拒绝，不把未知状态当成已授权', async () => {
    getFails = true
    await expect(ensurePrivacyAuthorizedStrict()).resolves.toBe(false)
  })

  test('查询异常：拒绝', async () => {
    getThrows = true
    await expect(ensurePrivacyAuthorizedStrict()).resolves.toBe(false)
  })

  test('requirePrivacyAuthorize 同步抛错：Promise 必须收口为拒绝，不能永远 pending', async () => {
    needAuthorization = true
    authorizeThrows = true
    await expect(ensurePrivacyAuthorizedStrict()).resolves.toBe(false)
  })

  test('requirePrivacyAuthorize 不存在：同样收口为拒绝，不能永远 pending', async () => {
    needAuthorization = true
    authorizeMissing = true
    await expect(ensurePrivacyAuthorizedStrict()).resolves.toBe(false)
  })
})
