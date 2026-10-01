import { describe, expect, test } from 'bun:test'
import {
  applyConsent,
  isEntryFromAuth,
  markConsent,
  takeConsent,
} from '../src/features/legal/entry'

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

describe('applyConsent —— 决定怎么落到登录页的勾选态上', () => {
  test('agreed 一律勾上、declined 一律取消 —— 两个方向都覆盖', () => {
    // 「同意并继续」在用户先取消过勾选时也必须把勾选补回来，否则回到登录页 CTA 仍是禁用的
    expect(applyConsent('agreed', false)).toBe(true)
    expect(applyConsent('agreed', true)).toBe(true)
    expect(applyConsent('declined', true)).toBe(false)
    expect(applyConsent('declined', false)).toBe(false)
  })

  test('没有待处理的决定时保持原值，不擅自改动用户的勾选', () => {
    expect(applyConsent(null, true)).toBe(true)
    expect(applyConsent(null, false)).toBe(false)
  })
})
