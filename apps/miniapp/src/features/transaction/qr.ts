/**
 * 面交二维码的本地渲染（#114）。
 *
 * 卖家「交易码」页要把后端签发的 `qrPayload` 画成二维码给对方扫。
 * `qrcode-generator` 是无依赖的纯 JS 编码器：这里只做编码，
 * 输出 GIF 的 base64 data URL 直接塞进 `<Image src>` —— 不碰 Canvas，
 * 就不用适配小程序 canvas 2d 与 H5 预览两套 API。
 */
import qrcode from 'qrcode-generator'

/** cellSize=8、留 4 模块白边：37×37 左右的码在 300rpx 容器里清晰可扫。 */
export function qrDataUrl(payload: string, cellSize = 8, margin = 4): string {
  const qr = qrcode(0, 'M')
  qr.addData(payload)
  qr.make()
  return qr.createDataURL(cellSize, margin)
}
