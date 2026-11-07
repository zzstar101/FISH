import { describe, expect, test } from 'bun:test'
import { parseScanEntry, SCAN_PAGE, scanPageUrl } from '../src/components/scan-tabs/tabs'

/**
 * 扫码页（#583）的入口 URL 与进页参数解析。
 *
 * 各入口（首页相机 / 搜索页识图钮 → 拍图搜；我的 / 面交页 / 会话状态条 → 扫一扫）都经
 * `scanPageUrl` 拼 URL，扫码页用 `parseScanEntry` 读回来 —— 两头写错只会在运行时表现为
 * 进错 tab 或「输入 6 位码」该出不出，所以在这里成对钉住。
 */

describe('scanPageUrl ↔ parseScanEntry', () => {
  test('两个 tab 往返一致；只有面交页带 from=meetup', () => {
    expect(scanPageUrl('scan')).toBe(`${SCAN_PAGE}?tab=scan`)
    expect(scanPageUrl('photo')).toBe(`${SCAN_PAGE}?tab=photo`)
    expect(scanPageUrl('scan', { fromMeetup: true })).toBe(`${SCAN_PAGE}?tab=scan&from=meetup`)

    const query = (url: string) => Object.fromEntries(new URLSearchParams(url.split('?')[1]))
    expect(parseScanEntry(query(scanPageUrl('photo')))).toEqual({ tab: 'photo', fromMeetup: false })
    expect(parseScanEntry(query(scanPageUrl('scan', { fromMeetup: true })))).toEqual({
      tab: 'scan',
      fromMeetup: true,
    })
  })

  test('缺省 / 未知的 tab 落扫一扫', () => {
    expect(parseScanEntry({})).toEqual({ tab: 'scan', fromMeetup: false })
    expect(parseScanEntry({ tab: 'vision' })).toEqual({ tab: 'scan', fromMeetup: false })
  })

  test('扫码页已在 app.config.ts 的 pkg-vision 分包注册', async () => {
    const config = await Bun.file(new URL('../src/app.config.ts', import.meta.url)).text()
    const [root, ...rest] = SCAN_PAGE.slice(1).split('/')
    const block = config.match(new RegExp(`root: '${root}'[\\s\\S]*?pages: \\[([\\s\\S]*?)\\]`))
    expect(block?.[1]).toContain(`'${rest.join('/')}'`)
  })
})
