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
import { probeImage, probeVoiceDuration } from './media-probe'
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

/** 服务端解析媒体属性读取到的字节上限：图片/音频头部足够解开尺寸与时长。 */
const MEDIA_HEAD_PROBE_BYTES = 128 * 1024

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
      const stat = await storage.stat(input.objectKey)
      if (!stat) throw invalid('MEDIA_OBJECT_NOT_FOUND', '媒体尚未上传完成')
      if (stat.size !== input.sizeBytes || stat.contentType !== input.contentType) {
        throw invalid('MEDIA_OBJECT_INVALID', '媒体实际属性与声明不一致')
      }
      // 服务端从对象内容解析真实尺寸 / 时长（fail-closed）：
      // 不信任客户端声明的 width/height/durationMs，解析失败或超出限制一律拒绝。
      if (!storage.readHead) {
        throw invalid('MEDIA_OBJECT_INVALID', '存储未提供内容读取能力，无法完成服务端校验')
      }
      const head = await storage.readHead(input.objectKey, MEDIA_HEAD_PROBE_BYTES)
      if (!head || head.length === 0) {
        throw invalid('MEDIA_OBJECT_INVALID', '媒体内容为空或不可读取')
      }
      // 校验通过后统一落库 + 事件推送。
      const persist = async (verified: MediaMessageInput) => {
        const result = dto(await store.create(conversationId, userId, verified), (id) =>
          mediaUrl(conversationId, id),
        )
        const participants = await store.participant(conversationId, userId)
        if (participants) onMediaCreated?.(participants, result)
        return result
      }
      if (input.kind === 'IMAGE') {
        const probed = probeImage(head, input.contentType)
        if (!probed) throw invalid('MEDIA_DIMENSION_EXCEEDED', '图片尺寸解析失败')
        if (probed.width > MEDIA_MAX_IMAGE_DIMENSION || probed.height > MEDIA_MAX_IMAGE_DIMENSION) {
          throw invalid('MEDIA_DIMENSION_EXCEEDED', '图片尺寸超过限制')
        }
        const declared = 'width' in input ? input.width : undefined
        if (declared !== undefined && declared !== probed.width) {
          throw invalid('MEDIA_OBJECT_INVALID', '媒体尺寸与声明不一致')
        }
        // 用真实尺寸覆盖声明值，避免后端存的可能与客户端声明不一致。
        return persist({ ...input, width: probed.width, height: probed.height })
      }
      const probed = probeVoiceDuration(head, input.contentType)
      if (!probed) throw invalid('MEDIA_OBJECT_INVALID', '语音时长解析失败')
      if (probed.durationMs > MEDIA_MAX_VOICE_DURATION_MS) {
        throw invalid('MEDIA_DURATION_EXCEEDED', '语音时长超过限制')
      }
      const declared = 'durationMs' in input ? input.durationMs : undefined
      if (declared !== undefined && declared !== probed.durationMs) {
        throw invalid('MEDIA_OBJECT_INVALID', '语音时长与声明不一致')
      }
      return persist({ ...input, durationMs: probed.durationMs })
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
