import type {
  ListingCategory,
  ListingCondition,
  ListingDetail,
} from '@fish/contracts/listings/schema'
import { MAX_LISTING_IMAGES } from '@fish/contracts/listings/schema'
import { Alert, AlertDescription } from '@fish/ui/alert'
import { Button } from '@fish/ui/button'
import { Field, FieldLabel } from '@fish/ui/field'
import { Input } from '@fish/ui/input'
import { FormRow, NavBar } from '@fish/ui/nav-bar'
import { LoadingState } from '@fish/ui/states'
import { Textarea } from '@fish/ui/textarea'
import { useNavigate } from '@tanstack/react-router'
import { Camera, CircleCheck, X } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { ListingThumb } from '../../components/listing-thumb'
import { formatPrice } from '../../lib/format'
import { CONDITION_LABEL, categoryLabel } from '../../lib/labels'
import { toUploadableFile, uploadImage, validateImageFile } from './api'
import { useCreateListing, useListingForEdit, useUpdateListing } from './queries'

const CATEGORY_OPTIONS = (
  [
    'DIGITAL',
    'BOOKS',
    'DAILY',
    'APPAREL',
    'SPORTS',
    'TRANSPORT',
    'BEAUTY',
    'OTHER',
  ] as ListingCategory[]
).map((value) => ({ value, label: categoryLabel(value) }))

const CONDITION_OPTIONS = (['NEW', 'LIKE_NEW', 'GOOD', 'FAIR'] as ListingCondition[]).map(
  (value) => ({ value, label: CONDITION_LABEL[value] }),
)

/** 整数或最多两位小数，避免 `Number('abc')` 变成 NaN 后渲染出 `¥NaN`。 */
const PRICE_PATTERN = /^\d+(\.\d{1,2})?$/

type PickerKey = 'category' | 'condition'

/** 已选图片：真实文件 + 本地预览 URL；`id` 仅用于列表 key 与移除。 */
type PickedImage = { id: string; file: File; previewUrl: string }

/** 发布 / 编辑共用同一张表单；编辑模式先取回原商品再挂载表单。 */
export function PublishPage({ editId }: { editId?: string }) {
  const existing = useListingForEdit(editId)

  if (editId && existing.isPending) {
    return (
      <div className="min-h-dvh bg-bg">
        <LoadingState label="加载商品…" />
      </div>
    )
  }

  return <PublishForm editId={editId} initial={existing.data ?? null} />
}

function PublishForm({ editId, initial }: { editId?: string; initial: ListingDetail | null }) {
  const navigate = useNavigate()
  const createListing = useCreateListing()
  const updateListing = useUpdateListing()
  const editing = Boolean(editId)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [images, setImages] = useState<PickedImage[]>([])
  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [category, setCategory] = useState<ListingCategory | null>(initial?.category ?? null)
  const [condition, setCondition] = useState<ListingCondition>(initial?.condition ?? 'GOOD')
  const [price, setPrice] = useState(initial ? (initial.priceCents / 100).toString() : '')
  const [picker, setPicker] = useState<PickerKey | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [urgent, setUrgent] = useState(initial?.urgent ?? false)
  const [negotiable, setNegotiable] = useState(initial?.negotiable ?? false)
  /** 提交失败的行内提示；重试成功或再次提交时清掉。 */
  const [submitError, setSubmitError] = useState('')
  /**
   * 发布成功后的落地态：不立刻跳走，先给一次明确反馈。
   * 直接 `navigate` 的话用户只看到页面跳了，不确定到底发出去没有。
   */
  const [created, setCreated] = useState<ListingDetail | null>(null)
  const [uploadedCount, setUploadedCount] = useState(0)
  const titleId = useId()
  const descriptionId = useId()

  const pending = createListing.isPending || updateListing.isPending || uploadedCount > 0
  /** 「0 元送」由价格推导：填了 0 才算，空字符串不算。 */
  const free = Number(price) === 0 && price.trim() !== ''

  const addFiles = (files: FileList | null) => {
    if (!files) return
    const next: PickedImage[] = []
    let error = ''
    for (const file of files) {
      if (images.length + next.length >= MAX_LISTING_IMAGES) {
        error = `最多 ${MAX_LISTING_IMAGES} 张图片`
        break
      }
      // HEIC 选择时不校验（提交时 canvas 转码成 JPG 再过规格）；其它格式立即校验。
      const isHeic = file.type === 'image/heic' || /\.heic$/i.test(file.name)
      if (!isHeic) {
        const invalid = validateImageFile(file)
        if (invalid) {
          error = invalid
          continue
        }
      }
      next.push({
        file,
        id: `img-${Date.now()}-${next.length}`,
        previewUrl: URL.createObjectURL(file),
      })
    }
    if (next.length > 0) setImages((prev) => [...prev, ...next])
    setErrors((prev) => ({ ...prev, images: error }))
  }

  const validate = () => {
    const next: Record<string, string> = {}
    if (!editing && images.length === 0) next.images = '至少 1 张图片'
    if (title.trim().length < 2 || title.trim().length > 40) next.title = '标题需要 2–40 个字符'
    if (description.trim().length === 0) next.description = '写点描述,买家更愿意问'
    if (description.length > 500) next.description = '描述最多 500 字'
    if (!category) next.category = '请选择分类'
    // 0 元合法 = 免费送（#6 工作项）；这里只挡空值、非数字与负数。
    if (price.trim() === '' || !PRICE_PATTERN.test(price.trim())) {
      next.price = '填一个数字,0 元即免费送,最多两位小数'
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const submit = async () => {
    if (!validate() || pending) return
    setSubmitError('')
    const fail = (error: unknown) => {
      setSubmitError(error instanceof Error ? error.message : '发布失败,请检查网络后重试')
    }

    if (editId) {
      // 编辑：契约没有「换图」入口（详情响应不给 objectKey，无法全量替换），
      // objectKeys 整个省略 = 图片保持不变，只改文本字段。
      updateListing.mutate(
        {
          id: editId,
          input: {
            title: title.trim(),
            description: description.trim(),
            priceCents: Math.round(Number(price) * 100),
            category: category ?? 'OTHER',
            condition,
            urgent,
            negotiable: free ? false : negotiable,
            free,
          },
        },
        {
          onError: fail,
          onSuccess: () =>
            void navigate({ to: '/detail/$listingId', params: { listingId: editId } }),
        },
      )
      return
    }

    try {
      // 逐张上传（presign → PUT → confirm），先转码 HEIC 再校验规格。
      const objectKeys: string[] = []
      setUploadedCount(0)
      for (const image of images) {
        const target = (await toUploadableFile(image.file)) ?? image.file
        const invalid = validateImageFile(target)
        if (invalid) throw new Error(invalid)
        objectKeys.push(await uploadImage(target))
        setUploadedCount(objectKeys.length)
      }

      const detail = await createListing.mutateAsync({
        title: title.trim(),
        description: description.trim(),
        priceCents: Math.round(Number(price) * 100),
        category: category ?? 'OTHER',
        condition,
        urgent,
        negotiable: free ? false : negotiable,
        free,
        objectKeys,
      })
      setCreated(detail)
    } catch (error) {
      fail(error)
    } finally {
      setUploadedCount(0)
    }
  }

  // 发布成功：停在成功态，让用户确认发出去了，再决定看详情还是继续发。
  if (created) {
    return <PublishSuccess listing={created} />
  }

  return (
    <div className="min-h-dvh bg-bg pb-24">
      <div className="sticky top-0 z-20 bg-surface">
        <NavBar
          onBack={() => window.history.back()}
          right={
            <button
              className="text-brand text-sm disabled:opacity-50"
              disabled={pending}
              onClick={() => void submit()}
              type="button"
            >
              {editing ? '保存' : '发布'}
            </button>
          }
          title={editing ? '编辑闲置' : '发布闲置'}
        />
      </div>

      <section className="mt-2 bg-surface px-4 py-4">
        <p className="mb-3 text-[15px]">
          宝贝图片 <span className="text-danger">*</span>
        </p>

        {editing ? (
          <>
            {/*
              编辑模式图片只读：详情响应刻意不给 objectKey（存储布局不进读协议），
              全量替换 objectKeys 无从谈起——省略该字段即保持原图，只改文本字段。
            */}
            <div className="flex flex-wrap gap-3">
              {initial?.images
                .slice()
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((image) => (
                  <ListingThumb
                    alt={initial.title}
                    className="size-24 rounded-xl"
                    coverUrl={image.url}
                    key={image.sortOrder}
                    listingId={initial.id}
                  />
                ))}
            </div>
            <p className="mt-2 text-ink-3 text-xs">图片暂不支持修改；需要换图请下架后重新发布</p>
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-3">
              {images.map((image, index) => (
                <div
                  className="relative size-24 overflow-hidden rounded-xl bg-surface-2"
                  key={image.id}
                >
                  <img
                    alt={`已选图片 ${index + 1}`}
                    className="size-full object-cover"
                    src={image.previewUrl}
                  />
                  {index === 0 ? (
                    <span className="absolute bottom-1 left-1 rounded bg-black/45 px-1 text-[10px] text-white">
                      封面
                    </span>
                  ) : null}
                  <button
                    aria-label="移除图片"
                    className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-ink text-white"
                    onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
                    type="button"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
              <button
                className="flex size-24 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-ink-3 text-ink-2"
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                <Camera className="size-6" />
                <span className="text-xs">从相册选</span>
              </button>
              <input
                accept="image/jpeg,image/png,image/webp,image/heic"
                hidden
                multiple
                onChange={(event) => {
                  addFiles(event.target.files)
                  event.target.value = ''
                }}
                ref={fileInputRef}
                type="file"
              />
            </div>
            {errors.images ? <p className="mt-1 text-danger text-xs">{errors.images}</p> : null}
            <p className="mt-1 text-ink-3 text-xs">
              第一张作为封面,最多 9 张;支持 JPG / PNG / WebP,iPhone 的 HEIC 会先转码
            </p>
          </>
        )}
      </section>

      <section className="mt-2 space-y-4 bg-surface px-4 py-4">
        <div>
          <Field className="gap-2">
            <FieldLabel htmlFor={titleId}>
              标题 <span className="text-danger">*</span>
            </FieldLabel>
            <Input
              id={titleId}
              maxLength={40}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="一句话说清是什么,如:捷安特山地车 99新"
              value={title}
            />
          </Field>
          {errors.title ? <p className="mt-1 text-danger text-xs">{errors.title}</p> : null}
        </div>
        <div>
          <Field className="gap-2">
            <FieldLabel htmlFor={descriptionId}>
              描述 <span className="text-danger">*</span>
            </FieldLabel>
            <Textarea
              id={descriptionId}
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="说说购入时间、使用频率、有无磕碰、配件情况,越详细越好卖~"
              value={description}
            />
          </Field>
          <p className="mt-1 text-right text-ink-3 text-xs">{description.length}/500</p>
          {errors.description ? <p className="text-danger text-xs">{errors.description}</p> : null}
        </div>
      </section>

      <section className="mt-2 divide-y divide-line bg-surface">
        <FormRow
          label={
            <>
              分类 <span className="text-danger">*</span>
            </>
          }
          onClick={() => setPicker('category')}
          placeholder="选择分类"
          value={category ? categoryLabel(category) : undefined}
        />
        {errors.category ? (
          <p className="px-4 py-1 text-danger text-xs">{errors.category}</p>
        ) : null}
        <div className="flex h-13 items-center gap-3 px-4">
          <span className="shrink-0 text-[15px]">
            价格 <span className="text-danger">*</span>
          </span>
          <span className="text-ink-3">¥</span>
          <Input
            className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-right text-[15px] shadow-none focus-visible:bg-transparent"
            inputMode="decimal"
            onChange={(event) => setPrice(event.target.value)}
            placeholder="0.00"
            value={price}
          />
        </div>
        {errors.price ? <p className="px-4 py-1 text-danger text-xs">{errors.price}</p> : null}
        <FormRow
          label="成色"
          onClick={() => setPicker('condition')}
          value={CONDITION_LABEL[condition]}
        />
      </section>

      {/*
        #6 的「急出 / 可刀 / 0 元送」：前两个是开关，直接写在商品上；
        「0 元送」不单独给开关——它由价格推导（填 0 就是），两个入口会让同一件事有两种真相。
        交易方式 / 校区 / 原价不在 #6 冻结契约的写模型里，切真实后从表单移除。
      */}
      <section className="mt-2 divide-y divide-line bg-surface">
        <FlagRow
          description="商品卡左上角打「急出」角标,排在前面更容易被看到"
          label="急出"
          onChange={setUrgent}
          value={urgent}
        />
        <FlagRow
          description={
            free ? '已填 0 元(免费送),不再叠「可小刀」' : '买家可以还价,商品上会显示「可小刀」'
          }
          disabled={free}
          label="可小刀"
          onChange={setNegotiable}
          value={free ? false : negotiable}
        />
        {free ? (
          <p className="px-4 py-2.5 text-brand text-xs">价格填的是 0 元,会作为「免费送」发布</p>
        ) : null}
      </section>

      <p className="px-4 py-3 text-ink-3 text-xs leading-relaxed">
        发布即表示你同意《校园二手交易公约》:如实描述物品情况,不发布违规物品,建议在校内公共区域当面交易。
      </p>

      {submitError ? (
        <div className="px-4 pb-3">
          <Alert className="rounded-lg border-0 bg-danger-soft px-3 py-2" variant="destructive">
            <AlertDescription className="text-danger">{submitError}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <div className="pb-safe fixed bottom-0 left-1/2 z-30 w-full max-w-[430px] -translate-x-1/2 bg-bg px-4 py-3">
        {submitError ? (
          <button
            className="mb-2 w-full text-center text-brand text-xs"
            onClick={() => void submit()}
            type="button"
          >
            重试一次
          </button>
        ) : null}
        <Button className="w-full" disabled={pending} onClick={() => void submit()} size="lg">
          {uploadedCount > 0
            ? `上传图片 ${uploadedCount}/${images.length}…`
            : pending
              ? '提交中…'
              : editing
                ? '保存修改'
                : '发布闲置'}
        </Button>
      </div>

      {picker ? (
        <PickerSheet
          onClose={() => setPicker(null)}
          onPick={(value) => {
            if (picker === 'category') setCategory(value as ListingCategory)
            if (picker === 'condition') setCondition(value as ListingCondition)
            setPicker(null)
          }}
          options={picker === 'category' ? CATEGORY_OPTIONS : CONDITION_OPTIONS}
          title={picker === 'category' ? '选择分类' : '选择成色'}
          value={picker === 'category' ? category : condition}
        />
      ) : null}
    </div>
  )
}

/**
 * 发布成功页。
 *
 * 刻意**不自动跳转**：跳走之后用户不确定到底成功没有。
 * 这里给明确反馈 + 三个出口（看详情 / 再发一件 / 回首页），把选择权交回用户。
 */
function PublishSuccess({ listing }: { listing: ListingDetail }) {
  const navigate = useNavigate()

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <div className="sticky top-0 z-20 bg-surface">
        <NavBar title="发布结果" />
      </div>

      <div className="flex flex-1 flex-col items-center px-6 pt-16 text-center">
        <span className="flex size-16 items-center justify-center rounded-full bg-success-soft">
          <CircleCheck className="size-8 text-success" />
        </span>
        <h1 className="mt-4 font-semibold text-lg">发布成功</h1>
        <p className="mt-1.5 text-ink-2 text-sm">同学们已经能搜到这件闲置了</p>

        <div className="mt-6 flex w-full items-center gap-3 rounded-2xl bg-surface p-3 text-left">
          <ListingThumb
            alt={listing.title}
            className="size-14 shrink-0 rounded-xl"
            coverUrl={listing.coverUrl}
            listingId={listing.id}
          />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 font-medium text-[15px] leading-snug">{listing.title}</p>
            <p className="mt-1 font-semibold text-brand text-sm">
              {formatPrice(listing.priceCents)}
              {listing.urgent ? ' · 急出' : ''}
              {listing.negotiable ? ' · 可小刀' : ''}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2 px-6 pb-8">
        <Button
          className="w-full"
          onClick={() =>
            void navigate({ to: '/detail/$listingId', params: { listingId: listing.id } })
          }
          size="lg"
        >
          看看发布效果
        </Button>
        <Button
          className="w-full"
          onClick={() => void navigate({ to: '/publish' })}
          variant="outline"
        >
          再发一件
        </Button>
        <Button className="w-full" onClick={() => void navigate({ to: '/' })} variant="ghost">
          返回首页
        </Button>
      </div>
    </div>
  )
}

/** 「急出 / 可小刀」这类开关行，与上下的 `FormRow` 共用同一套高度与字号。 */
function FlagRow({
  label,
  description,
  value,
  onChange,
  disabled = false,
}: {
  label: string
  description: string
  value: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      aria-checked={value}
      className="flex h-13 w-full items-center gap-3 px-4 text-left disabled:opacity-50"
      disabled={disabled}
      onClick={() => onChange(!value)}
      role="switch"
      type="button"
    >
      <span className="shrink-0 text-[15px]">{label}</span>
      <span className="min-w-0 flex-1 truncate text-ink-3 text-xs">{description}</span>
      <span
        className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${
          value ? 'bg-brand' : 'bg-line'
        }`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${
            value ? 'translate-x-[18px]' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  )
}

/** 极简选择面板：从底部弹出，单选即关闭。 */
function PickerSheet({
  title,
  options,
  value,
  onPick,
  onClose,
}: {
  title: string
  options: { value: string; label: string }[]
  value: string | null
  onPick: (value: string) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" data-overlay-open="">
      <button
        aria-label="关闭"
        className="absolute inset-0 bg-black/35"
        onClick={onClose}
        type="button"
      />
      <div className="pb-safe relative w-full max-w-[430px] rounded-t-2xl bg-surface pt-2">
        <p className="py-3 text-center font-medium text-[15px]">{title}</p>
        <ul className="max-h-[50vh] overflow-y-auto pb-2">
          {options.map((option) => (
            <li key={option.value}>
              <button
                className={`flex h-12 w-full items-center justify-center text-[15px] ${
                  option.value === value ? 'font-semibold text-brand' : 'text-ink'
                }`}
                onClick={() => onPick(option.value)}
                type="button"
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
