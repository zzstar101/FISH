import {
  type ListingCategory,
  ListingCategorySchema,
  type ListingCondition,
  ListingConditionSchema,
  type ListingDetail,
  type ListingUpdateInput,
  MAX_LISTING_IMAGES,
} from '@fish/contracts/listings/schema'
import { Alert, AlertDescription, AlertTitle } from '@fish/ui/alert'
import { Button } from '@fish/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@fish/ui/dialog'
import { Field, FieldError, FieldLabel } from '@fish/ui/field'
import { Input } from '@fish/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@fish/ui/select'
import { ErrorState, LoadingState } from '@fish/ui/states'
import { Switch } from '@fish/ui/switch'
import { Textarea } from '@fish/ui/textarea'
import { CircleAlert, ImagePlus, Loader2, X } from 'lucide-react'
import { type ChangeEvent, useEffect, useId, useState } from 'react'
import { ApiError } from '../../lib/api-client'
import { CATEGORY_LABEL, CONDITION_LABEL } from '../../lib/labels'
import { currentSessionGeneration } from '../../lib/session-cache'
import { useListingDetail } from '../listing-detail/queries'
import {
  isPublishTaskCancelled,
  toUploadableFile,
  uploadListingImage,
  validateImageFile,
} from '../publish/api'
import { effectiveNegotiable, parsePriceToCents } from '../publish/form-model'
import {
  collectObjectKeys,
  type EditImageState,
  enterImageEditMode,
  existingImagesFromDetail,
  remainingImageSlots,
} from './image-model'
import { useUpdateListing } from './queries'

type EditForm = {
  title: string
  description: string
  price: string
  category: ListingCategory
  condition: ListingCondition
  urgent: boolean
  negotiable: boolean
  free: boolean
}

type EditFieldErrors = Partial<
  Record<'title' | 'description' | 'price' | 'category' | 'images', string>
>

function formFromDetail(detail: ListingDetail): EditForm {
  return {
    title: detail.title,
    description: detail.description,
    price: detail.free ? '0.00' : (detail.priceCents / 100).toFixed(2),
    category: detail.category,
    condition: detail.condition,
    urgent: detail.urgent,
    negotiable: detail.negotiable,
    free: detail.free,
  }
}

export function EditListingDialog({
  listing,
  ownerId,
  open,
  onOpenChange,
}: {
  listing: { id: string }
  ownerId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const detail = useListingDetail(listing.id, ownerId, { enabled: open })
  const updateListing = useUpdateListing(ownerId)
  const imageInputId = useId()
  const [form, setForm] = useState<EditForm | null>(null)
  const [fieldErrors, setFieldErrors] = useState<EditFieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [images, setImages] = useState<EditImageState>({
    dirty: false,
    existing: [],
    added: [],
  })

  useEffect(() => {
    if (!open || detail.data === undefined || detail.data === null) return
    setForm(formFromDetail(detail.data))
    setFieldErrors({})
    setFormError(null)
    setImages({ dirty: false, existing: existingImagesFromDetail(detail.data.images), added: [] })
  }, [detail.data, open])

  useEffect(
    // 卸载（关闭弹窗）时统一回收新图预览的 objectURL；逐张移除的回收在 removeAdded 里做。
    // 现有图的 url 由服务端管，不归这里撤。
    () => () => {
      for (const image of images.added) {
        if (image.previewUrl !== '') URL.revokeObjectURL(image.previewUrl)
      }
    },
    [],
  )

  function patch(next: Partial<EditForm>) {
    setForm((current) => (current === null ? current : { ...current, ...next }))
  }

  /** 进入图片编辑态：不可重新引用的原图此时被强制标记移除（见 image-model）。 */
  function startImageEdit() {
    setImages((current) => ({
      ...current,
      dirty: true,
      existing: enterImageEditMode(current.existing),
    }))
  }

  function toggleExistingRemoved(id: string) {
    setImages((current) => ({
      ...current,
      existing: current.existing.map((image) =>
        // 不可重新引用的行不允许恢复：保留它 = 提交必 422（见 image-model）。
        image.id === id && !(image.objectKey === null && image.removed)
          ? { ...image, removed: !image.removed }
          : image,
      ),
    }))
  }

  function removeAdded(id: string) {
    setImages((current) => {
      const target = current.added.find((image) => image.id === id)
      if (target !== undefined && target.previewUrl !== '') URL.revokeObjectURL(target.previewUrl)
      return { ...current, added: current.added.filter((image) => image.id !== id) }
    })
  }

  async function addImages(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0 || form === null) return

    const slots = remainingImageSlots(images.existing, images.added, MAX_LISTING_IMAGES)
    const accepted = files.slice(0, Math.max(0, slots))
    if (accepted.length === 0) {
      setFieldErrors((current) => ({ ...current, images: `最多上传 ${MAX_LISTING_IMAGES} 张图片` }))
      return
    }

    for (const file of accepted) {
      const id = `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const previewUrl = URL.createObjectURL(file)
      setImages((current) => ({
        ...current,
        added: [...current.added, { id, previewUrl, objectKey: null, error: null }],
      }))

      const invalid = validateImageFile(file)
      if (invalid !== null) {
        setImages((current) => ({
          ...current,
          added: current.added.map((image) =>
            image.id === id ? { ...image, error: invalid } : image,
          ),
        }))
        continue
      }

      try {
        const uploadable = await toUploadableFile(file)
        if (uploadable === null) throw new Error('unreadable')
        // 会话代次守卫：切号/登出后迟到的上传结果不再写回弹窗状态。
        const generation = currentSessionGeneration()
        const objectKey = await uploadListingImage(uploadable, {
          isCurrent: () => generation === currentSessionGeneration(),
        })
        setImages((current) => ({
          ...current,
          added: current.added.map((image) => (image.id === id ? { ...image, objectKey } : image)),
        }))
      } catch (error) {
        if (isPublishTaskCancelled(error)) continue
        setImages((current) => ({
          ...current,
          added: current.added.map((image) =>
            image.id === id ? { ...image, error: '图片上传失败，请移除后重试' } : image,
          ),
        }))
      }
    }
  }

  function validate(current: EditForm): EditFieldErrors {
    const errors: EditFieldErrors = {}
    const title = current.title.trim()
    const description = current.description.trim()
    if (title.length < 2) errors.title = '标题至少 2 个字'
    else if (title.length > 40) errors.title = '标题最多 40 个字'
    if (description.length < 1) errors.description = '请填写描述'
    else if (description.length > 500) errors.description = '描述最多 500 个字'
    if (parsePriceToCents(current.price, current.free) === null) errors.price = '请填写正确价格'
    return errors
  }

  // 编辑态下的展示序号：被移除的行不占用位置 —— 提交后「第一张保留图」才是封面。
  let keptCounter = 0
  const existingDisplay = images.existing.map((image) => ({
    image,
    displayIndex: image.removed ? null : keptCounter++,
  }))

  async function submit() {
    if (form === null || updateListing.isPending) return
    const errors = validate(form)
    setFormError(null)

    if (images.dirty) {
      if (images.added.some((image) => image.error !== null)) {
        errors.images = '有图片上传失败，请先移除它再保存'
      } else if (images.added.some((image) => image.objectKey === null)) {
        errors.images = '图片还在上传，请稍候再保存'
      } else {
        const collected = collectObjectKeys(images.existing, images.added)
        if (!collected.ok) errors.images = collected.error
      }
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      return
    }

    const input: ListingUpdateInput = {
      title: form.title.trim(),
      description: form.description.trim(),
      priceCents: parsePriceToCents(form.price, form.free) ?? 0,
      category: form.category,
      condition: form.condition,
      urgent: form.urgent,
      negotiable: effectiveNegotiable(form),
      free: form.free,
    }
    // 不动图就不发 objectKeys：PATCH 里它缺省 = 服务端不触碰图片，
    // 「只想改个价格」不该变成一次意外的图片全量替换。
    if (images.dirty) {
      const collected = collectObjectKeys(images.existing, images.added)
      if (collected.ok) input.objectKeys = collected.keys
    }

    try {
      await updateListing.mutateAsync({ id: listing.id, input })
      onOpenChange(false)
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : '保存失败，请稍后重试')
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[680px]">
        <DialogHeader>
          <DialogTitle className="text-xl">编辑商品</DialogTitle>
          <DialogDescription>
            修改文字、价格、展示选项，并可更换商品图片（保存时整体替换）。
          </DialogDescription>
        </DialogHeader>

        {detail.isPending ? <LoadingState label="正在读取商品…" /> : null}
        {detail.isError ? (
          <ErrorState message="商品详情加载失败" onRetry={() => void detail.refetch()} />
        ) : null}
        {detail.data === null ? <ErrorState message="商品不存在或不可编辑" /> : null}

        {form !== null ? (
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <Field data-invalid={fieldErrors.title !== undefined}>
              <FieldLabel htmlFor="edit-listing-title">标题</FieldLabel>
              <Input
                aria-invalid={fieldErrors.title !== undefined}
                id="edit-listing-title"
                maxLength={40}
                onChange={(event) => patch({ title: event.target.value })}
                value={form.title}
              />
              {fieldErrors.title !== undefined ? (
                <FieldError>{fieldErrors.title}</FieldError>
              ) : null}
            </Field>

            <Field data-invalid={fieldErrors.description !== undefined}>
              <FieldLabel htmlFor="edit-listing-description">描述</FieldLabel>
              <Textarea
                aria-invalid={fieldErrors.description !== undefined}
                id="edit-listing-description"
                maxLength={500}
                onChange={(event) => patch({ description: event.target.value })}
                rows={4}
                value={form.description}
              />
              {fieldErrors.description !== undefined ? (
                <FieldError>{fieldErrors.description}</FieldError>
              ) : null}
            </Field>

            <div className="grid grid-cols-2 gap-5">
              <Field data-invalid={fieldErrors.price !== undefined}>
                <FieldLabel htmlFor="edit-listing-price">价格</FieldLabel>
                <Input
                  aria-invalid={fieldErrors.price !== undefined}
                  disabled={form.free}
                  id="edit-listing-price"
                  inputMode="decimal"
                  onChange={(event) => patch({ price: event.target.value })}
                  value={form.free ? '0.00' : form.price}
                />
                {fieldErrors.price !== undefined ? (
                  <FieldError>{fieldErrors.price}</FieldError>
                ) : null}
              </Field>

              <Field>
                <FieldLabel htmlFor="edit-listing-category">分类</FieldLabel>
                <Select
                  onValueChange={(value) => patch({ category: ListingCategorySchema.parse(value) })}
                  value={form.category}
                >
                  <SelectTrigger className="w-full" id="edit-listing-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ListingCategorySchema.options.map((category) => (
                      <SelectItem key={category} value={category}>
                        {CATEGORY_LABEL[category]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="edit-listing-condition">成色</FieldLabel>
              <Select
                onValueChange={(value) => patch({ condition: ListingConditionSchema.parse(value) })}
                value={form.condition}
              >
                <SelectTrigger className="w-full" id="edit-listing-condition">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ListingConditionSchema.options.map((condition) => (
                    <SelectItem key={condition} value={condition}>
                      {CONDITION_LABEL[condition]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field data-invalid={fieldErrors.images !== undefined}>
              <FieldLabel htmlFor={imageInputId}>商品图片</FieldLabel>

              {images.dirty ? (
                <div className="mt-3 grid grid-cols-4 gap-4">
                  {existingDisplay.map(({ image, displayIndex }) => {
                    return (
                      <div
                        className={`relative aspect-square overflow-hidden rounded-2xl border ${
                          image.removed ? 'border-line opacity-40' : 'border-line'
                        }`}
                        key={image.id}
                      >
                        <img
                          alt={`商品图片 ${(displayIndex ?? 0) + 1}`}
                          className="size-full object-cover"
                          src={image.url}
                        />
                        {displayIndex === 0 ? (
                          <span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 font-medium text-[11px] text-white">
                            封面
                          </span>
                        ) : null}
                        {image.removed ? (
                          <span className="absolute inset-0 grid place-items-center bg-black/45 text-[11px] text-white">
                            将移除
                          </span>
                        ) : null}
                        <button
                          aria-label={image.removed ? '恢复这张图片' : '移除这张图片'}
                          className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80"
                          onClick={() => toggleExistingRemoved(image.id)}
                          type="button"
                        >
                          {image.removed ? '↺' : <X className="size-3.5" />}
                        </button>
                      </div>
                    )
                  })}
                  {images.added.map((image) => (
                    <div
                      className="relative aspect-square overflow-hidden rounded-2xl border border-line"
                      key={image.id}
                    >
                      <img
                        alt="新增商品图片"
                        className="size-full object-cover"
                        src={image.previewUrl}
                      />
                      {image.objectKey === null && image.error === null ? (
                        <span className="absolute inset-0 grid place-items-center bg-black/35 text-white">
                          <Loader2 className="size-5 animate-spin" />
                        </span>
                      ) : null}
                      {image.error !== null ? (
                        <span className="absolute inset-x-0 bottom-0 bg-danger/85 px-1.5 py-1 text-center text-[11px] text-white">
                          {image.error}
                        </span>
                      ) : null}
                      <button
                        aria-label="移除这张新图片"
                        className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/60 text-white hover:bg-black/80"
                        onClick={() => removeAdded(image.id)}
                        type="button"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
                  {remainingImageSlots(images.existing, images.added, MAX_LISTING_IMAGES) > 0 ? (
                    <label
                      className="grid aspect-square cursor-pointer place-items-center rounded-2xl border border-dashed border-line text-ink-3 transition-colors hover:border-brand/50 hover:text-brand"
                      htmlFor={imageInputId}
                    >
                      <ImagePlus className="size-6" />
                    </label>
                  ) : null}
                </div>
              ) : (
                <div className="mt-3 grid grid-cols-4 gap-4">
                  {images.existing.map((image, index) => (
                    <div
                      className="relative aspect-square overflow-hidden rounded-2xl border border-line"
                      key={image.id}
                    >
                      <img
                        alt={`商品图片 ${index + 1}`}
                        className="size-full object-cover"
                        src={image.url}
                      />
                      {index === 0 ? (
                        <span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 font-medium text-[11px] text-white">
                          封面
                        </span>
                      ) : null}
                      {image.moderationStatus === 'BLOCKED' || image.objectKey === null ? (
                        <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-black/55 px-1.5 py-1 text-center text-[11px] text-white">
                          <CircleAlert className="size-3" />
                          审核未通过 · 编辑时需移除
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}

              <input
                accept="image/jpeg,image/png,image/webp,image/heic"
                className="sr-only"
                id={imageInputId}
                multiple
                onChange={(event) => void addImages(event)}
                type="file"
              />

              {images.dirty ? (
                <p className="mt-2 text-ink-3 text-xs">
                  保存后将整体替换为上图的当前列表（第一张为封面）；最多 {MAX_LISTING_IMAGES} 张。
                </p>
              ) : (
                <div className="mt-2 flex items-center justify-between gap-4">
                  <p className="text-ink-3 text-xs">查看当前图片；要更换请先点「编辑图片」。</p>
                  <Button onClick={startImageEdit} size="sm" type="button" variant="outline">
                    编辑图片
                  </Button>
                </div>
              )}
              {fieldErrors.images !== undefined ? (
                <FieldError>{fieldErrors.images}</FieldError>
              ) : null}
            </Field>

            <div className="grid grid-cols-3 gap-4">
              <div className="flex items-center justify-between rounded-xl bg-surface-2 px-4 py-3 text-sm">
                急出
                <Switch
                  aria-label="急出"
                  checked={form.urgent}
                  onCheckedChange={(checked) => patch({ urgent: checked })}
                />
              </div>
              <div className="flex items-center justify-between rounded-xl bg-surface-2 px-4 py-3 text-sm">
                可小刀
                <Switch
                  aria-label="可小刀"
                  checked={effectiveNegotiable(form)}
                  disabled={form.free}
                  onCheckedChange={(checked) => patch({ negotiable: checked })}
                />
              </div>
              <div className="flex items-center justify-between rounded-xl bg-surface-2 px-4 py-3 text-sm">
                免费送
                <Switch
                  aria-label="免费送"
                  checked={form.free}
                  onCheckedChange={(checked) =>
                    patch({
                      free: checked,
                      price: checked ? '' : form.price,
                      negotiable: checked ? false : form.negotiable,
                    })
                  }
                />
              </div>
            </div>

            {formError !== null ? (
              <Alert variant="destructive">
                <AlertTitle>保存失败</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}

            <DialogFooter>
              <Button
                disabled={updateListing.isPending}
                onClick={() => onOpenChange(false)}
                type="button"
                variant="outline"
              >
                取消
              </Button>
              <Button disabled={updateListing.isPending} type="submit">
                {updateListing.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                {updateListing.isPending ? '正在保存…' : '保存修改'}
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
