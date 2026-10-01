/**
 * 面交二维码的本地渲染（对应小程序 `apps/miniapp/src/features/transaction/qr.ts`）。
 *
 * `qrcode-generator` 无运行时依赖，只做编码：输出 GIF 的 base64 data URL 直接塞进
 * `<img src>`，不碰 Canvas。**编码参数与小程序保持一致**（cellSize=8、留 4 模块白边）——
 * 两端渲染的是同一枚码，一方能扫另一方就该能扫，参数漂移会让「小程序能扫、PC 扫不了」
 * 变成难查的问题。
 *
 * 明文凭证只经这里进 DOM，不进 URL / 日志 / 可分享链接（一次性消费由服务端兜底）。
 */
import qrcode from 'qrcode-generator'

export function qrDataUrl(payload: string, cellSize = 8, margin = 4): string {
  const qr = qrcode(0, 'M')
  qr.addData(payload)
  qr.make()
  return qr.createDataURL(cellSize, margin)
}
