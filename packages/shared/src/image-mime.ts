/**
 * 图片字节 → 真实 MIME 的**魔术字节**判定（#324 M2）。
 *
 * 为什么需要：查询图经预签名直传，`Content-Type` 由客户端声明；`stat()` 拿回来的是**上传时
 * 声明的类型**，不是内容的真实类型。把它直接交给上游模型（或按它决定扩展名）等于让客户端
 * 决定服务端怎么解析这段字节。所以服务端一律以魔术字节为准，声明值与实际不符即拒绝。
 *
 * 只认契约里的三种格式（`ALLOWED_IMAGE_MIME`）。解析失败返回 `null` 由调用方 fail-closed，
 * 不在这里抛错——"为什么不是图片"是调用方要决定响应码的事。
 *
 * 放在 `@fish/shared` 而不是某个 app 下：API（查询图校验）与 worker（回填时复核封面）
 * 都需要同一个实现，两份拷贝迟早会漂移。
 */
export type SniffedImageMime = 'image/jpeg' | 'image/png' | 'image/webp'

export function sniffImageMime(bytes: Uint8Array): SniffedImageMime | null {
  // JPEG：SOI 标记 + 第一个段标记（FF D8 FF）。
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }

  // PNG：8 字节固定签名。
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }

  // WebP：RIFF 容器 + `WEBP` 四字符码（第 4-7 字节是长度，不参与判定）。
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }

  return null
}
