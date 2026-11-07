/**
 * 相册识码的**像素解码**（纯逻辑，可单测）：端上 jsQR，不走网络（#583）。
 *
 * 取像素的那一段（离屏 Canvas `drawImage` → `getImageData`）依赖小程序运行时，在页面里；
 * 这里只回答两件事：
 *
 * 1. **画布画多大**（`decodeCanvasSize`）：相册原图动辄 4000px，整张 `getImageData` 既慢又
 *    吃内存，jsQR 的耗时也随像素数线性涨。长边先收到 `MAX_DECODE_SIDE` 以内 —— 截图里的
 *    交易码缩到这个尺寸仍有上百像素宽，足够解。
 * 2. **解出来是什么**（`decodeQrPixels`）：解不出（没有二维码 / 太糊）返回 `null`，由分派
 *    落「图里没找到二维码」。
 *
 * jsQR 只被本分包（`pkg-vision`）引用，不进主包。
 */
import jsQR from 'jsqr'

/** 解码画布的长边上限（设备 px） */
export const MAX_DECODE_SIDE = 1024

export type PixelSize = { width: number; height: number }

/** 按长边等比收进 `max`；本来就小于它的原样返回。每边至少 1px。 */
export function decodeCanvasSize(image: PixelSize, max = MAX_DECODE_SIDE): PixelSize {
  const longest = Math.max(image.width, image.height)
  const scale = longest > max ? max / longest : 1
  return {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  }
}

/** RGBA 像素 → 二维码文本；没解出来（或解出空串）返回 `null`。 */
export function decodeQrPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  const code = jsQR(data, width, height)
  if (code === null || code.data === '') return null
  return code.data
}
