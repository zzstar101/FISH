import { describe, expect, test } from 'bun:test'
import { asSourceReportId } from './governance-dialog'

/**
 * 关联举报单 ID 的值域守卫（#467 审查发现 Primitive Obsession）：
 * 端上不再自写 `/^rpt_[0-9a-z]+$/` 复刻前缀知识，而是复用契约的 `ReportIdSchema`
 * （TypeID：`rpt_` + 26 位 Base32），所以下面这些「旧正则放过、契约拒绝」的输入
 * 必须被拒——修复前 `rpt_abc` 会被放行并提交给服务端。
 */
describe('asSourceReportId（复用契约 ReportIdSchema）', () => {
  test('接受规范举报单 ID', () => {
    expect(asSourceReportId('rpt_01jc000000e00800000000000a')).toBe(
      'rpt_01jc000000e00800000000000a',
    )
  })

  test('拒绝短 ID、大写、非举报单前缀与空串', () => {
    expect(asSourceReportId('rpt_abc')).toBeUndefined()
    expect(asSourceReportId('rpt_01JC000000E00800000000000A')).toBeUndefined()
    expect(asSourceReportId('usr_01jc000000e00800000000000a')).toBeUndefined()
    expect(asSourceReportId('')).toBeUndefined()
  })
})
