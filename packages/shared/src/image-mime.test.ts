import { describe, expect, test } from 'bun:test'
import { sniffImageMime } from './image-mime'

/**
 * 魔术字节判定（#324 M2）：客户端声明的 `Content-Type` 从不被信任，服务端按内容判定格式。
 * 这里钉住"什么算三种允许格式"与"什么必须被拒"——放宽一条就等于让非图片字节进入上游计费。
 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SOI = [0xff, 0xd8, 0xff]
const RIFF_WEBP = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

describe('sniffImageMime', () => {
  test('PNG 的 8 字节签名', () => {
    expect(sniffImageMime(bytes(...PNG_SIGNATURE, 0x00, 0x00, 0x00, 0x0d))).toBe('image/png')
  })

  test('JPEG 的 SOI + 段标记', () => {
    expect(sniffImageMime(bytes(...JPEG_SOI, 0xe0, 0x00, 0x10))).toBe('image/jpeg')
  })

  test('WebP 的 RIFF 容器 + WEBP 四字符码', () => {
    expect(sniffImageMime(bytes(...RIFF_WEBP))).toBe('image/webp')
  })

  test('恰好 3 字节的 JPEG 前缀也算（只判前缀，不要求完整文件）', () => {
    expect(sniffImageMime(bytes(...JPEG_SOI))).toBe('image/jpeg')
  })

  test('GIF / BMP / PDF / 纯文本一律拒绝', () => {
    expect(sniffImageMime(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBeNull()
    expect(sniffImageMime(bytes(0x42, 0x4d, 0x00, 0x00))).toBeNull()
    expect(sniffImageMime(new TextEncoder().encode('%PDF-1.7'))).toBeNull()
    expect(sniffImageMime(new TextEncoder().encode('not an image at all'))).toBeNull()
  })

  test('空数组与过短的前缀拒绝，而不是抛错', () => {
    expect(sniffImageMime(new Uint8Array(0))).toBeNull()
    expect(sniffImageMime(bytes(0xff, 0xd8))).toBeNull()
    expect(sniffImageMime(bytes(...PNG_SIGNATURE.slice(0, 7)))).toBeNull()
    expect(sniffImageMime(bytes(...RIFF_WEBP.slice(0, 11)))).toBeNull()
  })

  test('PNG 签名第 8 字节不符即拒绝（差一个字节就不是 PNG）', () => {
    const wrong = [...PNG_SIGNATURE]
    wrong[7] = 0x0b
    expect(sniffImageMime(bytes(...wrong, 0x00, 0x00))).toBeNull()
  })

  test('RIFF 容器但不是 WEBP（如 WAVE）拒绝', () => {
    const wave = [...RIFF_WEBP]
    wave[8] = 0x57
    wave[9] = 0x41
    wave[10] = 0x56
    wave[11] = 0x45
    expect(sniffImageMime(bytes(...wave))).toBeNull()
  })

  test('接受 Uint8Array 的子类（Bun 的 Buffer）', () => {
    expect(sniffImageMime(Buffer.from([...PNG_SIGNATURE, 0x00, 0x00]))).toBe('image/png')
  })
})
