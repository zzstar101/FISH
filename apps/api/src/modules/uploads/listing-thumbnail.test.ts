import { describe, expect, test } from 'bun:test'
import { newId } from '@fish/db/ids'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import {
  ListingThumbnailError,
  renderListingThumbnail,
  tryWriteListingThumbnail,
  writeListingThumbnail,
} from './listing-thumbnail'
import type { MediaStorage } from './storage'

const USER_ID = '01930000-0000-7000-8000-00000000000a'
const MEDIA_ID = '01930000-0000-7000-8000-0000000000c2'

/**
 * 用 24 位未压缩 BMP 造一张真实图片：`Bun.Image` 读不了裸像素，而缩略图链路（#620）测的是
 * 解码 → 缩放 → webp 编码，必须喂它真能解开的字节。BMP 头部固定 54 字节，按行 4 字节对齐，
 * 像素为 `BGR`、行序自下而上 —— 这里只关心尺寸，颜色无所谓。
 */
function bmp(width: number, height: number): Uint8Array {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const dataSize = rowSize * height
  const buffer = Buffer.alloc(54 + dataSize)
  buffer.write('BM', 0)
  buffer.writeUInt32LE(54 + dataSize, 2)
  buffer.writeUInt32LE(54, 10)
  buffer.writeUInt32LE(40, 14)
  buffer.writeInt32LE(width, 18)
  buffer.writeInt32LE(height, 22)
  buffer.writeUInt16LE(1, 26)
  buffer.writeUInt16LE(24, 28)
  buffer.writeUInt32LE(dataSize, 34)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = 54 + y * rowSize + x * 3
      buffer[offset] = 0
      buffer[offset + 1] = 0
      buffer[offset + 2] = 128
    }
  }
  return new Uint8Array(buffer)
}

async function decodeDimension(bytes: Uint8Array): Promise<{ width: number; height: number }> {
  const metadata = await new Bun.Image(bytes).metadata()
  return { width: metadata.width, height: metadata.height }
}

describe('renderListingThumbnail', () => {
  test('把长边压到 400，保持比例，输出 webp', async () => {
    const source = bmp(500, 400)
    const rendered = await renderListingThumbnail(source)

    expect(rendered.width).toBe(400)
    expect(rendered.height).toBe(320)
    expect(new TextDecoder().decode(rendered.bytes.subarray(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(rendered.bytes.subarray(8, 12))).toBe('WEBP')
    expect(await decodeDimension(rendered.bytes)).toEqual({ width: 400, height: 320 })
    // 原图 600 KB 的未压缩 BMP 换成 1–2 KB 的 webp：列表封面的字节量级由此改变。
    expect(rendered.bytes.byteLength).toBeLessThan(source.byteLength)
  })

  test('小图不被放大（withoutEnlargement）', async () => {
    const rendered = await renderListingThumbnail(bmp(120, 80))

    expect(rendered.width).toBe(120)
    expect(rendered.height).toBe(80)
    expect(await decodeDimension(rendered.bytes)).toEqual({ width: 120, height: 80 })
  })

  test('解不开的字节抛 ListingThumbnailError（调用方据此降级）', async () => {
    const error = await renderListingThumbnail(new Uint8Array([1, 2, 3, 4])).catch(
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(ListingThumbnailError)
    expect((error as ListingThumbnailError).name).toBe('ListingThumbnailError')
    expect((error as Error).message).toBe('列表缩略图渲染失败')
  })
})

describe('writeListingThumbnail', () => {
  test('写 `listings/{usr}/{med}-thumb.webp`，内容类型 webp', async () => {
    const writes: { key: string; contentType: string }[] = []
    const storage: Pick<MediaStorage, 'writeMediaBytes'> = {
      writeMediaBytes: async (key, _bytes, contentType) => {
        writes.push({ key, contentType })
      },
    }
    const publicKey = `listings/${encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID)}/${encodePublicId(PUBLIC_ID_PREFIX.media, MEDIA_ID)}.jpg`

    await expect(writeListingThumbnail(storage, publicKey, bmp(320, 240))).resolves.toBe(true)
    expect(writes).toEqual([
      { key: `${publicKey.slice(0, -4)}-thumb.webp`, contentType: 'image/webp' },
    ])
  })

  test('非规范公开键没有缩略图，直接返回 false 且不写对象', async () => {
    let called = 0
    const storage: Pick<MediaStorage, 'writeMediaBytes'> = {
      writeMediaBytes: async () => {
        called += 1
      },
    }

    // 审核中的私有键、seed 演示键、legacy UUID 键都不是"列表封面会被生成缩略图"的键域。
    await expect(writeListingThumbnail(storage, 'covers/a.jpg', bmp(10, 10))).resolves.toBe(false)
    await expect(
      writeListingThumbnail(storage, 'listings/seed-k380/0.jpg', bmp(10, 10)),
    ).resolves.toBe(false)
    expect(called).toBe(0)
  })
})

test('tryWriteListingThumbnail 吞掉写入失败（缩略图不该阻断上传/人工放行）', async () => {
  const storage: Pick<MediaStorage, 'writeMediaBytes'> = {
    writeMediaBytes: async () => {
      throw new Error('S3 抖动')
    },
  }
  const publicKey = `listings/${encodePublicId(PUBLIC_ID_PREFIX.user, newId())}/${encodePublicId(PUBLIC_ID_PREFIX.media, MEDIA_ID)}.png`

  await expect(tryWriteListingThumbnail(storage, publicKey, bmp(30, 20))).resolves.toBeUndefined()
})
