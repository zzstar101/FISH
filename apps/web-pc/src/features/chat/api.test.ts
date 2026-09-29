import { describe, expect, test } from 'bun:test'
import type { MediaMessageDto } from '@fish/contracts/chat/schema'
import { ApiError } from '../../lib/api-client'
import {
  conversationListPath,
  createConversation,
  describeCreateConversationFailure,
  describeSendFailure,
  fetchMediaPage,
  isConversationNotFound,
  MediaUploadError,
  mediaListPath,
  messageListPath,
  sendMediaMessage,
} from './api'
import type { MediaUploadDraft } from './media'

const CONVERSATION_ID = 'cnv_01jc000000e00800000000001a'
const CLIENT_REQUEST_ID = '0192f0a0-0000-7000-8000-000000000001'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const mediaDto: MediaMessageDto = {
  id: 'msg_01jc000000e00800000000001v',
  conversationId: CONVERSATION_ID,
  senderId: 'usr_01jc000000e00800000000000a',
  kind: 'IMAGE',
  mediaId: 'med_01jc000000e00800000000002a',
  url: `/api/conversations/${CONVERSATION_ID}/media/med_01jc000000e00800000000002a`,
  mimeType: 'image/png',
  sizeBytes: 5,
  width: 800,
  height: 600,
  durationMs: null,
  createdAt: '2026-01-01T00:00:00.000Z',
}

const imageDraft: MediaUploadDraft = {
  kind: 'IMAGE',
  file: new File(['bytes'], 'a.png', { type: 'image/png' }),
  width: 800,
  height: 600,
}

describe('chat api paths', () => {
  test('conversation list always sends the contract limit and optional cursor', () => {
    expect(conversationListPath()).toBe('/conversations?limit=50')
    expect(conversationListPath('abc+/=')).toBe('/conversations?limit=50&cursor=abc%2B%2F%3D')
  })

  test('media list always sends the contract limit and optional cursor', () => {
    expect(mediaListPath(CONVERSATION_ID)).toBe(`/conversations/${CONVERSATION_ID}/media?limit=100`)
    expect(mediaListPath(CONVERSATION_ID, 'abc+/=')).toBe(
      `/conversations/${CONVERSATION_ID}/media?limit=100&cursor=abc%2B%2F%3D`,
    )
  })

  test('message list always sends the contract limit and optional before cursor', () => {
    expect(messageListPath('cnv_01jc000000e00800000000001a')).toBe(
      '/conversations/cnv_01jc000000e00800000000001a/messages?limit=100',
    )
    expect(
      messageListPath('cnv_01jc000000e00800000000001a', 'msg_01jc000000e00800000000001t'),
    ).toBe(
      '/conversations/cnv_01jc000000e00800000000001a/messages?limit=100&before=msg_01jc000000e00800000000001t',
    )
  })
})

describe('chat error helpers', () => {
  test('detects the unified conversation-not-found error', () => {
    expect(isConversationNotFound(new ApiError('CONVERSATION_NOT_FOUND', 404, '会话不存在'))).toBe(
      true,
    )
    expect(isConversationNotFound(new ApiError('INTERNAL_ERROR', 500, '请求失败'))).toBe(false)
    expect(isConversationNotFound(new Error('network'))).toBe(false)
  })

  test('describes conversation-create failures', () => {
    expect(
      describeCreateConversationFailure(new ApiError('LISTING_NOT_FOUND', 404, 'missing')),
    ).toBe('商品不存在或已下架')
    expect(describeCreateConversationFailure(new Error('network'))).toBe('发起会话失败，请重试')
  })

  test('creates a conversation with only the listing id', async () => {
    const originalFetch = globalThis.fetch
    let requestBody: unknown
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          id: 'cnv_01jc000000e00800000000001a',
          listingId: 'lst_01jc000000e00800000000000t',
          role: 'buyer',
          listing: {
            id: 'lst_01jc000000e00800000000000t',
            title: '九成新自行车',
            priceCents: 12000,
            status: 'ACTIVE',
            coverUrl: null,
          },
          counterpart: { id: 'usr_01jc000000e00800000000000b', nickname: '小林', avatarUrl: null },
          unreadCount: 0,
          counterpartLastReadAt: null,
          lastMessage: null,
          lastMessageAt: '2026-01-01T00:00:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    try {
      const conversation = await createConversation('lst_01jc000000e00800000000000t')
      expect(requestBody).toEqual({ listingId: 'lst_01jc000000e00800000000000t' })
      expect(conversation.id).toBe('cnv_01jc000000e00800000000001a')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('describes idempotency reuse without pretending success', () => {
    expect(
      describeSendFailure(new ApiError('IDEMPOTENCY_KEY_REUSED', 409, '同一个 clientRequestId')),
    ).toBe('该次发送已用于其它内容')
    expect(describeSendFailure(new ApiError('CONVERSATION_NOT_FOUND', 404, '会话不存在'))).toBe(
      '会话不存在或不可访问',
    )
    expect(describeSendFailure(new Error('network'))).toBe('发送失败，请重试')
  })

  test('describes media failures with their own messages', () => {
    expect(describeSendFailure(new ApiError('MEDIA_OBJECT_NOT_FOUND', 422, '未上传'))).toBe(
      '媒体上传未完成，请重试',
    )
    expect(describeSendFailure(new ApiError('MEDIA_OBJECT_INVALID', 422, '不一致'))).toBe(
      '媒体文件与声明不一致，请重试',
    )
    expect(describeSendFailure(new ApiError('MEDIA_DURATION_EXCEEDED', 422, '太长'))).toBe(
      '语音不能超过 60 秒',
    )
    expect(describeSendFailure(new ApiError('MEDIA_DIMENSION_EXCEEDED', 422, '太大'))).toBe(
      '图片尺寸超过限制',
    )
    expect(describeSendFailure(new ApiError('MEDIA_NOT_FOUND', 404, '不存在'))).toBe(
      '媒体不存在或不可访问',
    )
    expect(describeSendFailure(new MediaUploadError())).toBe('媒体上传失败，请重试')
  })

  test('describes platform restrictions so a banned account is not told to retry', () => {
    expect(describeSendFailure(new ApiError('USER_RESTRICTED', 403, '账号被封禁'))).toBe(
      '账号已被限制，暂不能发送消息',
    )
    expect(describeSendFailure(new ApiError('USER_GUARD_BUSY', 503, '繁忙'))).toBe(
      '操作繁忙，请稍后重试',
    )
  })

  test('rejects the owned-by-someone-else media history read instead of faking an empty list', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: 'CONVERSATION_NOT_FOUND', message: '会话不存在' } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
    try {
      await expect(fetchMediaPage(CONVERSATION_ID)).rejects.toBeInstanceOf(ApiError)
      await expect(fetchMediaPage(CONVERSATION_ID)).rejects.toMatchObject({
        code: 'CONVERSATION_NOT_FOUND',
        status: 404,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('chat media sending', () => {
  function stubFetch(
    respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ): Array<{ url: string; init: RequestInit | undefined }> {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      return respond(url, init)
    }) as unknown as typeof fetch
    return calls
  }

  const presignBody = {
    uploadUrl: 'https://minio.local/chat-media/a.png?sig=1',
    objectKey: 'chat-media/cnv_01jc000000e00800000000001a/usr_a/med_a.png',
    headers: { 'x-amz-acl': 'private' },
    expiresAt: '2026-01-01T00:05:00.000Z',
  }

  test('sends media as presign → direct PUT → create, never proxying the object store', async () => {
    const originalFetch = globalThis.fetch
    const calls = stubFetch((url) => {
      if (url === `/api/conversations/${CONVERSATION_ID}/media/presign`)
        return jsonResponse(presignBody)
      if (url === presignBody.uploadUrl) return new Response(null, { status: 200 })
      return jsonResponse(mediaDto)
    })
    try {
      const sent = await sendMediaMessage(CONVERSATION_ID, imageDraft, CLIENT_REQUEST_ID)

      expect(sent).toEqual(mediaDto)
      expect(calls.map((call) => call.url)).toEqual([
        `/api/conversations/${CONVERSATION_ID}/media/presign`,
        presignBody.uploadUrl,
        `/api/conversations/${CONVERSATION_ID}/media`,
      ])
      expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
        kind: 'IMAGE',
        contentType: 'image/png',
        sizeBytes: 5,
      })
      // 直传：原文件 + presign 下发的头，不能加 /api 前缀（对象存储是外域）。
      expect(calls[1]?.init?.method).toBe('PUT')
      expect(calls[1]?.init?.headers).toEqual({
        'x-amz-acl': 'private',
        'content-type': 'image/png',
      })
      expect(calls[1]?.init?.body).toBe(imageDraft.file)
      // create：真实宽高 + 幂等键，重试时服务端据此返回同一条。
      expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
        kind: 'IMAGE',
        objectKey: presignBody.objectKey,
        contentType: 'image/png',
        sizeBytes: 5,
        width: 800,
        height: 600,
        clientRequestId: CLIENT_REQUEST_ID,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('sends voice with the recorded duration and mime', async () => {
    const originalFetch = globalThis.fetch
    const voiceDto: MediaMessageDto = {
      ...mediaDto,
      kind: 'VOICE',
      mimeType: 'audio/webm',
      sizeBytes: 11,
      width: null,
      height: null,
      durationMs: 1_500,
    }
    const calls = stubFetch((url) => {
      if (url === `/api/conversations/${CONVERSATION_ID}/media/presign`) {
        return jsonResponse({ ...presignBody, uploadUrl: 'https://minio.local/voice.webm?sig=2' })
      }
      if (url.startsWith('https://minio.local/')) return new Response(null, { status: 200 })
      return jsonResponse(voiceDto)
    })
    const draft: MediaUploadDraft = {
      kind: 'VOICE',
      file: new File(['voice-bytes'], 'voice.webm', { type: 'audio/webm' }),
      durationMs: 1_500,
    }
    try {
      await sendMediaMessage(CONVERSATION_ID, draft, CLIENT_REQUEST_ID)
      expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
        kind: 'VOICE',
        objectKey: presignBody.objectKey,
        contentType: 'audio/webm',
        sizeBytes: 11,
        durationMs: 1_500,
        clientRequestId: CLIENT_REQUEST_ID,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('fails the send when the direct upload is rejected', async () => {
    const originalFetch = globalThis.fetch
    const calls = stubFetch((url) => {
      if (url === `/api/conversations/${CONVERSATION_ID}/media/presign`)
        return jsonResponse(presignBody)
      return new Response(null, { status: 403 })
    })
    try {
      await expect(
        sendMediaMessage(CONVERSATION_ID, imageDraft, CLIENT_REQUEST_ID),
      ).rejects.toThrow('媒体上传失败，请重试')
      // 直传失败就不能再调 create，否则会给一个没有对象的 key 建消息。
      expect(calls).toHaveLength(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
