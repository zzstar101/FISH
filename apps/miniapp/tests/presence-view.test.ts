import { describe, expect, test } from 'bun:test'
import { presenceView } from '../src/features/presence/view'

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
