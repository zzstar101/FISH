/**
 * 扫码家族（扫一扫 / 识图 / 交易码）底部分类切换的**纯逻辑**。
 *
 * 三个页面共用同一组文字切换钮（Owner 2026-09-26 定版）：扫一扫页、识图页与交易码页
 * 互为兄弟页，切换用 `redirectTo` 把当前页从栈里换掉，避免来回切把页面栈堆满。
 *
 * 抽成纯函数是为了让「点哪个 tab 发生什么」可被单测覆盖——三个 redirect 的
 * URL 是页面间契约，写错只会在运行时表现为静默失败。
 */

export type ScanTabKey = 'scan' | 'vision' | 'code'

/** 扫一扫页（通用二维码）；交易码页见 `pages/scan-pr`；识图页见 `pages/scan-vision`。 */
export const SCAN_QR_PAGE = '/pkg-vision/pages/scan/index'
export const SCAN_CODE_PAGE = '/pkg-vision/pages/scan-pr/index'
/** 识图（拍照找同款）：入口页只做取图 + 上传查询图，结果由搜索页渲染。 */
export const SCAN_VISION_PAGE = '/pkg-vision/pages/scan-vision/index'

export type ScanTabAction = { kind: 'redirect'; url: string } | { kind: 'toast'; title: string }

/** 点某个 tab 的去向；当前已在该 tab 上时返回 null（组件不重复跳转）。 */
export function scanTabAction(key: ScanTabKey, active: ScanTabKey): ScanTabAction | null {
  if (key === active) return null
  if (key === 'vision') return { kind: 'redirect', url: SCAN_VISION_PAGE }
  if (key === 'code') return { kind: 'redirect', url: SCAN_CODE_PAGE }
  return { kind: 'redirect', url: SCAN_QR_PAGE }
}

export const SCAN_TABS: { key: ScanTabKey; label: string }[] = [
  { key: 'scan', label: '扫一扫' },
  { key: 'vision', label: '识图' },
  { key: 'code', label: '交易码' },
]
