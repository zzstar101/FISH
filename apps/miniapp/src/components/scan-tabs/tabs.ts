/**
 * 扫码家族（扫一扫 / 识图 / 交易码）底部分类切换的**纯逻辑**。
 *
 * 三个页面共用同一组文字切换钮（Owner 2026-09-26 定版）：扫一扫页与交易码页
 * 互为兄弟页，切换用 `redirectTo` 把当前页从栈里换掉，避免来回切把页面栈堆满；
 * 识图（商品识图搜索）尚未开工，点了只给提示。
 *
 * 抽成纯函数是为了让「点哪个 tab 发生什么」可被单测覆盖——两个 redirect 的
 * URL 是页面间契约，写错只会在运行时表现为静默失败。
 */

export type ScanTabKey = 'scan' | 'vision' | 'code'

/** 扫一扫页（通用二维码）；交易码页见 `pages/scan-pr`。 */
export const SCAN_QR_PAGE = '/pages/scan/index'
export const SCAN_CODE_PAGE = '/pages/scan-pr/index'

export type ScanTabAction = { kind: 'redirect'; url: string } | { kind: 'toast'; title: string }

/** 点某个 tab 的去向；当前已在该 tab 上时返回 null（组件不重复跳转）。 */
export function scanTabAction(key: ScanTabKey, active: ScanTabKey): ScanTabAction | null {
  if (key === active) return null
  if (key === 'vision') return { kind: 'toast', title: '识图搜索暂未开放' }
  if (key === 'code') return { kind: 'redirect', url: SCAN_CODE_PAGE }
  return { kind: 'redirect', url: SCAN_QR_PAGE }
}

export const SCAN_TABS: { key: ScanTabKey; label: string }[] = [
  { key: 'scan', label: '扫一扫' },
  { key: 'vision', label: '识图' },
  { key: 'code', label: '交易码' },
]
