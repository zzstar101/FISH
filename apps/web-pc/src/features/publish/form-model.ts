import type { ListingCategory, ListingCondition } from '@fish/contracts/listings/schema'
import type { ApiErrorDetail } from '@fish/contracts/system/error'
import { ApiError } from '../../lib/api-client'

export type PublishField = 'title' | 'description' | 'price' | 'category' | 'images'
export type PublishFieldErrors = Partial<Record<PublishField, string>>

export type PublishFormState = {
  title: string
  description: string
  price: string
  category: ListingCategory | null
  condition: ListingCondition
  urgent: boolean
  negotiable: boolean
  free: boolean
}

export type PublishImageStatus = 'preparing' | 'uploading' | 'uploaded' | 'failed'

export type PublishImage = {
  id: string
  /** 用户最初选择的文件；图片处理失败后重试仍从这里开始。 */
  sourceFile: File
  /** 已转换且可上传的文件；`preparing` / 处理失败时为 null。 */
  file: File | null
  /** 只有处理成功后才创建；避免未提交槽位的 Blob URL 泄漏。 */
  previewUrl: string
  status: PublishImageStatus
  objectKey: string | null
  error: string | null
}

export const INITIAL_PUBLISH_FORM: PublishFormState = {
  title: '',
  description: '',
  price: '',
  category: null,
  condition: 'LIKE_NEW',
  urgent: false,
  negotiable: false,
  free: false,
}

const PRICE_PATTERN = /^\d+(\.\d{1,2})?$/

/** 价格字符串 → 整数分；勾选免费送时恒为 0。 */
export function parsePriceToCents(price: string, free: boolean): number | null {
  if (free) return 0
  const trimmed = price.trim()
  if (!PRICE_PATTERN.test(trimmed)) return null
  const cents = Math.round(Number(trimmed) * 100)
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= 10_000_000 ? cents : null
}

/** 免费送与议价互斥：界面和提交载荷都走这一条，避免两个入口各判一遍后漂移。 */
export function effectiveNegotiable(form: Pick<PublishFormState, 'free' | 'negotiable'>): boolean {
  return form.free ? false : form.negotiable
}

/** 传输层异常不把浏览器的英文底层报错直接展示给用户；ApiError 是可信业务文案。 */
export function uploadFailureMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '图片上传失败，请重试'
}

export function publishImageCheck(images: readonly PublishImage[]): {
  done: boolean
  label: string
} {
  if (images.length === 0) return { done: false, label: '至少上传 1 张图片' }
  if (images.some((image) => image.status === 'failed')) {
    return { done: false, label: '有图片处理失败，请重试' }
  }
  if (images.some((image) => image.status === 'preparing')) {
    return { done: false, label: '图片处理中…' }
  }
  if (images.some((image) => image.status === 'uploading')) {
    return { done: false, label: '图片上传中…' }
  }
  return { done: true, label: `${images.length} 张图片已上传` }
}

export function publishImageHelperText(images: readonly PublishImage[]): string | null {
  if (images.length === 0) return '请先添加图片'
  if (images.some((image) => image.status === 'failed')) return '请先重试失败图片'
  if (images.some((image) => image.status === 'preparing')) return '图片处理完成后即可提交'
  if (images.some((image) => image.status === 'uploading')) return '图片上传完成后即可提交'
  return null
}

export function validatePublishForm(
  form: PublishFormState,
  images: readonly PublishImage[],
): PublishFieldErrors {
  const errors: PublishFieldErrors = {}
  const title = form.title.trim()
  const description = form.description.trim()
  if (title.length < 2) errors.title = '标题至少 2 个字'
  else if (title.length > 40) errors.title = '标题最多 40 个字'
  if (description.length < 1) errors.description = '请填写描述'
  else if (description.length > 500) errors.description = '描述最多 500 个字'
  if (parsePriceToCents(form.price, form.free) === null) errors.price = '请填写正确价格'
  if (form.category === null) errors.category = '请选择分类'
  if (images.length < 1) errors.images = '至少上传 1 张图片'
  else if (images.some((image) => image.status !== 'uploaded')) {
    errors.images = '请等待图片处理完成，失败图片需先重试'
  }
  return errors
}

function fieldFromDetail(field: string): PublishField | null {
  const root = field.split('.')[0]
  if (root === 'title' || root === 'description' || root === 'category') return root
  if (root === 'priceCents') return 'price'
  if (root === 'objectKeys') return 'images'
  return null
}

/** 服务端字段错误 → 表单字段错误；同一字段只保留第一条。 */
export function publishFieldErrorsFromDetails(
  details: readonly ApiErrorDetail[] | undefined,
): PublishFieldErrors {
  const errors: PublishFieldErrors = {}
  for (const detail of details ?? []) {
    const field = fieldFromDetail(detail.field)
    if (field !== null && errors[field] === undefined) errors[field] = detail.message
  }
  return errors
}

export function publishBlockMessage(errors: PublishFieldErrors): string {
  const hit = (['title', 'description'] as const).filter((field) => errors[field] !== undefined)
  if (hit.length === 2) return '标题和描述中有违规内容'
  if (hit.length === 1) return hit[0] === 'title' ? '标题中有违规内容' : '描述中有违规内容'
  return '商品内容未通过审核'
}

export type PolishFailureView = {
  message: string
  detail: string | null
  canRetry: boolean
}

function retryAfterText(seconds: number | undefined): string {
  if (seconds === undefined) return '稍后'
  if (seconds >= 3600) return `约 ${Math.ceil(seconds / 3600)} 小时`
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} 分钟`
  return `${seconds} 秒`
}

/** 429 后的冷却截止时间；缺失/非正数秒数时保持本次页面生命周期禁用。 */
export function polishCooldownUntilFrom(
  retryAfterSeconds: number | undefined,
  now = Date.now(),
): number {
  if (retryAfterSeconds === undefined || retryAfterSeconds <= 0) return Number.POSITIVE_INFINITY
  return now + retryAfterSeconds * 1000
}

export function polishFailureView(code: string, retryAfterSeconds?: number): PolishFailureView {
  switch (code) {
    case 'AI_POLISH_QUOTA':
      return {
        message:
          retryAfterSeconds === undefined
            ? '操作太频繁，请稍后再试'
            : retryAfterSeconds > 3600
              ? `润色配额已用尽，约 ${retryAfterText(retryAfterSeconds)}后可重试`
              : retryAfterSeconds > 60
                ? `操作太频繁，约 ${retryAfterText(retryAfterSeconds)}后可重试`
                : `操作太频繁，${retryAfterSeconds} 秒后可重试`,
        detail: '不会自动重试，当前描述保持不变。',
        canRetry: false,
      }
    case 'AI_TIMEOUT':
      return {
        message: '润色请求超时',
        detail: '当前描述保持不变，可以手动重试。',
        canRetry: true,
      }
    case 'AI_UPSTREAM_ERROR':
      return {
        message: '润色服务暂时不可用',
        detail: '当前描述保持不变，可以稍后手动重试。',
        canRetry: true,
      }
    case 'AI_RESULT_EMPTY':
      return {
        message: '没有可用候选',
        detail: '当前描述保持不变，补充描述后可以再试一次。',
        canRetry: true,
      }
    case 'AI_NOT_CONFIGURED':
      return {
        message: '润色能力暂未开通',
        detail: '不会自动重试，请直接填写文案。',
        canRetry: false,
      }
    default:
      return {
        message: '润色失败',
        detail: '当前描述保持不变，可以手动重试。',
        canRetry: true,
      }
  }
}

export function polishPreconditionError(form: PublishFormState): string | null {
  if (form.title.trim().length < 2) return '标题至少填写 2 个字后再润色'
  if (form.description.trim().length < 1) return '先填写商品描述再润色'
  if (form.category === null) return '先选好分类再润色'
  return null
}

export function isListingReview(detail: { moderationStatus: string | null }): boolean {
  return detail.moderationStatus === 'REVIEW'
}

export function listingErrorView(error: unknown): {
  fieldErrors: PublishFieldErrors
  message: string | null
} {
  if (!(error instanceof ApiError)) {
    return { fieldErrors: {}, message: '请求失败，请检查网络后重试' }
  }
  if (error.code === 'LISTING_CONTENT_BLOCKED') {
    const fieldErrors = publishFieldErrorsFromDetails(error.details)
    return { fieldErrors, message: publishBlockMessage(fieldErrors) }
  }
  return { fieldErrors: publishFieldErrorsFromDetails(error.details), message: error.message }
}
