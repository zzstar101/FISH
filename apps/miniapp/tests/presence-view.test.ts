import { describe, expect, test } from 'bun:test'
import { PRESENCE_ONLINE_TTL_MS } from '@fish/contracts/users/schema'
import { PRESENCE_TICK_MS, presenceView } from '../src/features/presence/view'

/**
 * #359 第五点：三处展示位共用的在线态文案。
 *
 * 时钟由调用方传入，所以 TTL 边界、相对时间档位都是可确定复现的事件。
 */
const NOW = Date.parse('2026-09-30T12:00:00.000Z')

describe('presenceView —— 在线', () => {
  test('服务端说在线且活动在窗口内：绿点 + 「在线」', () => {
    expect(presenceView({ online: true, lastActiveAt: '2026-09-30T11:59:30.000Z' }, NOW)).toEqual({
      online: true,
      text: '在线',
    })
  })

  test('TTL 边界内算在线，越过本地过期（与服务端下一次读取同结论）', () => {
    expect(
      presenceView({ online: true, lastActiveAt: new Date(NOW - 59_999).toISOString() }, NOW),
    ).toEqual({ online: true, text: '在线' })
    // 恰好 60s：服务端窗口是 `< TTL`，端上必须同款，否则会出现「端上还在线、服务端已离线」
    expect(
      presenceView({ online: true, lastActiveAt: new Date(NOW - 60_000).toISOString() }, NOW),
    ).toEqual({ online: false, text: '1 分钟前活跃' })
  })

  test('在线但没有活动时刻（契约允许）：信服务端那一次判定', () => {
    expect(presenceView({ online: true, lastActiveAt: null }, NOW)).toEqual({
      online: true,
      text: '在线',
    })
  })
})

describe('presenceView —— 离线', () => {
  test('从未活动过：只说「离线」，不编「最后活跃」', () => {
    expect(presenceView({ online: false, lastActiveAt: null }, NOW)).toEqual({
      online: false,
      text: '离线',
    })
  })

  test('多久没上线按相对时间档位说：刚刚 / 分钟 / 小时 / 昨天 / 天', () => {
    const label = (iso: string) => presenceView({ online: false, lastActiveAt: iso }, NOW)?.text
    expect(label('2026-09-30T11:59:40.000Z')).toBe('刚刚活跃')
    expect(label('2026-09-30T11:45:00.000Z')).toBe('15 分钟前活跃')
    expect(label('2026-09-30T09:00:00.000Z')).toBe('3 小时前活跃')
    expect(label('2026-09-29T10:00:00.000Z')).toBe('昨天活跃')
    expect(label('2026-09-26T10:00:00.000Z')).toBe('4 天前活跃')
  })

  test('非法时间戳降级成「离线」，不拼出「活跃」这种半句话', () => {
    expect(presenceView({ online: false, lastActiveAt: '昨天' }, NOW)).toEqual({
      online: false,
      text: '离线',
    })
  })
})

describe('presenceView —— 拿不到在线态', () => {
  test('缺失时返回 null，由调用方整块不渲染（不把「拿不到」画成「离线」）', () => {
    expect(presenceView(null, NOW)).toBeNull()
    expect(presenceView(undefined, NOW)).toBeNull()
  })
})

/**
 * #376 审查回合：端上必须有一个**会前进**的「现在」，本地过期才真的会发生。
 *
 * 组件接线本身没有渲染测试基建（时钟是否真的在走、隐藏时是否真的停表，靠端上验收）；
 * 这里锁的是它两半里能抽出来的部分：重算节拍与 TTL 的关系（陈旧绿点的谎言时长上界），
 * 以及「只有 now 前进、没有任何新请求」时结论必须自己翻成离线。
 */
describe('PRESENCE_TICK_MS —— 端上重算「现在」的节拍', () => {
  test('不超过 TTL 的一半：陈旧的「在线」最多多挂半个 TTL', () => {
    expect(PRESENCE_TICK_MS).toBeLessThanOrEqual(PRESENCE_ONLINE_TTL_MS / 2)
    // 节拍必须是个正数：为 0 会让定时器退化成死循环，也让这条判据失去意义
    expect(PRESENCE_TICK_MS).toBeGreaterThan(0)
  })

  test('页面停在屏幕上、只有「现在」前进：越过 TTL 必然转离线（最迟晚一个节拍）', () => {
    const presence = { online: true, lastActiveAt: new Date(NOW).toISOString() }
    expect(presenceView(presence, NOW)).toEqual({ online: true, text: '在线' })
    // 过期时刻 = lastActiveAt + TTL；再往后一个节拍（重算最迟发生在这一刻）必须已经是离线
    expect(presenceView(presence, NOW + PRESENCE_ONLINE_TTL_MS + PRESENCE_TICK_MS)).toEqual({
      online: false,
      text: '1 分钟前活跃',
    })
  })
})
