import { describe, expect, test } from 'bun:test'
import {
  COMMENT_POLICIES,
  DEFAULT_NOTIFY_PREFS,
  gateUnreadForNotifyPrefs,
  NOTIFY_KEYS,
  parseStoredPrefs,
  readStoredPrefs,
  resolveNotifyPrefs,
} from '../src/features/notify/preferences'
import type { MockSettings } from '../src/mock/types'

/**
 * 偏好的本机读回与通知闸门（修「写而不读」：persist 落了 `fish:settings`，
 * 挂载却恒读 mock 常量，重进页面全部重置）。
 *
 * 页面里 `Taro.getStorageSync` 那一步只能在端上跑（与 `feedback-draft.test.ts`
 * 同一说明），单测锁解析层：认得出的键与类型才收，垃圾值**按字段丢**回默认值，
 * 不整份丢。挂载读回 + 留言口径选项即时上屏这两步接线由微信开发者工具演示验证。
 *
 * 模块住在 `features/notify`：设置页（写）与 custom-tab-bar（底栏红点闸门）消费
 * 同一份白名单，谁也不许自己再抄一份键名。
 */

const DEFAULTS: MockSettings = {
  notifyChat: true,
  notifyWish: true,
  notifyDeal: true,
  notifyNews: false,
  commentPolicy: '已认证用户',
}

describe('readStoredPrefs —— 存储原始值 → 合法偏好', () => {
  test('weapp 形态：getStorageSync 原样给对象，合法值全收、未知键不透传', () => {
    expect(readStoredPrefs({ notifyChat: false, commentPolicy: '仅好友', foo: 1 })).toEqual({
      notifyChat: false,
      commentPolicy: '仅好友',
    })
  })

  test('H5 形态：getStorageSync 给 JSON 字符串，解析后同样收', () => {
    const raw = JSON.stringify({ notifyNews: true })
    expect(readStoredPrefs(raw)).toEqual({ notifyNews: true })
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
    expect(readStoredPrefs({ notifyWish: 'yes', commentPolicy: '谁都可以' })).toEqual({})
    expect(readStoredPrefs({ notifyWish: 'yes', notifyDeal: 0 })).toEqual({})
    expect(readStoredPrefs({ notifyChat: false, commentPolicy: '谁都可以' })).toEqual({
      notifyChat: false,
    })
  })

  test('未知键单独出现也不透传', () => {
    expect(readStoredPrefs({ foo: 1, bar: 'dark' })).toEqual({})
  })
})

describe('readStoredPrefs —— 旧版短键兜底（老用户升级不丢通知偏好）', () => {
  test('只有旧短键：4 个通知项都按新形态读回', () => {
    expect(readStoredPrefs({ chat: false, wish: true, deal: false, news: true })).toEqual({
      notifyChat: false,
      notifyWish: true,
      notifyDeal: false,
      notifyNews: true,
    })
  })

  test('新旧键同时存在且冲突：新键胜，旧键不覆盖', () => {
    expect(
      readStoredPrefs({ notifyChat: true, chat: false, notifyNews: false, news: true }),
    ).toEqual({ notifyChat: true, notifyNews: false })
  })

  test('旧短键值不是 boolean：丢该字段，其余字段照收', () => {
    expect(readStoredPrefs({ chat: 'yes', wish: 1, deal: false, news: true })).toEqual({
      notifyDeal: false,
      notifyNews: true,
    })
  })

  test('混合形态：部分新键 + 部分旧键，各自对上自己那一项', () => {
    expect(readStoredPrefs({ notifyChat: false, deal: true, news: false })).toEqual({
      notifyChat: false,
      notifyDeal: true,
      notifyNews: false,
    })
  })

  test('新键损坏（非 boolean）+ 旧短键合法：回落到旧短键，不把这一项一起丢', () => {
    expect(readStoredPrefs({ notifyChat: 0, chat: true, notifyWish: 'yes', wish: false })).toEqual({
      notifyChat: true,
      notifyWish: false,
    })
  })
})

describe('parseStoredPrefs —— 存量盖在默认值上', () => {
  test('没存过 = 默认值原样', () => {
    expect(parseStoredPrefs(null, DEFAULTS)).toEqual(DEFAULTS)
    expect(parseStoredPrefs('', DEFAULTS)).toEqual(DEFAULTS)
  })

  test('存过的键盖默认值，没存的保持默认', () => {
    expect(parseStoredPrefs({ notifyNews: true }, DEFAULTS)).toEqual({
      ...DEFAULTS,
      notifyNews: true,
    })
  })

  test('部分字段损坏只丢那一个字段', () => {
    expect(
      parseStoredPrefs({ notifyChat: 'x', notifyChat2: 1, notifyDeal: false }, DEFAULTS),
    ).toEqual({
      ...DEFAULTS,
      notifyDeal: false,
    })
  })
})

describe('resolveNotifyPrefs —— 闸门用四布尔（缺省 = 开）', () => {
  test('没存过 / 空 = 四类全开', () => {
    expect(resolveNotifyPrefs({})).toEqual(DEFAULT_NOTIFY_PREFS)
  })

  test('存过的 boolean 生效（包括 false），没存的补默认', () => {
    expect(resolveNotifyPrefs({ notifyChat: false, notifyNews: true })).toEqual({
      notifyChat: false,
      notifyWish: true,
      notifyDeal: true,
      notifyNews: true,
    })
  })
})

describe('gateUnreadForNotifyPrefs —— 底栏徽标按通知偏好关分量', () => {
  test('四类全开（默认）：分量原样透传', () => {
    expect(
      gateUnreadForNotifyPrefs({ conversations: 3, notifications: 5 }, DEFAULT_NOTIFY_PREFS),
    ).toEqual({ conversations: 3, notifications: 5 })
  })

  test('「新消息」关：会话分量按 0 计（明确的不计入，不是「不知道」）', () => {
    expect(
      gateUnreadForNotifyPrefs(
        { conversations: 3, notifications: 5 },
        { ...DEFAULT_NOTIFY_PREFS, notifyChat: false },
      ),
    ).toEqual({ conversations: 0, notifications: 5 })
  })

  test('通知类三档全关：通知分量按 0 计', () => {
    expect(
      gateUnreadForNotifyPrefs(
        { conversations: 3, notifications: 5 },
        { notifyChat: true, notifyWish: false, notifyDeal: false, notifyNews: false },
      ),
    ).toEqual({ conversations: 3, notifications: 0 })
  })

  test('通知类任一开着：通知分量计入（服务端计数不分种类，本地拆不了）', () => {
    expect(
      gateUnreadForNotifyPrefs(
        { conversations: 0, notifications: 5 },
        { notifyChat: false, notifyWish: false, notifyDeal: true, notifyNews: false },
      ),
    ).toEqual({ conversations: 0, notifications: 5 })
  })

  test('「不知道」（null）在闸门开着时原样透传 —— 闸门不把它偷换成「没有」', () => {
    expect(
      gateUnreadForNotifyPrefs(
        { conversations: null, notifications: null },
        {
          notifyChat: false,
          notifyWish: false,
          notifyDeal: false,
          notifyNews: false,
        },
      ),
    ).toEqual({ conversations: 0, notifications: 0 })
    expect(
      gateUnreadForNotifyPrefs({ conversations: 2, notifications: null }, DEFAULT_NOTIFY_PREFS)
        .notifications,
    ).toBeNull()
  })
})

describe('与页面共享的常量', () => {
  test('通知明细行的存储键 = MockSettings 的 notify* 字段，写（页面行配置）读（白名单）两侧同源', () => {
    expect(NOTIFY_KEYS).toEqual(['notifyChat', 'notifyWish', 'notifyDeal', 'notifyNews'])
    for (const key of NOTIFY_KEYS) {
      expect(readStoredPrefs({ [key]: false })).toEqual({ [key]: false })
    }
  })

  test('留言口径三档与页面 ActionSheet 同源，顺序错 = 档位错乱', () => {
    expect(COMMENT_POLICIES).toEqual(['已认证用户', '所有人', '仅好友'])
  })
})
