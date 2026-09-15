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
})
