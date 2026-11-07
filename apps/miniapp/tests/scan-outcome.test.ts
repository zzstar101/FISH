import { describe, expect, test } from 'bun:test'
import { buildMeetupQrPayload } from '@fish/contracts/transactions/meetup-qr'
import qrcode from 'qrcode-generator'
import { scanOutcome } from '../src/pkg-vision/pages/scan/outcome'
import { decodeCanvasSize, decodeQrPixels } from '../src/pkg-vision/pages/scan/qr-decode'

/**
 * 扫一扫的结果分派与相册识码（#583）。相机识码与相册识码走同一个 `scanOutcome`：
 * 只认鱼小应的交易码，其余落「这不是鱼小应的交易码」，相册图里解不出码落「图里没找到二维码」。
 */

const TX_ID = 'txn_01jc001qkte00800000000fjta'
const PAYLOAD = buildMeetupQrPayload(TX_ID, 'tok_abc123def456ghi789')

/** 把一段文本编码成二维码，铺成 RGBA 像素（每模块 `cell` px、四周 4 模块白边） */
function qrPixels(text: string, cell = 4): { data: Uint8ClampedArray; size: number } {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  const modules = qr.getModuleCount()
  const size = (modules + 8) * cell
  const data = new Uint8ClampedArray(size * size * 4).fill(255)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const row = Math.floor(y / cell) - 4
      const col = Math.floor(x / cell) - 4
      if (row >= 0 && col >= 0 && row < modules && col < modules && qr.isDark(row, col)) {
        const i = (y * size + x) * 4
        data[i] = 0
        data[i + 1] = 0
        data[i + 2] = 0
      }
    }
  }
  return { data, size }
}

describe('scanOutcome', () => {
  test('交易码 → 面交页（原值整段 URL 编码带过去）', () => {
    expect(scanOutcome(PAYLOAD)).toEqual({
      kind: 'meetup',
      url: `/pkg-trade/pages/transaction-meetup/index?code=${encodeURIComponent(PAYLOAD)}`,
    })
  })

  test('其他二维码 / 任意文本 → 「这不是鱼小应的交易码」', () => {
    expect(scanOutcome('https://example.com/pay?id=1')).toEqual({
      kind: 'failure',
      reason: 'invalid',
    })
    expect(scanOutcome('hello')).toEqual({ kind: 'failure', reason: 'invalid' })
  })

  test('相册图里没解出码 → 「图里没找到二维码」', () => {
    expect(scanOutcome(null)).toEqual({ kind: 'failure', reason: 'no-qr' })
  })
})

describe('相册识码', () => {
  test('交易码图片解出来走面交页', () => {
    const { data, size } = qrPixels(PAYLOAD)
    const raw = decodeQrPixels(data, size, size)
    expect(raw).toBe(PAYLOAD)
    expect(scanOutcome(raw).kind).toBe('meetup')
  })

  test('没有二维码的图解码失败 → no-qr', () => {
    const size = 64
    const blank = new Uint8ClampedArray(size * size * 4).fill(255)
    const raw = decodeQrPixels(blank, size, size)
    expect(raw).toBeNull()
    expect(scanOutcome(raw)).toEqual({ kind: 'failure', reason: 'no-qr' })
  })

  test('解码画布按长边收到上限内、等比；小图原样', () => {
    expect(decodeCanvasSize({ width: 4000, height: 3000 }, 1024)).toEqual({
      width: 1024,
      height: 768,
    })
    expect(decodeCanvasSize({ width: 600, height: 800 }, 1024)).toEqual({ width: 600, height: 800 })
  })
})
