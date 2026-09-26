import type { PublicUserProfile } from '@fish/contracts/users/schema'
import { Image, ScrollView, Text, View } from '@tarojs/components'
import type { ScrollViewProps } from '@tarojs/components/types/ScrollView'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import NavBar from '@/components/nav-bar'
import { useAuth } from '@/features/auth/store'
import { loadPublicUserHome, MOCK_FALLBACK_ENABLED } from '@/features/fetchers'
import { signatureFirstLine } from '@/features/profile/signature-text'
import { DEMO_SIGNATURES, DEMO_USER_IDS } from '@/features/user/demo-signatures'
import { readNavMetrics } from '@/lib/nav-metrics'
import { formatAmount, type MockListing } from '@/mock/api'
import { userListEnd } from './list-end'
import './index.scss'

/**
 * 他人主页（设计稿 `D:\Downloads\1改\小程序1版user.html`）。
 *
 * **隐私硬规则**（沿用 C2 稿 04 帧的「公开信息边界」，1版稿注解 ⑤ 同口径）：公开页只展示
 * 头像 / 昵称 / 认证徽章 / 个性签名 / 在售数 / 卖出数；
 * **不展示**邮箱、学号、班级、真实姓名、校区。未认证时不占位、不留白（徽章整块不渲染）。
 *
 * **数据来源（#122）**：`GET /users/:userId/public` + `GET /users/:userId/listings`
 * （`@fish/contracts/users/routes`），两个端点匿名可读。页面只渲染契约真有的字段：
 *
 * - **个性签名（稿 `.psign`）：展示样式与演示态已就绪，真实字段接线待 #179**。
 *   契约 `PublicUserProfileSchema` 没有 signature 字段（原 #143 已 CLOSED/NOT_PLANNED
 *   并入 #86），后端三层都没有，所以本页**没有** `profile.signature` 可读 —— 下面那个
 *   `signatureText` 只取演示注入表，后端将来加上字段也不会自动显示，需要一次接线改动。
 *   **演示态（Owner 拍板「mock 先行」）**：页内从 `features/user/demo-signatures.ts` 取
 *   （按真实 uuid 分键、不落契约、不落 DB、不读本机存储）；真实构建或非演示账号下
 *   **这一行不渲染、不留白**。⚠️ 不能读本机存储来顶：`features/profile/signature.ts`
 *   的键按**本人 id** 分，本机只有当前登录用户自己的签名，读出来给别人看是错的。
 * - **校区不渲染（#86 F：已从产品整体移除）**：2026-09-22 产品冻结「不采集、不公开校区」，
 *   `users.campus` 列与所有契约字段（`Me` / `ListingSeller` / `PublicUserProfile`）已删除，
 *   本页没有任何 campus 数据可读，也不会显示「XX校区」。
 * - **在售列表只有一页**（`PAGE_SIZE = 50`），终点提示按「服务端游标 + 真总数」判定，
 *   不能只看条数就说「已经到底了」（见 `./list-end.ts`）。
 * - **好评率不渲染**：仓库没有 reviews / ratings 表，没有真实口径 —— 恒显 `--`，
 *   不编一个百分比（稿里的 98% / 100% 是演示数据，不照抄）。
 * - **卖出数**用契约的 `soldCount`（已完成交易里 TA 是卖家的条数）。
 * - **「加入 N 天」按稿不展示**（被签名行替换；签名缺字段时不额外补回）。
 *
 * **页面结构（1版稿取舍 ②）**：昵称区跟着内容滚走，导航条常驻但初始透明 ——
 * 下滑过阈值起变玻璃底，**昵称 + 徽章整行滚出视野后**才把「昵称 + 徽章」淡入成
 * 居中标题（`NavBar` 的 `glass` / `titleAlign="center"`，组件默认渲染与旧版逐像素一致）。
 *
 * **本页范围内的取舍（Owner 拍板）**：
 * - **关注钮：演示态**（2026-09-22 二次拍板 —— 稿里那颗三态钮要还原可见）。关注关系
 *   没有 follows 表（契约 `users/schema.ts` 注释明确「#122 明确不做」），所以按钮只有
 *   组件内状态、无数据面、生产构建不渲染，真实现归属后续「我的关注」页 + 后端 follows 域；
 *   详见 `followState` 处的注释。
 * - **聊一聊 / 更多钮不做**：发起会话要带 `listingId`（Chat 契约按 `(listingId, 买家)`
 *   复用会话），主页没有商品上下文；「更多」钮按稿 ① 删掉（分享 / 黑名单等真机里走
 *   微信胶囊的 ··· 菜单 —— 那是稿的取舍）。举报一度只有胶囊菜单、没有站内出口；
 *   现在列表终点下有「举报用户」行进 `pages/report-user`（#252，原因枚举对齐后端
 *   Draft PR #231/#240/#241；main 仍没有 Report 契约，页面按演示/如实缺口双档实现）。
 * - **不做下拉刷新**（稿的 `.refresher` 不实现）。
 */
export default function UserHome() {
  const router = useRouter<{ id?: string }>()
  /**
   * 路径参数就是这个页面的唯一输入。**没有兜底值**：mock 时代那句
   * `?? 'u-lin'` 在真实接口下等于"随手挑一个真实用户给访客看"，
   * 缺 id 一律进 notFound 态（见下面的 `load`）。
   */
  const userId = router.params.id ?? ''
  /** 当前登录账号：只用来识别「这是不是本人主页」（本人不显示举报入口） */
  const { user: authedUser } = useAuth()
  const isSelf = authedUser !== null && authedUser.id === userId

  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'notFound' | 'failed'>('loading')
  const [profile, setProfile] = useState<PublicUserProfile | null>(null)
  const [items, setItems] = useState<MockListing[]>([])
  /** 服务端游标说还有下一页（契约 `nextCursor !== null`）；本页不翻页，但这决定终点怎么说 */
  const [hasMore, setHasMore] = useState(false)

  const load = useCallback(async () => {
    // 重试先清残留：上一轮的 notFound / failed 终态与旧数据不能带进新一轮加载。
    setLoadState('loading')
    setProfile(null)
    setItems([])
    setHasMore(false)
    /**
     * 顶栏两态也要跟着复位。失败态会把 `ScrollView` 整块卸载（改渲染 `LoadError`），
     * 重试时它是**新挂载**的、`scrollTop` 回到 0，而 `glassOn` / `titled` 是页面级
     * state、会留着上一轮的值 —— 不复位就会出现「停在页顶却顶着玻璃底和居中标题」。
     */
    setGlassOn(false)
    setTitled(false)

    if (userId === '') {
      // 没有 id 就没有"这个人"，不猜测是谁。
      setLoadState('notFound')
      return
    }

    const result = await loadPublicUserHome(userId)
    if (result.status !== 'ok') {
      setLoadState(result.status)
      return
    }
    setProfile(result.profile)
    setItems(result.listings)
    setHasMore(result.hasMore)
    setLoadState('ok')
  }, [userId])

  const [left, right] = useMemo(() => {
    const l: MockListing[] = []
    const r: MockListing[] = []
    items.forEach((item, i) => {
      if (i % 2 === 0) l.push(item)
      else r.push(item)
    })
    return [l, r]
  }, [items])

  /**
   * 顶栏滚动联动（稿 `syncNav` 的两段阈值，`onScroll` 的 `scrollTop` 是**设备 px**，
   * 不 ×2 —— 与 `usePageScroll` 同口径，先例注释 `pages/chat/index.tsx`）：
   *
   * 1. **玻璃底**：下滑过 `GLASS_AT` 起导航条变玻璃（稿 40pt 口径，设备 px）；
   * 2. **居中标题**：身份区（昵称行 + 签名）整体滚出滚动口上沿后才淡入。
   *    稿用 `getBoundingClientRect()` 逐帧比对，scroll-view 里逐帧测量会掉帧；
   *    改为数据到位后量一次「身份区底边」相对滚动内容的偏移，滚动时只做数值比较
   *    （先例：`pages/home/index.tsx` 的 `pinAt` —— 量一次 + 滚动量补偿）。
   */
  const GLASS_AT = 40
  const [glassOn, setGlassOn] = useState(false)
  const [titled, setTitled] = useState(false)
  /** 身份区底边相对**滚动内容顶部**的偏移；数据/签名展开态变化后重量 */
  const identityBottomAt = useRef(Number.POSITIVE_INFINITY)
  /**
   * 当前滚动量（内容 px）。两个用途：
   * - 量取时把 `boundingClientRect` 的**视口坐标**换成**内容坐标**（补偿滚动，
   *   否则「先在骨架屏上滚了一段、数据才到」量出来的偏移会少一截）；
   * - 重量之后就地重算标题态，不让标题等到下一次滚动事件才纠正。
   */
  const scrollTopRef = useRef(0)
  /**
   * 导航条总高（状态栏 + 内容行，**设备 px**，见 `nav-metrics.ts`）：
   * 给 `.uhome__topbg` 行内定高用 —— 定色带必须正好铺到导航条下沿，
   * 写死样式表数值会在大状态栏机型上让接缝错位。
   */
  const navMetrics = useMemo(() => readNavMetrics(), [])
  const navTotalHeight = navMetrics.totalHeight
  /**
   * 身份区顶到导航条以下的距离，**设备 px**（行内 px 不经 pxtransform，见 `nav-metrics.ts`）。
   *
   * 稿里导航条**在流内**（状态栏 + 导航行共 87pt），`.headblock{padding-top:6pt}` +
   * `.profile{margin-top:8pt}` 把头像行推到导航条下沿再往下 14pt。本页导航条是绝对定位的
   * 覆盖层、滚动区从 y=0 起，所以要自己让出导航条总高；`.uhome__headblock` 已有那 6pt
   * （12px）上内边距，这里只补剩下的 8pt（16px）。
   */
  const identityTopGap = navTotalHeight + 16

  /** 滚动事件很密：值没变就还同一个值，React 会跳过这轮渲染（先例：home 的 `setCatsPinned`） */
  const onScroll = useCallback((e: { detail: ScrollViewProps.onScrollDetail }) => {
    const st = e.detail.scrollTop
    scrollTopRef.current = st
    const nextGlass = st > GLASS_AT
    setGlassOn((prev) => (prev === nextGlass ? prev : nextGlass))
    // 标题要等身份区整行（含签名）滚出上沿才出现；留 6px 提前量与稿一致（稿 `+6`）
    const nextTitled = st >= identityBottomAt.current - 6
    setTitled((prev) => (prev === nextTitled ? prev : nextTitled))
  }, [])

  /**
   * 量一次身份区底边，换算成**内容坐标**。
   *
   * `boundingClientRect` 给的是**视口坐标**，必须加上当时的滚动量才是它在滚动内容里的
   * 位置。不补偿就会漏掉「先在骨架屏上滚了一段、数据随后才到」这一档：那时视口坐标比
   * 内容坐标小一整个 `scrollTop`，算出的阈值偏小，标题会在昵称还看得见时就冒出来。
   *
   * **量的节点是签名行（没有签名时退回头像行）**，与稿 `syncNav` 同一口径
   * （`p = $('psign'); if (!p || !p.offsetHeight) p = $('profile')`）—— 稿的判据是
   * 「身份块整行滚干净才补标题」，签名行是身份块的最后一行；量到数据行（`.uhome__stats`）
   * 底边会让标题整整晚一行才出现。
   *
   * 量不到（节点未上屏 / 选择器失效）时兜底 `IDENTITY_FALLBACK`：与 home 页的 `pinAt`
   * 兜底同理 —— 不给兜底会变成「标题永远不出现」，给个偏大的估计值最多让标题晚一点
   * 淡入（页头真实高度 ≈ 导航条 91 + 身份区上边距 152 + 头像行 83 + 签名行 ≈ 40，
   * 按设备 px 约 320+）。
   *
   * 量完**就地重算标题态**：长签名展开 / 收起会改变身份区高度（实测折叠 20px → 展开
   * 40px），阈值跟着变；等下一次滚动事件才纠正的话，用户会看到标题「多留」或「早退」
   * 一段。这里直接把当前的 `scrollTop` 拿去比对，不依赖后续事件。
   */
  const IDENTITY_FALLBACK = 320
  const measureIdentity = useCallback(() => {
    void Taro.nextTick(() => {
      Taro.createSelectorQuery()
        .select('#uhome-psign')
        .boundingClientRect()
        .select('#uhome-profile')
        .boundingClientRect()
        .exec((res) => {
          /** 节点在屏且真有高度才算数（`height === 0` 说明它没渲染 / 被裁） */
          const pick = (i: number): { top: number; height: number } | undefined => {
            const rect = res?.[i] as { top?: number; height?: number } | undefined
            const { top, height } = rect ?? {}
            if (typeof top !== 'number' || typeof height !== 'number' || height <= 0)
              return undefined
            return { top, height }
          }
          // 签名行缺失（无签名的用户）时退回头像行，与稿一致
          const rect = pick(0) ?? pick(1)
          identityBottomAt.current = rect
            ? rect.top + scrollTopRef.current + rect.height
            : IDENTITY_FALLBACK
          const nextTitled = scrollTopRef.current >= identityBottomAt.current - 6
          setTitled((prev) => (prev === nextTitled ? prev : nextTitled))
        })
    })
  }, [])

  useLoad(() => {
    void load()
  })

  const card = (item: MockListing) => (
    <View
      key={item.id}
      className="uhome__card"
      onClick={() => void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${item.id}` })}
    >
      <View className="uhome__img">
        <Image className="uhome__img-real" src={item.coverUrl} mode="aspectFill" />
        {item.free ? (
          <Text className="uhome__corner uhome__corner--free">0 元送</Text>
        ) : item.urgent ? (
          <Text className="uhome__corner uhome__corner--hot">急出</Text>
        ) : null}
      </View>
      <View className="uhome__pbody">
        <Text className="uhome__ptitle">{item.title}</Text>
        <View className="uhome__pmeta">
          <Text className="uhome__pprice num">¥{formatAmount(item.priceCents)}</Text>
          {item.originalPriceCents ? (
            <Text className="uhome__porig num">¥{formatAmount(item.originalPriceCents)}</Text>
          ) : null}
        </View>
        <View className="uhome__pfoot">
          {/* 契约没有「想要」计数：真实数据下为 null，连分隔点一起不画，避免出现孤立的分隔符 */}
          {item.wants === null ? null : (
            <>
              <Text className="uhome__pwant num">想要 {item.wants}</Text>
              <View className="uhome__dot" />
            </>
          )}
          <Text className="uhome__ptime">{`${Math.floor(item.createdHoursAgo / 24)} 天前`}</Text>
        </View>
      </View>
    </View>
  )

  const verified = profile?.authStatus === 'VERIFIED'

  /**
   * 列表终点判定（纯函数，用例见 `tests/user-list-end.test.ts`）。
   *
   * 「已经到底了」要两个信号同时点头：服务端游标说没有下一页，且这份列表条数不少于
   * 服务端报的在售真总数 `activeCount`。任一条不成立就改说「仅显示最近 N 件」——
   * 单看条数会在超过单页上限（50）时把「还有没展示的」说成「TA 就这些」。
   * `profile` 还没到（加载中）时 `shown` 恒为 0，判定自然是 `none`，不提前下结论。
   */
  const end = userListEnd(items.length, profile?.activeCount ?? 0, hasMore)

  /**
   * 演示内容的**唯一闸门**：演示构建 + 页主是演示账号（seed 三号之一，见
   * `features/user/demo-signatures.ts`）。假签名、假关注钮、骨架里的签名占位都挂在它上面。
   *
   * ⚠️ 只判 `MOCK_FALLBACK_ENABLED` 不够：它在 `NODE_ENV === 'development'` 下也为真
   * （`config/index.ts`），而 `bun run dev:weapp` 是连真后端的 —— 那样每张真实用户主页
   * 都会长出假的关注钮和「已关注（演示）」toast。所以再加一层真实 uuid 白名单。
   *
   * 判据用**路由参数 `userId`** 而不是 `profile.id`：骨架屏阶段 profile 还没到，
   * 而骨架里要不要留签名行占位也取决于同一条判据（留了才不跳高）。
   */
  const isDemoUser = MOCK_FALLBACK_ENABLED && DEMO_USER_IDS.includes(userId)

  /**
   * 签名展示口径（与「我的」页一致）：
   * - 只对演示账号取演示注入表（Owner 拍板 mock 先行）；其它人 / 真实构建 →
   *   `undefined`，签名行整行不渲染、不留白。
   * - 只取首行（`signatureFirstLine`），折叠成单行省略号。
   */
  const signatureText = useMemo(() => {
    const raw = DEMO_SIGNATURES[userId]
    return isDemoUser && raw ? signatureFirstLine(raw) : ''
  }, [isDemoUser, userId])

  /** 折叠态是否真被截断：`false` 时点击不展开、箭头不渲染（稿 `.has-more` 判定） */
  const [signHasMore, setSignHasMore] = useState(false)
  const [signOpen, setSignOpen] = useState(false)

  /**
   * 关注按钮（稿 `.btn-follow`，Owner 2026-09-22 二次拍板「本次页面改版先还原稿里的
   * 演示态」）：**纯演示，没有数据面**。没有 follows 表（契约 `users/schema.ts` 注释
   * 明确「#122 明确不做」），所以：
   * - 状态只是组件内的 `followState`（未关注 → 关注中 1.5s → 已关注 → 可点回未关注），
   *   刷新/重进就重置 —— 不落存储、不假装后端已有关注关系；
   * - **生产口径不变**：`MOCK_FALLBACK_ENABLED === false` 时不渲染按钮（未关注占位、
   *   不留白），与签名行同一套「字段到位才渲染」的边界；
   * - 归属不变：真实现归「我的关注」页 + 后端 follows 域，PR 里写明。
   */
  type FollowState = 'none' | 'busy' | 'on'
  const [followState, setFollowState] = useState<FollowState>('none')
  const showFollowBtn = isDemoUser
  const followTimer = useRef<ReturnType<typeof setTimeout>>()

  // 卸载时清掉未完成的「关注中」定时器（换人由 reLaunch/navigateTo 重建实例兜住）
  useEffect(() => {
    return () => {
      if (followTimer.current) clearTimeout(followTimer.current)
    }
  }, [])

  const toggleFollow = () => {
    if (followState === 'busy') return
    if (followState === 'on') {
      setFollowState('none')
      void Taro.showToast({ title: '已取消关注（演示）', icon: 'none' })
      return
    }
    setFollowState('busy')
    followTimer.current = setTimeout(() => {
      setFollowState('on')
      void Taro.showToast({ title: '已关注（演示）', icon: 'none' })
    }, 1500)
  }
  /** 展开态点击收起 / 折叠态点击展开；短签名（`!signHasMore`）点击无效果 */
  const toggleSign = () => {
    if (!signHasMore) return
    setSignOpen((prev) => !prev)
  }

  /**
   * 箭头显隐（稿 `syncSign` 的 `.has-more` 判定）。
   *
   * ⚠️ weapp 的坑（实测）：`Text` 被 `white-space: nowrap; overflow: hidden` 折叠时，
   * `boundingClientRect` 返回的 height 恒等于**单行高**（文本被裁掉，不参与布局），
   * 拿不到「原始文本该有的行数」，DOM 量测判定不了溢出。
   *
   * 因此改用**文本长度阈值**口径：超过一行可容纳的估算字符数才给箭头。这是估计
   * 而非精确值，所以只用于箭头显隐与「点击能否展开」，不影响任何数据口径。
   *
   * 阈值算法：`.uhome__psign` 可用宽 = 750 − 2×40（headblock 左右内边距）− 42（右侧
   * 给箭头留的位）= 628rpx；正文 25rpx，CJK 单字前进宽 ≈ 1em = 25rpx → 一行约 25 字。
   * 取 24 留一格余量。**阈值必须贴着真实容量**：给小了会出现「有箭头但点开毫无变化」
   * （文本本来就没溢出），这比不给箭头更像坏掉。
   */
  const SIGN_CHARS_PER_LINE = 24
  const syncSignOverflow = useCallback(() => {
    setSignHasMore(signatureText.length > SIGN_CHARS_PER_LINE)
  }, [signatureText])

  useEffect(() => {
    syncSignOverflow()
  }, [syncSignOverflow])

  /**
   * 身份区重新上屏（loading 骨架 ↔ 数据、重试）或长度变化（签名展开 / 收起）后重量一次。
   *
   * `profile` / `loadState` 进 deps 是**刻意的多余依赖**：`measureIdentity` 恒定，真正要追的是
   * 「身份区重新渲染」这个时机，而它由这两个状态驱动 —— 只写 `[measureIdentity]` 会漏掉
   * 数据到位后的那次重渲染。这样也顺带覆盖了「加载中先滚动、数据后到」：那次测量用的是
   * 补偿过 `scrollTop` 的内容坐标，量出来的阈值不随滚动量漂移。
   *
   * `signOpen` / `signatureText` 同理：展开长签名会把身份区撑高，阈值必须跟着重量
   * （本 effect 因此必须排在这两个 `const` 之后 —— 依赖数组在渲染期求值，写在前面对
   * 暂时性死区求值会直接 ReferenceError）。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上，刻意追身份区那次重渲染的时机
  useEffect(() => {
    measureIdentity()
  }, [measureIdentity, profile, loadState, signOpen, signatureText])

  /**
   * 顶栏举报钮与微信胶囊的间距：`.navfloat` 容器自带 32rpx（16pt）右内边距，
   * 这里在它之上再让出 capsuleInset 与那段内边距的差值，按钮右缘正好贴着胶囊左边
   * （「隔壁」）。都在设备 px 口径（32rpx 按屏宽折算，见 nav-metrics.ts 的换算规则）。
   */
  const navReportGap = useMemo(() => {
    try {
      const w = Taro.getWindowInfo().windowWidth
      return Math.max(navMetrics.capsuleInset - (32 * w) / 750, 8)
    } catch {
      return navMetrics.capsuleInset
    }
  }, [navMetrics])

  /**
   * #252：进「举报用户」页。对象三项由 query 带入、页内不可改（公开资料子集：
   * 头像 + 昵称，不带教育邮箱 / 手机号 / 校区 —— #86 边界）。`id` 是**当前契约的
   * uuid**（页面目前不消费该参数，POST /reports 接线时启用）：Report 契约
   * （#231/#240/#241）与 TypeID（#217）冻结后改传 `usr_` 公开 ID。
   * 未登录由举报页的 useAuthGuard 引导登录。
   */
  const goReport = () => {
    const query = [
      `id=${encodeURIComponent(userId)}`,
      profile?.nickname ? `nickname=${encodeURIComponent(profile.nickname)}` : null,
      profile?.avatarUrl ? `avatar=${encodeURIComponent(profile.avatarUrl)}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join('&')
    void Taro.navigateTo({ url: `/pages/report-user/index?${query}` })
  }

  /** 顶栏举报钮（Owner 拍板：贴微信胶囊放）。仅非本人主页渲染，见 isSelf。 */
  const navReportAction =
    profile && !isSelf ? (
      <View
        className={`uhome__navreport${glassOn ? ' is-glass' : ''}`}
        style={{ marginRight: `${navReportGap}px` }}
        onClick={goReport}
      >
        <Image className="uhome__navreport-ic" src={ICONS.shieldLine} mode="aspectFit" />
      </View>
    ) : null

  /** 导航居中标题：昵称 + 认证徽章（徽章与页头同款，未认证整块不渲染） */
  const navTitle = profile ? (
    <>
      <Text className="uhome__navname">{profile.nickname}</Text>
      {verified ? (
        <View className="uhome__badge uhome__badge--nav">
          <Image className="uhome__badge-ic" src={ICONS.verifiedAccent} mode="aspectFit" />
          <Text>已认证</Text>
        </View>
      ) : null}
    </>
  ) : null

  return (
    <View className="uhome">
      {/* 钉在滚动区后面的浅蓝定色带：只铺到导航条下沿，与页头渐变同起点色，
          滚动时接缝看不出来（稿 `.topbg`）。滚动区压在其上。
          高度行内给：状态栏是设备 px（不经 pxtransform），写死样式表数值会在
          大状态栏机型上让玻璃底最后一段透出页面底色。 */}
      <View className="uhome__topbg" style={{ height: `${navTotalHeight}px` }} />

      <NavBar
        glass={glassOn}
        titleAlign="center"
        title={titled ? navTitle : null}
        actions={navReportAction}
      />

      {loadState === 'failed' ? (
        <LoadError title="主页加载失败" onRetry={() => void load()} />
      ) : loadState === 'notFound' ? (
        <EmptyState
          title="用户不存在"
          text="这个主页的主人可能已注销，或链接已失效"
          icon={ICONS.box}
          actionText="返回"
          onAction={() => void Taro.navigateBack()}
        />
      ) : (
        <ScrollView
          className="uhome__scroll"
          scrollY
          enhanced
          showScrollbar={false}
          onScroll={onScroll}
        >
          {/* 页头进滚动区：渐变块只包身份区（稿 `.headblock` 只含 profile/psign/stats），
              列表区坐在页面底色上；昵称区跟着滚走，导航条常驻按需补标题（稿取舍 ②） */}
          <View className="uhome__headblock">
            {profile ? (
              <View className="uhome__identity" style={{ marginTop: `${identityTopGap}px` }}>
                <View className="uhome__profile" id="uhome-profile">
                  {/* 头像：契约的 `PublicUserProfileSchema.avatarUrl` 真实存在（可空），
                      有图就渲染真图；只有「没有图」才退昵称首字 —— 首字是缺图的降级呈现，
                      不是这个人的身份。首字降级与 `conversation` 同款
                      （`watchers` 的缺图降级是 `—`，不是首字，别照抄那一处）。
                      不做占位色块：本页有首字可退，比通用色块更可辨。 */}
                  <View className="uhome__avatar">
                    {profile.avatarUrl ? (
                      <Image
                        className="uhome__avatar-img"
                        src={profile.avatarUrl}
                        mode="aspectFill"
                      />
                    ) : (
                      <Text className="uhome__avatar-tx">{profile.nickname.slice(0, 1)}</Text>
                    )}
                  </View>
                  <View className="uhome__pinfo">
                    <View className="uhome__nameRow">
                      <Text className="uhome__pname">{profile.nickname}</Text>
                      {/* 徽章只在 VERIFIED 时渲染：未认证不占位、不留白 */}
                      {verified ? (
                        <View className="uhome__badge">
                          <Image
                            className="uhome__badge-ic"
                            src={ICONS.verifiedAccent}
                            mode="aspectFit"
                          />
                          <Text>已认证</Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                  {/* 关注按钮（稿 `.btn-follow`）：**头像行内第三格**，昵称块右侧 ——
                      稿的 `.profile` 是 `头像 | 昵称块 | 关注钮` 三格 flex，签名不在这一行里。
                      见上方 `followState` 注释：纯演示三态，未关注（品牌渐变 + plus）/
                      关注中（转圈 + 禁用 1.5s）/ 已关注（浅底 + check）；无后端，
                      生产构建整颗不渲染。 */}
                  {showFollowBtn ? (
                    <View
                      className={`uhome__follow${
                        followState === 'on'
                          ? ' uhome__follow--on'
                          : followState === 'busy'
                            ? ' uhome__follow--busy'
                            : ''
                      }`}
                      onClick={toggleFollow}
                    >
                      {followState === 'on' ? (
                        <>
                          <Image
                            className="uhome__follow-ic"
                            src={ICONS.checkAccent}
                            mode="aspectFit"
                          />
                          <Text>已关注</Text>
                        </>
                      ) : followState === 'busy' ? (
                        <>
                          <View className="uhome__follow-spin" />
                          <Text>关注中</Text>
                        </>
                      ) : (
                        <>
                          {/* 稿 `.btn-follow` 的图标是 `currentColor` = `--surface`（白），
                              压在品牌渐变底上。别用 `personAdd`：那颗是品牌蓝（`#4285ff`），
                              蓝压蓝几乎看不见。`plus` 才是白色那颗（sell 页主按钮同款）。 */}
                          <Image className="uhome__follow-ic" src={ICONS.plus} mode="aspectFit" />
                          <Text>关注</Text>
                        </>
                      )}
                    </View>
                  ) : null}
                </View>

                {/* 个性签名（稿 `.psign`）：头像行的**下一行、独占全宽** ——
                    稿把「校区 · 加入天数」换成签名，正是为了吃到全宽（和关注钮挤同一行
                    只剩约 170pt，一句话要折五六行）。字段到位才渲染（演示 mock /
                    将来契约落地）。展示口径与「我的」页一致 —— signatureFirstLine 只取
                    首行；长签名折叠成单行省略号，行尾箭头展开 / 收起；短签名不给空箭头。
                    `id` 给滚动联动量「身份块滚干净了没」（稿 `syncNav` 量的就是这个节点）。 */}
                {signatureText ? (
                  <View
                    className={`uhome__psign${signOpen ? ' uhome__psign--open' : ''}`}
                    id="uhome-psign"
                    onClick={toggleSign}
                  >
                    <Text className="uhome__psign-txt">{signatureText}</Text>
                    {signHasMore ? (
                      <Image
                        className="uhome__psign-toggle"
                        src={ICONS.chevronDownMuted}
                        mode="aspectFit"
                      />
                    ) : null}
                  </View>
                ) : null}

                <View className="uhome__stats">
                  <View className="uhome__stat">
                    <Text className="uhome__stat-num num">{profile.activeCount}</Text>
                    <Text className="uhome__stat-label">在售</Text>
                  </View>
                  <View className="uhome__stat">
                    <Text className="uhome__stat-num num">{profile.soldCount}</Text>
                    <Text className="uhome__stat-label">卖出</Text>
                  </View>
                  <View className="uhome__stat">
                    {/* 好评率：仓库没有评价表，没有真实口径 → 恒显 `--`，不编百分比 */}
                    <Text className="uhome__stat-num num">--</Text>
                    <Text className="uhome__stat-label">好评率</Text>
                  </View>
                </View>
              </View>
            ) : (
              /* 资料没拿到之前先给页头骨架：头像盘 + 昵称条 + 签名条 + 数据行条
                  （稿 04 帧的页头骨架）。骨架里**不画关注钮占位** —— 那颗钮是
                  演示态、生产不渲染，给它留位只会在真机上留一块空白。
                  签名条反过来**要**画（稿 `signHTML` 的 loading 分支）：演示账号的
                  签名行必然出现，骨架里缺这一行会让数据到位时整页下跳约 40px。
                  id 与数据态同一套：loading 期也要参与「身份块滚干净了没」的测量。 */
              <View className="uhome__identity" style={{ marginTop: `${identityTopGap}px` }}>
                <View className="uhome__profile" id="uhome-profile">
                  <View className="uhome__skel-disc" />
                  <View className="uhome__skel-col">
                    <View className="uhome__skel-bar" style={{ width: '60%' }} />
                    <View
                      className="uhome__skel-bar uhome__skel-bar--sm"
                      style={{ width: '42%' }}
                    />
                  </View>
                </View>
                {isDemoUser ? (
                  <View className="uhome__psign" id="uhome-psign">
                    <View className="uhome__skel-bar" style={{ width: '62%' }} />
                  </View>
                ) : null}
                <View className="uhome__stats">
                  {[0, 1, 2].map((i) => (
                    <View key={`st-${i}`} className="uhome__stat">
                      <View className="uhome__skel-bar" style={{ width: '64px' }} />
                      <View
                        className="uhome__skel-bar uhome__skel-bar--sm"
                        style={{ width: '72px' }}
                      />
                    </View>
                  ))}
                </View>
              </View>
            )}
          </View>

          {/* 列表区坐在页面底色上（稿 `.inner` 是 headblock 的兄弟节点，不在渐变块内） */}
          <View className="uhome__body">
            <View className="uhome__sect">
              <Text className="uhome__sect-title">TA 的在售</Text>
              {/* 计数用服务端的 activeCount（与上方「在售」同一口径），
                  不用 items.length —— 列表有单页上限，用它会在超出上限时低报 */}
              <Text className="uhome__sect-cnt num">
                {profile ? `${profile.activeCount} 件` : '加载中'}
              </Text>
            </View>

            {loadState === 'loading' ? (
              <View className="uhome__grid">
                {[0, 1, 2, 3].map((i) => (
                  <View key={`sk-${i}`} className="uhome__skel">
                    <View className="uhome__skel-img" />
                    <View className="uhome__skel-lines">
                      <View className="uhome__skel-bar" />
                      <View className="uhome__skel-bar" style={{ width: '56%' }} />
                    </View>
                  </View>
                ))}
              </View>
            ) : items.length === 0 ? (
              <View className="uhome__empty">
                <View className="uhome__empty-disc">
                  <Image className="uhome__empty-ic" src={ICONS.box} mode="aspectFit" />
                </View>
                <Text className="uhome__empty-title">TA 暂无在售商品</Text>
                <Text className="uhome__empty-text">TA 的东西都被抢光啦，有新上架会出现在这里</Text>
              </View>
            ) : (
              <View className="uhome__grid">
                <View className="uhome__col">{left.map(card)}</View>
                <View className="uhome__col">{right.map(card)}</View>
              </View>
            )}

            {/* 列表终点（稿 `.list-end`）：只有**确认这份列表就是全部**时才说「已经到底了」。
                在售列表是单页读取（上限 50），超过时 `activeCount > items.length` —— 那种
                情况改说「仅显示最近 N 件」，不能宣称 TA 就这些（判定见 `./list-end.ts`）。
                两条都**不带总数**：稿的 N 是列表长度，与服务端 COUNT 口径不同，带上会打架。 */}
            {end === 'end' ? (
              <View className="uhome__list-end">
                <View className="uhome__list-end-line" />
                <Text className="uhome__list-end-txt num">已经到底了</Text>
                <View className="uhome__list-end-line" />
              </View>
            ) : end === 'partial' ? (
              <View className="uhome__list-end">
                <View className="uhome__list-end-line" />
                <Text className="uhome__list-end-txt num">{`仅显示最近 ${items.length} 件`}</Text>
                <View className="uhome__list-end-line" />
              </View>
            ) : null}
          </View>
        </ScrollView>
      )}
    </View>
  )
}
