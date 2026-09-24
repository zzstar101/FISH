import type { AiPolishCandidate, AiPolishProvider } from '@fish/contracts/ai/schema'
import {
  type ListingCategory,
  type ListingDetail,
  MAX_LISTING_IMAGES,
} from '@fish/contracts/listings/schema'
import { Image, Input, Text, Textarea, View } from '@tarojs/components'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import { fetchPolishCandidates } from '@/features/ai/api'
import { useAuthGuard } from '@/features/auth/guard'
import { createListing, fetchListingDetail, updateListing } from '@/features/listing/api'
import { type SellDraft, takeSellHandoff } from '@/features/listing/edit-target'
import { type PickedPhoto, pickPhotos, uploadListingImage } from '@/features/upload/api'
import { cancellable } from '@/lib/cancellable'
import { isApiError } from '@/lib/request'
import { categoryLabel } from '@/mock/api'
import { productImage } from '@/mock/images'
import {
  parsePriceToCents,
  type SellFieldErrors,
  sellBlockMessage,
  sellBusyText,
  sellFieldErrorsFromDetails,
  sellSubmitOutcome,
  validateSellForm,
} from './form'
import {
  nextPolishIndex,
  POLISH_FIELD_ERROR_TOAST,
  POLISH_REDACT_NOTE,
  type PolishCooldown,
  polishButtonText,
  polishCooldownFrom,
  polishFailureRoute,
  polishFailureView,
  polishPreconditionError,
  tickPolishCooldown,
} from './polish'
import './index.scss'

/**
 * 「出物」页（设计稿 D1）。**本轮从「只能演示」改为真实写后端**（#89 sell 行 / #74）。
 *
 * 表单字段与 `listings` 写契约的 `ListingCreateInput` 一一对应
 * （title / description / priceCents / category / condition / urgent / negotiable / free / objectKeys）。
 *
 * **本轮改动**
 * 1. 图片：`Taro.chooseMedia` 选图 → 本地按契约白名单与 5MB 预校验 →
 *    presign → 直传对象存储 → confirm（`features/upload/api.ts`）。**选中即上传**：
 *    每张图带自己的「上传中 / 重传」状态，发布那一刻只剩一次 create 请求。
 * 2. 提交：`POST /listings`；编辑态走 `PATCH /listings/:id`。
 *    编辑态图片只读 —— 详情响应不给 `objectKey`，没有全量替换所需的输入（换图能力见
 *    `#165`，需要契约先向本人暴露 objectKey 或新增增删端点）。
 *    编辑目标由 `features/listing/edit-target.ts` 一次性交接（Tab 页不能带 query 跳转），
 *    在 `useDidShow` 里消费；也兼容 `?id=`（开发者工具演示 / 带参进入）。
 *    **同一条交接也承载「再次上架」**（我的发布 · 已售出）：契约没有「照成交记录另起一条在售」的
 *    端点，所以那是**新建**而不是编辑 —— 交接里带的是 `prefill` 草稿（文案字段），图片必须重选。
 * 3. 分类：契约必填而设计稿原先没有这一栏，按既有 chips 样式补了一行。
 * 4. 审核反馈：BLOCK（422 `LISTING_CONTENT_BLOCKED`）的 `details` 按字段贴到对应输入框，
 *    页头提示条说明有几处要改；**前端不再保留任何敏感词表**，判定只在服务端。
 * 5. REVIEW：商品已受理但 `status = OFFLINE`、不在公开列表 —— 留在本页显示
 *    「已提交，正在审核」，不跳详情、不显示「发布成功」。
 * 6. AI 润色接真实接口（`POST /ai/polish-candidates`，#142 / 设计 §10）：状态机补失败态、
 *    非 idle 不可点、429 按 `retryAfterSeconds` 倒计时、`provider='stub'` 显示演示角标、
 *    `redacted` 说明脱敏。判定全在 `./polish`（可测），页面只做接线。
 *
 * 明确不做（等后续单）：web 端润色入口；编辑态换图。
 */

const CONDITIONS: { key: 'NEW' | 'LIKE_NEW' | 'GOOD' | 'FAIR'; label: string }[] = [
  { key: 'NEW', label: '全新' },
  { key: 'LIKE_NEW', label: '九成新' },
  { key: 'GOOD', label: '八成新' },
  { key: 'FAIR', label: '七成新' },
]

/** 分类顺序与首页横滑一致（去掉「推荐」）。契约要求必填，所以这里没有默认值。 */
const CATEGORIES: ListingCategory[] = [
  'BOOKS',
  'DIGITAL',
  'TRANSPORT',
  'DAILY',
  'SPORTS',
  'APPAREL',
  'BEAUTY',
  'OTHER',
]

/**
 * 已选图片。`url` 是本地临时路径（预览用）；**选中即上传**，`status` 是这一张自己的上传状态。
 *
 * 每张带自己的 `id`：同一张图可以被选两次（本地路径可能相同），
 * 拿 `url` 当 key / 当删除判据会撞 key 并一次删掉两张。
 */
type SelectedPhoto = PickedPhoto & {
  id: string
  url: string
  status: 'uploading' | 'done' | 'failed'
  objectKey: string | null
  error: string | null
}

/** 编辑态加载结果。`idle` 含「新建」与「编辑内容已就绪」两种正常态。 */
type EditLoadState = 'idle' | 'loading' | 'notfound' | 'failed'

/**
 * AI 润色状态机。
 *
 * `ready` 带上 `provider` / `redacted`：它们只有响应回来才知道，角标与脱敏说明就靠它们渲染，
 * 不在页面里另存一份。`failed` 只带 `code`（429 另带秒数），文案由 `./polish` 推出来。
 */
type PolishState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | {
      phase: 'ready'
      candidates: AiPolishCandidate[]
      index: number
      provider: AiPolishProvider
      redacted: boolean
    }
  | { phase: 'failed'; code: string; retryAfterSeconds?: number }

/** 分 → 价格输入框的字符串（整数不带小数位，避免回填出 160.00）。 */
function priceToInput(priceCents: number): string {
  if (priceCents % 100 === 0) return String(priceCents / 100)
  return (priceCents / 100).toFixed(2)
}

export default function Sell() {
  // 出物是 Tab 页：Tab 页只能用 navigateTo 跳登录页（见 guard.ts 文件头）
  const authStatus = useAuthGuard({ tab: true })
  const router = useRouter()
  /** URL 上的 `?id=`（开发者工具演示 / reLaunch 等带参进入）；我的发布页走 `edit-target` 交接 */
  const routeId = router.params.id ?? null
  const [editId, setEditId] = useState<string | null>(routeId)
  const editing = editId !== null
  /**
   * 当前页面实例处于哪种模式：`null` = 新建。用它判断「这次回到出物页是不是该清掉编辑态」——
   * 不能读 `editId` state（`useDidShow` 的回调闭包可能拿到旧值）。
   */
  const modeRef = useRef<string | null>(routeId)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('')
  const [category, setCategory] = useState<ListingCategory | null>(null)
  const [condition, setCondition] = useState<(typeof CONDITIONS)[number]['key']>('LIKE_NEW')
  const [free, setFree] = useState(false)
  const [urgent, setUrgent] = useState(false)
  const [negotiable, setNegotiable] = useState(true)
  const [photos, setPhotos] = useState<SelectedPhoto[]>([])
  /** 编辑态的商品原图（只读）：详情响应只给 url，不给 objectKey，无法全量替换 */
  const [existingImages, setExistingImages] = useState<string[]>([])
  const [editState, setEditState] = useState<EditLoadState>(routeId ? 'loading' : 'idle')
  const [polish, setPolish] = useState<PolishState>({ phase: 'idle' })
  /**
   * 429 冷却：`short` 逐秒恢复；`coarse`（>60s）与 `unknown`（服务端没给秒数）都不逐秒，
   * 在本次页面生命周期内保持置灰（见 `./polish`）
   */
  const [cooldown, setCooldown] = useState<PolishCooldown | null>(null)
  /** 飞行中的润色请求：关 sheet = 放弃，迟到响应按 `cancellable` 丢弃 */
  const polishCancelRef = useRef<(() => void) | null>(null)
  /** 服务端的字段级错误（BLOCK / 422），键与输入区对应；空对象 = 没有 */
  const [fieldErrors, setFieldErrors] = useState<SellFieldErrors>({})
  /** 页头提示条：只在服务端明确拒绝时出现 */
  const [blockMessage, setBlockMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  /** 审核中的商品 id：非 null 时整页换成结果视图 */
  const [pendingReviewId, setPendingReviewId] = useState<string | null>(null)

  const toast = (text: string) => {
    void Taro.showToast({ title: text, icon: 'none' })
  }

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

  const applyDetail = (detail: ListingDetail) => {
    setTitle(detail.title)
    setDescription(detail.description)
    setFree(detail.free)
    setPrice(priceToInput(detail.priceCents))
    setCategory(detail.category)
    setCondition(detail.condition)
    setUrgent(detail.urgent)
    setNegotiable(detail.negotiable)
    setExistingImages(
      detail.images
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((image) => image.url),
    )
  }

  /**
   * 「再次上架」/「重新上架」的预填：只灌**新发布能带过去的字段**，不碰图片。
   *
   * 图片不在其中，是契约决定的：详情响应刻意不给 `objectKey`（存储布局不进读协议），
   * 而 `POST /listings` 只接受 `objectKeys`。所以这条路必须由用户重新选图 ——
   * 页面靠 `syncEditTarget` 里那句 toast 说明（「图片需要重新选择」），
   * **不能**指望图片区那行 `.sell__pnote`：它只在**编辑态**渲染（`editing` 为真时），
   * 而预填走的是新建态，用户看不到它。
   */
  const applyDraft = (draft: SellDraft) => {
    setTitle(draft.title)
    setDescription(draft.description)
    setFree(draft.free)
    setPrice(priceToInput(draft.priceCents))
    setCategory(draft.category)
    setCondition(draft.condition)
    setUrgent(draft.urgent)
    setNegotiable(draft.negotiable)
  }

  const resetForm = () => {
    setTitle('')
    setDescription('')
    setPrice('')
    setCategory(null)
    setCondition('LIKE_NEW')
    setFree(false)
    setUrgent(false)
    setNegotiable(true)
    setPhotos([])
    setExistingImages([])
    // 润色候选也属于「这一份表单」：不清的话发布成功后回到本页，新表单里还挂着上一件的候选。
    // 飞行中的请求一并作废 —— 它回来时对应的已经不是这份表单了。
    dropPolishRequest()
    setPolish({ phase: 'idle' })
    setFieldErrors({})
    setBlockMessage('')
    setPendingReviewId(null)
  }

  /** 编辑态取回原商品；404 / 非本人一律走「无法编辑」空态，不静默降级成一张空表单 */
  const loadForEdit = (id: string) => {
    setEditState('loading')
    void (async () => {
      try {
        const detail = await fetchListingDetail(id)
        if (!detail?.isOwner) {
          setEditState('notfound')
          return
        }
        applyDetail(detail)
        setEditState('idle')
      } catch {
        setEditState('failed')
      }
    })()
  }

  /**
   * 每次显示本页时决定「新建还是改某一件 / 复制某一件」。
   *
   * 用 `useDidShow` 而不是 `useLoad`：出物是 Tab 页，实例常驻，`useLoad` 只在首次创建时跑一次，
   * 之后再从「我的发布」点编辑就进不来了。`takeSellHandoff()` 取一次即失效（见该模块说明）。
   *
   * 没有待取目标时若本页还停在编辑态，必须清空回新建：否则从底栏点「出物」会把上一件商品
   * 的标题/价格当成新发布的内容。`prefill`（「再次上架」/「重新上架」）只是把字段灌进新建表单，
   * 同一段清空逻辑对它同样成立 —— 它没有自己的持久模式。
   *
   * **`prefill` 优先于 `routeId`**：交接是「用户刚刚按下的那一下」，`routeId` 却是本页实例
   * 创建时抓到的 `?id=`（Tab 页正常进不来，但一旦来了就永远是那个旧值）。
   * 若先看 `routeId`，从「我的发布」点「再次上架」会掉进**另一件商品的编辑态**，
   * 而且那份 prefill 草稿被静默丢掉。
   */
  const syncEditTarget = () => {
    const handoff = takeSellHandoff()

    if (handoff?.kind === 'prefill') {
      // 再次上架 / 重新上架：整表单重来一遍，再灌入原商品的可用字段（图片必须重选）
      modeRef.current = null
      resetForm()
      setEditId(null)
      setEditState('idle')
      applyDraft(handoff.draft)
      // 图片是空的，说一句为什么 —— 否则用户会以为原图没带过来是丢图
      toast('已带入原商品的文字信息 · 图片需要重新选择')
      return
    }

    const target = handoff?.kind === 'edit' ? handoff.listingId : routeId
    if (target === null) {
      if (modeRef.current !== null) {
        modeRef.current = null
        setEditId(null)
        setEditState('idle')
        resetForm()
      }
      return
    }
    modeRef.current = target
    setEditId(target)
    loadForEdit(target)
  }

  useDidShow(syncEditTarget)

  /**
   * 发布成功 → 商品详情。
   *
   * 先 `resetForm()` 再 `navigateTo`：这样 back 回到发布页时是一张新表单，
   * 而不是一份填过的旧内容（否则容易再点一次「发布」）。
   */
  const goDetail = (id: string) => {
    resetForm()
    void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${id}` })
  }

  /**
   * 上传一张图并回写它自己的状态。
   *
   * **选中即上传**（而不是等点发布）：发布那一刻只剩一次 create 请求，
   * 失败也早暴露在图上去重传，而不是等用户填完表单才说图片传不上去。
   * 用户在飞行途中删掉这张时，`setPhotos` 里已经找不到它 —— 更新自然变成 no-op
   * （对象存储里会留下一个没人引用的对象，可接受）。
   */
  const startUpload = (photo: SelectedPhoto) => {
    void (async () => {
      try {
        const objectKey = await uploadListingImage({
          path: photo.path,
          mime: photo.mime,
          sizeBytes: photo.sizeBytes,
        })
        setPhotos((prev) =>
          prev.map((item) =>
            item.id === photo.id ? { ...item, status: 'done', objectKey, error: null } : item,
          ),
        )
      } catch (error) {
        setPhotos((prev) =>
          prev.map((item) =>
            item.id === photo.id
              ? {
                  ...item,
                  status: 'failed',
                  error: error instanceof Error ? error.message : '上传失败，请重试',
                }
              : item,
          ),
        )
      }
    })()
  }

  const pickImage = () => {
    const remaining = MAX_LISTING_IMAGES - photos.length
    if (remaining <= 0) {
      toast(`最多上传 ${MAX_LISTING_IMAGES} 张图片`)
      return
    }
    void (async () => {
      try {
        const { photos: picked, rejected } = await pickPhotos(remaining)
        if (rejected) toast(rejected)
        if (picked.length === 0) return
        const added: SelectedPhoto[] = picked.map((photo, index) => ({
          ...photo,
          id: `pick-${Date.now()}-${index}`,
          url: photo.path,
          status: 'uploading',
          objectKey: null,
          error: null,
        }))
        setPhotos((prev) => [...prev, ...added])
        // 逐张独立上传、并行推进：任何一张失败不影响其余张
        for (const photo of added) startUpload(photo)
      } catch (error) {
        // 只有「用户取消」被 pickPhotos 吞掉；走到这里的是权限被拒 / 相机异常等真失败
        toast(error instanceof Error ? error.message : '选择图片失败，请重试')
      }
    })()
  }

  const retryUpload = (photo: SelectedPhoto) => {
    setPhotos((prev) =>
      prev.map((item) => (item.id === photo.id ? { ...item, status: 'uploading' } : item)),
    )
    startUpload(photo)
  }

  /** 服务端拒绝 → 字段级错误落位；认不出的字段不猜，退到整块提示条 */
  const handleSubmitError = (error: unknown) => {
    if (isApiError(error) && error.details && error.details.length > 0) {
      const errors = sellFieldErrorsFromDetails(error.details)
      setFieldErrors(errors)
      // 内容审核点名字段（「描述中有违规内容」）；非审核类校验退到通用文案
      setBlockMessage(
        error.code === 'LISTING_CONTENT_BLOCKED'
          ? sellBlockMessage(errors)
          : '有字段未通过校验，请检查后重试',
      )
      return
    }
    if (isApiError(error)) {
      toast(error.message || '提交失败，请稍后重试')
      return
    }
    toast(error instanceof Error ? error.message : '提交失败，请稍后重试')
  }

  const submit = () => {
    if (submitting) return
    // 选中即上传：还有没传完 / 传失败的图就先别提交，否则 create 会缺图
    if (!editing) {
      if (photos.some((photo) => photo.status === 'failed')) {
        toast('有图片上传失败，点缩略图上的「重传」')
        return
      }
      if (photos.some((photo) => photo.status === 'uploading')) {
        toast('图片还在上传，稍等一下')
        return
      }
    }
    const priceCents = parsePriceToCents(price, free)
    const imageCount = editing ? existingImages.length : photos.length
    const localError = validateSellForm({ title, description, priceCents, category, imageCount })
    if (localError) {
      toast(localError)
      return
    }
    // 类型收窄：validateSellForm 已经挡下这两个分支
    if (priceCents === null || category === null) return

    setSubmitting(true)
    setFieldErrors({})
    setBlockMessage('')
    void (async () => {
      try {
        const input = {
          title: title.trim(),
          description: description.trim(),
          priceCents,
          category,
          condition,
          urgent,
          negotiable: free ? false : negotiable,
          free,
        }
        const detail =
          editing && editId !== null
            ? // 编辑：省略 objectKeys = 保持原图
              await updateListing(editId, input)
            : await createListing({
                ...input,
                // 上面已挡下「还有图没传完/传失败」，这里的 key 必然齐全
                objectKeys: photos
                  .map((photo) => photo.objectKey)
                  .filter((key): key is string => key !== null),
              })

        if (sellSubmitOutcome(detail) === 'pending-review') {
          setPendingReviewId(detail.id)
          return
        }
        goDetail(detail.id)
      } catch (error) {
        handleSubmitError(error)
      } finally {
        setSubmitting(false)
      }
    })()
  }

  /**
   * 冷却倒计时。
   *
   * 只在 `short` 上挂定时器：`coarse`（>60s）的真实等待可能上万秒，挂一个长定时器只为把
   * 按钮从灰变亮并不划算，重进页面即复位（见 `./polish` 的 `tickPolishCooldown`）。
   * 依赖取 `kind` 而不是整个对象：后者每秒变化会让定时器每秒重建。
   */
  const cooldownKind = cooldown?.kind ?? null
  useEffect(() => {
    if (cooldownKind !== 'short') return
    const timer = setInterval(() => {
      setCooldown((prev) => (prev === null ? null : tickPolishCooldown(prev)))
    }, 1000)
    return () => clearInterval(timer)
  }, [cooldownKind])

  /** 作废飞行中的请求：关 sheet（scrim / 放弃 / 采用）都算放弃本次润色 */
  const dropPolishRequest = () => {
    polishCancelRef.current?.()
    polishCancelRef.current = null
  }

  /**
   * 失败分流（判据在 `./polish`，页面只负责落地）：
   * 401 静默交守卫、422 落字段级错误、其余进 sheet 的失败态。
   * 429 额外把入口按钮置灰倒计时 —— 不置灰的话用户会一直点，每次都吃一次拒绝。
   */
  const handlePolishFailure = (error: unknown) => {
    if (!isApiError(error)) {
      // 传输层失败 / 契约漂移。演示构建的传输层失败已在 `features/ai/api.ts` 换成 mock 响应，
      // 所以走到这里的都是「真失败」，必须显式报错。
      setPolish({ phase: 'failed', code: '' })
      return
    }
    const route = polishFailureRoute(error)
    if (route === 'unauthenticated') {
      // 会话已失效：`apiRequest` 清了本地会话，`useAuthGuard` 会跳登录页。
      // 这里再弹一句失败提示只会与跳转打架。
      setPolish({ phase: 'idle' })
      return
    }
    if (route === 'field-errors') {
      const errors = sellFieldErrorsFromDetails(error.details)
      if (Object.keys(errors).length === 0) {
        // 一个字段都认不出来（信封没带 details / 字段名不在映射里）：关掉 sheet 就只剩一句
        // 指向空的 toast（说你有错，却满屏找不到标红的地方），所以留在 sheet 里说清楚。
        setPolish({ phase: 'failed', code: error.code })
        return
      }
      setFieldErrors(errors)
      setPolish({ phase: 'idle' })
      toast(POLISH_FIELD_ERROR_TOAST)
      return
    }
    if (error.code === 'AI_POLISH_QUOTA') setCooldown(polishCooldownFrom(error.retryAfterSeconds))
    setPolish({ phase: 'failed', code: error.code, retryAfterSeconds: error.retryAfterSeconds })
  }

  /** 真正发请求。前置校验与守卫在 `openPolish`，失败态的「重试」直接进这里。 */
  const requestPolish = (selectedCategory: ListingCategory) => {
    dropPolishRequest()
    setPolish({ phase: 'loading' })
    // 关 sheet 即 `cancel()`；`accept` 恒真 —— 这次的结果只要没被取消就该用，不按内容过滤
    const load = cancellable(
      () =>
        fetchPolishCandidates({
          title: title.trim(),
          description: description.trim(),
          category: selectedCategory,
        }),
      () => true,
    )
    polishCancelRef.current = load.cancel
    void load.promise
      .then((response) => {
        // `null` = 已被取消（用户关了 sheet）：迟到的候选不再把弹层拉回来
        if (!response || load.isCancelled()) return
        polishCancelRef.current = null
        setPolish({
          phase: 'ready',
          candidates: response.candidates,
          index: 0,
          provider: response.provider,
          redacted: response.redacted,
        })
      })
      .catch((error: unknown) => {
        if (load.isCancelled()) return
        polishCancelRef.current = null
        handlePolishFailure(error)
      })
  }

  /** 关 sheet：作废飞行中的请求并复位状态机（采用 / 放弃 / 点遮罩都走它） */
  const closeSheet = () => {
    dropPolishRequest()
    setPolish({ phase: 'idle' })
  }

  /**
   * 开润色。
   *
   * 两道前置：**非 idle 不可点**（接真接口后每次点击都吃一次 5s 配额，连点必 429），
   * 以及本地先拦不齐的入参（标题 / 分类 / 描述都会被服务端独立拒掉，这里只是少打一次
   * 注定 422 的请求）。冷却中同样不可点。
   */
  const openPolish = () => {
    if (polish.phase !== 'idle' || cooldown !== null) return
    const localError = polishPreconditionError({ title, description, category })
    if (localError) {
      toast(localError)
      return
    }
    if (!category) return
    requestPolish(category)
  }

  const retryPolish = () => {
    if (!category) return
    requestPolish(category)
  }

  const nextCandidate = () => {
    setPolish((prev) => {
      if (prev.phase !== 'ready') return prev
      return { ...prev, index: nextPolishIndex(prev.index, prev.candidates.length) }
    })
  }

  /**
   * 采用：**这一步才**写进描述框（采用前原文一直原样保留）。
   *
   * 不推断审核结论：采用后的真实语义是保存时服务端重跑 moderation（`PATCH /listings/:id`）。
   * 也不去清上一次提交留下的字段级错误 / 页头提示条 —— 手动改描述框同样不会清，
   * 那是「改完再提交一次」的既有口径，不是本单引入的。
   */
  const adopt = () => {
    if (polish.phase !== 'ready') return
    const text = polish.candidates[polish.index]?.text
    if (text) setDescription(text)
    closeSheet()
    toast('已采用润色文案')
  }

  const candidate = polish.phase === 'ready' ? (polish.candidates[polish.index]?.text ?? '') : ''

  /**
   * 失败态的内容。
   *
   * 抽成函数而不是在 JSX 里读一个 `failureView` 变量：变量之间收窄不了，
   * 而这里要按 `polish.phase === 'failed'` 让 TS 认下 `code` / `retryAfterSeconds`。
   */
  const renderPolishFailure = (state: { code: string; retryAfterSeconds?: number }) => {
    const view = polishFailureView(state.code, state.retryAfterSeconds)
    return (
      <>
        <Text className="sell__sheet-sub">{view.message}</Text>
        {view.detail ? <Text className="sell__sheet-fail-detail">{view.detail}</Text> : null}

        <View className="sell__sheet-acts">
          {/* 429 不给「重试」：冷却中再点只会再吃一次拒绝（见 ./polish 的 canRetry） */}
          {view.canRetry ? (
            <View className="sell__btn-ghost sell__btn-ghost--pill" onClick={retryPolish}>
              <Text>重试</Text>
            </View>
          ) : null}
          <View className="sell__btn-ghost sell__btn-ghost--pill" onClick={closeSheet}>
            <Text>关闭</Text>
          </View>
        </View>
      </>
    )
  }

  const titleError = fieldErrors.title
  const descriptionError = fieldErrors.description
  const priceError = fieldErrors.price
  const imagesError = fieldErrors.images
  const categoryError = fieldErrors.category
  /** 有图没传上去：提交会被挡下，所以这里要给出可操作的提示 */
  const hasUploadFailure = !editing && photos.some((photo) => photo.status === 'failed')

  /**
   * 未登录 / 登录态未就绪：守卫在跳转，这里同时**拦住渲染**。
   * 本页写操作必须带会话，不拦的话跳转落地前会先画一帧空表单。
   */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  /** 审核中：已受理但不在公开列表，留在本页把话说清楚（不跳详情、不说「发布成功」） */
  if (pendingReviewId !== null) {
    return (
      <View className="sell">
        <View className="sell__hero-bg" />
        <TopBar back variant="glass" spacer title="发" titleEm="闲置" />
        <View className="sell__body">
          <View className="sell__result">
            <View className="sell__result-badge">
              <Image className="sell__result-ic" src={ICONS.warnInk} mode="aspectFit" />
            </View>
            <Text className="sell__result-title">已提交，正在审核</Text>
            <Text className="sell__result-text">
              这件闲置需要人工复核，通过后才会出现在首页与搜索里。审核期间它停在「我的发布 ·
              已下架」里，通过后会自动回到「在售」。
            </Text>
            <View
              className="sell__submit"
              onClick={() => {
                void Taro.navigateTo({ url: '/pages/mylist/index' })
              }}
            >
              <Text className="sell__submit-text">去「我的发布」看看</Text>
            </View>
            <View className="sell__btn-line" onClick={resetForm}>
              <Text>继续发布</Text>
            </View>
          </View>
        </View>
      </View>
    )
  }

  if (editing && editState !== 'idle') {
    return (
      <View className="sell">
        <View className="sell__hero-bg" />
        <TopBar back variant="glass" spacer title="编" titleEm="闲置" />
        <View className="sell__body">
          {editState === 'loading' ? (
            <View className="sell__head">
              <Text className="sell__kicker num">闲置出手</Text>
              <Text className="sell__title">正在加载商品…</Text>
            </View>
          ) : editState === 'notfound' ? (
            <EmptyState
              actionText="返回"
              onAction={() => {
                void Taro.navigateBack()
              }}
              text="找不到这件闲置,可能已被下架或删除"
              title="无法编辑"
            />
          ) : (
            <LoadError
              onRetry={() => {
                if (editId !== null) loadForEdit(editId)
              }}
              text="商品加载失败,请重试"
            />
          )}
        </View>
      </View>
    )
  }

  return (
    <View className="sell">
      <View className="sell__hero-bg" />
      {/* 本页不渲染底栏（见 custom-tab-bar 的 HIDDEN_ROUTE），返回钮是唯一出口 */}
      {/* 页名大字跟其它页面顶栏同款：前段黑 + 尾段品牌蓝，跟在返回钮右边不居中 */}
      <TopBar back variant="glass" spacer title={editing ? '编' : '发'} titleEm="闲置" />

      <View className="sell__body">
        <View className="sell__head">
          <Text className="sell__kicker num">{editing ? '编辑闲置' : '闲置出手'}</Text>
          <Text className="sell__title">{editing ? '修改这件闲置' : '发布一件闲置'}</Text>
          <Text className="sell__sub">
            {blockMessage
              ? '修改标红的字段后可以重新提交，已上传的图片不会丢'
              : '只在本校范围内交易 · 面交时用交易码确认'}
          </Text>
        </View>

        {/* 服务端拒绝的整块提示：字段细节贴在各输入框下方，这里只说有几处要改 */}
        {blockMessage ? (
          <View className="sell__alert">
            <Image className="sell__alert-ic" src={ICONS.warnInk} mode="aspectFit" />
            <View className="sell__alert-main">
              <Text className="sell__alert-title">{blockMessage}</Text>
              <Text className="sell__alert-desc">
                按标红字段修改后可直接重新提交，已上传的图片不会丢。
              </Text>
            </View>
          </View>
        ) : null}

        <View className="sell__card">
          <View className="sell__field">
            <View className="sell__frow">
              <Text className="sell__label">商品图片</Text>
              <Text className="sell__fhint num">
                {editing
                  ? `${existingImages.length} 张 · 编辑时不可更换`
                  : `${photos.length} / ${MAX_LISTING_IMAGES} · 第一张为封面`}
              </Text>
            </View>
            {editing ? (
              <>
                <View className="sell__photos">
                  {existingImages.map((url, index) => (
                    <View key={url} className="sell__photo">
                      <Image className="sell__photo-img" src={url} mode="aspectFill" />
                      {index === 0 ? <Text className="sell__photo-cover">封面</Text> : null}
                    </View>
                  ))}
                </View>
                <Text className="sell__pnote num">图片暂不支持修改；需要换图请下架后重新发布</Text>
              </>
            ) : (
              <>
                <View className="sell__photos">
                  {photos.map((photo, index) => (
                    <View key={photo.id} className="sell__photo">
                      <Image className="sell__photo-img" src={photo.url} mode="aspectFill" />
                      {index === 0 ? <Text className="sell__photo-cover">封面</Text> : null}
                      {photo.status === 'done' ? null : (
                        <Text
                          className={`sell__photo-flag${photo.status === 'failed' ? ' is-err' : ''}`}
                          onClick={photo.status === 'failed' ? () => retryUpload(photo) : undefined}
                        >
                          {photo.status === 'failed' ? '重传' : '上传中'}
                        </Text>
                      )}
                      <View
                        className="sell__photo-del"
                        onClick={() =>
                          setPhotos((prev) => prev.filter((item) => item.id !== photo.id))
                        }
                      >
                        <Image
                          className="sell__photo-del-img"
                          src={ICONS.delete}
                          mode="aspectFit"
                        />
                      </View>
                    </View>
                  ))}
                  {photos.length < MAX_LISTING_IMAGES ? (
                    <View className="sell__photo sell__photo--add" onClick={pickImage}>
                      <Image
                        className="sell__photo-add-img"
                        src={ICONS.plusLine}
                        mode="aspectFit"
                      />
                    </View>
                  ) : null}
                </View>
                {imagesError ? (
                  <View className="sell__err">
                    <Image className="sell__err-ic" src={ICONS.warnInk} mode="aspectFit" />
                    <Text className="sell__err-tx">{imagesError}</Text>
                  </View>
                ) : hasUploadFailure ? (
                  <View className="sell__err">
                    <Image className="sell__err-ic" src={ICONS.warnInk} mode="aspectFit" />
                    <Text className="sell__err-tx">
                      有图片上传失败，点缩略图上的「重传」再发布。
                    </Text>
                  </View>
                ) : (
                  <Text className="sell__pnote num">支持 JPG / PNG / WebP，单张不超过 5MB</Text>
                )}
              </>
            )}
          </View>

          {/* ---------------- 标题（必填，带服务端字段级错误块） ---------------- */}
          <View className="sell__field">
            <View className="sell__frow">
              <Text className="sell__label">标题</Text>
              <Text className={`sell__freq num${title.trim().length === 0 ? ' is-req' : ''}`}>
                {`必填 · ${title.length} / 30`}
              </Text>
            </View>
            <Input
              className={`sell__input${titleError ? ' is-err' : ''}`}
              value={title}
              maxlength={30}
              placeholder="例如：罗技 K380 无线键盘 白色"
              onInput={(event) => setTitle(event.detail.value)}
            />
            {titleError ? (
              <View className="sell__err">
                <Image className="sell__err-ic" src={ICONS.warnInk} mode="aspectFit" />
                <Text className="sell__err-tx">{`${titleError}，请修改后再发布。`}</Text>
              </View>
            ) : null}
          </View>

          {/* ---------------- 描述（AI 润色入口 + 服务端字段级错误块） ---------------- */}
          <View className="sell__field">
            <View className="sell__frow">
              <Text className="sell__label">描述</Text>
              <Text className="sell__fhint num">{`${description.length} / 500`}</Text>
            </View>
            <View className="sell__desc-wrap">
              {/* Textarea（不是 Input）：多行输入贴左上排，超框自动换行；Input 是单行、居中且横向滚 */}
              <Textarea
                className={`sell__input sell__input--area${descriptionError ? ' is-err' : ''}`}
                value={description}
                maxlength={500}
                disableDefaultPadding
                placeholder="买入时间、使用情况、有无磕碰、能否自提…"
                onInput={(event) => setDescription(event.detail.value)}
              />
              <View
                className={`sell__polish${polish.phase === 'idle' ? '' : ' is-busy'}${
                  cooldown === null ? '' : ' is-off'
                }`}
                onClick={openPolish}
              >
                <Image className="sell__polish-ic" src={ICONS.ai} mode="aspectFit" />
                <Text>{polishButtonText({ loading: polish.phase === 'loading', cooldown })}</Text>
              </View>
            </View>
            {descriptionError ? (
              <View className="sell__err">
                <Image className="sell__err-ic" src={ICONS.warnInk} mode="aspectFit" />
                <Text className="sell__err-tx">{`${descriptionError}，请修改后再发布。`}</Text>
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
            {priceError ? (
              <View className="sell__err">
                <Image className="sell__err-ic" src={ICONS.warnInk} mode="aspectFit" />
                <Text className="sell__err-tx">{priceError}</Text>
              </View>
            ) : null}
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

          {/* 分类是契约的必填字段（首页分类筛选与匹配都靠它），设计稿原先没有这一栏 */}
          <View className="sell__field">
            <View className="sell__frow">
              <Text className="sell__label">分类</Text>
              <Text className={`sell__freq${category === null ? ' is-req' : ''}`}>
                {category === null ? '必选' : categoryLabel(category)}
              </Text>
            </View>
            <View className="sell__chips">
              {CATEGORIES.map((item) => (
                <View
                  key={item}
                  className={`sell__chip${item === category ? ' is-on' : ''}`}
                  onClick={() => setCategory(item)}
                >
                  <Text>{categoryLabel(item)}</Text>
                </View>
              ))}
            </View>
            {categoryError ? (
              <View className="sell__err">
                <Image className="sell__err-ic" src={ICONS.warnInk} mode="aspectFit" />
                <Text className="sell__err-tx">{categoryError}</Text>
              </View>
            ) : null}
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
                  src={photos[0]?.url ?? productImage('digital-laptop', 0)}
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
            发布即表示你已阅读校内交易规范；违规商品会被下架，审核结果会在「我的发布」里显示。
          </Text>
        </View>

        <View className="sell__submit" onClick={submit}>
          {submitting ? null : (
            <Image className="sell__submit-icon" src={ICONS.plus} mode="aspectFit" />
          )}
          <Text className="sell__submit-text">
            {submitting
              ? editing
                ? '保存中…'
                : '发布中…'
              : blockMessage
                ? '修改后重新提交'
                : editing
                  ? '保存修改'
                  : '发布闲置'}
          </Text>
        </View>
      </View>

      {/*
        提交（create / PATCH）期间盖住整页：`submit` 在点击那一刻就捕获了表单快照，
        飞行途中若还能改价改文案，提交上去的内容与屏幕上看到的就不是一回事。
        图片是**选中即上传**的，这里的等待通常只有一次请求那么短。
      */}
      {submitting ? (
        <View className="sell__busy">
          <View className="sell__busy-card">
            <View className="sell__spin" />
            <Text className="sell__busy-text">{sellBusyText({ editing })}</Text>
          </View>
        </View>
      ) : null}

      {/* ---------------- AI 润色候选卡（稿子第 02 帧） ---------------- */}
      {polish.phase !== 'idle' ? (
        <>
          <View className="sell__scrim" onClick={closeSheet} />
          <View className="sell__sheet">
            <View className="sell__sheet-h">
              <Image className="sell__sheet-h-ic" src={ICONS.ai} mode="aspectFit" />
              <Text className="sell__sheet-h-tx">AI 润色建议</Text>
            </View>

            {/* 上游是假模型（stub 传输 / 演示构建的兜底）：不能让候选被当成真实润色结果 */}
            {polish.phase === 'ready' && polish.provider === 'stub' ? (
              <View className="sell__sheet-stub">
                <Text className="sell__sheet-stub-tx">演示文案·非真实模型</Text>
              </View>
            ) : null}

            {polish.phase === 'loading' ? (
              <View className="sell__sheet-loading">
                <View className="sell__spin" />
                <Text className="sell__sheet-sub num">正在生成候选文案…</Text>
              </View>
            ) : polish.phase === 'failed' ? (
              renderPolishFailure(polish)
            ) : (
              <>
                <Text className="sell__sheet-sub num">
                  {`第 ${polish.index + 1} / ${polish.candidates.length} 条 · 采用前不会覆盖你写的内容`}
                </Text>

                {/* 送上游前命中过脱敏规则。文案只说「发送前处理过」，不说「最终没有联系方式」——
                    回填会把用户原文还原，候选里照样可能有他写过的号码 */}
                {polish.redacted ? (
                  <Text className="sell__sheet-redact">{POLISH_REDACT_NOTE}</Text>
                ) : null}

                <View className="sell__cand">
                  <Text className="sell__cand-flag num">{`候选 ${polish.index + 1}`}</Text>
                  <Text className="sell__cand-tx">{candidate}</Text>
                </View>

                <View className="sell__origin">
                  <Text className="sell__origin-k num">你写的原文 · 采用后才会替换</Text>
                  <Text className="sell__origin-t">{description}</Text>
                </View>

                <View className="sell__sheet-acts">
                  {/* dot 按真实条数渲染：服务端会过滤候选，不足 3 条时不为凑数造假 */}
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
                  <View className="sell__btn-ghost sell__btn-ghost--pill" onClick={closeSheet}>
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
