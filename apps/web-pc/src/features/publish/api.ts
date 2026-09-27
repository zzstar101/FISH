import { AI_ROUTES } from '@fish/contracts/ai/routes'
import {
  type AiPolishCandidatesRequest,
  type AiPolishCandidatesResponse,
  AiPolishCandidatesResponseSchema,
} from '@fish/contracts/ai/schema'
import { LISTING_ROUTES, UPLOAD_ROUTES } from '@fish/contracts/listings/routes'
import {
  ALLOWED_IMAGE_MIME,
  type ListingCreateInput,
  type ListingDetail,
  ListingDetailSchema,
  MAX_IMAGE_BYTES,
  UploadConfirmResponseSchema,
  UploadPresignResponseSchema,
} from '@fish/contracts/listings/schema'
import { apiRequest } from '../../lib/api-client'

export type UploadMime = (typeof ALLOWED_IMAGE_MIME)[number]

const MIME_BY_EXTENSION: Record<string, UploadMime> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

function allowedMime(file: File): UploadMime | null {
  const exact = ALLOWED_IMAGE_MIME.find((mime) => mime === file.type)
  if (exact) return exact
  // MIME 明确但不允许时不能用扩展名“洗白”：否则 PDF 改名 .jpg 会被当作图片，
  // 并以客户端声明的 image/jpeg 上传。只有浏览器给不出 MIME 时才退回扩展名。
  if (file.type !== '') return null
  return MIME_BY_EXTENSION[extensionOf(file.name)] ?? null
}

/**
 * 浏览器可展示的图片直接原样返回；HEIC 尝试用 canvas 转 JPG。
 * 转不了时返回 null，调用方给明确文案，不把注定 422 的文件送去上传。
 */
export async function toUploadableFile(file: File): Promise<File | null> {
  if (allowedMime(file) !== null) return file
  if (file.type !== 'image/heic' && extensionOf(file.name) !== 'heic') return null

  try {
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) {
      bitmap.close()
      return null
    }
    context.drawImage(bitmap, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9),
    )
    bitmap.close()
    if (!blob) return null
    return new File([blob], `${file.name.replace(/\.heic$/i, '')}.jpg`, { type: 'image/jpeg' })
  } catch {
    return null
  }
}

/** 上传前的前端校验：与契约同源的上限，超了直接给文案，不打 API。 */
export function validateImageFile(file: File): string | null {
  if (allowedMime(file) === null) return '仅支持 JPG / PNG / WebP 图片'
  if (file.size < 1) return '图片文件为空或无法读取'
  if (file.size > MAX_IMAGE_BYTES) return '单张图片不能超过 5MB'
  return null
}

export class PublishTaskCancelledError extends Error {
  constructor() {
    super('发布任务已失效')
    this.name = 'PublishTaskCancelledError'
  }
}

export function isPublishTaskCancelled(error: unknown): boolean {
  return (
    error instanceof PublishTaskCancelledError ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

type UploadOptions = {
  signal?: AbortSignal
  isCurrent: () => boolean
}

function assertCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new PublishTaskCancelledError()
}

/**
 * 单张图片上传：presign → 客户端直传对象存储 → confirm。
 * 每一步后都检查任务是否仍属于当前账号/页面，防止切号或离开页面后迟到响应写回。
 */
export async function uploadListingImage(file: File, options: UploadOptions): Promise<string> {
  const contentType = allowedMime(file)
  if (contentType === null) throw new Error('仅支持 JPG / PNG / WebP 图片')
  const invalid = validateImageFile(file)
  if (invalid !== null) throw new Error(invalid)

  const presign = UploadPresignResponseSchema.parse(
    await apiRequest(UPLOAD_ROUTES.presign, {
      method: 'POST',
      body: JSON.stringify({ contentType, sizeBytes: file.size }),
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  )
  assertCurrent(options.isCurrent)

  const uploaded = await fetch(presign.uploadUrl, {
    body: file,
    headers: { ...presign.headers, 'content-type': contentType },
    method: 'PUT',
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!uploaded.ok) throw new Error('图片上传失败，请重试')
  assertCurrent(options.isCurrent)

  const confirmed = UploadConfirmResponseSchema.parse(
    await apiRequest(UPLOAD_ROUTES.confirm, {
      method: 'POST',
      body: JSON.stringify({ objectKey: presign.objectKey }),
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  )
  assertCurrent(options.isCurrent)
  return confirmed.objectKey
}

export async function createListing(
  input: ListingCreateInput,
  signal?: AbortSignal,
): Promise<ListingDetail> {
  const payload = await apiRequest(LISTING_ROUTES.base, {
    method: 'POST',
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  })
  return ListingDetailSchema.parse(payload)
}

export async function fetchPolishCandidates(
  input: AiPolishCandidatesRequest,
  signal?: AbortSignal,
): Promise<AiPolishCandidatesResponse> {
  const payload = await apiRequest(AI_ROUTES.polishCandidates, {
    method: 'POST',
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  })
  return AiPolishCandidatesResponseSchema.parse(payload)
}
