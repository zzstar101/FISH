import { listingThumbnailKeyOf, type MediaStorage } from './storage'

/**
 * 列表缩略图（#620）。
 *
 * 商品卡 / 收藏 / 订单 / 会话里显示封面的位置全是小图（最大的他人主页网格与商品卡也只在
 * 300–345 CSS px 量级），却一直原样加载上传原图：6 张公开封面合计 1.5 MiB，单张 1280×857
 * 就有 309 KB。这里在**服务端**把它们压到长边 ≤ 400 的 webp，作为独立对象与写入时的
 * `listings/{usr}/{med}.{ext}` 并存；列表/卡片的 `coverUrl` 指向缩略图，详情与放大仍用原图。
 *
 * 为什么不用 CDN 的查询参数（`?imageMogr2/...`）：issue #620 实测当前生产配置下它返回的
 * 仍是原字节与原 ETag，打开它需要改生产 CDN 配置。生成独立对象只依赖 `Bun.Image`（Bun 原生，
 * 无新依赖）与现有的对象存储写入能力，字节在写入时就已确定。
 */

/**
 * 缩略图长边。
 *
 * 卡片封面最大约 345 CSS px（商品卡、他人主页半宽网格），400 留出一点余量；再大对 2x/3x 屏的
 * 小图没有可感知收益，却会明显增加列表流量。
 */
export const LISTING_THUMBNAIL_MAX_EDGE = 400

/**
 * webp 质量 75。目前只用本机样本（小程序截图、合成图）量过字节，**没有真实商品照片做主观对比**：
 * 长边 400 时样本落在 4–8 KB，q80 大约多 15%（见 PR 的样本记录）。真实照片会更接近 10–20 KB。
 */
export const LISTING_THUMBNAIL_QUALITY = 75

export const LISTING_THUMBNAIL_CONTENT_TYPE = 'image/webp'

export type RenderedListingThumbnail = {
  bytes: Uint8Array
  width: number
  height: number
}

/** 渲染失败（损坏的图片、超大头像、编解码器拒绝）——调用方据此决定降级还是报错。 */
export class ListingThumbnailError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ListingThumbnailError'
  }
}

/**
 * 把一张已经过内容审核的图片渲染成列表缩略图。
 *
 * - **不放大小图**：`withoutEnlargement` 保证 100×100 的头像仍是 100×100（`fit: 'inside'` 单独
 *   使用时会把小图放大到 400，反而更糊、更大）；
 * - **方向**：`Bun.Image` 默认 `autoOrient`，EXIF Orientation 已在解码阶段应用（实测
 *   Orientation=6 的 400×200 JPEG，`metadata()` 返回 200×400，输出像素方向正确、EXIF 被剥离）；
 * - **格式**：一律 webp；透明通道保留（PNG 商品图/头像不会变黑底）。
 */
export async function renderListingThumbnail(
  source: Uint8Array,
): Promise<RenderedListingThumbnail> {
  let metadata: Bun.Image.Metadata
  let bytes: Uint8Array
  try {
    metadata = await new Bun.Image(source).metadata()
    bytes = await new Bun.Image(source)
      .resize(LISTING_THUMBNAIL_MAX_EDGE, LISTING_THUMBNAIL_MAX_EDGE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: LISTING_THUMBNAIL_QUALITY })
      .bytes()
  } catch (error) {
    throw new ListingThumbnailError('列表缩略图渲染失败', { cause: error })
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new ListingThumbnailError('列表缩略图渲染结果为空')
  }
  const scale = Math.min(1, LISTING_THUMBNAIL_MAX_EDGE / Math.max(metadata.width, metadata.height))
  return {
    bytes,
    width: Math.max(1, Math.round(metadata.width * scale)),
    height: Math.max(1, Math.round(metadata.height * scale)),
  }
}

/**
 * 渲染并写入缩略图对象；返回 `false` 表示这个键没有缩略图（不是规范公开键）。
 *
 * 故意**抛错**而不是吞掉：`confirm` 与人工放行结算都刚成功写入过同一个存储，缩略图写失败说明
 * 存储正在抖动或图片无法解码，调用方必须自己决定（当前是记日志 + 由回填脚本修复）。
 */
export async function writeListingThumbnail(
  storage: Pick<MediaStorage, 'writeMediaBytes'>,
  publicKey: string,
  source: Uint8Array,
): Promise<boolean> {
  const thumbnailKey = listingThumbnailKeyOf(publicKey)
  if (!thumbnailKey) return false
  const writeBytes = storage.writeMediaBytes
  if (!writeBytes) {
    throw new ListingThumbnailError('媒体存储不支持写入字节，无法生成列表缩略图')
  }
  const rendered = await renderListingThumbnail(source)
  await writeBytes.call(storage, thumbnailKey, rendered.bytes, LISTING_THUMBNAIL_CONTENT_TYPE)
  return true
}

/**
 * `writeListingThumbnail` 的**尽力而为**版本：失败只记日志。
 *
 * 用在 `confirm` 与人工放行结算里 —— 图片本身已经审核并固化，缩略图失败不该让用户重传或让
 * 管理员无法给出结论。代价是这张图在列表里会暂时 404（卡片位置空白），
 * `apps/api/scripts/backfill-listing-thumbnails.ts` 可幂等地补上。
 */
export async function tryWriteListingThumbnail(
  storage: Pick<MediaStorage, 'writeMediaBytes'>,
  publicKey: string,
  source: Uint8Array,
): Promise<void> {
  try {
    await writeListingThumbnail(storage, publicKey, source)
  } catch (error) {
    console.warn('[uploads] 列表缩略图生成失败（可用回填脚本修复）', publicKey, error)
  }
}
