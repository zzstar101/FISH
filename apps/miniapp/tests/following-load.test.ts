import { describe, expect, test } from 'bun:test'
import type { FollowedUser } from '@fish/contracts/follows/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { FOLLOW_DEMO } from '../src/features/following/demo'
import {
  demoReady,
  dtoRow,
  followingMode,
  mergeFollowingPage,
  removeFollowingRow,
} from '../src/features/following/load'
import { followingStatsOf } from '../src/features/following/stats'

/**
 * 「我的关注」的取数口径、行映射与翻页合并（纯函数）。
 *
 * 三条容易做错、错了会被用户当成事实的事，在这里钉住：
 *
 * 1. **只有演示构建才摆 fixture**（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`）。
 *    `dev:weapp` 的日常开发只满足前者、且连的是真后端，必须走真接口 —— 只看
 *    `MOCK_FALLBACK_ENABLED` 会把日常开发顶成演示列表。
 * 2. **真实行不携带演示字段**：签名与最近活跃在真实数据面没有来源，`dtoRow` 必须把它们
 *    落成空串（页面据此整行不渲染），且真实头像走 `avatarUrl` 而不是 `placeholderBlock`
 *    （后者要与首字叠成两层，前者独占整圆）。
 * 3. **计数来自服务端全量，不是这一页的行数**：翻页合并后 `total` / `mutualTotal`
 *    取最新一页回包里的值，本地删除时按被删行的 `mutual` 增减。
 */

const TARGET = encodePublicId(PUBLIC_ID_PREFIX.user, '01930000-0000-7000-8000-00000000000b')
const TARGET2 = encodePublicId(PUBLIC_ID_PREFIX.user, '01930000-0000-7000-8000-00000000000c')

function dto(overrides: Partial<FollowedUser> = {}): FollowedUser {
  return {
    id: TARGET,
    nickname: '林一',
    avatarUrl: null,
    authStatus: 'VERIFIED',
    mutual: false,
    ...overrides,
  }
}

describe('我的关注：取数口径', () => {
  test('真实构建（两个开关都关）→ live：走真接口，不退演示', () => {
    expect(followingMode(false, false)).toBe('live')
  })

  test('只开 mock 回退（dev:weapp 的日常开发）→ 仍是 live，不摆演示数据', () => {
    expect(followingMode(true, false)).toBe('live')
  })

  test('只开演示登录态 → 仍是 live（两个开关缺一不可）', () => {
    expect(followingMode(false, true)).toBe('live')
  })

  test('演示构建（两个开关都开）→ demo：照稿的 5 个人', () => {
    expect(followingMode(true, true)).toBe('demo')
    expect(demoReady().rows).toHaveLength(5)
  })
})

describe('我的关注：行映射', () => {
  test('真实行只带公开投影的字段：verify 由 authStatus 推导、演示字段落空串', () => {
    const row = dtoRow(
      dto({ authStatus: 'UNVERIFIED', mutual: true, avatarUrl: 'https://a/b.png' }),
    )

    expect(row).toEqual({
      id: TARGET,
      nickname: '林一',
      avatarUrl: 'https://a/b.png',
      placeholderBlock: '',
      verified: false,
      mutual: true,
      bio: '',
      seenLabel: '',
    })
  })

  test('演示行：色块与首字两层、签名与最近活跃都在，avatarUrl 空着', () => {
    const ready = demoReady()
    for (const row of ready.rows) {
      expect(row.avatarUrl).toBeNull()
      expect(row.placeholderBlock.length).toBeGreaterThan(0)
      expect(row.bio.length).toBeGreaterThan(0)
      expect(row.seenLabel.length).toBeGreaterThan(0)
    }
    // 计数由同一份列表现算，与「我的」页数字栏的 followCount 一致
    const stats = followingStatsOf(FOLLOW_DEMO)
    expect(ready.total).toBe(stats.count)
    expect(ready.mutualTotal).toBe(stats.mutual)
    expect(ready.nextCursor).toBeNull()
    expect(ready.demo).toBe(true)
  })

  test('行内不含校区 / 院系（与「想要的人」同一隐私口径）', () => {
    for (const row of demoReady().rows) {
      expect(Object.keys(row)).not.toContain('campus')
      expect(Object.keys(row)).not.toContain('department')
    }
  })
})

describe('我的关注：翻页合并', () => {
  test('追加一页并按 id 去重，计数与游标取服务端最新值', () => {
    const first = {
      ...demoReady(),
      demo: false,
      rows: [dtoRow(dto())],
      total: 3,
      mutualTotal: 1,
      nextCursor: 'c1',
    }
    // 第二页重复了第一页第一条（游标边界），再带一条新的
    const merged = mergeFollowingPage(first, {
      items: [dto(TARGET), dto({ id: TARGET2, nickname: '张三' })],
      nextCursor: null,
      total: 5,
      mutualTotal: 2,
    })

    expect(merged.rows.map((row) => row.id)).toEqual([TARGET, TARGET2])
    expect(merged.nextCursor).toBeNull()
    expect(merged.total).toBe(5)
    expect(merged.mutualTotal).toBe(2)
  })

  test('本地取关后：人数减一，互粉数只在被删行是互关时减一', () => {
    const base = {
      ...demoReady(),
      demo: false,
      rows: [dtoRow(dto({ mutual: true })), dtoRow(dto({ id: TARGET2, mutual: false }))],
      total: 2,
      mutualTotal: 1,
      nextCursor: null,
    }

    const removedMutual = removeFollowingRow(base, TARGET)
    expect(removedMutual.rows.map((row) => row.id)).toEqual([TARGET2])
    expect(removedMutual.total).toBe(1)
    expect(removedMutual.mutualTotal).toBe(0)

    const removedPlain = removeFollowingRow(base, TARGET2)
    expect(removedPlain.total).toBe(1)
    expect(removedPlain.mutualTotal).toBe(1)

    // 不在列表里的 id：原样返回，不误减
    expect(removeFollowingRow(base, 'usr_unknown')).toBe(base)
  })
})
