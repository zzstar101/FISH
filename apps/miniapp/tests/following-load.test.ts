import { describe, expect, test } from 'bun:test'
import { FOLLOW_DEMO } from '../src/features/following/demo'
import { followingLoadOf } from '../src/features/following/load'
import { followingStatsOf } from '../src/features/following/stats'

/**
 * 「我的关注」的取数与统计口径。
 *
 * 本页**没有可发的请求**（契约无 follows 端点、API 无模块、DB 无表，见
 * `features/following/load.ts` 的文件头），所以「渲染什么」完全由这两个开关决定。
 * 三条容易做错、错了会被用户当成事实的事，在这里钉住：
 *
 * 1. **只开 mock 回退不能摆演示数据**。`dev:weapp` 的日常开发也满足
 *    `MOCK_FALLBACK_ENABLED`，只看它会把真实空态顶成演示列表；必须两个开关都开
 *    （口径与「我的」页 `fetchers.ts` 的 `loadProfile` 回退一致）。
 * 2. **演示人数照稿为 5 条**：本页演示列表数必须与「我的」页数字栏一致，
 *    否则演示时会出现「数字栏 5、点进去 3 人」。⚠️ 这条**耦合没有被机器校验**：
 *    另一位数字在 `features/fetchers.ts` 的 `demoProfile()`（`followCount: 5`），
 *    而该文件在四线并行的文件白名单之外、本轮不许改，所以这里只能钉住「本页是 5 条」，
 *    **改 `demoProfile` 的 followCount 时这些用例仍会全绿** —— 需要人工对齐。
 * 3. **统计行从正在渲染的列表现算**：`关注 N 人` 必须等于列表行数，
 *    `互粉 M 人` 必须等于 `mutual` 为真的行数 —— 旁路读一份汇总是
 *    `pages/watchers` 上踩过的坑（列表 8 行 / 共 7 人想要）。
 *
 * ⚠️ 本文件**不覆盖**「页面是否真的把这两个函数接上了」：那需要组件级测试。
 * 把页面改回内联演示数据时，这些用例仍会全绿。
 */

describe('我的关注：取数口径', () => {
  test('真实构建（两个开关都关）→ empty：空态 + 缺口说明，不是演示列表', () => {
    expect(followingLoadOf(false, false)).toEqual({ kind: 'empty' })
  })

  test('只开 mock 回退（dev:weapp 的日常开发）→ 仍是 empty，不摆演示数据', () => {
    expect(followingLoadOf(true, false)).toEqual({ kind: 'empty' })
  })

  test('只开演示登录态 → 仍是 empty（两个开关缺一不可）', () => {
    // ⚠️ 这一组合在当前 `config/index.ts` 下**构造不可达**：`__DEMO_AUTH__`
    // 的条件是 `__ALLOW_MOCK_FALLBACK__` 的子集，所以真实构建里只可能出现
    // (false,false) / (true,false) / (true,true) 三种。留着它是当**函数契约**锁：
    // 方案 §2.3 要求本页与「我的」页回退口径一致（`&&` 不是 `||`），
    // 将来谁把加载开关拆成两个独立来源，这条会立刻红。
    expect(followingLoadOf(false, true)).toEqual({ kind: 'empty' })
  })

  test('演示构建（两个开关都开）→ demo：照稿的 5 个人', () => {
    const load = followingLoadOf(true, true)
    expect(load.kind).toBe('demo')
    if (load.kind !== 'demo') return
    expect(load.people).toHaveLength(5)
  })
})

describe('我的关注：演示数据', () => {
  // ⚠️ 这条只锁「本页是 5 条」。`demoProfile()` 的 `followCount` 在
  // `features/fetchers.ts`（白名单外，本轮不许改），测试**读不到**它 ——
  // 那边改成别的数字时这条不会红，需要人工对齐（见文件头第 2 点）。
  test('条数照稿为 5 条（需与「我的」页数字栏的 followCount 人工对齐）', () => {
    expect(FOLLOW_DEMO).toHaveLength(5)
  })

  test('两态都出现：互粉与已关注各有人在（稿决策④要求两态可区分）', () => {
    expect(FOLLOW_DEMO.some((person) => person.mutual)).toBe(true)
    expect(FOLLOW_DEMO.some((person) => !person.mutual)).toBe(true)
  })

  test('互粉人数 = 2（与稿的「互粉 2 人」一致）', () => {
    expect(followingStatsOf(FOLLOW_DEMO).mutual).toBe(2)
  })

  test('每一行都有昵称、签名与最近活跃（行内只展示这三样，缺一就是空行）', () => {
    for (const person of FOLLOW_DEMO) {
      expect(person.nickname.length).toBeGreaterThan(0)
      expect(person.bio.length).toBeGreaterThan(0)
      expect(person.seenLabel.length).toBeGreaterThan(0)
    }
  })

  test('行内不含校区 / 院系字段（与「想要的人」同一隐私口径）', () => {
    // 类型上没有这两个字段，写进来会触发 excess property check —— 这条
    // 主要防的是「later 有人给类型加回 campus 又忘了隐私口径」。
    for (const person of FOLLOW_DEMO) {
      expect(Object.keys(person)).not.toContain('campus')
      expect(Object.keys(person)).not.toContain('department')
    }
  })

  test('头像字段叫 placeholderBlock（占位色块），不是 avatarUrl（真实头像）', () => {
    // 这两个名字必须分开：占位色块要垫在首字**下面**（稿的「色圈 + 首字」是两层），
    // 真头像到位后要独占整圆、首字不能再压上去。合用一个字段名就会把
    // 「首字叠在人脸上」变成默认行为 —— 这条锁住那个语义边界。
    for (const person of FOLLOW_DEMO) {
      expect(Object.keys(person)).toContain('placeholderBlock')
      expect(Object.keys(person)).not.toContain('avatarUrl')
    }
  })
})

describe('我的关注：统计口径', () => {
  test('count 等于列表行数，mutual 等于 mutual 为真的行数', () => {
    const stats = followingStatsOf(FOLLOW_DEMO)
    expect(stats.count).toBe(FOLLOW_DEMO.length)
    expect(stats.mutual).toBe(FOLLOW_DEMO.filter((person) => person.mutual).length)
  })

  test('空列表 → 0 人 / 0 互粉（「确实没有关注的人」，与「没读到」是两回事）', () => {
    expect(followingStatsOf([])).toEqual({ count: 0, mutual: 0 })
  })
})
