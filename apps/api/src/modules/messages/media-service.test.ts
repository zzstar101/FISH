import { describe, expect, test } from 'bun:test'
import type { MediaMessageInput, MediaPresignInput } from '@fish/contracts/chat/schema'
import type { MediaStorage } from '../uploads/storage'
import { createMediaMessageService, MediaMessageServiceError } from './media-service'
import type { MediaMessageStore, MediaRow } from './media-store'

const conversationId = '11111111-1111-4111-8111-111111111111'
const userId = '22222222-2222-4222-8222-222222222222'
const mediaId = '33333333-3333-4333-8333-333333333333'

const image: MediaMessageInput = {
  kind: 'IMAGE',
  objectKey: `chat-media/${conversationId}/${userId}/image.webp`,
  contentType: 'image/webp',
  sizeBytes: 1024,
  width: 100,
  height: 80,
}

function row(input: MediaMessageInput): MediaRow {
  return {
    message_id: '44444444-4444-4444-8444-444444444444',
    conversation_id: conversationId,
    sender_id: userId,
    media_id: mediaId,
    kind: input.kind,
    object_key: input.objectKey,
    mime_type: input.contentType,
    size_bytes: input.sizeBytes,
    width: 'width' in input ? input.width : null,
    height: 'height' in input ? input.height : null,
    duration_ms: 'durationMs' in input ? input.durationMs : null,
    created_at: '2026-09-14T12:00:00.000Z',
    created_at_iso: '2026-09-14T12:00:00.000000Z',
  }
}

function setup(
  overrides: Partial<MediaMessageStore> = {},
  storageOverrides: Partial<MediaStorage> = {},
) {
  const store: MediaMessageStore = {
    participant: async () => ({
      buyerId: userId,
      sellerId: '55555555-5555-4555-8555-555555555555',
    }),
    create: async (_conversationId, _senderId, input) => row(input),
    list: async () => [],
    find: async () => row(image),
    ...overrides,
  }
  const storage: MediaStorage = {
    presignPut: () => ({
      url: 'https://upload.test/media',
      headers: {},
      expiresAt: '2026-09-14T12:10:00.000Z',
    }),
    stat: async () => ({ size: 1024, contentType: 'image/webp' }),
    readMediaBytes: async () => webpBytes(),
    publicUrl: (key) => `https://cdn.test/${key}`,
    ...storageOverrides,
  }
  return createMediaMessageService({
    store,
    storage,
    mediaUrl: (conversation, media) =>
      `https://api.test/conversations/${conversation}/media/${media}`,
  })
}

// ---- 可解析的媒体字节样本（与 media-probe.test 一致的构造）----

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

function u24le(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]
}

function ascii(value: string): number[] {
  return value.split('').map((c) => c.charCodeAt(0))
}

/** WebP VP8X 尺寸样本：800x600。 */
function webpBytes(): Uint8Array {
  const chunk = [...ascii('VP8X'), ...u32be(10), 0x0f, 0, 0, 0, ...u24le(799), ...u24le(599)]
  return new Uint8Array([...ascii('RIFF'), ...u32le(8 + chunk.length), ...ascii('WEBP'), ...chunk])
}

function vint(value: number, length: 1 | 2 | 3 | 4 = 2): number[] {
  const result: number[] = []
  let remaining = value
  for (let i = length - 1; i >= 1; i--) {
    result.unshift(remaining & 0xff)
    remaining >>>= 8
  }
  const valueBits = 8 * length - length
  const mask = (1 << valueBits) - 1
  result.unshift(((remaining & mask) | ((1 << (8 - length)) as number)) & 0xff)
  return result
}

function f64be(value: number): number[] {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value, false)
  const out: number[] = []
  for (let i = 0; i < 8; i++) out.push(view.getUint8(i))
  return out
}

/** EBML **Unsigned Integer Element Data**（普通大端，非 VINT）。 */
function uintBE(value: number, length: number): number[] {
  const out: number[] = []
  for (let i = length - 1; i >= 0; i--) out.push((value >>> (8 * i)) & 0xff)
  return out
}

/**
 * WebM：`Info[TimecodeScale=1ms, Duration=ticks]`，时长 = ticks ms。
 *
 * 两个字段都是 **EBML Unsigned Integer / Float**，不是 VINT：用普通大端 uint 编码
 * （旧的 `vint()` 写法会把实现的错误一起冻结，见评审 blocker 2）。
 */
function webmBytes(durationMs: number): Uint8Array {
  const scaleBytes = uintBE(1_000_000, 3)
  const timecodeScale = [...vint(0x2ad7b1, 3), ...vint(scaleBytes.length), ...scaleBytes]
  const duration = [...vint(0x4489, 2), ...vint(8), ...f64be(durationMs)]
  const info = [
    ...vint(0x1549a966, 4),
    ...vint(timecodeScale.length + duration.length),
    ...timecodeScale,
    ...duration,
  ]
  const ebmlHeader = [0x1a, 0x45, 0xdf, 0xa3, ...vint(0)]
  const segmentId = [0x18, 0x53, 0x80, 0x67]
  return new Uint8Array([
    ...ebmlHeader,
    ...segmentId,
    ...vint(ebmlHeader.length + info.length),
    ...info,
  ])
}

describe('media message service', () => {
  test('presigns only allowed image and voice metadata', async () => {
    const service = setup()
    const input: MediaPresignInput = { kind: 'IMAGE', contentType: 'image/webp', sizeBytes: 1024 }
    expect((await service.presign(userId, conversationId, input)).objectKey).toStartWith(
      `chat-media/${conversationId}/${userId}/`,
    )
    await expect(
      service.presign(userId, conversationId, {
        kind: 'IMAGE',
        contentType: 'image/gif',
        sizeBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(MediaMessageServiceError)
  })

  test('requires the uploaded object to match the declared metadata', async () => {
    const service = setup({}, { stat: async () => ({ size: 9, contentType: 'image/webp' }) })
    await expect(service.create(userId, conversationId, image)).rejects.toMatchObject({
      code: 'MEDIA_OBJECT_INVALID',
    })
  })

  test('rejects outsiders and keeps media access participant-scoped', async () => {
    const service = setup({ participant: async () => null })
    await expect(
      service.create('66666666-6666-4666-8666-666666666666', conversationId, image),
    ).rejects.toMatchObject({
      code: 'CONVERSATION_NOT_FOUND',
    })
    await expect(service.getObject(userId, conversationId, mediaId)).rejects.toMatchObject({
      code: 'CONVERSATION_NOT_FOUND',
    })
  })

  test('parses real image dimensions server-side (fix-plan F5)', async () => {
    const service = setup({}, { stat: async () => ({ size: 1024, contentType: 'image/webp' }) })
    // 客户端声明 800x600 与真实一致：服务端解析并校验一致后放行。
    const created = await service.create(userId, conversationId, {
      kind: 'IMAGE',
      objectKey: `chat-media/${conversationId}/${userId}/real.webp`,
      contentType: 'image/webp',
      sizeBytes: 1024,
      width: 800,
      height: 600,
    })
    expect(created.width).toBe(800)
    expect(created.height).toBe(600)
  })

  test('rejects an image whose probed size exceeds the limit', async () => {
    // 构造 5000x5000 的 VP8X canvas（canvas width-1/height-1 在 chunk data +4/+7 的 24-bit LE）
    const chunk = [...ascii('VP8X'), ...u32be(10), 0x0f, 0, 0, 0, ...u24le(4999), ...u24le(4999)]
    const huge = new Uint8Array([
      ...ascii('RIFF'),
      ...u32le(8 + chunk.length),
      ...ascii('WEBP'),
      ...chunk,
    ])
    const service = setup(
      {},
      {
        stat: async () => ({ size: 2048, contentType: 'image/webp' }),
        readMediaBytes: async () => huge,
      },
    )
    const oversized = {
      kind: 'IMAGE' as const,
      objectKey: `chat-media/${conversationId}/${userId}/huge.webp`,
      contentType: 'image/webp',
      sizeBytes: 2048,
      width: 5000,
      height: 5000,
    }
    await expect(service.create(userId, conversationId, oversized)).rejects.toMatchObject({
      code: 'MEDIA_DIMENSION_EXCEEDED',
    })
  })

  test('rejects an image when the real dimension differs from the declared one', async () => {
    const service = setup({}, { stat: async () => ({ size: 1024, contentType: 'image/webp' }) })
    await expect(
      service.create(userId, conversationId, {
        ...image,
        objectKey: `chat-media/${conversationId}/${userId}/real.webp`,
        width: 10,
        height: 10,
      }),
    ).rejects.toMatchObject({
      code: 'MEDIA_OBJECT_INVALID',
    })
  })

  test('parses real voice duration server-side (fix-plan F5 / B1)', async () => {
    const service = setup(
      {},
      {
        stat: async () => ({ size: 2048, contentType: 'audio/webm' }),
        readMediaBytes: async () => webmBytes(3500),
      },
    )
    const created = await service.create(userId, conversationId, {
      kind: 'VOICE',
      objectKey: `chat-media/${conversationId}/${userId}/voice.webm`,
      contentType: 'audio/webm',
      sizeBytes: 2048,
      durationMs: 3500,
    })
    expect(created.durationMs).toBe(3500)
  })

  test('rejects a voice clip longer than the limit (fix-plan F5 / B1)', async () => {
    const service = setup(
      {},
      {
        stat: async () => ({ size: 2048, contentType: 'audio/webm' }),
        readMediaBytes: async () => webmBytes(61_000),
      },
    )
    await expect(
      service.create(userId, conversationId, {
        kind: 'VOICE',
        objectKey: `chat-media/${conversationId}/${userId}/long.webm`,
        contentType: 'audio/webm',
        sizeBytes: 2048,
        durationMs: 61_000,
      }),
    ).rejects.toMatchObject({
      code: 'MEDIA_DURATION_EXCEEDED',
    })
  })

  test('fails closed when the object cannot be read (fix-plan F5)', async () => {
    const service = setup({}, { readMediaBytes: async () => null })
    await expect(service.create(userId, conversationId, image)).rejects.toMatchObject({
      code: 'MEDIA_OBJECT_INVALID',
    })
  })

  // 回归（评审 blocker 1）：presign 只校验客户端声明的 sizeBytes，而签名不约束 Content-Length。
  // 攻击路径：用 1MB 声明拿 presign → 实际上传 100MB → 在 create 时声明 100MB 落库。
  // 必须在 create 里基于 `stat.size` 再做一次真实上限校验。
  test('rejects an object whose real size exceeds the kind limit (defense in depth)', async () => {
    const service = setup(
      {},
      {
        // 真实对象 100MB，但客户端声明也只有 1KB（两者一致，所以只靠 stat===declared 拦不住）
        stat: async () => ({ size: 100 * 1024 * 1024, contentType: 'image/webp' }),
      },
    )
    await expect(
      service.create(userId, conversationId, {
        ...image,
        objectKey: `chat-media/${conversationId}/${userId}/huge.webp`,
        sizeBytes: 100 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ code: 'MEDIA_OBJECT_INVALID' })
  })

  // 回归（评审 major）：媒体历史必须真的分页。契约是 `{items, nextCursor}`，
  // 旧实现固定 `nextCursor: null`，>limit 条后更早的媒体没有可达路径。
  test('returns a cursor for the next page and pages backwards without gaps', async () => {
    // 12 条媒体，`limit=5`：第一页 5 条（最新）+ 游标；第二页再 5 条；第三页 2 条 + null。
    const all = Array.from({ length: 12 }, (_, index) => {
      const minute = String(59 - index).padStart(2, '0')
      return {
        ...row(image),
        message_id: `01930000-0000-7000-8000-0000000000${String(index).padStart(2, '0')}`,
        created_at: `2026-09-14T12:${minute}:00.000Z`,
        created_at_iso: `2026-09-14T12:${minute}:00.000000Z`,
      }
    })

    // fake 按 `(created_at, id) < cursor` 做与 SQL 同语义的过滤，并返回 DESC。
    const store: Partial<MediaMessageStore> = {
      list: async (_conversationId, _userId, { limit, cursor }) => {
        const remaining = cursor
          ? all.filter(
              (item) =>
                item.created_at_iso < cursor.createdAt ||
                (item.created_at_iso === cursor.createdAt && item.message_id < cursor.id),
            )
          : all
        return [...remaining]
          .sort((a, b) => (a.created_at_iso < b.created_at_iso ? 1 : -1))
          .slice(0, limit + 1)
      },
    }
    const service = setup(store)

    const first = await service.list(userId, conversationId, { limit: 5 })
    expect(first.items).toHaveLength(5)
    expect(first.nextCursor).not.toBeNull()

    const second = await service.list(userId, conversationId, {
      limit: 5,
      cursor: first.nextCursor ?? undefined,
    })
    expect(second.items).toHaveLength(5)
    expect(second.nextCursor).not.toBeNull()

    const third = await service.list(userId, conversationId, {
      limit: 5,
      cursor: second.nextCursor ?? undefined,
    })
    expect(third.items).toHaveLength(2)
    expect(third.nextCursor).toBeNull()

    // 三页恰好覆盖全部 12 条、不重不漏（对比 id 集合）。
    const ids = [...first.items, ...second.items, ...third.items].map((item) => item.id)
    expect(new Set(ids).size).toBe(12)
    // 每页内部仍是时间正序。
    const times = first.items.map((item) => item.createdAt)
    expect(times).toEqual([...times].sort())
  })

  test('rejects a malformed media cursor with 422', async () => {
    const service = setup()
    await expect(
      service.list(userId, conversationId, { limit: 5, cursor: 'not-base64-json' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 })
    await expect(
      service.list(userId, conversationId, {
        limit: 5,
        // 形状对但日期越界：必须在这里挡成 422，而不是被 PG 拒成 500。
        cursor: Buffer.from(
          JSON.stringify({ createdAt: '2026-13-45T99:99:99.999999Z', id: mediaId }),
        ).toString('base64url'),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 })
  })
})
