import {
  type WishCategory,
  type WishDto,
  wishCategorySchema,
  wishCreateInputSchema,
} from '@fish/contracts/wishes/schema'
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
import { Switch } from '@fish/ui/switch'
import { Textarea } from '@fish/ui/textarea'
import { useEffect, useState } from 'react'
import { ApiError } from '../../lib/api-client'
import { CATEGORY_LABEL } from '../../lib/labels'
import { parseBudgetCents } from './api'
import { useCreateWish, useUpdateWish } from './queries'

type WishFormState = {
  keyword: string
  category: WishCategory
  budgetMin: string
  budgetMax: string
  description: string
  acceptSimilar: boolean
}

type WishFieldErrors = Partial<Record<'keyword' | 'budget' | 'description', string>>

const INITIAL_FORM: WishFormState = {
  keyword: '',
  category: 'DIGITAL',
  budgetMin: '',
  budgetMax: '',
  description: '',
  acceptSimilar: true,
}

const CATEGORY_OPTIONS = wishCategorySchema.options.map((value) => ({
  value,
  label: CATEGORY_LABEL[value],
}))

export function WishFormDialog({
  open,
  onOpenChange,
  ownerId,
  wish,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  ownerId: string
  wish?: WishDto
}) {
  const createWish = useCreateWish(ownerId)
  const updateWish = useUpdateWish(ownerId)
  const [form, setForm] = useState<WishFormState>(INITIAL_FORM)
  const [fieldErrors, setFieldErrors] = useState<WishFieldErrors>({})
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setForm(
      wish === undefined
        ? INITIAL_FORM
        : {
            keyword: wish.keyword,
            category: wish.category,
            budgetMin: String(wish.budgetMinCents / 100),
            budgetMax: String(wish.budgetMaxCents / 100),
            description: wish.description ?? '',
            acceptSimilar: wish.acceptSimilar,
          },
    )
    setFieldErrors({})
    setMessage(null)
  }, [open, wish])

  function patch(next: Partial<WishFormState>) {
    setForm((current) => ({ ...current, ...next }))
  }

  async function submit() {
    const keyword = form.keyword.trim()
    const budgetMinCents = parseBudgetCents(form.budgetMin, true)
    const budgetMaxCents = parseBudgetCents(form.budgetMax)
    const errors: WishFieldErrors = {}

    if (keyword.length < 2 || keyword.length > 30 || !/[^\s\p{P}]/u.test(keyword)) {
      errors.keyword = '关键词需要 2–30 个字符，且不能只有空白或标点'
    }
    if (budgetMaxCents === null || budgetMaxCents <= 0) {
      errors.budget = '预算上限必须大于 0，最多两位小数'
    } else if (budgetMinCents === null || budgetMaxCents < budgetMinCents) {
      errors.budget = '预算上限不能低于下限'
    }
    if (form.description.length > 500) errors.description = '描述最多 500 个字符'

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      setMessage(null)
      return
    }

    setFieldErrors({})
    setMessage(null)

    try {
      const payload = {
        keyword,
        category: form.category,
        budgetMinCents: budgetMinCents ?? 0,
        budgetMaxCents: budgetMaxCents ?? 0,
        description: form.description.trim() || undefined,
        acceptSimilar: form.acceptSimilar,
      }
      if (wish === undefined) {
        await createWish.mutateAsync(wishCreateInputSchema.parse(payload))
      } else {
        await updateWish.mutateAsync({
          id: wish.id,
          input: {
            ...wishCreateInputSchema.parse(payload),
            description: form.description.trim() || null,
          },
        })
      }
      onOpenChange(false)
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 403) setMessage('只能编辑自己的愿望')
        else if (error.status === 409) {
          setMessage(wish === undefined ? error.message : '愿望状态已变化，请刷新后重试')
        } else if (error.status === 404) setMessage('愿望不存在或已不可用')
        else setMessage(error.message)
      } else {
        setMessage('保存失败，请稍后重试')
      }
    }
  }

  const pending = createWish.isPending || updateWish.isPending

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-[620px]">
        <DialogHeader>
          <DialogTitle className="text-xl">
            {wish === undefined ? '发布愿望' : '编辑愿望'}
          </DialogTitle>
          <DialogDescription>
            关键词 2–30 字；预算按元填写，最多两位小数。匹配由服务端 Worker 异步产出。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <Field data-invalid={fieldErrors.keyword !== undefined}>
            <FieldLabel htmlFor="wish-keyword">关键词</FieldLabel>
            <Input
              aria-invalid={fieldErrors.keyword !== undefined}
              id="wish-keyword"
              maxLength={30}
              onChange={(event) => patch({ keyword: event.target.value })}
              placeholder="例如：机械键盘"
              value={form.keyword}
            />
            {fieldErrors.keyword !== undefined ? (
              <FieldError>{fieldErrors.keyword}</FieldError>
            ) : null}
          </Field>

          <Field>
            <FieldLabel htmlFor="wish-category">分类</FieldLabel>
            <Select
              onValueChange={(value) => patch({ category: wishCategorySchema.parse(value) })}
              value={form.category}
            >
              <SelectTrigger className="w-full" id="wish-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field data-invalid={fieldErrors.budget !== undefined}>
            <FieldLabel htmlFor="wish-budget-min">预算区间（元）</FieldLabel>
            <div className="flex items-center gap-3">
              <Input
                aria-invalid={fieldErrors.budget !== undefined}
                id="wish-budget-min"
                inputMode="decimal"
                onChange={(event) => patch({ budgetMin: event.target.value })}
                placeholder="下限，可留空"
                value={form.budgetMin}
              />
              <span className="shrink-0 text-ink-3">~</span>
              <Input
                aria-invalid={fieldErrors.budget !== undefined}
                aria-label="预算上限（元）"
                id="wish-budget-max"
                inputMode="decimal"
                onChange={(event) => patch({ budgetMax: event.target.value })}
                placeholder="上限"
                value={form.budgetMax}
              />
            </div>
            {fieldErrors.budget !== undefined ? (
              <FieldError>{fieldErrors.budget}</FieldError>
            ) : null}
          </Field>

          <Field data-invalid={fieldErrors.description !== undefined}>
            <FieldLabel htmlFor="wish-description">描述（选填）</FieldLabel>
            <Textarea
              aria-invalid={fieldErrors.description !== undefined}
              id="wish-description"
              maxLength={500}
              onChange={(event) => patch({ description: event.target.value })}
              placeholder="补充成色、规格、面交偏好等"
              rows={4}
              value={form.description}
            />
            <div className="flex justify-between">
              {fieldErrors.description !== undefined ? (
                <FieldError>{fieldErrors.description}</FieldError>
              ) : (
                <span />
              )}
              <span className="text-ink-3 text-xs">{form.description.length}/500</span>
            </div>
          </Field>

          <div className="flex items-center justify-between rounded-xl bg-surface-2 px-4 py-3">
            <label htmlFor="wish-accept-similar">
              <span className="block font-medium text-sm">接受相似商品</span>
              <span className="mt-0.5 block text-ink-3 text-xs">
                允许标题、分类或预算相近的商品参与匹配。
              </span>
            </label>
            <Switch
              checked={form.acceptSimilar}
              id="wish-accept-similar"
              onCheckedChange={(checked) => patch({ acceptSimilar: checked })}
            />
          </div>

          {message !== null ? (
            <p className="rounded-xl bg-danger-soft px-3 py-2 text-danger text-sm" role="alert">
              {message}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            disabled={pending}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            取消
          </Button>
          <Button disabled={pending} onClick={() => void submit()} type="button">
            {pending ? '正在保存…' : wish === undefined ? '发布愿望' : '保存修改'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
