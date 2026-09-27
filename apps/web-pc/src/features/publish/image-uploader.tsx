import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { CircleAlert, CircleCheck, ImagePlus, Loader2, RefreshCw, X } from 'lucide-react'
import { useId } from 'react'
import type { PublishImage } from './form-model'

type ImageUploaderProps = {
  images: readonly PublishImage[]
  maxImages: number
  disabled: boolean
  error?: string
  notice: string | null
  onAddFiles: (files: File[]) => void | Promise<void>
  onRemove: (id: string) => void
  onRetry: (id: string) => void
}

export function ImageUploader({
  images,
  maxImages,
  disabled,
  error,
  notice,
  onAddFiles,
  onRemove,
  onRetry,
}: ImageUploaderProps) {
  const inputId = useId()
  const full = images.length >= maxImages

  return (
    <Card className="gap-0 border border-line p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-lg">
            商品图片 <span className="text-danger">*</span>
          </h2>
          <p className="mt-1.5 text-ink-3 text-sm">
            1–{maxImages} 张，第一张作为封面；支持 JPG / PNG / WebP，单张不超过 5MB。
          </p>
        </div>
        <p className="shrink-0 text-ink-3 text-sm">
          {images.length}/{maxImages}
        </p>
      </div>

      <div className="mt-5 grid grid-cols-4 gap-4">
        {images.map((image, index) => (
          <div
            className="group relative aspect-square overflow-hidden rounded-2xl border border-line bg-surface-2"
            key={image.id}
          >
            {image.previewUrl !== '' ? (
              <img
                alt={`商品图片 ${index + 1}`}
                className="size-full object-cover"
                src={image.previewUrl}
              />
            ) : (
              <span className="grid size-full place-items-center text-ink-3">
                <Loader2 className="size-6 animate-spin" />
              </span>
            )}

            {index === 0 ? (
              <span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 font-medium text-[11px] text-white">
                封面
              </span>
            ) : null}

            {image.status === 'preparing' ? (
              <span className="absolute inset-x-0 bottom-0 bg-black/55 px-2 py-1.5 text-center text-[11px] text-white">
                处理中
              </span>
            ) : null}

            {image.status === 'uploading' ? (
              <span className="absolute inset-0 grid place-items-center bg-black/35 text-white">
                <span className="flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-xs">
                  <Loader2 className="size-3.5 animate-spin" />
                  上传中
                </span>
              </span>
            ) : null}

            {image.status === 'uploaded' ? (
              <span className="absolute top-2 right-2 grid size-6 place-items-center rounded-full bg-success text-white">
                <CircleCheck className="size-4" />
              </span>
            ) : null}

            {image.status === 'failed' ? (
              <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-danger-soft/95 p-2 text-center text-danger">
                <CircleAlert className="size-5" />
                <span className="line-clamp-2 text-[11px] leading-4">
                  {image.error ?? '上传失败'}
                </span>
                <Button
                  className="h-7 px-2.5 text-xs"
                  disabled={disabled}
                  onClick={() => onRetry(image.id)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <RefreshCw className="size-3" />
                  重试
                </Button>
              </span>
            ) : null}

            <button
              aria-label={`移除第 ${index + 1} 张图片`}
              className="absolute top-2 left-2 grid size-6 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
              disabled={disabled}
              onClick={() => onRemove(image.id)}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}

        {!full ? (
          <label
            className={`flex aspect-square cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-ink-3/40 border-dashed bg-surface-2 text-ink-3 transition-colors hover:border-brand hover:bg-brand-soft hover:text-brand ${
              disabled ? 'pointer-events-none opacity-50' : ''
            }`}
            htmlFor={inputId}
          >
            <ImagePlus className="size-7" />
            <span className="text-sm">添加图片</span>
            <span className="text-xs">最多还可选 {maxImages - images.length} 张</span>
          </label>
        ) : null}
      </div>

      <input
        accept="image/jpeg,image/png,image/webp,image/heic"
        className="sr-only"
        disabled={disabled || full}
        id={inputId}
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (files.length > 0) void onAddFiles(files)
        }}
        type="file"
      />

      {error ? <p className="mt-3 text-danger text-sm">{error}</p> : null}
      {notice ? (
        <p className="mt-3 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn" role="status">
          {notice}
        </p>
      ) : null}
    </Card>
  )
}
