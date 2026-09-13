import { UPLOAD_ROUTES } from '@fish/contracts/listings/routes'
import {
  ALLOWED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  UploadConfirmResponseSchema,
  UploadPresignResponseSchema,
} from '@fish/contracts/listings/schema'
import { apiRequest } from '../../lib/api-client'

/**
 * 上传前把文件整理成契约允许的形态。
 *
 * `image/heic` 刻意不在允许列表里（契约 §上传约束：多端渲染不了）；
 * iOS 相册默认导出 HEIC，这里尝试 canvas 转码成 JPG——浏览器解不开时
 * 返回 null，由调用方给出明确的错误文案，而不是把 422 抛给用户。
 */
export async function toUploadableFile(file: File): Promise<File | null> {
  if ((ALLOWED_IMAGE_MIME as readonly string[]).includes(file.type)) return file
  if (file.type !== 'image/heic' && !/\.heic$/i.test(file.name)) return null

  try {
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) return null
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
  if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(file.type)) {
    return '仅支持 JPG / PNG / WebP 图片'
  }
  if (file.size > MAX_IMAGE_BYTES) return '单张图片不能超过 5MB'
  return null
}

/**
 * 单张图片上传：presign → 客户端直传对象存储 → confirm。
 * 每张独立失败独立重试（契约 §3：前端对 1–9 张图逐张调用）。
 */
export async function uploadImage(file: File): Promise<string> {
  const presign = UploadPresignResponseSchema.parse(
    await apiRequest(UPLOAD_ROUTES.presign, {
      method: 'POST',
      body: JSON.stringify({ contentType: file.type, sizeBytes: file.size }),
    }),
  )

  const uploaded = await fetch(presign.uploadUrl, {
    body: file,
    // presign.headers 当前是空对象，但对象存储会把 PUT 的 Content-Type 落成对象的
    // mime——创建商品时 `assertUsableObjectKeys` 按它校验（#41 冒烟实测：不带会 422
    // IMAGE_REFERENCE_INVALID），因此必须显式带上。
    headers: { ...presign.headers, 'content-type': file.type },
    method: 'PUT',
  })
  if (!uploaded.ok) throw new Error('图片上传失败,请重试')

  const confirmed = UploadConfirmResponseSchema.parse(
    await apiRequest(UPLOAD_ROUTES.confirm, {
      method: 'POST',
      body: JSON.stringify({ objectKey: presign.objectKey }),
    }),
  )
  return confirmed.objectKey
}
