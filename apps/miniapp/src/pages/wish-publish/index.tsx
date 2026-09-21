import { Image, Input, ScrollView, Text, Textarea, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState } from 'react'
import { HOME_CATEGORY_ICONS } from '@/assets/home-icons'
import { ICONS } from '@/assets/lib-icons'
import NavBar from '@/components/nav-bar'
import {
  categoryLabel,
  createWishLocal,
  type MockWish,
  myWishes,
  WISH_CATEGORIES,
} from '@/mock/api'
import './index.scss'

/**
 * 我要许愿（二级页，设计稿 `许愿墙-改版设计-按契约.html` 的屏③）。
 *
 * 表单字段与校验逐条对齐契约 `wishCreateInputSchema`
 * （`packages/contracts/src/wishes/schema.ts`）：
 * - `keyword`：trim 后 2–30 字，且不能只有空白或标点，入库前**转小写**；
 * - `category`：`wishCategorySchema` 的 8 个枚举值之一；
 * - `budgetMinCents` 非负整数、`budgetMaxCents` 正整数且 ≥ 最低（界面收**元**，提交时 ×100）；
 * - `description` 选填 ≤ 500 字；`acceptSimilar` 默认 true。
 *
 * 提交**不调接口**：小程序端还没有 wish 客户端（属 #89），这里只写本地 mock
 * （`createWishLocal`）然后返回许愿页。真实端点是 `POST /wishes`。
 */

/** 契约约束文案里的两个后端常量：契约未导出，真源是
 *  `apps/api/src/modules/wishes/service.ts`（`ACTIVE_WISH_LIMIT` / `DUPLICATE_WINDOW_MS`） */
const ACTIVE_WISH_LIMIT = 10
const DUPLICATE_WINDOW_SECONDS = 5

type FieldErrors = {
  keyword?: string
  budget?: string
}

export default function WishPublish() {
  const [keyword, setKeyword] = useState('')
  const [category, setCategory] = useState<MockWish['category']>(WISH_CATEGORIES[0] ?? 'DIGITAL')
  /** 预算两个输入框收的都是「元」的字符串，提交时才转分 */
  const [budgetMin, setBudgetMin] = useState('')
  const [budgetMax, setBudgetMax] = useState('')
  const [description, setDescription] = useState('')
  const [acceptSimilar, setAcceptSimilar] = useState(true)
  const [errors, setErrors] = useState<FieldErrors>({})

  const back = () => {
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) {
      void Taro.navigateBack()
    } else {
      // 预览里直接打开本页时没有上一页，回许愿页（与 `nav-bar` 的兜底一致）
      void Taro.switchTab({ url: '/pages/wish/index' })
    }
  }

  const submit = () => {
    const next: FieldErrors = {}

    const trimmed = keyword.trim()
    /**
     * 长度按**码点**数（`[...str].length`），与契约一致：`z.string().min/max` 数的是
     * 码点，不是 UTF-16 code unit —— 一个 emoji 算 1 个字符。用 `trimmed.length` 的话，
     * 单个 emoji 前端会放过（2 个 code unit）、服务端会拒（1 个码点），16 个 emoji
     * 则反过来。`maxlength={30}` 是 code unit 口径，只会**更严**（截断在 30 个 code unit），
     * 不会放过服务端会拒的输入。
     */
    const keywordLength = [...trimmed].length
    if (keywordLength < 2 || keywordLength > 30) {
      next.keyword = 'keyword 需要 2–30 个字符'
    } else if (!/[^\s\p{P}]/u.test(trimmed)) {
      next.keyword = '关键词不能只有空白或标点'
    }

    // 最低可空 = 0；两个都必须是非负/正整数（与契约的 .int() 一致，小数与空串都拦下）
    const minYuan = budgetMin.trim() === '' ? 0 : Number(budgetMin.trim())
    const maxYuan = Number(budgetMax.trim())
    if (!Number.isInteger(minYuan) || minYuan < 0) {
      next.budget = 'budgetMinCents 必须是非负整数'
    } else if (!Number.isInteger(maxYuan) || maxYuan <= 0) {
      next.budget = 'budgetMaxCents 必须是正整数'
    } else if (maxYuan < minYuan) {
      next.budget = 'budgetMaxCents 必须 ≥ budgetMinCents'
    }

    setErrors(next)
    if (next.keyword || next.budget) return

    // 服务端还有一条「同时 ACTIVE 最多 10 条」的业务规则（不在输入 schema 里）。
    // 本地预检只为给出更快的反馈，真实判定仍在服务端。
    if (myWishes().filter((wish) => wish.status === 'ACTIVE').length >= ACTIVE_WISH_LIMIT) {
      void Taro.showToast({
        title: `409 · ACTIVE 愿望已达上限 ${ACTIVE_WISH_LIMIT} 条`,
        icon: 'none',
      })
      return
    }

    createWishLocal({
      // 契约的 `keywordSchema` 会 trim + 转小写，这里先做一遍，mock 里的数据才与真实入库一致
      keyword: trimmed.toLowerCase(),
      category,
      budgetMinCents: minYuan * 100,
      budgetMaxCents: maxYuan * 100,
      description: description.trim() === '' ? undefined : description.trim(),
      acceptSimilar,
    })

    void Taro.showToast({ title: '已发布愿望，等卖家来找你', icon: 'none' })
    back()
  }

  return (
    <View className="wp">
      <View className="wp__topbg" />

      <NavBar title="许个愿" />

      <View className="wp__body">
        {/* ---------------- 想要什么 ---------------- */}
        <View className="wp__field">
          <View className="wp__frow">
            <Text className="wp__label">
              想要什么 <Text className="wp__req">*</Text>
            </Text>
            <Text className="wp__fhint">keyword · 2–30 字</Text>
          </View>
          <Input
            className={`wp__input${errors.keyword ? ' is-err' : ''}`}
            value={keyword}
            maxlength={30}
            placeholder="例如：机械键盘"
            onInput={(event) => setKeyword(event.detail.value)}
          />
          {errors.keyword ? (
            <View className="wp__err">
              <Image className="wp__err-ic" src={ICONS.warnInk} mode="aspectFit" />
              <Text className="wp__err-tx">{errors.keyword}</Text>
            </View>
          ) : null}
        </View>

        {/* ---------------- 哪一类 ---------------- */}
        <View className="wp__field">
          <View className="wp__frow">
            <Text className="wp__label">
              哪一类 <Text className="wp__req">*</Text>
            </Text>
            <Text className="wp__fhint">category · 8 枚举</Text>
          </View>
          <ScrollView className="wp__cats" scrollX enableFlex>
            <View className="wp__cats-inner">
              {WISH_CATEGORIES.map((key) => (
                <View
                  key={key}
                  className={`wp__cat${key === category ? ' is-on' : ''}`}
                  onClick={() => setCategory(key)}
                >
                  <Image className="wp__cat-ic" src={HOME_CATEGORY_ICONS[key]} mode="aspectFit" />
                  <Text>{categoryLabel(key)}</Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </View>

        {/* ---------------- 预算区间 ---------------- */}
        <View className="wp__field">
          <View className="wp__frow">
            <Text className="wp__label">
              预算区间 <Text className="wp__req">*</Text>
            </Text>
            <Text className="wp__fhint">元 · 提交时 ×100 → Cents</Text>
          </View>
          <View className="wp__row2">
            <Input
              className={`wp__input${errors.budget ? ' is-err' : ''}`}
              value={budgetMin}
              type="number"
              placeholder="最低 ¥（可空＝0）"
              onInput={(event) => setBudgetMin(event.detail.value)}
            />
            <Input
              className={`wp__input${errors.budget ? ' is-err' : ''}`}
              value={budgetMax}
              type="number"
              placeholder="最高 ¥"
              onInput={(event) => setBudgetMax(event.detail.value)}
            />
          </View>
          {errors.budget ? (
            <View className="wp__err">
              <Image className="wp__err-ic" src={ICONS.warnInk} mode="aspectFit" />
              <Text className="wp__err-tx">{errors.budget}</Text>
            </View>
          ) : null}
        </View>

        {/* ---------------- 具体要求 ---------------- */}
        <View className="wp__field">
          <View className="wp__frow">
            <Text className="wp__label">具体要求</Text>
            <Text className="wp__fhint">{`description · 选填 ≤500 字（${description.length}）`}</Text>
          </View>
          <Textarea
            className="wp__input wp__input--area"
            value={description}
            maxlength={500}
            disableDefaultPadding
            placeholder="成色要求、可接受的替代型号、面交时间…"
            onInput={(event) => setDescription(event.detail.value)}
          />
        </View>

        {/* ---------------- 匹配偏好 ---------------- */}
        <View className="wp__field">
          <View className="wp__frow">
            <Text className="wp__label">匹配偏好</Text>
            <Text className="wp__fhint">acceptSimilar · 默认 true</Text>
          </View>
          <View className="wp__sw">
            <View className="wp__sw-tx">
              <Text className="wp__sw-title">接受相似商品</Text>
              <Text className="wp__sw-sub">关闭后只匹配完全命中的商品</Text>
            </View>
            <View
              className={`wp__track${acceptSimilar ? ' is-on' : ''}`}
              onClick={() => setAcceptSimilar((value) => !value)}
            >
              <View className="wp__knob" />
            </View>
          </View>
        </View>

        {/* ---------------- 契约约束说明 ---------------- */}
        <View className="wp__note">
          <Text className="wp__note-hd">契约约束（服务端会二次校验）</Text>
          <Text className="wp__note-line">{`· 同时 ACTIVE 的心愿最多 ${ACTIVE_WISH_LIMIT} 条，超出返回 409`}</Text>
          <Text className="wp__note-line">
            {`· ${DUPLICATE_WINDOW_SECONDS} 秒内重复提交同 keyword+category 会返回已有记录（软幂等）`}
          </Text>
          <Text className="wp__note-line">· keyword 服务端会 trim + 转小写后入库</Text>
          <Text className="wp__note-line">
            · 提交成功后投递 MATCH_WISH job，匹配由 Worker 异步完成
          </Text>
        </View>
      </View>

      <View className="wp__bar">
        <View className="wp__cancel" onClick={back}>
          <Text>取消</Text>
        </View>
        <View className="wp__submit" onClick={submit}>
          <Text>发布愿望</Text>
        </View>
      </View>
    </View>
  )
}
