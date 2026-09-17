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
    readHead: async () => webpBytes(),
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

/** WebM：仅 Info[TimecodeScale=1ms, durationTicks=ticks]，时长 = ticks ms。 */
function webmBytes(durationMs: number): Uint8Array {
  const timecodeScale = [...vint(0x2ad7b1, 3), ...vint(3), ...vint(1_000_000, 3)]
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
        readHead: async () => huge,
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
        readHead: async () => webmBytes(3500),
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
        readHead: async () => webmBytes(61_000),
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
    const service = setup({}, { readHead: async () => null })
    await expect(service.create(userId, conversationId, image)).rejects.toMatchObject({
      code: 'MEDIA_OBJECT_INVALID',
    })
  })
})
