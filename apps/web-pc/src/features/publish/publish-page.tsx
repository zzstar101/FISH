import {
  ListingCategorySchema,
  ListingConditionSchema,
  type ListingDetail,
  MAX_LISTING_IMAGES,
} from '@fish/contracts/listings/schema'
import { Alert, AlertDescription, AlertTitle } from '@fish/ui/alert'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { Field, FieldError, FieldLabel } from '@fish/ui/field'
import { Input } from '@fish/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@fish/ui/select'
import { Spinner } from '@fish/ui/spinner'
import { Switch } from '@fish/ui/switch'
import { Textarea } from '@fish/ui/textarea'
import { Link, useNavigate } from '@tanstack/react-router'
import { CircleCheck, Clock3, Send, ShieldAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ApiError, isUnauthenticatedError } from '../../lib/api-client'
import { CATEGORY_LABEL, CONDITION_LABEL } from '../../lib/labels'
import { currentHref } from '../../lib/redirect'
import { currentSessionGeneration } from '../../lib/session-cache'
import { useAuth } from '../auth/auth-provider'
import { AiPolishPanel, type PolishState } from './ai-polish-panel'
import {
  isPublishTaskCancelled,
  toUploadableFile,
  uploadListingImage,
  validateImageFile,
} from './api'
import {
  effectiveNegotiable,
  INITIAL_PUBLISH_FORM,
  isListingReview,
  listingErrorView,
  type PublishField,
  type PublishFieldErrors,
  type PublishFormState,
  type PublishImage,
  parsePriceToCents,
  polishCooldownUntilFrom,
  polishFailureView,
  polishPreconditionError,
  publishImageCheck,
  publishImageHelperText,
  uploadFailureMessage,
  validatePublishForm,
} from './form-model'
import { ImageUploader } from './image-uploader'
import { useCreateListing, usePolishCandidates } from './queries'

function revokePreview(image: PublishImage) {
  if (image.previewUrl !== '') URL.revokeObjectURL(image.previewUrl)
}

type PublishTask = {
  sessionGeneration: number
  formEpoch: number
}

export function PublishPage() {
  const { me } = useAuth()
  // me 在 RequireAuth 下必定存在；仍显式收口，避免类型分支散落页面。
  if (!me) return null
  // 换号时整页重挂载，旧的异步任务也无法再把状态写回新账号。
  return <PublishForm key={me.id} />
}

function PublishForm() {
  const navigate = useNavigate()
  const createListing = useCreateListing()
  const polishCandidates = usePolishCandidates()
  const [form, setForm] = useState<PublishFormState>({ ...INITIAL_PUBLISH_FORM })
  const [images, setImages] = useState<PublishImage[]>([])
  const [fieldErrors, setFieldErrors] = useState<PublishFieldErrors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [imageNotice, setImageNotice] = useState<string | null>(null)
  const [polish, setPolish] = useState<PolishState>({ phase: 'idle' })
  const [polishCooldownUntil, setPolishCooldownUntil] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [reviewResult, setReviewResult] = useState<ListingDetail | null>(null)

  const mountedRef = useRef(false)
  const formEpochRef = useRef(0)
  const imagesRef = useRef<PublishImage[]>([])
  const uploadControllersRef = useRef(new Map<string, AbortController>())
  const polishControllerRef = useRef<AbortController | null>(null)
  const submitControllerRef = useRef<AbortController | null>(null)

  imagesRef.current = images

  function replaceImages(next: PublishImage[]) {
    imagesRef.current = next
    setImages(next)
  }

  function updateImages(updater: (current: PublishImage[]) => PublishImage[]) {
    replaceImages(updater(imagesRef.current))
  }

  function createTask(): PublishTask {
    return {
      sessionGeneration: currentSessionGeneration(),
      formEpoch: formEpochRef.current,
    }
  }

  function isTaskCurrent(task: PublishTask): boolean {
    return (
      mountedRef.current &&
      task.sessionGeneration === currentSessionGeneration() &&
      task.formEpoch === formEpochRef.current
    )
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const controller of uploadControllersRef.current.values()) controller.abort()
      uploadControllersRef.current.clear()
      polishControllerRef.current?.abort()
      submitControllerRef.current?.abort()
      for (const image of imagesRef.current) revokePreview(image)
    }
  }, [])

  useEffect(() => {
    if (polishCooldownUntil === null || !Number.isFinite(polishCooldownUntil)) return
    const remaining = polishCooldownUntil - Date.now()
    if (remaining <= 0) {
      setPolishCooldownUntil(null)
      return
    }
    const timer = setTimeout(() => setPolishCooldownUntil(null), remaining)
    return () => clearTimeout(timer)
  }, [polishCooldownUntil])

  function patchForm(patch: Partial<PublishFormState>) {
    setForm((current) => ({ ...current, ...patch }))
  }

  function clearFieldError(field: PublishField) {
    setFieldErrors((current) => {
      if (current[field] === undefined) return current
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  function resetForm() {
    formEpochRef.current += 1
    for (const controller of uploadControllersRef.current.values()) controller.abort()
    uploadControllersRef.current.clear()
    polishControllerRef.current?.abort()
    submitControllerRef.current?.abort()
    submitControllerRef.current = null
    for (const image of imagesRef.current) revokePreview(image)
    imagesRef.current = []
    setImages([])
    setForm({ ...INITIAL_PUBLISH_FORM })
    setFieldErrors({})
    setSubmitError(null)
    setImageNotice(null)
    setPolish({ phase: 'idle' })
    setPolishCooldownUntil(null)
    setSubmitting(false)
    setReviewResult(null)
  }

  function addFiles(files: File[]) {
    setImageNotice(null)
    const room = MAX_LISTING_IMAGES - imagesRef.current.length
    if (room <= 0) {
      setImageNotice(`最多只能上传 ${MAX_LISTING_IMAGES} 张图片`)
      return
    }
    if (files.length > room)
      setImageNotice(`本次只添加前 ${room} 张，最多 ${MAX_LISTING_IMAGES} 张`)

    const additions: PublishImage[] = files.slice(0, room).map((sourceFile) => ({
      id: crypto.randomUUID(),
      sourceFile,
      file: null,
      previewUrl: '',
      status: 'preparing',
      objectKey: null,
      error: null,
    }))
    if (additions.length === 0) return
    updateImages((current) => [...current, ...additions].slice(0, MAX_LISTING_IMAGES))
    clearFieldError('images')
    for (const image of additions) void prepareOne(image.id, image.sourceFile)
  }

  async function prepareOne(id: string, sourceFile: File) {
    const task = createTask()
    updateImages((current) =>
      current.map((image) =>
        image.id === id
          ? { ...image, status: 'preparing', file: null, objectKey: null, error: null }
          : image,
      ),
    )

    const file = await toUploadableFile(sourceFile)
    if (!isTaskCurrent(task)) return
    if (!imagesRef.current.some((image) => image.id === id)) return
    if (file === null) {
      updateImages((current) =>
        current.map((image) =>
          image.id === id
            ? { ...image, status: 'failed', file: null, error: '无法读取或转换图片' }
            : image,
        ),
      )
      return
    }
    const invalid = validateImageFile(file)
    if (invalid !== null) {
      updateImages((current) =>
        current.map((image) =>
          image.id === id ? { ...image, status: 'failed', file: null, error: invalid } : image,
        ),
      )
      return
    }

    const previewUrl = URL.createObjectURL(file)
    updateImages((current) =>
      current.map((image) =>
        image.id === id ? { ...image, file, previewUrl, status: 'uploading', error: null } : image,
      ),
    )
    void uploadOne(id, file)
  }

  async function uploadOne(id: string, file: File) {
    const task = createTask()
    uploadControllersRef.current.get(id)?.abort()
    const controller = new AbortController()
    uploadControllersRef.current.set(id, controller)

    updateImages((current) =>
      current.map((image) =>
        image.id === id ? { ...image, status: 'uploading', objectKey: null, error: null } : image,
      ),
    )

    try {
      const objectKey = await uploadListingImage(file, {
        signal: controller.signal,
        isCurrent: () => isTaskCurrent(task),
      })
      if (!isTaskCurrent(task)) return
      updateImages((current) =>
        current.map((image) =>
          image.id === id ? { ...image, status: 'uploaded', objectKey, error: null } : image,
        ),
      )
      clearFieldError('images')
    } catch (error) {
      if (!isTaskCurrent(task) || controller.signal.aborted || isPublishTaskCancelled(error)) return
      if (isUnauthenticatedError(error)) {
        // 上传走裸 apiRequest，不经过 Query/MutationCache；这里补上会话失效出口。
        window.location.assign(`/pc/login?redirect=${encodeURIComponent(currentHref())}`)
        return
      }
      updateImages((current) =>
        current.map((image) =>
          image.id === id
            ? {
                ...image,
                status: 'failed',
                objectKey: null,
                error: uploadFailureMessage(error),
              }
            : image,
        ),
      )
    } finally {
      if (uploadControllersRef.current.get(id) === controller) {
        uploadControllersRef.current.delete(id)
      }
    }
  }

  function removeImage(id: string) {
    uploadControllersRef.current.get(id)?.abort()
    uploadControllersRef.current.delete(id)
    const image = imagesRef.current.find((item) => item.id === id)
    if (image) revokePreview(image)
    updateImages((current) => current.filter((item) => item.id !== id))
    clearFieldError('images')
  }

  function retryImage(id: string) {
    const image = imagesRef.current.find((item) => item.id === id)
    if (!image) return
    if (image.file === null) void prepareOne(id, image.sourceFile)
    else void uploadOne(id, image.file)
  }

  function startPolish() {
    if (polishCooldownUntil !== null) return
    const precondition = polishPreconditionError(form)
    if (precondition !== null) {
      setPolish({ phase: 'failed', view: { message: precondition, detail: null, canRetry: false } })
      return
    }
    if (form.category === null) return

    polishControllerRef.current?.abort()
    const controller = new AbortController()
    polishControllerRef.current = controller
    const task = createTask()
    setPolishCooldownUntil(null)
    setPolish({ phase: 'loading' })

    polishCandidates.mutate(
      {
        input: {
          title: form.title.trim(),
          description: form.description.trim(),
          category: form.category,
        },
        signal: controller.signal,
      },
      {
        onSuccess: (response) => {
          if (!isTaskCurrent(task) || controller.signal.aborted) return
          setPolishCooldownUntil(null)
          setPolish({
            phase: 'ready',
            candidates: response.candidates,
            index: 0,
            provider: response.provider,
            redacted: response.redacted,
          })
        },
        onError: (error) => {
          if (!isTaskCurrent(task) || controller.signal.aborted) return
          if (error instanceof ApiError) {
            if (error.code === 'AI_POLISH_QUOTA') {
              setPolishCooldownUntil(polishCooldownUntilFrom(error.retryAfterSeconds))
            } else {
              setPolishCooldownUntil(null)
            }
            setPolish({
              phase: 'failed',
              view: polishFailureView(error.code, error.retryAfterSeconds),
            })
            return
          }
          setPolishCooldownUntil(null)
          setPolish({ phase: 'failed', view: polishFailureView('UNKNOWN') })
        },
      },
    )
  }

  function applyPolish(text: string) {
    patchForm({ description: text })
    clearFieldError('description')
  }

  async function submit() {
    if (submitControllerRef.current !== null) return
    setSubmitError(null)
    const errors = validatePublishForm(form, imagesRef.current)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return

    const objectKeys = imagesRef.current.map((image) => image.objectKey)
    if (objectKeys.some((objectKey) => objectKey === null)) {
      setFieldErrors((current) => ({
        ...current,
        images: '请等待图片上传完成，失败图片需先重试',
      }))
      return
    }

    const task = createTask()
    const controller = new AbortController()
    submitControllerRef.current = controller
    setSubmitting(true)

    try {
      const detail = await createListing.mutateAsync({
        input: {
          title: form.title.trim(),
          description: form.description.trim(),
          priceCents: parsePriceToCents(form.price, form.free) ?? 0,
          category: form.category ?? 'OTHER',
          condition: form.condition,
          urgent: form.urgent,
          negotiable: effectiveNegotiable(form),
          free: form.free,
          objectKeys: objectKeys.filter((objectKey): objectKey is string => objectKey !== null),
        },
        signal: controller.signal,
      })
      if (!isTaskCurrent(task)) return

      if (isListingReview(detail)) {
        setReviewResult(detail)
        return
      }

      void navigate({ to: '/listing/$listingId', params: { listingId: detail.id } })
    } catch (error) {
      if (!isTaskCurrent(task) || controller.signal.aborted || isPublishTaskCancelled(error)) return
      const view = listingErrorView(error)
      setFieldErrors(view.fieldErrors)
      setSubmitError(view.message)
    } finally {
      if (submitControllerRef.current === controller) {
        if (isTaskCurrent(task)) setSubmitting(false)
        submitControllerRef.current = null
      }
    }
  }

  if (reviewResult) return <ReviewSubmitted listing={reviewResult} onReset={resetForm} />

  const imageCheck = publishImageCheck(images)
  const imageHelper = publishImageHelperText(images)
  const disabledReason = polishPreconditionError(form)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-semibold text-[26px] tracking-[-0.03em]">发布闲置</h1>
        <p className="mt-1.5 text-ink-3 text-sm">
          图片直传对象存储；标题和描述命中阻断内容时会保留当前表单。
        </p>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-7">
        <div className="space-y-5">
          <ImageUploader
            disabled={submitting}
            error={fieldErrors.images}
            images={images}
            maxImages={MAX_LISTING_IMAGES}
            notice={imageNotice}
            onAddFiles={addFiles}
            onRemove={removeImage}
            onRetry={retryImage}
          />

          <Card className="gap-0 border border-line p-6">
            <h2 className="font-semibold text-lg">商品信息</h2>

            <div className="mt-5 space-y-5">
              <Field data-invalid={fieldErrors.title !== undefined}>
                <FieldLabel htmlFor="publish-title">
                  标题 <span className="text-danger">*</span>
                </FieldLabel>
                <Input
                  aria-invalid={fieldErrors.title !== undefined}
                  id="publish-title"
                  maxLength={40}
                  onChange={(event) => {
                    patchForm({ title: event.target.value })
                    clearFieldError('title')
                  }}
                  placeholder="一句话说清是什么，例如：99新捷安特山地车"
                  value={form.title}
                />
                <FieldError>{fieldErrors.title}</FieldError>
                <p className="text-right text-ink-3 text-xs">{form.title.length}/40</p>
              </Field>

              <Field data-invalid={fieldErrors.description !== undefined}>
                <FieldLabel htmlFor="publish-description">
                  描述 <span className="text-danger">*</span>
                </FieldLabel>
                <Textarea
                  aria-invalid={fieldErrors.description !== undefined}
                  id="publish-description"
                  maxLength={500}
                  onChange={(event) => {
                    patchForm({ description: event.target.value })
                    clearFieldError('description')
                  }}
                  placeholder="购入时间、使用频率、有无磕碰、配件是否齐全……"
                  value={form.description}
                />
                <FieldError>{fieldErrors.description}</FieldError>
                <p className="text-right text-ink-3 text-xs">{form.description.length}/500</p>
              </Field>

              <div className="grid grid-cols-2 gap-5">
                <Field data-invalid={fieldErrors.category !== undefined}>
                  <FieldLabel htmlFor="publish-category">
                    分类 <span className="text-danger">*</span>
                  </FieldLabel>
                  <Select
                    onValueChange={(value) => {
                      patchForm({ category: ListingCategorySchema.parse(value) })
                      clearFieldError('category')
                    }}
                    value={form.category ?? undefined}
                  >
                    <SelectTrigger
                      aria-invalid={fieldErrors.category !== undefined}
                      className="h-11 w-full bg-surface-2"
                      id="publish-category"
                    >
                      <SelectValue placeholder="请选择分类" />
                    </SelectTrigger>
                    <SelectContent>
                      {ListingCategorySchema.options.map((category) => (
                        <SelectItem key={category} value={category}>
                          {CATEGORY_LABEL[category]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldError>{fieldErrors.category}</FieldError>
                </Field>

                <Field>
                  <FieldLabel htmlFor="publish-condition">成色</FieldLabel>
                  <Select
                    onValueChange={(value) =>
                      patchForm({ condition: ListingConditionSchema.parse(value) })
                    }
                    value={form.condition}
                  >
                    <SelectTrigger className="h-11 w-full bg-surface-2" id="publish-condition">
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
              </div>

              <Field data-invalid={fieldErrors.price !== undefined}>
                <FieldLabel htmlFor="publish-price">
                  价格 <span className="text-danger">*</span>
                </FieldLabel>
                <div className="flex h-11 items-center rounded-lg border border-line bg-surface-2 px-3 focus-within:border-brand focus-within:bg-surface">
                  <span className="mr-1.5 text-ink-3">¥</span>
                  <Input
                    aria-invalid={fieldErrors.price !== undefined}
                    className="h-auto flex-1 rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:border-0 focus-visible:bg-transparent"
                    disabled={form.free}
                    id="publish-price"
                    inputMode="decimal"
                    onChange={(event) => {
                      patchForm({ price: event.target.value })
                      clearFieldError('price')
                    }}
                    placeholder={form.free ? '0.00' : '0.00'}
                    value={form.free ? '0.00' : form.price}
                  />
                </div>
                <FieldError>{fieldErrors.price}</FieldError>
              </Field>

              <dl className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
                <FlagRow
                  checked={form.urgent}
                  description="打上「急出」角标，更容易被看到"
                  label="急出"
                  onChange={(checked) => patchForm({ urgent: checked })}
                />
                <FlagRow
                  checked={effectiveNegotiable(form)}
                  description={
                    form.free ? '0 元送开启后不可议价，开关已锁定' : '允许买家围绕价格发起协商'
                  }
                  disabled={form.free}
                  label="可小刀"
                  onChange={(checked) => patchForm({ negotiable: checked })}
                />
                <FlagRow
                  checked={form.free}
                  description="价格自动归零，发布后显示「免费送」"
                  label="免费送"
                  onChange={(checked) =>
                    patchForm({
                      free: checked,
                      price: checked ? '' : form.price,
                      negotiable: checked ? false : form.negotiable,
                    })
                  }
                />
              </dl>
            </div>
          </Card>
        </div>

        <aside className="sticky top-24 space-y-4">
          <AiPolishPanel
            coolingDown={polishCooldownUntil !== null}
            disabledReason={disabledReason}
            onApply={applyPolish}
            onPolish={startPolish}
            onSelect={(index) =>
              setPolish((current) => (current.phase === 'ready' ? { ...current, index } : current))
            }
            state={polish}
          />

          <Card className="gap-0 border border-line p-6">
            <h2 className="font-semibold text-base">发布检查</h2>
            <ul className="mt-4 space-y-2 text-sm">
              <CheckLine done={imageCheck.done} label={imageCheck.label} />
              <CheckLine done={form.title.trim().length >= 2} label="标题至少 2 个字" />
              <CheckLine done={form.description.trim().length > 0} label="填写商品描述" />
              <CheckLine done={form.category !== null} label="选择商品分类" />
              <CheckLine
                done={parsePriceToCents(form.price, form.free) !== null}
                label={form.free ? '免费送价格已归零' : '填写有效价格'}
              />
            </ul>

            {submitError ? (
              <Alert className="mt-5" variant="destructive">
                <ShieldAlert />
                <AlertTitle>发布失败</AlertTitle>
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            ) : null}

            <Button
              className="mt-5 w-full"
              disabled={submitting || !imageCheck.done}
              onClick={() => void submit()}
              size="lg"
              type="button"
            >
              {submitting ? <Spinner className="size-4" /> : <Send className="size-4" />}
              {submitting ? '正在发布…' : '发布闲置'}
            </Button>
            {imageHelper ? (
              <p className="mt-2 text-center text-ink-3 text-xs">{imageHelper}</p>
            ) : null}
          </Card>

          <p className="flex gap-2 px-2 text-ink-3 text-xs leading-5">
            <Clock3 className="mt-0.5 size-3.5 shrink-0" />
            审核中的商品不会进入公开列表；审核通过后才会被其他同学看到。
          </p>
        </aside>
      </div>
    </div>
  )
}

function FlagRow({
  checked,
  label,
  description,
  disabled = false,
  onChange,
}: {
  checked: boolean
  label: string
  description: string
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className={`flex items-center gap-4 px-4 py-3 ${disabled ? 'opacity-55' : ''}`}>
      <div className="min-w-0 flex-1">
        <dt className="font-medium text-sm">{label}</dt>
        <dd className="mt-1 text-ink-3 text-xs">{description}</dd>
      </div>
      <Switch aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  )
}

function CheckLine({ done, label }: { done: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-2 ${done ? 'text-success' : 'text-ink-3'}`}>
      <CircleCheck className={`size-4 ${done ? 'opacity-100' : 'opacity-35'}`} />
      {label}
    </li>
  )
}

function ReviewSubmitted({ listing, onReset }: { listing: ListingDetail; onReset: () => void }) {
  return (
    <div className="mx-auto max-w-[680px]">
      <Card className="gap-0 border border-line p-8 text-center">
        <span className="mx-auto grid size-16 place-items-center rounded-full bg-warn-soft text-warn">
          <Clock3 className="size-8" />
        </span>
        <h1 className="mt-5 font-semibold text-2xl">已提交审核</h1>
        <p className="mt-2 text-ink-2 text-sm leading-6">
          「{listing.title}
          」已受理，但当前处于审核中，尚未进入公开列表。审核通过后其他同学才能看到。
        </p>
        <div className="mt-7 flex justify-center gap-3">
          <Button asChild>
            <Link params={{ listingId: listing.id }} to="/listing/$listingId">
              查看商品详情
            </Link>
          </Button>
          <Button onClick={onReset} type="button" variant="outline">
            再发一件
          </Button>
        </div>
      </Card>
    </div>
  )
}
