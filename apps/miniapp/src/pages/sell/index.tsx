import { Image, Input, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import NavBar from '@/components/nav-bar'
import { moderate, type PolishCandidate, polishCandidates } from '@/mock/api'
import { productImage } from '@/mock/images'
import './index.scss'

/**
 * 「出物」页（设计稿 D1 在现有页上**增补三块**，只增不删）。
 *
 * 表单字段与 `listings` 写契约的 `ListingCreateInput`
 * （title / description / priceCents / category / condition / free）一一对应。
 *
 * **本轮增补（D1）**
 * 1. AI 润色入口：描述框右下角「✨ 润色」→ 吸底候选卡（采用 / 换一条 / 放弃）。
 *    **采用前不覆盖原文**——候选卡里同时展示「候选」与「你写的原文」，点「采用」才替换。
 *    候选来自 `polishCandidates()`，不在页面里内联文案。
 * 2. 审核失败反馈：贴在**对应输入框下方**的 `--danger` 错误块，并把命中的违规词标红。
 *    判定来自 `moderate()`（mock；真实实现是后端返回命中片段）。
 * 3. `急出` / `0元送` 角标：与首页商品卡共用 `@include badge-corner(...)`，
 *    并补上「0 元送时价格锁定 + 议价锁定」的联动（稿子第 04 帧）。
 *
 * 明确不做（避免假装已实现）：真实图片上传、presign、润色与审核的真实接口。
 * 提交只做前端校验 + 审核提示，不写任何后端。
 */

const CONDITIONS: { key: 'NEW' | 'LIKE_NEW' | 'GOOD' | 'FAIR'; label: string }[] = [
  { key: 'NEW', label: '全新' },
  { key: 'LIKE_NEW', label: '九成新' },
  { key: 'GOOD', label: '八成新' },
  { key: 'FAIR', label: '七成新' },
]

/** 演示用的「已选图片」：真实上传接好后换成用户选择的本地路径 */
const DEMO_PHOTOS = ['digital-laptop', 'digital-phone', 'daily-desklamp'].map((slug) =>
  productImage(slug, 0),
)

/** AI 润色的三条候选（页面只保存索引与候选本身，不保存状态机之外的中间态） */
type PolishState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; candidates: PolishCandidate[]; index: number }

export default function Sell() {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('')
  const [condition, setCondition] = useState<(typeof CONDITIONS)[number]['key']>('LIKE_NEW')
  const [free, setFree] = useState(false)
  const [urgent, setUrgent] = useState(false)
  const [negotiable, setNegotiable] = useState(true)
  const [photos, setPhotos] = useState<string[]>(DEMO_PHOTOS)
  const [polish, setPolish] = useState<PolishState>({ phase: 'idle' })
  /** 审核结果：null = 还没提交过（不显示任何错误块，包括空表单时） */
  const [review, setReview] = useState<ReturnType<typeof moderate> | null>(null)

  /** 审核错误块只在「提交过」且「对应字段命中」时渲染，避免用户一进页面就被标红 */
  const showTitleError = review !== null && review.title.length > 0
  const showDescError = review !== null && review.description.length > 0

  /** 0 元送时价格与议价都锁定（稿子第 04 帧的 is-locked 行） */
  const toggleFree = () => {
    setFree((prev) => {
      const next = !prev
      if (next) {
        setPrice('')
        setNegotiable(false)
      }
      return next
    })
  }

  const submit = () => {
    if (title.trim().length < 2) {
      void Taro.showToast({ title: '标题至少 2 个字', icon: 'none' })
      return
    }
    if (!free && !/^\d+(\.\d{1,2})?$/.test(price.trim())) {
      void Taro.showToast({ title: '请填写正确价格', icon: 'none' })
      return
    }
    if (description.trim().length < 1) {
      void Taro.showToast({ title: '请填写描述', icon: 'none' })
      return
    }
    // 审核：真实实现由后端返回命中片段；这里用同一份判定驱动错误块与页头提示条
    const result = moderate(title, description)
    setReview(result)
    if (!result.passed) return
    void Taro.showToast({ title: '发布流程待接入', icon: 'none' })
  }

  const pickImage = () => {
    void Taro.showToast({ title: '图片上传待接入', icon: 'none' })
  }

  /** 开润色：先给「润色中」态，再出候选（稿子第 02 帧画了这两个态） */
  const openPolish = () => {
    const origin = description.trim()
    if (!origin) {
      void Taro.showToast({ title: '先写一句描述再润色', icon: 'none' })
      return
    }
    setPolish({ phase: 'loading' })
    setTimeout(() => {
      setPolish({
        phase: 'ready',
        candidates: polishCandidates(origin),
        index: 0,
      })
    }, 800)
  }

  const nextCandidate = () => {
    setPolish((prev) => {
      if (prev.phase !== 'ready') return prev
      return { ...prev, index: (prev.index + 1) % prev.candidates.length }
    })
  }

  /** 采用：**这一步才**写进描述框（采用前原文一直原样保留） */
  const adopt = () => {
    if (polish.phase !== 'ready') return
    const text = polish.candidates[polish.index]?.text
    if (text) setDescription(text)
    setPolish({ phase: 'idle' })
    setReview(null)
    void Taro.showToast({ title: '已采用润色文案', icon: 'none' })
  }

  const candidate = polish.phase === 'ready' ? (polish.candidates[polish.index]?.text ?? '') : ''

  /**
   * 标题里把命中词高亮（错误块复用）：按命中词切分原文。
   *
   * 先剥掉字段原文结尾的句读——错误块会在引用后面接「，请修改后再发布」，
   * 不剥的话会出现「…价格好商量。，请修改」这种标点连排。
   */
  const highlight = (text: string, words: string[]) => {
    const clean = text.replace(/[。.！!？?，,、；;：:]+$/, '')
    if (words.length === 0) return [{ key: 'p0', text: clean, hit: false }]
    const pattern = new RegExp(
      `(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
      'g',
    )
    /**
     * 用「片段在原文中的起始偏移」当稳定 key：既不依赖渲染下标（`noArrayIndexKey`），
     * 也不会像「拿文案当 key」那样在两个违规词相同时撞 key。
     */
    let offset = 0
    return clean
      .split(pattern)
      .map((part) => {
        const item = { key: `p${offset}`, text: part, hit: words.includes(part) }
        offset += part.length
        return item
      })
      .filter((item) => item.text !== '')
  }

  return (
    <View className="sell">
      <View className="sell__hero-bg" />
      <NavBar back={false} />

      <View className="sell__body">
        <View className="sell__head">
          <Text className="sell__kicker num">闲置出手</Text>
          <Text className="sell__title">发布一件闲置</Text>
          <Text className="sell__sub">
            {review && !review.passed
              ? '修改标红的字段后可以重新提交，草稿已自动保存'
              : '只在本校范围内交易 · 面交时用交易码确认'}
          </Text>
        </View>

        {/* 审核失败提示条：只说明「有几处要改」，不重复每个字段的细节 */}
        {review && !review.passed ? (
          <View className="sell__alert">
            <Image className="sell__alert-ic" src={ICONS.warnInk} mode="aspectFit" />
            <View className="sell__alert-main">
              <Text className="sell__alert-title">{`提交未通过审核（${review.fieldCount} 处需要修改）`}</Text>
              <Text className="sell__alert-desc">
                {review.title.length > 0 && review.description.length > 0
                  ? `标题含违规词，描述含 ${review.description.length} 个违规词。修改后可直接重新提交，无需重新填表。`
                  : review.title.length > 0
                    ? '标题含违规词。修改后可直接重新提交，无需重新填表。'
                    : `描述含 ${review.description.length} 个违规词。修改后可直接重新提交，无需重新填表。`}
              </Text>
            </View>
          </View>
        ) : null}

        <View className="sell__card">
          <View className="sell__field">
            <View className="sell__frow">
              <Text className="sell__label">商品图片</Text>
              <Text className="sell__fhint num">{`${photos.length} / 9 · 长按拖动可换封面`}</Text>
            </View>
            <View className="sell__photos">
              {photos.map((src, index) => (
                <View key={src} className="sell__photo">
                  <Image className="sell__photo-img" src={src} mode="aspectFill" />
                  {index === 0 ? <Text className="sell__photo-cover">封面</Text> : null}
                  <View
                    className="sell__photo-del"
                    onClick={() => setPhotos((prev) => prev.filter((item) => item !== src))}
                  >
                    <Image className="sell__photo-del-img" src={ICONS.delete} mode="aspectFit" />
                  </View>
                </View>
              ))}
              {photos.length < 9 ? (
                <View className="sell__photo sell__photo--add" onClick={pickImage}>
                  <Image className="sell__photo-add-img" src={ICONS.plusLine} mode="aspectFit" />
                </View>
              ) : null}
            </View>
          </View>

          {/* ---------------- 标题（必填，带审核错误块） ---------------- */}
          <View className="sell__field">
            <View className="sell__frow">
              <Text className="sell__label">标题</Text>
              <Text className={`sell__freq num${title.trim().length === 0 ? ' is-req' : ''}`}>
                {`必填 · ${title.length} / 30`}
              </Text>
            </View>
            <Input
              className={`sell__input${showTitleError ? ' is-err' : ''}`}
              value={title}
              maxlength={30}
              placeholder="例如：罗技 K380 无线键盘 白色"
              onInput={(event) => setTitle(event.detail.value)}
            />
            {showTitleError ? (
              <View className="sell__err">
                <Image className="sell__err-ic" src={ICONS.warnInk} mode="aspectFit" />
                <Text className="sell__err-tx">
                  标题包含违规词：
                  {highlight(title, review.title).map((part) =>
                    part.hit ? (
                      <Text key={part.key} className="sell__bad-word">
                        {part.text}
                      </Text>
                    ) : (
                      <Text key={part.key}>{part.text}</Text>
                    ),
                  )}
                  ，请修改后再发布。校园二手仅允许发布实物闲置。
                </Text>
              </View>
            ) : null}
          </View>

          {/* ---------------- 描述（AI 润色入口 + 审核错误块） ---------------- */}
          <View className="sell__field">
            <View className="sell__frow">
              <Text className="sell__label">描述</Text>
              <Text className="sell__fhint num">{`${description.length} / 500`}</Text>
            </View>
            <View className="sell__desc-wrap">
              <Input
                className={`sell__input sell__input--area${showDescError ? ' is-err' : ''}`}
                value={description}
                maxlength={500}
                placeholder="买入时间、使用情况、有无磕碰、能否自提…"
                onInput={(event) => setDescription(event.detail.value)}
              />
              <View
                className={`sell__polish${polish.phase === 'idle' ? '' : ' is-busy'}`}
                onClick={openPolish}
              >
                <Image className="sell__polish-ic" src={ICONS.ai} mode="aspectFit" />
                <Text>{polish.phase === 'loading' ? '润色中' : '润色'}</Text>
              </View>
            </View>
            {showDescError ? (
              <View className="sell__err">
                <Image className="sell__err-ic" src={ICONS.warnInk} mode="aspectFit" />
                <Text className="sell__err-tx">
                  描述包含违规词：
                  {highlight(description, review.description).map((part) =>
                    part.hit ? (
                      <Text key={part.key} className="sell__bad-word">
                        {part.text}
                      </Text>
                    ) : (
                      <Text key={part.key}>{part.text}</Text>
                    ),
                  )}
                  ，请修改后再发布。{'\n'}
                  校园二手仅允许发布实物闲置，不接受代写、代考等服务类内容。
                </Text>
              </View>
            ) : null}
          </View>

          {/* ---------------- 价格 ---------------- */}
          <View className="sell__field">
            <View className="sell__frow">
              <Text className="sell__label">价格</Text>
              <Text className="sell__fhint num">{free ? '0 元送 · 已锁定' : '可议价'}</Text>
            </View>
            <View className={`sell__price-row${free ? ' is-off' : ''}`}>
              <Text className="sell__price-cur">¥</Text>
              <Input
                className="sell__price-input"
                type="digit"
                value={free ? '0' : price}
                disabled={free}
                placeholder="0.00"
                onInput={(event) => setPrice(event.detail.value)}
              />
            </View>
            {free ? (
              <Text className="sell__pnote num">
                0 元送商品不能设置价格，领取时仍需对方扫码确认
              </Text>
            ) : null}
          </View>

          <View className="sell__field">
            <View className="sell__frow">
              <Text className="sell__label">成色</Text>
              <Text className="sell__fhint">必选</Text>
            </View>
            <View className="sell__chips">
              {CONDITIONS.map((item) => (
                <View
                  key={item.key}
                  className={`sell__chip${item.key === condition ? ' is-on' : ''}`}
                  onClick={() => setCondition(item.key)}
                >
                  <Text>{item.label}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>

        {/* ---------------- 两个角标开关：与首页卡片共用同一套角标样式 ---------------- */}
        <View className="sell__card sell__card--flags">
          <View className="sell__swrow">
            <View className="sell__swmain">
              <Text className="sell__swlab">急出</Text>
              <Text className="sell__swdesc">卡片左上角展示「急出」角标，会优先进入需求匹配</Text>
            </View>
            <View
              className={`sell__sw${urgent ? ' is-on' : ''}`}
              onClick={() => setUrgent((p) => !p)}
            >
              <View className="sell__sw-knob" />
            </View>
          </View>

          <View className="sell__swrow">
            <View className="sell__swmain">
              <Text className="sell__swlab">0 元送</Text>
              <Text className="sell__swdesc">价格按 ¥0 展示，同学可免费领取</Text>
            </View>
            <View className={`sell__sw${free ? ' is-on' : ''}`} onClick={toggleFree}>
              <View className="sell__sw-knob" />
            </View>
          </View>

          {/* 0 元送开启后议价被锁定：这是稿子第 04 帧明确画出的联动 */}
          <View className={`sell__swrow${free ? ' is-locked' : ''}`}>
            <View className="sell__swmain">
              <Text className="sell__swlab">议价</Text>
              <Text className="sell__swdesc">
                {free ? '0 元送开启后不可议价，开关已锁定' : '允许买家在会话里还价'}
              </Text>
            </View>
            <View
              className={`sell__sw${negotiable && !free ? ' is-on' : ''}`}
              onClick={() => {
                if (free) return
                setNegotiable((p) => !p)
              }}
            >
              <View className="sell__sw-knob" />
            </View>
          </View>

          {/* 角标落位预览：让「开关」与「卡片上的样子」在同一屏可见 */}
          {urgent || free ? (
            <View className="sell__badge-preview">
              <Text className="sell__badge-preview-k num">卡片角标预览</Text>
              <View className="sell__badge-thumb">
                <Image
                  className="sell__badge-thumb-img"
                  src={photos[0] ?? productImage('digital-laptop', 0)}
                  mode="aspectFill"
                />
                {/* 两个角标同时存在时上下堆叠（稿子明确要求），用一列 flex 自然实现 */}
                <View className="sell__badge-stack">
                  {urgent ? <Text className="sell__corner sell__corner--hot">急出</Text> : null}
                  {free ? <Text className="sell__corner sell__corner--free">0 元送</Text> : null}
                </View>
              </View>
              <View className="sell__badge-main">
                <Text className="sell__badge-title">{title || '标题会显示在这里'}</Text>
                <Text className="sell__badge-price num">
                  {free ? '免费领取' : `¥${price || '0.00'}`}
                </Text>
              </View>
            </View>
          ) : null}
        </View>

        <View className="sell__hint">
          <Text className="sell__hint-text">
            发布即表示你已阅读校内交易规范；违规商品会被下架（审核能力待接入）。
          </Text>
        </View>

        {review && !review.passed ? (
          <View className="sell__acts">
            <View className="sell__btn-line" onClick={() => setReview(null)}>
              <Text>存为草稿</Text>
            </View>
            <View className="sell__submit sell__submit--inline" onClick={submit}>
              <Text className="sell__submit-text">修改后重新提交</Text>
            </View>
          </View>
        ) : (
          <View className="sell__submit" onClick={submit}>
            <Image className="sell__submit-icon" src={ICONS.plus} mode="aspectFit" />
            <Text className="sell__submit-text">发布闲置</Text>
          </View>
        )}
      </View>

      {/* ---------------- AI 润色候选卡（稿子第 02 帧） ---------------- */}
      {polish.phase !== 'idle' ? (
        <>
          <View className="sell__scrim" onClick={() => setPolish({ phase: 'idle' })} />
          <View className="sell__sheet">
            <View className="sell__sheet-h">
              <Image className="sell__sheet-h-ic" src={ICONS.ai} mode="aspectFit" />
              <Text className="sell__sheet-h-tx">AI 润色建议</Text>
            </View>

            {polish.phase === 'loading' ? (
              <View className="sell__sheet-loading">
                <View className="sell__spin" />
                <Text className="sell__sheet-sub num">正在生成候选文案…</Text>
              </View>
            ) : (
              <>
                <Text className="sell__sheet-sub num">
                  {`第 ${polish.index + 1} / ${polish.candidates.length} 条 · 采用前不会覆盖你写的内容`}
                </Text>

                <View className="sell__cand">
                  <Text className="sell__cand-flag num">{`候选 ${polish.index + 1}`}</Text>
                  <Text className="sell__cand-tx">{candidate}</Text>
                </View>

                <View className="sell__origin">
                  <Text className="sell__origin-k num">你写的原文 · 采用后才会替换</Text>
                  <Text className="sell__origin-t">{description}</Text>
                </View>

                <View className="sell__sheet-acts">
                  <View className="sell__dots">
                    {polish.candidates.map((item, i) => (
                      <View
                        key={item.id}
                        className={`sell__dot${i === polish.index ? ' is-on' : ''}`}
                      />
                    ))}
                  </View>
                  <View className="sell__btn-ghost sell__btn-ghost--pill" onClick={nextCandidate}>
                    <Text>换一条</Text>
                  </View>
                  <View className="sell__btn-solid" onClick={adopt}>
                    <Text>采用</Text>
                  </View>
                </View>

                <View className="sell__sheet-acts">
                  <View
                    className="sell__btn-ghost sell__btn-ghost--pill"
                    onClick={() => setPolish({ phase: 'idle' })}
                  >
                    <Text>放弃润色</Text>
                  </View>
                </View>
              </>
            )}
          </View>
        </>
      ) : null}
    </View>
  )
}
