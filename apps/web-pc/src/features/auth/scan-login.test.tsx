import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ExpiredQrPreview } from './scan-login'

describe('ExpiredQrPreview', () => {
  test('过期态展示压暗的码图与「已过期」，不再出现沙漏', () => {
    const html = renderToStaticMarkup(
      createElement(ExpiredQrPreview, {
        qrCodeDataUrl: 'data:image/jpeg;base64,AAAA',
      }),
    )

    expect(html).toContain('已过期')
    expect(html).toContain('mix-blend-multiply')
    expect(html).toContain('data:image/jpeg;base64,AAAA')
    expect(html).not.toContain('⌛')
  })

  test('没有码图时退化为同色系占位徽标', () => {
    const html = renderToStaticMarkup(createElement(ExpiredQrPreview, { qrCodeDataUrl: null }))

    expect(html).not.toContain('<img')
    expect(html).toContain('lucide-qr-code')
  })
})
