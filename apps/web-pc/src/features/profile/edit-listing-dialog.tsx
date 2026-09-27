import {
  type ListingCategory,
  ListingCategorySchema,
  type ListingCondition,
  ListingConditionSchema,
  type ListingDetail,
  type ListingUpdateInput,
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
import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ApiError } from '../../lib/api-client'
import { CATEGORY_LABEL, CONDITION_LABEL } from '../../lib/labels'
import { useListingDetail } from '../listing-detail/queries'
import { effectiveNegotiable, parsePriceToCents } from '../publish/form-model'
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

type EditFieldErrors = Partial<Record<'title' | 'description' | 'price' | 'category', string>>

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
  const detail = useListingDetail(listing.id, open)
  const updateListing = useUpdateListing(ownerId)
  const [form, setForm] = useState<EditForm | null>(null)
  const [fieldErrors, setFieldErrors] = useState<EditFieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || detail.data === undefined || detail.data === null) return
    setForm(formFromDetail(detail.data))
    setFieldErrors({})
    setFormError(null)
  }, [detail.data, open])

  function patch(next: Partial<EditForm>) {
    setForm((current) => (current === null ? current : { ...current, ...next }))
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

  async function submit() {
    if (form === null || updateListing.isPending) return
    const errors = validate(form)
    setFieldErrors(errors)
    setFormError(null)
    if (Object.keys(errors).length > 0) return

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
            只修改文字、价格和展示选项；图片替换仍不在 PC 本阶段范围内。
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
