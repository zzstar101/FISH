/**
 * 评价配图上传链的平台层（#475）：presign → 客户端直传对象存储 → confirm。
 *
 * 与 `features/upload/api.ts`（商品图）同一条三步语义，但端点独立成链
 * （`TRANSACTION_REVIEW_ROUTES.mediaPresign/mediaConfirm`，授权锚定在交易上：
 * 参与者 + COMPLETED + 尚未评价），并且比商品图链**多一道引用收口**——只有 confirm
 * 返回的 final 键（`reviews/{usr_…}/{med_…}.ext`）能进评价的 `imageObjectKeys`；
 * staging 键（`transaction-review-media/…`）不在公开读白名单，填进评价会被 422 拒。
 *
 * 平台层差异与商品图链一致（那里已踩过坑，这里直接沿用）：
 * 1. 读本地临时文件用 `readFileBuffer`（不传 encoding，二进制不能读坏）；
 * 2. 直传用 `Taro.request`（PUT + ArrayBuffer），且必须**显式带 content-type** ——
 *    对象存储会把 PUT 的 Content-Type 落成对象 mime，而 confirm 按真实字节复核 MIME；
 * 3. `sizeBytes` 用**读出来的字节长度**声明（与 chat-media 同一口径：声明值取真实值，
 *    不信选图器报的数）。
 *
 * `isActive` 是调用方的在途判据：三步里**每一次**发请求前都会问一遍。弹层被关闭 /
 * 配图被移除 / 账号切换后立刻中止，不再发出后续请求（confirm 出一个永不引用的公开对象就是孤儿）。
 * 中止抛 `UploadAbortedError`（./active 的既定哨兵）；调用方按中止原因分别处理 ——
 * 条目已不在表里时什么都不做，身份已变时把槽位标成失败（见 `components/review-dialog` 的
 * `abandonSlot`，不让槽位永久停在「上传中」）。
 */
import { TRANSACTION_REVIEW_ROUTES } from '@fish/contracts/transaction-reviews/routes'
import {
  ReviewMediaConfirmRequestSchema,
  ReviewMediaConfirmResponseSchema,
  type ReviewMediaPresignRequest,
  ReviewMediaPresignResponseSchema,
} from '@fish/contracts/transaction-reviews/schema'
import Taro from '@tarojs/taro'
import { assertUploadActive } from '@/features/upload/active'
import { readFileBuffer, UPLOAD_TIMEOUT_MS } from '@/features/upload/api'
import type { AllowedImageMime } from '@/features/upload/mime'
import { apiRequest } from '@/lib/request'

/** 待上传的本地图片（`pickPhotos` 的产出形状的结构子集，mime 收在契约白名单内）。 */
export type ReviewPhoto = {
  path: string
  mime: AllowedImageMime
  sizeBytes: number
}

/**
 * 上传单张评价配图，返回**可引用的 final 键**（进 `imageObjectKeys` 的唯一合法值）。
 *
 * **一张一次调用，独立失败**（与商品图同款取舍）：弹层在用户选中图片时就调本函数，
 * 自己维护每张图的「上传中 / 已上传 / 重试」状态；一张失败不牵连其余张。
 */
export async function uploadReviewImage(
  transactionId: string,
  photo: ReviewPhoto,
  isActive?: () => boolean,
): Promise<string> {
  assertUploadActive(isActive)
  // 先读文件再 presign：sizeBytes 声明真实字节长度（选图器报的数可能是估算）
  const buffer = await readFileBuffer(photo.path)
  assertUploadActive(isActive)
  const presignInput: ReviewMediaPresignRequest = {
    contentType: photo.mime,
    sizeBytes: buffer.byteLength,
  }
  const presign = ReviewMediaPresignResponseSchema.parse(
    await apiRequest(TRANSACTION_REVIEW_ROUTES.mediaPresign(transactionId), {
      method: 'POST',
      body: presignInput,
    }),
  )

  // 直传 PUT 不携带会话（只有 presign 的签名），但同样不该在弹层已关后再发
  assertUploadActive(isActive)
  const uploaded = await Taro.request({
    url: presign.uploadUrl,
    method: 'PUT',
    data: buffer,
    // `presign.headers` 当前是空对象，但对象存储把 PUT 的 Content-Type 落成对象 mime，
    // confirm 按真实字节复核 MIME —— 必须显式带上。
    header: { ...presign.headers, 'content-type': photo.mime },
    timeout: UPLOAD_TIMEOUT_MS,
  })
  if (uploaded.statusCode < 200 || uploaded.statusCode >= 300) {
    throw new Error('图片上传失败，请重试')
  }

  assertUploadActive(isActive)
  const confirmed = ReviewMediaConfirmResponseSchema.parse(
    await apiRequest(TRANSACTION_REVIEW_ROUTES.mediaConfirm(transactionId), {
      method: 'POST',
      body: ReviewMediaConfirmRequestSchema.parse({ objectKey: presign.objectKey }),
    }),
  )
  return confirmed.objectKey
}
