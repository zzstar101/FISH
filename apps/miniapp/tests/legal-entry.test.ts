import { describe, expect, test } from 'bun:test'
import { isEntryFromAuth, markConsent, takeConsent } from '../src/features/legal/entry'

/**
 * 法务页入口来源与同意决定的回传。
 *
 * 这两个判定的后果都在**端上可见**：前者决定吸底同意条出不出现（从设置页进来是纯阅读，
 * 不该再点一次「同意」），后者决定用户按过同意条之后回到登录页，协议勾选是不是真的跟着变。
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

describe('takeConsent —— 同意条决定的跨页一次性信号', () => {
  test('取走即清：第二次取不到，不会反复改动用户的勾选', () => {
    expect(takeConsent()).toBeNull()
    markConsent('declined')
    expect(takeConsent()).toBe('declined')
    expect(takeConsent()).toBeNull()
  })

  test('两个方向都回传：agreed 与 declined 各自取回原值', () => {
    markConsent('agreed')
    expect(takeConsent()).toBe('agreed')
    markConsent('declined')
    expect(takeConsent()).toBe('declined')
  })

  test('后写的决定覆盖前一个，不会同时挂着两个', () => {
    markConsent('agreed')
    markConsent('declined')
    expect(takeConsent()).toBe('declined')
    expect(takeConsent()).toBeNull()
  })
})
