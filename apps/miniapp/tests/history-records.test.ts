import { describe, expect, test } from 'bun:test'
import {
  applyCleared,
  clearBlockedOf,
  clearDoneOf,
  clearedOf,
  DEMO_FAVS,
  DEMO_HISTORY,
  DEMO_MESSAGES,
  type DemoRecords,
  emptyCopyOf,
  emptyKindOf,
  NOTHING_CLEARED,
  noteOf,
  TAB_KEYS,
  TABS,
  tailTextOf,
  withCleared,
} from '../src/pkg-browse/pages/history/records'

/**
 * 「历史浏览」的数据口径（浏览档已接真接口 #415 M1；收藏 / 留言两档仍是演示 / 缺口空态，
 * 见 records.ts 文件头）。组件接线没有单测（本仓 tests/ 只有纯逻辑测试，无 Taro 组件渲染基建）。
 *
 * 这里锁的是几件最容易做错的事：
 * 1. 失效角标在「全部浏览」与「我收藏的」两处一致（同一件商品不能一处说已下架、
 *    另一处还能买）；
 * 2. 空态三种来由**不能混成一句**：真实构建的收藏 / 留言说「这一页还没接」、演示构建说
 *    「还没有记录」、清空之后说「已清空」—— 混了就会出现「我明明清空的，怎么说是没有后端」；
 * 3. 清空是**真的清**（演示构建）、只清当前档、刷新之后仍然是空的；
 * 4. 「清空过」是**账号作用域**的：换账号不能带着上一个账号的记忆。
 *
 * ⚠️ **「演示条数与『我的』页数字栏对齐」这条约束不在本文件**：
 * 演示条数的真源是 `features/fetchers.ts` 的 `demoProfile()`（收藏 8 / 足迹 24），
 * 它没有 export，所以这里只能锁「演示 fixture 自己的形状」（4 天 × 6 件 = 24 / 收藏 8 /
 * 留言 8）。真实构建下「我的」页的足迹数走 `GET /me/view-history` 的 `total`（同一张表
 * 同一个窗口），与历史页列表同源。这条链路分两层、别混：
 * `history-real.test.ts` 只锁 `fetchMyViewHistory` 自身的请求构造（limit / cursor）与 zod 收口；
 * 「`loadProfile` 把它接进数字栏」（`historyCount = total`、只读 1 行、失败只让本格显示 —）
 * 由 `profile-favorites-count.test.ts` 覆盖。历史页组件（Taro 页面）本身的接线无自动化覆盖，
 * 靠开发者工具验收。
 */
describe('演示数据的形状（见文件头：与「我的」页的对齐不在这里锁）', () => {
  test('足迹 24 件 · 4 天', () => {
    expect(DEMO_HISTORY).toHaveLength(4)
    const total = DEMO_HISTORY.reduce((n, day) => n + day.items.length, 0)
    expect(total).toBe(24)
    for (const day of DEMO_HISTORY) expect(day.items).toHaveLength(6)
  })

  test('收藏 8 件 / 留言 8 条（4 条商品留言 + 4 条交易评价）', () => {
    expect(DEMO_FAVS).toHaveLength(8)
    expect(DEMO_MESSAGES).toHaveLength(8)
    expect(DEMO_MESSAGES.filter((item) => item.kind === 'comment')).toHaveLength(4)
    expect(DEMO_MESSAGES.filter((item) => item.kind === 'review')).toHaveLength(4)
  })

  test('id 唯一：列表 key 不会撞', () => {
    const ids = [
      ...DEMO_HISTORY.flatMap((day) => day.items.map((item) => item.id)),
      ...DEMO_FAVS.map((item) => item.id),
      ...DEMO_MESSAGES.map((item) => item.id),
    ]
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('失效角标：两处口径一致', () => {
  test('同一件商品在足迹与收藏里的失效判据相同', () => {
    const goneOf = (items: { title: string; gone: string | null }[]) =>
      new Map(items.map((item) => [item.title, item.gone]))
    const history = goneOf(DEMO_HISTORY.flatMap((day) => day.items))
    const favs = goneOf(DEMO_FAVS)

    let shared = 0
    for (const [title, gone] of favs) {
      if (!history.has(title)) continue
      shared += 1
      expect(gone).toBe(history.get(title))
    }
    // 两处至少要有若干件重叠，否则这条断言等于没测（稿里两档就是同一份商品）
    expect(shared).toBeGreaterThanOrEqual(6)
  })

  test('角标只有「已下架 / 已卖掉」两种取值', () => {
    const all = [...DEMO_HISTORY.flatMap((day) => day.items), ...DEMO_FAVS].map((item) => item.gone)
    for (const gone of all) expect([null, '已下架', '已卖掉']).toContain(gone)
    // 「已降价」角标按 Owner 决策④删掉了，不要加回来。
    // 注：这条在类型层面是恒真的（`GoneLabel` 只有两个值），留着是为了让
    // 「谁把角标加回来」在 diff 里一眼可见 —— 它更像一条警示，不是一道有效的防线。
    expect(all).not.toContain('已降价')
  })
})

describe('清空：演示构建三档都真清，账号作用域不串', () => {
  const records = (ownerId: string): DemoRecords => ({
    ownerId,
    days: DEMO_HISTORY,
    favs: DEMO_FAVS,
    msgs: DEMO_MESSAGES,
  })

  test('清掉某一档之后，那一档真的空了，另外两档不受影响', () => {
    const cleared = clearedOf(
      withCleared({ ...NOTHING_CLEARED, ownerId: 'u-1' }, 'u-1', 'favs'),
      'u-1',
    )
    expect(cleared).toEqual({ history: false, favs: true, msgs: false })

    const after = applyCleared(records('u-1'), cleared)
    expect(after.favs).toHaveLength(0)
    // 另外两档必须原样保留 —— 清一档顺手清掉别的档是最坏的一种错
    expect(after.days).toBe(DEMO_HISTORY)
    expect(after.msgs).toBe(DEMO_MESSAGES)
  })

  test('三档都能各自清掉，且**刷新之后仍然是空的**（数据源没被改回去）', () => {
    let state = { ...NOTHING_CLEARED, ownerId: 'u-1' }
    for (const tab of TAB_KEYS) state = withCleared(state, 'u-1', tab)

    // 「刷新」= 重新取一次同样的演示数据，再按清空标记过滤
    const after = applyCleared(records('u-1'), clearedOf(state, 'u-1'))
    expect(after.days).toHaveLength(0)
    expect(after.favs).toHaveLength(0)
    expect(after.msgs).toHaveLength(0)
    // 底层 fixture 不能被就地改掉：`applyCleared` 是纯函数，原数组长度不变
    expect(DEMO_HISTORY).toHaveLength(4)
    expect(DEMO_FAVS).toHaveLength(8)
    expect(DEMO_MESSAGES).toHaveLength(8)
  })

  test('没清过时是恒等变换（连引用都不换，省一次渲染）', () => {
    const source = records('u-1')
    expect(applyCleared(source, NOTHING_CLEARED)).toBe(source)
  })

  test('「清空过」是账号作用域的：换账号 / 未登录一律按没清过读', () => {
    const cleared = withCleared({ ...NOTHING_CLEARED, ownerId: 'u-1' }, 'u-1', 'history')
    // 同一个账号：记得
    expect(clearedOf(cleared, 'u-1').history).toBe(true)
    // 换了账号：上一个账号的记忆必须作废，否则新账号一进来就看到空列表
    expect(clearedOf(cleared, 'u-2')).toEqual(NOTHING_CLEARED)
    // 退出登录：同上
    expect(clearedOf(cleared, null)).toEqual(NOTHING_CLEARED)
  })

  test('清空成功与做不了的说明各说各的，且带上这一档的记录名', () => {
    expect(clearDoneOf('history')).toBe('已清空浏览记录')
    expect(clearDoneOf('favs')).toBe('已清空收藏')
    expect(clearDoneOf('msgs')).toBe('已清空留言')

    // 真实构建的说明必须点出「后端未开放」，不能只说「清空失败」
    for (const tab of TAB_KEYS) {
      const text = clearBlockedOf(tab)
      expect(text).toContain('后端')
      expect(text).toContain('清空')
    }
  })
})

describe('三档的文案', () => {
  test('tab 顺序与键：全部浏览 / 我收藏的 / 我留言的', () => {
    expect(TABS.map((item) => item.key)).toEqual([...TAB_KEYS])
    expect(TABS.map((item) => item.label)).toEqual(['全部浏览', '我收藏的', '我留言的'])
  })

  test('到底提示按档位给量词', () => {
    expect(tailTextOf('history', 24)).toBe('已显示全部 24 件')
    expect(tailTextOf('favs', 8)).toBe('已显示全部 8 件')
    expect(tailTextOf('msgs', 8)).toBe('已显示全部 8 条')
  })

  test('只有浏览档有底部说明（收藏档的「已降价」说明随角标一起去掉）', () => {
    expect(noteOf('history')).toBe('浏览记录只保留最近 30 天，更早的会自动清掉。')
    expect(noteOf('favs')).toBe('')
    expect(noteOf('msgs')).toBe('')
  })
})

describe('空态：两种来由不能混成一句', () => {
  test('来由判定：清过 > 本来就没有', () => {
    expect(emptyKindOf(false)).toBe('empty')
    expect(emptyKindOf(true)).toBe('cleared')
  })

  test('三档都接了真端点，空态一律说「还没有 X」，不再自称「没有后端」', () => {
    /*
      `noBackend`（「这一页还没接」）随三档全部接线整体退役：浏览档 #415 M1、
      收藏档 #394、留言档 #195。真实构建里「接口成功但列表为空」就是你真的没有这条记录，
      再说「这一页还没接后端」就是假话。
    */
    for (const tab of TAB_KEYS) {
      const copy = emptyCopyOf(tab, 'empty')
      expect(copy.title).toContain('还没有')
      expect(copy.title).not.toContain('后端')
      expect(copy.text).not.toContain('后端')
      expect(copy.text).not.toContain('还没接')
      expect(copy.action).toBe('去逛逛')
    }
    // 三档各说各的记录名，不能共用一句
    expect(emptyCopyOf('history', 'empty').title).toBe('还没有浏览记录')
    expect(emptyCopyOf('favs', 'empty').title).toBe('还没有收藏的宝贝')
    expect(emptyCopyOf('msgs', 'empty').title).toBe('还没有留过言')
  })

  test('清空之后的空态说「已清空」，与「还没有」区分开', () => {
    for (const tab of TAB_KEYS) {
      const cleared = emptyCopyOf(tab, 'cleared')
      const empty = emptyCopyOf(tab, 'empty')
      expect(cleared.title).toContain('已清空')
      // 两种来由互不相同：同一句话套两种来由，用户会以为清空没生效
      expect(cleared.title).not.toBe(empty.title)
      expect(cleared.text).not.toBe(empty.text)
    }
  })
})
