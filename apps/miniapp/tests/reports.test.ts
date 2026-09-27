import { describe, expect, mock, test } from 'bun:test'
import type { Report } from '@fish/contracts/reports/schema'
import {
  DEMO_REPORTS,
  DEMO_SUBMITTED_LISTING_ID,
  DEMO_SUBMITTED_USER_ID,
  findDemoReport,
  loadDemoReports,
  type ReportRecord,
  rememberDemoReport,
} from '../src/features/reports/demo'
import { reportToRecord } from '../src/features/reports/map'
import {
  bannerCopy,
  emptyCopyOf,
  LISTING_REPORT_REASONS,
  REPORT_STATUS_META,
  reasonHint,
  reasonLabel,
  reasonsOf,
  shortReportId,
  submitFailureText,
  USER_REPORT_REASONS,
} from '../src/features/reports/meta'
import { resolveReportView, unavailableCopy, wantsReportRecord } from '../src/features/reports/view'

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
    expect(findDemoReport('rpt_01J8ZQ3XK7M2', 'LISTING')?.objTitle).toContain('戴尔')
    expect(findDemoReport('rpt_missing', 'LISTING')).toBe(null)
  })

  test('findDemoReport 按目标类型收口：拿用户举报的记录当商品举报查 → null', () => {
    // 两页的原因枚举不同，串了 target 会把「举报用户」的记录按商品原因解释
    expect(findDemoReport('rpt_01J8TN7RD2M4', 'LISTING')).toBe(null)
    expect(findDemoReport('rpt_01J8TN7RD2M4', 'USER')?.objTitle).toBe('老张的杂货铺')
    expect(findDemoReport('rpt_01J8ZQ3XK7M2', 'USER')).toBe(null)
    expect(findDemoReport('rpt_01J8ZQ3XK7M2', 'LISTING')?.target).toBe('LISTING')
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
    expect(findDemoReport(DEMO_SUBMITTED_LISTING_ID, 'LISTING')?.reason).toBe('SPAM')
    expect(findDemoReport(DEMO_SUBMITTED_USER_ID, 'USER')?.reason).toBe('HARASSMENT')

    // 同类反复提交：该类只留最新
    const updated: ReportRecord = { ...listingRecord, objTitle: '测试商品二' }
    rememberDemoReport(updated)
    const items = await loadDemoReports()
    expect(items.filter((r) => r.id === DEMO_SUBMITTED_LISTING_ID)).toHaveLength(1)
    expect(findDemoReport(DEMO_SUBMITTED_LISTING_ID, 'LISTING')?.objTitle).toBe('测试商品二')
    expect(items).toHaveLength(9)
  })
})

describe('只读入口判定（resolveReportView，两页共用）', () => {
  const sample = 'rpt_01J8ZQ3XK7M2' // 商品样例
  const userSample = 'rpt_01J8TN7RD2M4' // 用户样例

  test('不带 reportId（键不存在）→ 新建态', () => {
    expect(
      resolveReportView({ reportId: undefined, target: 'LISTING', demoEnabled: false }),
    ).toEqual({
      mode: 'fill',
      record: null,
    })
    expect(resolveReportView({ reportId: null, target: 'USER', demoEnabled: true }).mode).toBe(
      'fill',
    )
  })

  /**
   * `?reportId=` 这种**带了参数、值为空**的链接不是新建态：判据是「入口有没有给
   * reportId」，不是「值是不是空串」——否则被改坏的深链会静默变成一张空表单。
   */
  test('reportId 为空串 → 打不开，不落新建表单', () => {
    expect(resolveReportView({ reportId: '', target: 'LISTING', demoEnabled: true }).mode).toBe(
      'unavailable',
    )
    expect(resolveReportView({ reportId: '', target: 'USER', demoEnabled: false }).mode).toBe(
      'unavailable',
    )
  })

  /**
   * #260 / #261 复查 P2 的回归：真实构建（两个演示开关都关）深链直开一条样例编号，
   * 页面**不得**拿到样例对象 —— 否则用户看到的是没有「演示」标识的虚构处理记录。
   * 这条用例在修复前会失败：那时 findDemoReport 无条件命中。
   */
  test('真实构建：样例编号也拿不到记录，落「打不开」', () => {
    for (const target of ['LISTING', 'USER'] as const) {
      const view = resolveReportView({ reportId: sample, target, demoEnabled: false })
      expect(view.mode).toBe('unavailable')
      expect(view.record).toBe(null)
    }
  })

  test('演示构建：目标类型对得上才是只读态', () => {
    const listing = resolveReportView({ reportId: sample, target: 'LISTING', demoEnabled: true })
    expect(listing.mode).toBe('view')
    expect(listing.record?.objTitle).toContain('戴尔')

    const user = resolveReportView({ reportId: userSample, target: 'USER', demoEnabled: true })
    expect(user.mode).toBe('view')
    expect(user.record?.target).toBe('USER')
  })

  test('演示构建：目标类型串了 → 打不开（不按另一套枚举解释）', () => {
    expect(
      resolveReportView({ reportId: userSample, target: 'LISTING', demoEnabled: true }).mode,
    ).toBe('unavailable')
    expect(resolveReportView({ reportId: sample, target: 'USER', demoEnabled: true }).mode).toBe(
      'unavailable',
    )
  })

  test('演示构建：不存在的编号 → 打不开（不静默变成新建表单）', () => {
    expect(
      resolveReportView({ reportId: 'rpt_missing', target: 'LISTING', demoEnabled: true }).mode,
    ).toBe('unavailable')
  })

  test('「打不开」的文案按构建分档，都不导向新建', () => {
    const real = unavailableCopy(false)
    const demo = unavailableCopy(true)
    // 标题同一句（都是「这条举报打不开」），差别在解释：真实构建是查不到，演示构建是重启即失
    expect(real.title).toBe('这条举报打不开')
    expect(demo.title).toBe(real.title)
    expect(demo.text).not.toBe(real.text)
    // #252 已接线：真实构建不能再把「查不到这条记录」说成「后端还没做」
    expect(real.text).not.toContain('后端')
    expect(real.text).not.toContain('接口')
    expect(demo.text).toContain('重启')
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
  test('真实构建如实说「你还没举报过」，不再声称缺口；演示构建同款', () => {
    const real = emptyCopyOf(false)
    expect(real.title).toBe('还没有提交过举报')
    expect(real.actionLabel).toBe('去逛逛')
    // `GET /reports/mine` 已接线：空列表的语义是「你还没举报过」，
    // 不能再写「服务端还没有举报表与接口（#252）」——那与眼前的真实列表自相矛盾
    expect(real.text).not.toContain('后端')
    expect(real.text).not.toContain('接口')
    const demo = emptyCopyOf(true)
    expect(demo.title).toBe('还没有提交过举报')
    expect(demo.actionLabel).toBe(null)
  })
})

describe('「入口带没带编号」的判据（wantsReportRecord，两页共用）', () => {
  test('键不存在 = 新建态；空串 = 要查（查不到就是打不开）', () => {
    expect(wantsReportRecord(undefined)).toBe(false)
    expect(wantsReportRecord(null)).toBe(false)
    expect(wantsReportRecord('')).toBe(true)
    expect(wantsReportRecord('rpt_01J8ZQ3XK7M2')).toBe(true)
  })
})

describe('真实构建的只读态：记录由调用方查，target 照样收口', () => {
  const record: ReportRecord = {
    id: 'rpt_01J8ZQ3XK7M2',
    target: 'LISTING',
    objTitle: '被举报商品',
    objPrice: null,
    objId: 'lst_01jc000000e00800000000000k',
    reason: 'FRAUD',
    desc: '',
    timeLabel: '刚刚',
    status: 'PENDING',
  }

  test('查到记录才是只读态，且带上目标公开 ID', () => {
    const view = resolveReportView({
      reportId: record.id,
      target: 'LISTING',
      demoEnabled: false,
      record,
    })
    expect(view.mode).toBe('view')
    expect(view.record?.objId).toBe('lst_01jc000000e00800000000000k')
  })

  test('目标类型串了 → 打不开（真实记录同样按 target 收口）', () => {
    expect(
      resolveReportView({ reportId: record.id, target: 'USER', demoEnabled: false, record }).mode,
    ).toBe('unavailable')
  })

  test('还没查（undefined）与查不到（null）都落打不开，不静默变新建表单', () => {
    expect(
      resolveReportView({ reportId: record.id, target: 'LISTING', demoEnabled: false }).mode,
    ).toBe('unavailable')
    expect(
      resolveReportView({
        reportId: record.id,
        target: 'LISTING',
        demoEnabled: false,
        record: null,
      }).mode,
    ).toBe('unavailable')
  })
})

describe('契约 DTO → 端上记录（reportToRecord）', () => {
  const report: Report = {
    id: 'rpt_01J8ZQ3XK7M2',
    targetType: 'LISTING',
    targetId: 'lst_01jc000000e00800000000000k',
    reason: 'FRAUD',
    detailText: null,
    status: 'PENDING',
    createdAt: '2025-09-14T12:15:00.000Z',
    handledAt: null,
  }
  const now = Date.parse('2025-09-14T13:00:00.000Z')

  test('用户端 DTO 没有对象摘要：给中性称呼 + 目标公开 ID 让用户指认', () => {
    const record = reportToRecord(report, now)
    expect(record.target).toBe('LISTING')
    expect(record.objTitle).toBe('被举报商品')
    expect(record.objId).toBe('lst_01jc000000e00800000000000k')
    expect(record.objPrice).toBe(null)
    expect(record.reason).toBe('FRAUD')
    expect(record.status).toBe('PENDING')
    expect(record.desc).toBe('')
  })

  test('detailText 落到补充说明，时间戳落成 HH:mm 结尾的文案', () => {
    const record = reportToRecord({ ...report, detailText: '描述与实物不符' }, now)
    expect(record.desc).toBe('描述与实物不符')
    expect(record.timeLabel).toMatch(/\d{2}:\d{2}$/)
  })

  test('用户目标用「被举报用户」，且不把管理员处理原因带出来', () => {
    const record = reportToRecord(
      { ...report, targetType: 'USER', targetId: 'usr_01jc000000e00800000000000a' },
      now,
    )
    expect(record.target).toBe('USER')
    expect(record.objTitle).toBe('被举报用户')
    // 契约的用户端 DTO 里根本没有 handlingReason，映射后也不该凭空多出来
    expect(Object.keys(record)).not.toContain('handlingReason')
  })
})

describe('提交失败文案（只按错误码给固定说法，不透传服务端 message）', () => {
  test('已知码各有说法，未知码兜底', () => {
    expect(submitFailureText('REPORT_TARGET_NOT_FOUND')).toContain('不存在')
    expect(submitFailureText('REPORT_SELF_TARGET')).toContain('自己')
    expect(submitFailureText('REPORT_CONFLICT')).toContain('稍后')
    expect(submitFailureText('UNAUTHENTICATED')).toContain('重新登录')
    expect(submitFailureText(null)).toBe('提交失败，请稍后再试')
    expect(submitFailureText('SOMETHING_ELSE')).toBe('提交失败，请稍后再试')
  })
})
