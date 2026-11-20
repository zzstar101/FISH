import type { ListingCondition } from '@fish/contracts/listings/schema'
import {
  RENTAL_DEPOSIT_LABEL,
  RENTAL_DEPOSIT_NOTICE,
  RENTAL_MAX_DAYS,
  RENTAL_MIN_DAYS,
  RENTAL_RULE_PRESETS,
  type RentalCreateInput,
} from '@fish/contracts/rentals/schema'
import { Image, Input, Text, Textarea, View } from '@tarojs/components'
import Taro, { useDidHide, useDidShow } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'
import TopBar from '@/components/top-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { createRental } from '@/features/rental/api'
import { type PickResult, pickPhotos, uploadListingImage } from '@/features/upload/api'
import {
  fieldErrorsFromDetails,
  isRentalEligibilityError,
  parseDays,
  parseMoneyToCents,
  RENTAL_FORM_DEFAULTS,
  type RentalFieldErrors,
  rentalPublishErrorText,
  validateRentalForm,
} from './form'
import './index.scss'

/**
 * 出租发布（#706 RNT-02）。
 *
 * ## 与出物页（`pages/sell`）的关系
 *
 * 两个页面**不复用同一个表单组件**，因为字段集不同：
 * - 出售有「免费送 / 可议价 / 急出」三个布尔位、分类选择、售价；
 * - 出租没有那三个位，品类由 M0 冻结为数码（不给选择器），价格是**日租单价**，
 *   另外多出押金、最短 / 最长租期、规则。
 *
 * 强行复用一个组件会让每个字段都带「这个类型下是否适用」的分支，比两份独立表单更难读。
 * 共用的是**上传与审核流程**（`uploadListingImage` + 服务端共享内核），那才是真正该一致的部分。
 *
 * ## 押金文案
 *
 * `RENTAL_DEPOSIT_NOTICE.short` 常驻在押金输入框下方（不是 tooltip）：它是「平台不碰钱」
 * 这一事实的唯一告知点，藏起来等于没写。完整版在详情页常驻。
 *
 * ## 资格门
 *
 * 未通过教育邮箱认证的用户点发布 → 403 `RENTAL_NOT_ELIGIBLE`。这里**不预先查一次**资格：
 * 多一次请求换一个可能过期的结论，不如让服务端在提交时给权威答案；失败后引导去认证页。
 */
export default function RentalPublishPage() {
  const guard = useAuthGuard()
  const [title, setTitle] = useState<string>(RENTAL_FORM_DEFAULTS.title)
  const [description, setDescription] = useState<string>(RENTAL_FORM_DEFAULTS.description)
  const [dailyPrice, setDailyPrice] = useState<string>(RENTAL_FORM_DEFAULTS.dailyPrice)
  const [deposit, setDeposit] = useState<string>(RENTAL_FORM_DEFAULTS.deposit)
  const [rules, setRules] = useState<string>(RENTAL_FORM_DEFAULTS.rules)
  const [minDays, setMinDays] = useState<string>(RENTAL_FORM_DEFAULTS.minDays)
  const [maxDays, setMaxDays] = useState<string>(RENTAL_FORM_DEFAULTS.maxDays)
  const [condition, setCondition] = useState<ListingCondition>(RENTAL_FORM_DEFAULTS.condition)

  /**
   * 已上传的图片。`objectKey` 是 confirm 返回的 final 键（提交时用它），`preview` 是本地
   * 临时路径（只用于渲染缩略图）。两者必须成对保存：final 键是 `listings/<usr_...>/xxx.jpg`
   * 这样的对象键，**不能**直接当 `<Image src>` 用（它不是 URL）。
   */
  const [images, setImages] = useState<{ objectKey: string; preview: string }[]>([])
  /** 本地上传中的预览（与 `objectKeys` 一一对应地累加，成功后才进 objectKeys）。 */
  const [uploading, setUploading] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<RentalFieldErrors>({})

  /**
   * 页面存活判据：换号 / 卸载后不再把上传结果写回 state
   * （与出物页同一手法，见 `features/upload/active.ts`）。
   */
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])
  useDidShow(() => {
    aliveRef.current = true
  })
  useDidHide(() => {
    aliveRef.current = false
  })

  const objectKeys = images.map((item) => item.objectKey)

  const pickAndUpload = useCallback(async () => {
    const remaining = 9 - objectKeys.length - uploading
    if (remaining <= 0) {
      await Taro.showToast({ title: '最多 9 张图片', icon: 'none' })
      return
    }
    let picked: PickResult
    try {
      picked = await pickPhotos(remaining)
    } catch (error) {
      // 取消选图不提示；权限被拒 / 相机异常要告诉用户（`pickPhotos` 已把取消收敛成空数组）。
      await Taro.showToast({
        title: error instanceof Error ? error.message : '无法选择图片',
        icon: 'none',
      })
      return
    }
    // 本地校验挡下的原因（例如单张超 5MB）必须提示，否则用户只会看到「少选了一张」。
    if (picked.rejected) {
      await Taro.showToast({ title: picked.rejected, icon: 'none' })
    }
    if (picked.photos.length === 0) return

    for (const photo of picked.photos) {
      if (!aliveRef.current) return
      setUploading((count) => count + 1)
      try {
        const objectKey = await uploadListingImage(photo, () => aliveRef.current)
        if (!aliveRef.current) return
        setImages((current) =>
          current.some((item) => item.objectKey === objectKey)
            ? current
            : [...current, { objectKey, preview: photo.path }],
        )
      } catch {
        // 用户已经离开本页（换号 / 返回）：不要在他刚到的那个页面上弹「上传失败」。
        if (!aliveRef.current) return
        await Taro.showToast({ title: '图片上传失败，请重试', icon: 'none' })
      } finally {
        setUploading((count) => Math.max(0, count - 1))
      }
    }
  }, [objectKeys.length, uploading])

  const removeImage = useCallback((objectKey: string) => {
    setImages((current) => current.filter((item) => item.objectKey !== objectKey))
  }, [])

  const submit = useCallback(async () => {
    if (submitting || uploading > 0) return

    const dailyPriceCents = parseMoneyToCents(dailyPrice)
    const depositCents = parseMoneyToCents(deposit)
    const min = parseDays(minDays)
    const max = parseDays(maxDays)

    const localError = validateRentalForm({
      title,
      description,
      dailyPriceCents,
      depositCents,
      minDays: min,
      maxDays: max,
      imageCount: objectKeys.length,
    })
    if (localError) {
      await Taro.showToast({ title: localError, icon: 'none' })
      return
    }
    // 走到这里 `dailyPriceCents` / `depositCents` / `min` / `max` 必然非 null
    // （`validateRentalForm` 已逐项判定），但 TS 不知道，所以显式收口。
    if (dailyPriceCents === null || depositCents === null || min === null || max === null) return

    const input: RentalCreateInput = {
      title: title.trim(),
      description: description.trim(),
      dailyPriceCents,
      depositCents,
      minDays: min,
      maxDays: max,
      condition,
      objectKeys,
      // 空规则串不发字段（服务端契约把 `null` 与「没写」视为同一件事）。
      ...(rules.trim().length > 0 ? { rules: rules.trim() } : {}),
    }

    setSubmitting(true)
    setFieldErrors({})
    try {
      const detail = await createRental(input)
      // REVIEW 时商品是 OFFLINE 且不公开：文案要说「已提交审核」而不是「已发布」。
      const pending = detail.status !== 'ACTIVE'
      await Taro.showToast({
        title: pending ? '已提交审核' : '发布成功',
        icon: pending ? 'none' : 'success',
      })
      /*
       * 跳转失败**不能**被当成发布失败：商品已经落库了。
       * 之前这段在同一个 try 里，`redirectTo` 一失败就走进 catch 弹「发布失败」，
       * 用户会以为没发出去而重新提交 —— 5 秒去重窗口挡不住，于是多出一条重复出租。
       * 所以跳转单独包一层，失败就退回上一页（页面栈里本来就有）。
       */
      try {
        await Taro.redirectTo({ url: '/pkg-rental/pages/rental-square/index' })
      } catch {
        await Taro.navigateBack({ delta: 1 }).catch(() => undefined)
      }
    } catch (error) {
      if (isRentalEligibilityError(error)) {
        // 资格门：引导去认证页，而不是让用户对着一个改不动的表单反复提交。
        const { confirm } = await Taro.showModal({
          title: '需要校园认证',
          content: '发布出租需先完成教育邮箱认证，现在去认证？',
          confirmText: '去认证',
          cancelText: '稍后',
        })
        if (confirm) await Taro.navigateTo({ url: '/pkg-auth/pages/verify/index' })
        return
      }
      const details = (error as { details?: { field?: string; message: string }[] }).details
      setFieldErrors(fieldErrorsFromDetails(details))
      await Taro.showToast({ title: rentalPublishErrorText(error), icon: 'none' })
    } finally {
      if (aliveRef.current) setSubmitting(false)
    }
  }, [
    submitting,
    uploading,
    dailyPrice,
    deposit,
    minDays,
    maxDays,
    title,
    description,
    rules,
    condition,
    objectKeys,
  ])

  // 登录态未知时先不渲染（guard 会在 anonymous 时跳登录页）；
  // 已登录 / 未登录都要能进 —— 未认证的**登录用户**也要看到表单才能被引导去认证。
  if (guard === 'unknown') return null

  const canSubmit = objectKeys.length > 0 && uploading === 0 && !submitting

  return (
    <View className="rp">
      <TopBar variant="glass" spacer back center={<Text className="rp__title">出租发布</Text>} />

      <View className="rp__body">
        {/* —— 图片 —— */}
        <View className="rp__card">
          <Text className="rp__label">物品照片</Text>
          <View className="rp__grid">
            {images.map((item) => (
              <View key={item.objectKey} className="rp__thumb">
                <Image className="rp__thumb-img" src={item.preview} mode="aspectFill" />
                <View className="rp__thumb-del" onClick={() => removeImage(item.objectKey)}>
                  ×
                </View>
              </View>
            ))}
            {/* 占位不用数组下标做 key：上传完成后数量会变，下标 key 会让 React 复用错节点。 */}
            {uploading > 0 ? (
              <View key="uploading-placeholder" className="rp__thumb rp__thumb--busy">
                上传中
              </View>
            ) : null}
            {objectKeys.length + uploading < 9 ? (
              <View className="rp__thumb rp__thumb--add" onClick={pickAndUpload}>
                +
              </View>
            ) : null}
          </View>
          {fieldErrors.images ? <Text className="rp__err">{fieldErrors.images}</Text> : null}
        </View>

        {/* —— 基本信息 —— */}
        <View className="rp__card">
          <Text className="rp__label">标题</Text>
          <Input
            className="rp__input"
            value={title}
            maxlength={60}
            placeholder="例如：iPad Air 5 出租，含保护壳"
            onInput={(event) => setTitle(String(event.detail.value))}
          />
          {fieldErrors.title ? <Text className="rp__err">{fieldErrors.title}</Text> : null}

          <Text className="rp__label">描述</Text>
          <Textarea
            className="rp__textarea"
            value={description}
            maxlength={2000}
            placeholder="成色、配件、取物地点等"
            onInput={(event) => setDescription(String(event.detail.value))}
          />
          {fieldErrors.description ? (
            <Text className="rp__err">{fieldErrors.description}</Text>
          ) : null}

          <Text className="rp__label">成色</Text>
          <View className="rp__chips">
            {CONDITION_OPTIONS.map((option) => (
              <View
                key={option.value}
                className={`rp__chip${condition === option.value ? ' is-on' : ''}`}
                onClick={() => setCondition(option.value)}
              >
                {option.label}
              </View>
            ))}
          </View>
        </View>

        {/* —— 价格与租期 —— */}
        <View className="rp__card">
          <Text className="rp__label">日租价（元/天）</Text>
          <Input
            className="rp__input"
            type="digit"
            value={dailyPrice}
            placeholder="0.00"
            onInput={(event) => setDailyPrice(String(event.detail.value))}
          />
          {fieldErrors.dailyPrice ? (
            <Text className="rp__err">{fieldErrors.dailyPrice}</Text>
          ) : null}

          <Text className="rp__label">{RENTAL_DEPOSIT_LABEL}</Text>
          <Input
            className="rp__input"
            type="digit"
            value={deposit}
            placeholder="0"
            onInput={(event) => setDeposit(String(event.detail.value))}
          />
          {/* 押金说明常驻在输入框下方 —— 它是「平台不碰钱」的唯一告知点。 */}
          <Text className="rp__notice">{RENTAL_DEPOSIT_NOTICE.short}</Text>
          {fieldErrors.deposit ? <Text className="rp__err">{fieldErrors.deposit}</Text> : null}

          <View className="rp__row">
            <View className="rp__row-item">
              <Text className="rp__label">最短租期（天）</Text>
              <Input
                className="rp__input"
                type="number"
                value={minDays}
                placeholder={String(RENTAL_MIN_DAYS)}
                onInput={(event) => setMinDays(String(event.detail.value))}
              />
            </View>
            <View className="rp__row-item">
              <Text className="rp__label">最长租期（天）</Text>
              <Input
                className="rp__input"
                type="number"
                value={maxDays}
                placeholder={String(RENTAL_MAX_DAYS)}
                onInput={(event) => setMaxDays(String(event.detail.value))}
              />
            </View>
          </View>
          <Text className="rp__hint">
            平台允许 {RENTAL_MIN_DAYS}–{RENTAL_MAX_DAYS} 天，由你在这段范围内自行设定
          </Text>
          {fieldErrors.minDays ? <Text className="rp__err">{fieldErrors.minDays}</Text> : null}
          {fieldErrors.maxDays ? <Text className="rp__err">{fieldErrors.maxDays}</Text> : null}
        </View>

        {/* —— 出租规则 —— */}
        <View className="rp__card">
          <Text className="rp__label">出租规则（可选）</Text>
          <Textarea
            className="rp__textarea"
            value={rules}
            maxlength={2000}
            placeholder="取物验机、损坏赔付等约定"
            onInput={(event) => setRules(String(event.detail.value))}
          />
          {/* 预置条目：点一下追加到规则文本，减少「漏写关键条款」的情况。 */}
          <View className="rp__chips">
            {RENTAL_RULE_PRESETS.map((preset) => (
              <View
                key={preset}
                className="rp__chip rp__chip--preset"
                onClick={() =>
                  setRules((current) =>
                    current.includes(preset)
                      ? current
                      : `${current}${current ? '\n' : ''}${preset}`,
                  )
                }
              >
                {preset.length > 12 ? `${preset.slice(0, 12)}…` : preset}
              </View>
            ))}
          </View>
          {fieldErrors.rules ? <Text className="rp__err">{fieldErrors.rules}</Text> : null}
        </View>

        {/* 品类由 M0 冻结为数码，这里如实告知而不是给一个只有一项的选择器。 */}
        <Text className="rp__footnote">V1 仅支持数码产品出租（手机、电脑、相机、耳机等）</Text>
      </View>

      <View className="rp__bar">
        <View
          className={`rp__submit${canSubmit ? '' : ' is-off'}`}
          onClick={canSubmit ? submit : undefined}
        >
          {submitting ? '提交中…' : '发布出租'}
        </View>
      </View>
    </View>
  )
}

const CONDITION_OPTIONS: { value: ListingCondition; label: string }[] = [
  { value: 'NEW', label: '全新' },
  { value: 'LIKE_NEW', label: '几乎全新' },
  { value: 'GOOD', label: '成色良好' },
  { value: 'FAIR', label: '有明显使用痕迹' },
]
