import { describe, expect, test } from 'bun:test'
import {
  applyCleared,
  canClear,
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
} from '../src/pages/history/records'

/**
 * 「历史浏览」的数据口径（本轮三类数据后端一条都没有，见 records.ts 文件头）。
 * 组件接线没有单测（本仓 tests/ 只有纯逻辑测试，无 Taro 组件渲染基建）。
 *
 * 这里锁的是几件最容易做错的事：
 * 1. 失效角标在「全部浏览」与「我收藏的」两处一致（同一件商品不能一处说已下架、
 *    另一处还能买）；
 * 2. 空态三种来由**不能混成一句**：真实构建说「没有后端」、演示构建说「还没有记录」、
 *    清空之后说「已清空」—— 混了就会出现「我明明清空的，怎么说是没有后端」；
 * 3. 清空是**真的清**（演示构建）、只清当前档、刷新之后仍然是空的；
 * 4. 「清空过」是**账号作用域**的：换账号不能带着上一个账号的记忆。
 *
 * ⚠️ **「演示条数与『我的』页数字栏对齐」这条约束不在本文件**：
 * 那个数字的真源是 `features/fetchers.ts` 的 `demoProfile()`（收藏 8 / 足迹 24），
 * 它没有 export 且本轮白名单不允许改那个文件，所以这里只能锁「演示 fixture 自己的
 * 形状」（4 天 × 6 件 = 24 / 收藏 8 / 留言 8）—— 把 `demoProfile().historyCount`
 * 改成别的值，下面的用例**仍然会全绿**。真正的对齐靠改动两侧时人工比对，
 * 这里如实说明，不假装锁住了。
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

describe('清空：演示构建下是真的清，真实构建下只给说明', () => {
  const records = (ownerId: string): DemoRecords => ({
    ownerId,
    days: DEMO_HISTORY,
    favs: DEMO_FAVS,
    msgs: DEMO_MESSAGES,
  })

  test('只有演示构建能清（真实构建没有记录可清、也没有写端点）', () => {
    // 这一条锁的是 `canClear` 的**入参口径**（页面必须传 `demo`，不能传常量 true）。
    // 页面有没有真的把 `demo` 传进来，单测覆盖不到 —— 那要靠 code review。
    expect(canClear(true)).toBe(true)
    expect(canClear(false)).toBe(false)
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

describe('空态：三种来由不能混成一句', () => {
  test('来由判定：清过 > 演示空 > 没有后端', () => {
    expect(emptyKindOf(false, false)).toBe('noBackend')
    expect(emptyKindOf(true, false)).toBe('demoEmpty')
    expect(emptyKindOf(true, true)).toBe('cleared')
    // 真实构建不可能「清过」（清不掉），但真传进来时也要说得比「没有后端」更具体
    expect(emptyKindOf(false, true)).toBe('cleared')
  })

  test('真实构建的空态说的是「没有后端」，不是「你没有内容」', () => {
    for (const tab of TAB_KEYS) {
      const copy = emptyCopyOf(tab, 'noBackend')
      expect(copy.title).toContain('后端')
      expect(copy.action).toBe('去逛逛')
    }
  })

  test('演示构建没清过时的空态说「还没有」，不提后端', () => {
    for (const tab of TAB_KEYS) {
      const copy = emptyCopyOf(tab, 'demoEmpty')
      expect(copy.title).not.toContain('后端')
      expect(copy.title).toContain('还没有')
    }
  })

  test('清空之后的空态说「已清空」，与「还没有」区分开', () => {
    for (const tab of TAB_KEYS) {
      const cleared = emptyCopyOf(tab, 'cleared')
      const empty = emptyCopyOf(tab, 'demoEmpty')
      expect(cleared.title).toContain('已清空')
      // 三者互不相同：同一句话套三种来由，用户会以为清空没生效
      expect(cleared.title).not.toBe(empty.title)
      expect(cleared.text).not.toBe(empty.text)
      expect(cleared.title).not.toBe(emptyCopyOf(tab, 'noBackend').title)
    }
  })
})
