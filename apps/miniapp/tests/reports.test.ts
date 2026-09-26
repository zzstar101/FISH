import { describe, expect, mock, test } from 'bun:test'
import {
  DEMO_REPORTS,
  DEMO_SUBMITTED_LISTING_ID,
  DEMO_SUBMITTED_USER_ID,
  findDemoReport,
  loadDemoReports,
  type ReportRecord,
  rememberDemoReport,
} from '../src/features/reports/demo'
import {
  bannerCopy,
  emptyCopyOf,
  LISTING_REPORT_REASONS,
  REPORT_STATUS_META,
  reasonHint,
  reasonLabel,
  reasonsOf,
  shortReportId,
  USER_REPORT_REASONS,
} from '../src/features/reports/meta'

/**
 * 举报域的纯逻辑（原因枚举 / 状态文案 / 编号截断 / 演示数据完整性）。
 * 组件接线没有单测（本仓 tests/ 只有纯逻辑测试，无 Taro 组件渲染基建）。
 */

// `load.ts`（本文件末尾的取数分支）经 `features/load-failure` 间接摸到 `@/lib/request`，
// Bun 下加载真 Taro 会在求值阶段抛 —— 手法同 `favorites-list.test.ts`：先顶掉再引。
// 构建期注入的开关也必须在动态 import 之前定义。
mock.module('@tarojs/taro', () => ({ default: {} }))
Object.assign(globalThis, { __DEMO_AUTH__: true, __ALLOW_MOCK_FALLBACK__: true })

describe('原因枚举（#252 冻结的 key，页面胶囊顺序）', () => {
  test('商品类 key 与 #252 一致，5 项', () => {
    expect(LISTING_REPORT_REASONS.map((r) => r.key)).toEqual([
      'MISLEADING',
      'PROHIBITED',
      'FRAUD',
      'SPAM',
      'OTHER',
    ])
  })

  test('用户类 key 与 #252 一致，5 项', () => {
    expect(USER_REPORT_REASONS.map((r) => r.key)).toEqual([
      'HARASSMENT',
      'FRAUD',
      'IMPERSONATION',
      'ABUSE',
      'OTHER',
    ])
  })

  test('reasonsOf / reasonLabel / reasonHint', () => {
    expect(reasonsOf('LISTING')).toBe(LISTING_REPORT_REASONS)
    expect(reasonsOf('USER')).toBe(USER_REPORT_REASONS)
    expect(reasonLabel('LISTING', 'FRAUD')).toBe('涉嫌欺诈')
    expect(reasonLabel('USER', 'FRAUD')).toBe('涉嫌欺诈')
    // 两套枚举都有 FRAUD，但 IMPERSONATION 只在用户类 —— 串了 target 要回退成 key 本身
    expect(reasonLabel('LISTING', 'IMPERSONATION')).toBe('IMPERSONATION')
    expect(reasonHint('USER', null)).toBe(null)
    expect(reasonHint('USER', 'HARASSMENT')).toContain('骚扰')
  })
})

describe('状态元数据与横幅文案（不泄露管理员处理原因）', () => {
  test('三态的 tone 各归各位', () => {
    expect(REPORT_STATUS_META.PENDING).toEqual({ label: '审核中', tone: 'pending' })
    expect(REPORT_STATUS_META.HANDLED).toEqual({ label: '已处理', tone: 'done' })
    expect(REPORT_STATUS_META.REJECTED).toEqual({ label: '已驳回', tone: 'rejected' })
  })

  test('bannerCopy 三态标题，且都不出现内部处理细节字样', () => {
    expect(bannerCopy('PENDING').title).toBe('审核中')
    expect(bannerCopy('HANDLED').title).toBe('已处理')
    expect(bannerCopy('REJECTED').title).toBe('已驳回')
    for (const status of ['PENDING', 'HANDLED', 'REJECTED'] as const) {
      const copy = bannerCopy(status)
      expect(copy.text).not.toContain('下架')
      expect(copy.text).not.toContain('封禁')
      expect(copy.text.length).toBeGreaterThan(10)
    }
    // 已驳回要给「重新提交」的出口，不留死胡同
    expect(bannerCopy('REJECTED').text).toContain('重新提交')
  })
})

describe('编号截断', () => {
  test('长编号中段省略，短编号原样', () => {
    expect(shortReportId('rpt_01J8ZQ3XK7M2')).toBe('rpt_01J8Z…K7M2')
    expect(shortReportId('rpt_short')).toBe('rpt_short')
  })
})

describe('演示数据完整性（7 条 = 商品 4 + 用户 3，三态齐）', () => {
  test('数量与目标分布', () => {
    expect(DEMO_REPORTS.filter((r) => r.target === 'LISTING')).toHaveLength(4)
    expect(DEMO_REPORTS.filter((r) => r.target === 'USER')).toHaveLength(3)
  })

  test('每条的原因都属于自己 target 的枚举；商品才有价格；编号唯一', () => {
    const listingKeys = LISTING_REPORT_REASONS.map((r) => r.key)
    const userKeys = USER_REPORT_REASONS.map((r) => r.key)
    const ids = new Set<string>()
    for (const record of DEMO_REPORTS) {
      expect(ids.has(record.id)).toBe(false)
      ids.add(record.id)
      const valid = record.target === 'LISTING' ? listingKeys : userKeys
      expect(valid).toContain(record.reason)
      if (record.target === 'USER') expect(record.objPrice).toBe(null)
      expect(['PENDING', 'HANDLED', 'REJECTED']).toContain(record.status)
    }
    // 三态都出现（稿子的四种卡片状态都演示得到）
    expect(new Set(DEMO_REPORTS.map((r) => r.status)).size).toBe(3)
  })

  test('findDemoReport 命中与未命中', () => {
    expect(findDemoReport('rpt_01J8ZQ3XK7M2')?.objTitle).toContain('戴尔')
    expect(findDemoReport('rpt_missing')).toBe(null)
  })

  test('演示提交记录进列表头；商品 / 用户两类各占一条互不顶掉；同类只留最新', async () => {
    const listingRecord: ReportRecord = {
      id: DEMO_SUBMITTED_LISTING_ID,
      target: 'LISTING',
      objTitle: '测试商品',
      objPrice: '1',
      reason: 'SPAM',
      desc: '',
      timeLabel: '刚刚',
      status: 'PENDING',
    }
    const userRecord: ReportRecord = {
      id: DEMO_SUBMITTED_USER_ID,
      target: 'USER',
      objTitle: '测试用户',
      objPrice: null,
      reason: 'HARASSMENT',
      desc: '',
      timeLabel: '刚刚',
      status: 'PENDING',
    }
    rememberDemoReport(listingRecord)
    rememberDemoReport(userRecord)
    // 两类同时在列：先提交的商品记录不被后提交的用户记录顶掉（审查 P2-1 的回归）
    expect((await loadDemoReports()).map((r) => r.id)).toEqual([
      DEMO_SUBMITTED_USER_ID,
      DEMO_SUBMITTED_LISTING_ID,
      ...DEMO_REPORTS.map((r) => r.id),
    ])
    expect(findDemoReport(DEMO_SUBMITTED_LISTING_ID)?.reason).toBe('SPAM')
    expect(findDemoReport(DEMO_SUBMITTED_USER_ID)?.reason).toBe('HARASSMENT')

    // 同类反复提交：该类只留最新
    const updated: ReportRecord = { ...listingRecord, objTitle: '测试商品二' }
    rememberDemoReport(updated)
    const items = await loadDemoReports()
    expect(items.filter((r) => r.id === DEMO_SUBMITTED_LISTING_ID)).toHaveLength(1)
    expect(findDemoReport(DEMO_SUBMITTED_LISTING_ID)?.objTitle).toBe('测试商品二')
    expect(items).toHaveLength(9)
  })
})

describe('取数包装（演示构建）', () => {
  test('demo 开关为真时回演示数据并带 demo 标记', async () => {
    const { loadMyReports } = await import('../src/features/reports/load')
    const result = await loadMyReports()
    expect(result.demo).toBe(true)
    expect(result.failed).toBe(false)
    expect(result.items.length).toBeGreaterThanOrEqual(7)
  })
})

describe('空态文案', () => {
  test('真实构建如实说缺口并给去逛逛出口；演示构建不说缺口', () => {
    const real = emptyCopyOf(false)
    expect(real.title).toBe('举报功能还没有后端')
    expect(real.actionLabel).toBe('去逛逛')
    const demo = emptyCopyOf(true)
    expect(demo.title).toBe('还没有提交过举报')
    expect(demo.actionLabel).toBe(null)
  })
})
