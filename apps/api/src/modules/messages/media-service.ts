import {
  MEDIA_IMAGE_MIME,
  MEDIA_MAX_IMAGE_BYTES,
  MEDIA_MAX_IMAGE_DIMENSION,
  MEDIA_MAX_VOICE_BYTES,
  MEDIA_MAX_VOICE_DURATION_MS,
  MEDIA_VOICE_MIME,
  type MediaMessageDto,
  type MediaMessageInput,
  type MediaPresignInput,
  type MediaPresignResponse,
  mediaMessageDtoSchema,
  mediaPresignResponseSchema,
} from '@fish/contracts/chat/schema'
import { newId } from '@fish/db/ids'
import type { MediaStorage } from '../uploads/storage'
import type { MediaMessageStore, MediaRow } from './media-store'

export class MediaMessageServiceError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MediaMessageServiceError'
  }
}

const notFound = () => new MediaMessageServiceError(404, 'CONVERSATION_NOT_FOUND', '会话不存在')
const invalid = (code: string, message: string) => new MediaMessageServiceError(422, code, message)

export interface MediaMessageService {
  presign(
    userId: string,
    conversationId: string,
    input: MediaPresignInput,
  ): Promise<MediaPresignResponse>
  create(userId: string, conversationId: string, input: MediaMessageInput): Promise<MediaMessageDto>
  list(userId: string, conversationId: string, limit: number): Promise<MediaMessageDto[]>
  getObject(
    userId: string,
    conversationId: string,
    mediaId: string,
  ): Promise<{ key: string; contentType: string }>
}

const imageMime = (value: string): boolean =>
  (MEDIA_IMAGE_MIME as readonly string[]).includes(value)
const voiceMime = (value: string): boolean =>
  (MEDIA_VOICE_MIME as readonly string[]).includes(value)

function validate(
  kind: MediaMessageInput['kind'],
  mime: string,
  size: number,
  duration?: number,
  width?: number,
  height?: number,
) {
  if (kind === 'IMAGE' && (!imageMime(mime) || size > MEDIA_MAX_IMAGE_BYTES)) {
    throw invalid('MEDIA_OBJECT_INVALID', '图片格式或大小不符合要求')
  }
  if (kind === 'VOICE' && (!voiceMime(mime) || size > MEDIA_MAX_VOICE_BYTES)) {
    throw invalid('MEDIA_OBJECT_INVALID', '语音格式或大小不符合要求')
  }
  if (kind === 'VOICE' && (duration === undefined || duration > MEDIA_MAX_VOICE_DURATION_MS)) {
    throw invalid('MEDIA_DURATION_EXCEEDED', '语音时长超过限制')
  }
  if (
    kind === 'IMAGE' &&
    (width === undefined ||
      height === undefined ||
      width > MEDIA_MAX_IMAGE_DIMENSION ||
      height > MEDIA_MAX_IMAGE_DIMENSION)
  ) {
    throw invalid('MEDIA_DIMENSION_EXCEEDED', '图片尺寸超过限制')
  }
}

function dto(row: MediaRow, baseUrl: (id: string) => string): MediaMessageDto {
  return mediaMessageDtoSchema.parse({
    id: row.message_id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    kind: row.kind,
    mediaId: row.media_id,
    url: baseUrl(row.media_id),
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    createdAt: new Date(row.created_at).toISOString(),
  })
}

export function createMediaMessageService({
  store,
  storage,
  mediaUrl,
  onMediaCreated,
}: {
  store: MediaMessageStore
  storage: MediaStorage
  mediaUrl: (conversationId: string, mediaId: string) => string
  onMediaCreated?: (
    participants: { buyerId: string; sellerId: string },
    media: MediaMessageDto,
  ) => void
}): MediaMessageService {
  return {
    async presign(userId, conversationId, input) {
      if (!(await store.participant(conversationId, userId))) throw notFound()
      if (
        input.kind === 'IMAGE' &&
        (!imageMime(input.contentType) || input.sizeBytes > MEDIA_MAX_IMAGE_BYTES)
      ) {
        throw invalid('MEDIA_OBJECT_INVALID', '图片格式或大小不符合要求')
      }
      if (
        input.kind === 'VOICE' &&
        (!voiceMime(input.contentType) || input.sizeBytes > MEDIA_MAX_VOICE_BYTES)
      ) {
        throw invalid('MEDIA_OBJECT_INVALID', '语音格式或大小不符合要求')
      }
      const extension = input.contentType.split('/')[1] ?? 'bin'
      const key = `chat-media/${conversationId}/${userId}/${newId()}.${extension}`
      const signed = storage.presignPut({ key, contentType: input.contentType })
      return mediaPresignResponseSchema.parse({
        uploadUrl: signed.url,
        objectKey: key,
        headers: signed.headers,
        expiresAt: signed.expiresAt,
      })
    },
    async create(userId, conversationId, input) {
      if (!(await store.participant(conversationId, userId))) throw notFound()
      const prefix = `chat-media/${conversationId}/${userId}/`
      if (!input.objectKey.startsWith(prefix))
        throw invalid('MEDIA_OBJECT_INVALID', '媒体不属于当前用户或会话')
      validate(
        input.kind,
        input.contentType,
        input.sizeBytes,
        'durationMs' in input ? input.durationMs : undefined,
        'width' in input ? input.width : undefined,
        'height' in input ? input.height : undefined,
      )
      const stat = await storage.stat(input.objectKey)
      if (!stat) throw invalid('MEDIA_OBJECT_NOT_FOUND', '媒体尚未上传完成')
      if (stat.size !== input.sizeBytes || stat.contentType !== input.contentType) {
        throw invalid('MEDIA_OBJECT_INVALID', '媒体实际属性与声明不一致')
      }
      const result = dto(await store.create(conversationId, userId, input), (id) =>
        mediaUrl(conversationId, id),
      )
      const participants = await store.participant(conversationId, userId)
      if (participants) onMediaCreated?.(participants, result)
      return result
    },
    async list(userId, conversationId, limit) {
      if (!(await store.participant(conversationId, userId))) throw notFound()
      return (await store.list(conversationId, userId, limit)).map((row) =>
        dto(row, (id) => mediaUrl(conversationId, id)),
      )
    },
    async getObject(userId, conversationId, mediaId) {
      if (!(await store.participant(conversationId, userId))) throw notFound()
      const row = await store.find(conversationId, mediaId, userId)
      if (!row) throw new MediaMessageServiceError(404, 'MEDIA_NOT_FOUND', '媒体不存在')
      return { key: row.object_key, contentType: row.mime_type }
    },
  }
}
