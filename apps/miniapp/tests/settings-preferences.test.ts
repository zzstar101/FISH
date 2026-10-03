import { describe, expect, test } from 'bun:test'
import type { MockSettings } from '../src/mock/types'
import {
  COMMENT_POLICIES,
  parseStoredPrefs,
  readStoredPrefs,
  SETTINGS_STORAGE_KEY,
} from '../src/pages/settings/preferences'

/**
 * 设置页偏好的本机读回（修「写而不读」：persist 落了 `fish:settings`，
 * 挂载却恒读 mock 常量，重进页面全部重置）。
 *
 * 页面里 `Taro.getStorageSync` 那一步只能在端上跑（与 `feedback-draft.test.ts`
 * 同一说明），单测锁解析层：认得出的键与类型才收，垃圾值**按字段丢**回默认值，
 * 不整份丢。挂载读回 + 留言口径选项即时上屏这两步接线由微信开发者工具演示验证。
 */

const DEFAULTS: MockSettings = {
  theme: 'system',
  notifyChat: true,
  notifyWish: true,
  notifyDeal: true,
  notifyNews: false,
  commentPolicy: '已认证用户',
}

describe('readStoredPrefs —— 存储原始值 → 合法偏好', () => {
  test('weapp 形态：getStorageSync 原样给对象，合法值全收、未知键不透传', () => {
    expect(
      readStoredPrefs({ theme: 'dark', notifyChat: false, commentPolicy: '仅好友', foo: 1 }),
    ).toEqual({ theme: 'dark', notifyChat: false, commentPolicy: '仅好友' })
  })

  test('H5 形态：getStorageSync 给 JSON 字符串，解析后同样收', () => {
    const raw = JSON.stringify({ theme: 'light', notifyNews: true })
    expect(readStoredPrefs(raw)).toEqual({ theme: 'light', notifyNews: true })
  })

  test('坏 JSON / 空值 / 非对象一律视为「没存过」，不抛', () => {
    expect(readStoredPrefs('{不是 json')).toEqual({})
    expect(readStoredPrefs('null')).toEqual({})
    expect(readStoredPrefs('')).toEqual({})
    expect(readStoredPrefs(null)).toEqual({})
    expect(readStoredPrefs(undefined)).toEqual({})
    expect(readStoredPrefs(42)).toEqual({})
    expect(readStoredPrefs(['dark'])).toEqual({})
  })

  test('垃圾值按字段丢，不连累同一份里的合法字段', () => {
    expect(
      readStoredPrefs({ theme: 'blue', notifyWish: 'yes', commentPolicy: '谁都可以' }),
    ).toEqual({})
    expect(readStoredPrefs({ theme: 'light', notifyWish: 'yes', notifyDeal: 0 })).toEqual({
      theme: 'light',
    })
  })

  test('未知键单独出现也不透传', () => {
    expect(readStoredPrefs({ foo: 1, bar: 'dark' })).toEqual({})
  })
})

describe('parseStoredPrefs —— 存量盖在默认值上', () => {
  test('没存过 = 默认值原样', () => {
    expect(parseStoredPrefs(null, DEFAULTS)).toEqual(DEFAULTS)
    expect(parseStoredPrefs('', DEFAULTS)).toEqual(DEFAULTS)
  })

  test('存过的键盖默认值，没存的保持默认', () => {
    expect(parseStoredPrefs({ notifyNews: true, theme: 'light' }, DEFAULTS)).toEqual({
      ...DEFAULTS,
      notifyNews: true,
      theme: 'light',
    })
  })

  test('部分字段损坏只丢那一个字段', () => {
    expect(parseStoredPrefs({ theme: 42, notifyChat: false }, DEFAULTS)).toEqual({
      ...DEFAULTS,
      notifyChat: false,
    })
  })
})

describe('与页面共享的常量', () => {
  test('存储键锁死，persist 与读回不能各写各的', () => {
    expect(SETTINGS_STORAGE_KEY).toBe('fish:settings')
  })

  test('留言口径三档与页面 ActionSheet 同源，顺序错 = 档位错乱', () => {
    expect(COMMENT_POLICIES).toEqual(['已认证用户', '所有人', '仅好友'])
  })
})
