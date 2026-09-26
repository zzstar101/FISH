import { describe, expect, test } from 'bun:test'
import {
  SCAN_CODE_PAGE,
  SCAN_QR_PAGE,
  type ScanTabKey,
  scanTabAction,
} from '../src/components/scan-tabs/tabs'

/**
 * 扫码家族底部三段切换钮的去向映射。
 *
 * 两个 redirect 的 URL 是页面间契约（写错只会静默跳失败），识图的提示文案
 * 是用户可见输出，激活 tab 必须是 no-op —— 都在这里钉住。
 */

const ALL: ScanTabKey[] = ['scan', 'vision', 'code']

describe('scanTabAction', () => {
  test('激活 tab 不动作', () => {
    for (const key of ALL) {
      expect(scanTabAction(key, key)).toBeNull()
    }
  })

  test('扫一扫 tab 去扫一扫页，交易码 tab 去交易码页', () => {
    expect(scanTabAction('scan', 'code')).toEqual({ kind: 'redirect', url: SCAN_QR_PAGE })
    expect(scanTabAction('code', 'scan')).toEqual({ kind: 'redirect', url: SCAN_CODE_PAGE })
  })

  test('识图暂未开放：只提示不跳转', () => {
    expect(scanTabAction('vision', 'scan')).toEqual({
      kind: 'toast',
      title: '识图搜索暂未开放',
    })
  })
})
