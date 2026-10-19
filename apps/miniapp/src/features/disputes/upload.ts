/**
 * 争议附件上传链（#497）：presign → 客户端直传对象存储 → confirm。
 *
 * 与发布页（`features/upload/api.ts` 的 `uploadListingImage`）同一三步语义，**但路径不同**：
 * 争议附件的 presign/confirm 挂在 `/disputes/:id/attachments*` 上，配额与写入方（只发起人）
 * 都由服务端按争议判，不能复用发布链。
 *
 * 三步之间逐次做 `assertUploadActive`（同 #208 的理由）：`apiRequest` 的 Cookie 是调用那一刻
 * 现取的，换号后再发 confirm 会带着新账号的会话打到别人的争议上；PUT 还会在对象存储里留下
 * 没人引用的对象。传 `undefined` 表示不关心归属（页面在压栈期间不会卸载）。
 */
import type { DisputeAttachment } from '@fish/contracts/disputes/schema'
import Taro from '@tarojs/taro'
import { assertUploadActive } from '@/features/upload/active'
import { type PickedPhoto, readFileBuffer, UPLOAD_TIMEOUT_MS } from '@/features/upload/api'
import { confirmDisputeAttachment, presignDisputeAttachment } from './api'

export async function uploadDisputeAttachment(
  disputeId: string,
  photo: PickedPhoto,
  isActive?: () => boolean,
): Promise<DisputeAttachment> {
  assertUploadActive(isActive)
  const presign = await presignDisputeAttachment(disputeId, {
    contentType: photo.mime,
    sizeBytes: photo.sizeBytes,
  })

  assertUploadActive(isActive)
  const buffer = await readFileBuffer(photo.path)

  assertUploadActive(isActive)
  const uploaded = await Taro.request({
    url: presign.uploadUrl,
    method: 'PUT',
    data: buffer,
    header: { ...presign.headers, 'content-type': photo.mime },
    timeout: UPLOAD_TIMEOUT_MS,
  })
  if (uploaded.statusCode < 200 || uploaded.statusCode >= 300) {
    throw new Error('图片上传失败，请重试')
  }

  assertUploadActive(isActive)
  const confirmed = await confirmDisputeAttachment(disputeId, presign.objectKey)
  return confirmed.attachment
}
