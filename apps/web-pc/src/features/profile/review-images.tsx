import { MAX_REVIEW_IMAGES } from '@fish/contracts/transaction-reviews/schema'
import { Button } from '@fish/ui/button'
import { CircleAlert, ImagePlus, Loader2, RefreshCw, X } from 'lucide-react'
import { useId } from 'react'

/**
 * 评价配图的选择/上传状态展示件（#475）。上传编排在 `ReviewForm` 里（就地 useState +
 * AbortController），这里保持 **props 驱动**以便静态渲染测试（本仓无 jsdom 的惯例）。
 */

export type ReviewFormImage = {
  id: string
  /** `URL.createObjectURL` 的预览地址；预处理失败时为 `''`（没有可预览的图）。 */
  previewUrl: string
  status: 'uploading' | 'uploaded' | 'failed'
  /** 上传确认后的 final 键（`reviews/…`）；未成功时为 null。 */
  objectKey: string | null
  /** 失败原因（网络/校验/服务端文案）；成功为 null。 */
  error: string | null
  /** 预处理的产物（重试与上传用）；预处理失败为 null。 */
  file: File | null
}

/**
 * 提交闸门（纯函数，静态可测）：
 * - 还有图片在上传中 → 等一等（提交载荷会缺键，服务端不会补）；
 * - 有失败图片 → 重试或移除，**不允许静默丢弃**（用户以为带图提交、实际没有）。
 * 返回 null 表示可以提交。
 */
export function reviewSubmitBlockedReason(
  images: readonly ReviewFormImage[],
  submitting: boolean,
  maxImages = MAX_REVIEW_IMAGES,
): string | null {
  if (submitting) return null
  // 超限兜底：并发选图窗口里可能比 maxImages 多（room 是按进入时的长度算的），
  // 这里宁可挡住也不要让服务端 422 变成用户看不懂的失败。
  if (images.length > maxImages) return `最多 ${maxImages} 张配图，请先移除多余的`
  if (images.some((image) => image.status === 'uploading')) return '还有图片正在上传，请稍候'
  if (images.some((image) => image.status === 'failed')) {
    return '有图片未上传成功：请重试或移除后再提交'
  }
  return null
}

/**
 * 原子槽位预留（#483 审查响应）：满槽返回 `null`，调用方**不得**创建预览或发起上传。
 *
 * 并发两次 `addFiles` 在同一渲染窗内读到的还是同一个列表，靠 setState 的函数式更新
 * 「事后」挡人会让已确认（confirm）的上传对象没有任何表单条目可挂——孤儿对象 + 回收不到的
 * blob 预览。JS 单线程下「读-判-写」全同步的这段不会被交错，配合 ReviewForm 的同步权威
 * `imagesRef`（每次增删改先写 ref 再进 state）即可保证不超订。
 */
export function appendWithinLimit(
  images: readonly ReviewFormImage[],
  entry: ReviewFormImage,
  maxImages: number,
): ReviewFormImage[] | null {
  if (images.length >= maxImages) return null
  return [...images, entry]
}

export function ReviewImageSlots({
  disabled,
  images,
  maxImages,
  onAddFiles,
  onRemove,
  onRetry,
}: {
  disabled: boolean
  images: readonly ReviewFormImage[]
  maxImages: number
  onAddFiles: (files: File[]) => void
  onRemove: (id: string) => void
  onRetry: (id: string) => void
}) {
  const inputId = useId()
  const full = images.length >= maxImages

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <p className="font-medium text-sm">配图（可选）</p>
        <p className="text-ink-3 text-xs">
          {images.length}/{maxImages}
        </p>
      </div>
      <div className="mt-2 flex flex-wrap gap-3">
        {images.map((image, index) => (
          <div
            className="relative size-20 overflow-hidden rounded-xl border border-line bg-surface-2"
            key={image.id}
          >
            {image.previewUrl !== '' ? (
              <img
                alt={`评价配图 ${index + 1}`}
                className="size-full object-cover"
                src={image.previewUrl}
              />
            ) : (
              <span className="grid size-full place-items-center text-ink-3">
                <CircleAlert className="size-5" />
              </span>
            )}

            {image.status === 'uploading' ? (
              <span className="absolute inset-0 grid place-items-center bg-black/35 text-white">
                <Loader2 className="size-4 animate-spin" />
              </span>
            ) : null}

            {image.status === 'failed' ? (
              <span
                className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-danger-soft/95 px-1 py-0.5 text-[10px] text-danger"
                title={image.error ?? '上传失败'}
              >
                <RefreshCw className="size-3" />
                失败
              </span>
            ) : null}

            <button
              aria-label={`移除配图 ${index + 1}`}
              className="absolute top-1 right-1 grid size-5 place-items-center rounded-full bg-black/45 text-white hover:bg-black/65"
              disabled={disabled}
              onClick={() => onRemove(image.id)}
              type="button"
            >
              <X className="size-3" />
            </button>

            {image.status === 'failed' ? (
              <Button
                aria-label={`重试配图 ${index + 1}`}
                className="absolute bottom-1 left-1 h-6 px-2 text-xs"
                disabled={disabled}
                onClick={() => onRetry(image.id)}
                size="sm"
                type="button"
                variant="outline"
              >
                重试
              </Button>
            ) : null}
          </div>
        ))}

        {full ? null : (
          <label
            className="grid size-20 cursor-pointer place-items-center rounded-xl border border-dashed border-line text-ink-3 transition-colors hover:border-brand/50 hover:text-brand"
            htmlFor={inputId}
          >
            <ImagePlus className="size-5" />
            <input
              accept="image/jpeg,image/png,image/webp,image/heic"
              className="sr-only"
              disabled={disabled}
              id={inputId}
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                event.target.value = ''
                if (files.length > 0) onAddFiles(files)
              }}
              type="file"
            />
          </label>
        )}
      </div>
      <p className="mt-2 text-ink-3 text-xs">JPG / PNG / WebP，单张不超过 5MB。</p>
    </div>
  )
}
