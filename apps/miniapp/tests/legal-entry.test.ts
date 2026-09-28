import { describe, expect, test } from 'bun:test'
import { isEntryFromAuth, markDeclined, takeDeclined } from '../src/features/legal/entry'

/**
 * 法务页入口来源与「不同意」回传信号。
 *
 * 这两个判定的后果都在**端上可见**：前者决定吸底同意条出不出现（从设置页进来是纯阅读，
 * 不该再点一次「同意」），后者决定用户点了「不同意」回到登录页后协议勾选是不是真的取消了。
 */

describe('isEntryFromAuth —— 只有登录/注册流程进入才显示吸底同意条', () => {
  test('from=login / from=register 为真', () => {
    expect(isEntryFromAuth({ from: 'login' })).toBe(true)
    expect(isEntryFromAuth({ from: 'register' })).toBe(true)
  })

  test('无参数（设置页 / 关于页 / 页脚互链进来）与其它来源为假', () => {
    expect(isEntryFromAuth({})).toBe(false)
    expect(isEntryFromAuth({ from: undefined })).toBe(false)
    expect(isEntryFromAuth({ from: 'settings' })).toBe(false)
    expect(isEntryFromAuth({ from: '' })).toBe(false)
  })
})

describe('takeDeclined —— 「不同意」跨页一次性信号', () => {
  test('取走即清：第二次取不到，不会反复取消用户的勾选', () => {
    expect(takeDeclined()).toBe(false)
    markDeclined()
    expect(takeDeclined()).toBe(true)
    expect(takeDeclined()).toBe(false)
  })
})
