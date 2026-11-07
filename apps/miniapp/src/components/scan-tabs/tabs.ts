/**
 * 扫码页（`pkg-vision/pages/scan`）两段 tab 的**纯逻辑**：tab 定义、入口 URL 与参数解析。
 *
 * #583（Owner 2026-11-03 拍板）：扫码家族合成一个页面，底部两段 tab「扫一扫 / 拍图搜」
 * **页内切换、不跳页**；`?tab=scan|photo` 决定初始 tab，缺省 `scan`。
 *
 * 入口 URL 是页面间契约（写错只会在运行时表现为进错 tab / 进不去），所以各入口一律经
 * `scanPageUrl` 拼，不手写字符串；参数解析放这里是为了可被单测覆盖。
 */

export type ScanTabKey = 'scan' | 'photo'

/** 扫码页路由（扫一扫 / 拍图搜共用这一页） */
export const SCAN_PAGE = '/pkg-vision/pages/scan/index'

/** 「从面交页进来」的标记参数值：只有它才显示「输入 6 位交易码」（点了返回面交页输入） */
const FROM_MEETUP = 'meetup'

export const SCAN_TABS: { key: ScanTabKey; label: string }[] = [
  { key: 'scan', label: '扫一扫' },
  { key: 'photo', label: '拍图搜' },
]

/** 进扫码页的 URL。`fromMeetup` 只由面交页传（见 `parseScanEntry`）。 */
export function scanPageUrl(tab: ScanTabKey, options: { fromMeetup?: boolean } = {}): string {
  const base = `${SCAN_PAGE}?tab=${tab}`
  return options.fromMeetup === true ? `${base}&from=${FROM_MEETUP}` : base
}

/** 扫码页进页参数：未知 / 缺省的 `tab` 一律落 `scan`。 */
export function parseScanEntry(params: { tab?: string; from?: string }): {
  tab: ScanTabKey
  fromMeetup: boolean
} {
  return {
    tab: params.tab === 'photo' ? 'photo' : 'scan',
    fromMeetup: params.from === FROM_MEETUP,
  }
}
