import { describe, expect, test } from 'bun:test'
import {
  SCAN_CODE_PAGE,
  SCAN_QR_PAGE,
  SCAN_VISION_PAGE,
  type ScanTabKey,
  scanTabAction,
} from '../src/components/scan-tabs/tabs'

/**
 * 扫码家族底部三段切换钮的去向映射。
 *
 * 三个 redirect 的 URL 是页面间契约（写错只会静默失败：`redirectTo` 失败时组件只弹一句
 * 「页面打开失败，请重试」），激活 tab 必须是 no-op —— 都在这里钉住。
 *
 * 识图原来只弹「暂未开放」，现在有了落点页（`pages/scan-vision`）：这一段改成钉 URL，
 * 并额外确认该页已在 `app.config.ts` 注册 —— 没注册时 `redirectTo` 同样只在运行时失败。
 */

const ALL: ScanTabKey[] = ['scan', 'vision', 'code']

describe('scanTabAction', () => {
  test('激活 tab 不动作', () => {
    for (const key of ALL) {
      expect(scanTabAction(key, key)).toBeNull()
    }
  })

  test('三个 tab 各自去自己的页', () => {
    expect(scanTabAction('scan', 'code')).toEqual({ kind: 'redirect', url: SCAN_QR_PAGE })
    expect(scanTabAction('code', 'scan')).toEqual({ kind: 'redirect', url: SCAN_CODE_PAGE })
    expect(scanTabAction('vision', 'scan')).toEqual({ kind: 'redirect', url: SCAN_VISION_PAGE })
  })

  test('识图页已在 app.config.ts 注册', async () => {
    const config = await Bun.file(new URL('../src/app.config.ts', import.meta.url)).text()
    // 配置里写的是不带前导斜杠的页面路径（`'pages/scan-vision/index'`）
    expect(config).toContain(`'${SCAN_VISION_PAGE.slice(1)}'`)
  })
})
