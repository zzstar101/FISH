import { Button } from '@fish/ui/button'
import { Field, FieldLabel } from '@fish/ui/field'
import { Input } from '@fish/ui/input'
import { FormRow, NavBar } from '@fish/ui/nav-bar'
import { LoadingState } from '@fish/ui/states'
import { Textarea } from '@fish/ui/textarea'
import { useNavigate } from '@tanstack/react-router'
import { Camera, Sparkles, X } from 'lucide-react'
import { useId, useState } from 'react'
import type { ListingView } from '../../lib/mock/store'
import type { Campus, ListingCategory, TradeMethod } from '../../lib/mock/types'
import { useCreateListing, useListingForEdit, useUpdateListing } from './queries'

const CATEGORIES: ListingCategory[] = [
  '数码电子',
  '图书教材',
  '生活用品',
  '服饰鞋包',
  '运动健身',
  '代步工具',
  '美妆个护',
  '其他闲置',
]
const CONDITIONS = ['全新', '99新', '95新', '9成新', '8成新']
const TRADE_METHODS: TradeMethod[] = ['校内自提', '校内面交']
const CAMPUSES: Campus[] = ['东校区', '西校区', '南校区', '北校区']
/** Mock 没有真实图片，从相册选与演示占位都插一个 emoji 占位图。 */
const PLACEHOLDER_EMOJI = ['📦', '🎧', '📚', '🖱️', '👟', '💡', '🚲', '🎮', '📱']
/** 整数或最多两位小数，避免 `Number('abc')` 变成 NaN 后渲染出 `¥NaN`。 */
const PRICE_PATTERN = /^\d+(\.\d{1,2})?$/

type PickerKey = 'category' | 'condition' | 'tradeMethod' | 'campus'

/** 已选图片：Mock 阶段只有 emoji，`id` 仅用于列表 key 与移除。 */
type PickedImage = { id: string; emoji: string }

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

function PublishForm({ editId, initial }: { editId?: string; initial: ListingView | null }) {
  const navigate = useNavigate()
  const createListing = useCreateListing()
  const updateListing = useUpdateListing()
  const editing = Boolean(editId)
  const [images, setImages] = useState<PickedImage[]>(
    initial ? [{ id: 'cover', emoji: initial.emoji }] : [],
  )
  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description.join('\n') ?? '')
  const [category, setCategory] = useState<ListingCategory | null>(initial?.category ?? null)
  const [condition, setCondition] = useState<string>(initial?.condition ?? CONDITIONS[3] ?? '9成新')
  const [tradeMethod, setTradeMethod] = useState<TradeMethod>(initial?.tradeMethod ?? '校内自提')
  const [campus, setCampus] = useState<Campus>(initial?.campus ?? '东校区')
  const [price, setPrice] = useState(initial ? (initial.priceCents / 100).toString() : '')
  const [originalPrice, setOriginalPrice] = useState(
    initial?.originalPriceCents ? (initial.originalPriceCents / 100).toString() : '',
  )
  const [picker, setPicker] = useState<PickerKey | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const titleId = useId()
  const descriptionId = useId()

  const pending = createListing.isPending || updateListing.isPending

  const addImage = () => {
    if (images.length >= 9) {
      setErrors((prev) => ({ ...prev, images: '最多 9 张图片' }))
      return
    }
    const next = PLACEHOLDER_EMOJI[images.length % PLACEHOLDER_EMOJI.length] ?? '📦'
    setImages((prev) => [...prev, { id: `img-${Date.now()}-${prev.length}`, emoji: next }])
    setErrors((prev) => ({ ...prev, images: '' }))
  }

  const validate = () => {
    const next: Record<string, string> = {}
    if (images.length === 0) next.images = '至少 1 张图片'
    if (title.trim().length < 2 || title.trim().length > 40) next.title = '标题需要 2–40 个字符'
    if (description.trim().length === 0) next.description = '写点描述,买家更愿意问'
    if (description.length > 500) next.description = '描述最多 500 字'
    if (!category) next.category = '请选择分类'
    if (!PRICE_PATTERN.test(price.trim()) || Number(price) <= 0) {
      next.price = '填一个大于 0 的数字,最多两位小数'
    }
    if (originalPrice.trim() && !PRICE_PATTERN.test(originalPrice.trim())) {
      next.originalPrice = '原价最多两位小数'
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  const submit = () => {
    if (!validate()) return
    const draft = {
      title: title.trim(),
      description: description.trim(),
      category: category ?? '其他闲置',
      condition,
      campus,
      tradeMethod,
      priceCents: Math.round(Number(price) * 100),
      originalPriceCents: originalPrice ? Math.round(Number(originalPrice) * 100) : undefined,
      emoji: images[0]?.emoji ?? '📦',
      free: Number(price) === 0,
    }
    if (editId) {
      updateListing.mutate(
        { id: editId, draft },
        {
          onSuccess: () =>
            void navigate({ to: '/detail/$listingId', params: { listingId: editId } }),
        },
      )
      return
    }
    createListing.mutate(draft, {
      onSuccess: (created) => {
        void navigate({ to: '/detail/$listingId', params: { listingId: created.id } })
      },
    })
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
              onClick={submit}
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
        <div className="flex flex-wrap gap-3">
          {images.map((image, index) => (
            <div
              className="relative flex size-24 items-center justify-center rounded-xl bg-surface-2 text-3xl"
              key={image.id}
            >
              {image.emoji}
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
            onClick={addImage}
            type="button"
          >
            <Camera className="size-6" />
            <span className="text-xs">从相册选</span>
          </button>
          <button
            className="flex size-24 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-ink-3 text-ink-2"
            onClick={addImage}
            type="button"
          >
            <Sparkles className="size-6" />
            <span className="text-xs">演示占位</span>
          </button>
        </div>
        <p className="mt-2 text-ink-3 text-xs">
          第一张作为封面,最多 9 张;没有合适图片也可用演示占位
        </p>
        {errors.images ? <p className="mt-1 text-danger text-xs">{errors.images}</p> : null}
        <p className="mt-1 text-ink-3 text-xs">
          当前 {images.length}/9 · 支持 JPG / PNG / WebP,iPhone 的 HEIC 会先转码
        </p>
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
              placeholder="一句话说清是什么,如:捷安特山地车 9成新"
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
          value={category ?? undefined}
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
        <div className="flex h-13 items-center gap-3 px-4">
          <span className="shrink-0 text-[15px]">原价</span>
          <span className="text-ink-3">¥</span>
          <Input
            className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-right text-[15px] shadow-none focus-visible:bg-transparent"
            inputMode="decimal"
            onChange={(event) => setOriginalPrice(event.target.value)}
            placeholder="选填,帮你显示折扣"
            value={originalPrice}
          />
        </div>
        {errors.originalPrice ? (
          <p className="px-4 py-1 text-danger text-xs">{errors.originalPrice}</p>
        ) : null}
        <FormRow label="成色" onClick={() => setPicker('condition')} value={condition} />
        <FormRow label="交易方式" onClick={() => setPicker('tradeMethod')} value={tradeMethod} />
        <FormRow label="所在校区" onClick={() => setPicker('campus')} value={campus} />
      </section>

      <p className="px-4 py-3 text-ink-3 text-xs leading-relaxed">
        发布即表示你同意《校园二手交易公约》:如实描述物品情况,不发布违规物品,建议在校内公共区域当面交易。
      </p>

      <div className="pb-safe fixed bottom-0 left-1/2 z-30 w-full max-w-[430px] -translate-x-1/2 bg-bg px-4 py-3">
        <Button className="w-full" disabled={pending} onClick={submit} size="lg">
          {pending ? '提交中…' : editing ? '保存修改' : '发布闲置'}
        </Button>
      </div>

      {picker ? (
        <PickerSheet
          onClose={() => setPicker(null)}
          onPick={(value) => {
            if (picker === 'category') setCategory(value as ListingCategory)
            if (picker === 'condition') setCondition(value)
            if (picker === 'tradeMethod') setTradeMethod(value as TradeMethod)
            if (picker === 'campus') setCampus(value as Campus)
            setPicker(null)
          }}
          options={
            picker === 'category'
              ? CATEGORIES
              : picker === 'condition'
                ? CONDITIONS
                : picker === 'tradeMethod'
                  ? TRADE_METHODS
                  : CAMPUSES
          }
          title={
            picker === 'category'
              ? '选择分类'
              : picker === 'condition'
                ? '选择成色'
                : picker === 'tradeMethod'
                  ? '选择交易方式'
                  : '选择所在校区'
          }
          value={
            picker === 'category'
              ? category
              : picker === 'condition'
                ? condition
                : picker === 'tradeMethod'
                  ? tradeMethod
                  : campus
          }
        />
      ) : null}
    </div>
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
  options: readonly string[]
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
            <li key={option}>
              <button
                className={`flex h-12 w-full items-center justify-center text-[15px] ${
                  option === value ? 'font-semibold text-brand' : 'text-ink'
                }`}
                onClick={() => onPick(option)}
                type="button"
              >
                {option}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
