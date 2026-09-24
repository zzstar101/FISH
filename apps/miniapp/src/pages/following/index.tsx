import { Image, Text, View } from '@tarojs/components'
import Taro, { usePageScroll, usePullDownRefresh } from '@tarojs/taro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import EmptyState from '@/components/empty-state'
import TopBar from '@/components/top-bar'
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import type { FollowingPerson } from '@/features/following/demo'
import {
  FOLLOW_DEMO_LATENCY_MS,
  type FollowingLoad,
  followingLoadOf,
  isFollowingDemo,
} from '@/features/following/load'
import { followingStatsOf } from '@/features/following/stats'
import { MOCK_FALLBACK_ENABLED } from '@/features/load-failure'
import { cancellable } from '@/lib/cancellable'
import { readNavMetrics } from '@/lib/nav-metrics'
import './index.scss'

/**
 * 我的关注（设计稿 `小程序1版following.html`）。入口在「我的」页数字栏第三格。
 *
 * ## 数据（本轮的关键口径，见 `features/following/load.ts` 的文件头）
 *
 * 关注关系**三层都没有**：契约无 follows 端点（`packages/contracts/src/users/schema.ts:22`
 * 原话「没有 follows 表，关注关系未拆 Domain，#122 明确不做」）、API 无模块、DB 无表。
 * 所以本页**没有可发的请求**，两种结果二选一：
 *
 * - **真实构建**（`MOCK_FALLBACK_ENABLED === false`）→ **空态 + 缺口说明**。
 *   既不是错误态（没有东西加载失败），也不是假列表。
 * - **演示构建**（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`）→ 照稿的 5 个人
 *   （与「我的」页数字栏的 `followCount: 5` 对齐），并在列表上方**明写这是演示数据**。
 *
 * 两个开关都在页面里读、显式传给 `followingLoadOf`（纯函数），这样「哪种开关组合得到
 * 哪一种界面」能被 `bun test` 锁住，也让将来接端点时只改这一处取数。
 *
 * ## 关系钮不伪造状态
 *
 * 「互粉 / 已关注」两态**按数据渲染、必须区分**（互粉＝品牌浅底，已关注＝中性描边），
 * 但点击**不做任何本地翻转**：后端没有 follows 表，翻了就是假成功（稿决策⑥）。
 * 点击只给「关注管理待接入」说明。
 *
 * ## 行内只展示三样
 *
 * 昵称 / 个性签名（单行省略）/ 最近活跃 —— **不显示校区与院系**，与「想要的人」
 * （`pages/watchers`）同一隐私口径（Issue #123：公开字段不泄漏私有校园身份）。
 *
 * ## 「关注动态」是状态页
 *
 * 没有动态流的数据源（没有 follows 表就没有动态）。这一档如实写成「未上线」状态页，
 * **不编一屏假动态**（稿决策③）。稿里第三档「兴趣圈」已被 Owner 删除（决策④），不恢复。
 *
 * ## 顶栏吸顶（`components/top-bar` 的 glass 变体）
 *
 * 稿的 `.pagehead`（导航 + 两档 tab）在**滚动容器之外**，天然不随内容滚；真机上是页面级
 * 滚动，要同一个观感就得把这两行钉住。所以顶栏用一级页的 `top-bar`（`fixed` + 玻璃底 +
 * `below` 副行 + `spacer` 占位），而不是二级页的漂浮 `nav-bar`。标题的居中做法见
 * `center` 那一段（组件没有 `titleAlign`，得页面自己绝对定位到整条栏的中线）。
 */

/** 两档下划线 tab：关注的人 / 关注动态（稿决策②） */
type FollowingTab = 'people' | 'feed'

const TABS: { key: FollowingTab; label: string }[] = [
  { key: 'people', label: '关注的人' },
  { key: 'feed', label: '关注动态' },
]

/** 回到顶部钮的出现阈值：稿 `.totop` 滚过 380pt 后出现。
 *  `usePageScroll` 的单位是逻辑 px（= 稿的 pt），**不是** scss 里的 rpx，不 ×2。 */
const TOTOP_THRESHOLD = 380

/**
 * 本构建是不是演示态（口径与「我的」页的回退一致，见 `./features/following/load.ts`）。
 * 构建期常量：`__ALLOW_MOCK_FALLBACK__` / `__DEMO_AUTH__` 在打包时就定死了。
 */
const DEMO_BUILD = isFollowingDemo(MOCK_FALLBACK_ENABLED, DEMO_AUTH_ENABLED)

/**
 * 「还没算出来」的初值。
 *
 * 真实构建的结果**同步可知**（本页没有端点可发，结果只由两个构建开关决定），
 * 所以直接给出终值 —— 摆一帧「正在读取关注列表…」的骨架屏是在演一个并不存在的
 * 读取过程。演示构建才从 `null` 起步、走 `FOLLOW_DEMO_LATENCY_MS` 的延迟。
 */
function initialLoad(): FollowingLoad | null {
  return DEMO_BUILD ? null : followingLoadOf(MOCK_FALLBACK_ENABLED, DEMO_AUTH_ENABLED)
}

export default function Following() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  const userId = user?.id ?? null

  /**
   * 顶栏栅格（状态栏高 / 内容行高）。**必须来自 `lib/nav-metrics` 的运行时反推**，
   * 不能照抄稿的固定值：真机上胶囊位置逐机不同，稿里那个是画出来的假胶囊。
   * 只用它给居中标题定「与胶囊同行」的那条水平带（见下方 `center` 的说明）。
   */
  const metrics = useMemo(() => readNavMetrics(), [])

  const [tab, setTab] = useState<FollowingTab>('people')
  /**
   * `null` = 还没算出来（**只有演示构建**会经过这一帧，渲染骨架屏）。
   * 算出来之后是 demo / empty 二选一，见 `initialLoad`。
   */
  const [load, setLoad] = useState<FollowingLoad | null>(initialLoad)
  const [showTop, setShowTop] = useState(false)

  /**
   * 账号切换的**渲染期清场**（adjust-state-during-render，与 `pages/mylist`、
   * `features/transaction/useOrderList` 同一手法）：本页实例会被压在页面栈里跨登录态存活，
   * 换账号 / 退出回来时，上一帧的列表与档位都属于上一个账号，必须在**同一个 commit 内**
   * 清成「未加载」。写成 effect 里 setState 要到下一帧才生效，会露出一帧旧账号的数据。
   *
   * 注意 `userId === null`（未登录 / 未就绪）时也走清场：退出登录回到本页不能残留旧账号的
   * 关注列表。冷启动首帧 `prevUserId` 初值就是当时的 `userId`，不会误触发。
   *
   * 清成 `initialLoad()` 而不是 `null`：真实构建没有「正在读取」这件事（见 `initialLoad`），
   * 置 `null` 会让换账号后多闪一帧骨架屏。
   */
  const [prevUserId, setPrevUserId] = useState<string | null>(userId)
  if (prevUserId !== userId) {
    setPrevUserId(userId)
    setLoad(initialLoad())
    setTab('people')
  }

  /**
   * 在飞的那一轮取数。当前实现是**本地纯函数**（没有端点可发），但仍然包成
   * `cancellable` —— 这就是将来真实端点落地的接缝：
   *
   * 1. 换账号 / 退出 / 卸载时由生命周期显式 `cancel()`，迟到结果一律丢弃。
   *    `@/lib/cancellable` 的口径：不能只比对「响应里的 id === 发请求时的 id」，
   *    那只证明响应属于发请求时的账号，不证明现在登录的还是同一个人；
   * 2. `accept` 恒真：结果里没有可校验的账号标识（关注关系还没有契约模型），
   *    所以防串号完全靠「cleanup 取消 + 上面的渲染期清场」这两条，不假装做了校验。
   *
   * 演示分支走 `FOLLOW_DEMO_LATENCY_MS` 的延迟（骨架屏在评审时看得见）；
   * 真实分支**不加延迟**，也不摆一个并不存在的加载过程。
   */
  const pending = useRef<(() => void) | null>(null)

  const runLoad = useCallback((): Promise<void> => {
    // 上一轮立即作废：连点下拉刷新 / 重试时，先发的那轮不能后到并覆盖新结果
    pending.current?.()
    const job = cancellable(
      async () => {
        const next = followingLoadOf(MOCK_FALLBACK_ENABLED, DEMO_AUTH_ENABLED)
        if (next.kind === 'demo') {
          await new Promise((resolve) => setTimeout(resolve, FOLLOW_DEMO_LATENCY_MS))
        }
        return next
      },
      () => true,
    )
    pending.current = job.cancel
    return job.promise.then((next) => {
      if (next) setLoad(next)
    })
  }, [])

  useEffect(() => {
    if (authStatus !== 'authed' || userId === null) return
    void runLoad()
    // 换账号 / 退出 / 卸载：取消在飞的那一轮
    return () => pending.current?.()
  }, [authStatus, userId, runLoad])

  /**
   * 下拉刷新用**微信原生**（`index.config.ts` 的 `enablePullDownRefresh: true`，
   * 先例 `pages/orders-buy`）。**不重置 `load`**：原生指示器已经拉出来了，
   * 再把列表换成骨架屏只会让用户丢掉阅读位置。
   *
   * 本页没有网络请求，所以刷新**不弹「已刷新」之类的成功提示** —— 那会声称一件没发生的事。
   */
  usePullDownRefresh(() => {
    void runLoad().then(() => Taro.stopPullDownRefresh())
  })

  usePageScroll(({ scrollTop }) => setShowTop(scrollTop > TOTOP_THRESHOLD))

  const people = load?.kind === 'demo' ? load.people : []
  /** 统计**从正在渲染的这份列表现算**，不旁路读任何汇总 —— 否则会出现「统计 5 人 / 列表 3 行」 */
  const stats = useMemo(() => followingStatsOf(people), [people])

  const toast = (title: string) => {
    void Taro.showToast({ title, icon: 'none' })
  }

  /**
   * 关系钮：**不本地翻转**。后端没有 follows 表，翻了就是假成功（稿决策⑥）；
   * 互粉与已关注两态也**不互相切换** —— 那是后端的事。
   */
  const manageRelation = () => {
    toast('关注管理待接入')
  }

  /**
   * 行点击：演示稿里的用户 id（`P01`…）在库里不存在，跳过去必然 404，
   * 所以演示态下给**明确的演示说明**，不假装跳成功（方案 §2.3）。
   * 真实数据到位后这里换成 `/pages/user/index?id=`（契约的他人主页是匿名可读的真实端点）。
   */
  const openPerson = (person: FollowingPerson) => {
    toast(`演示数据：${person.nickname} 的主页不可打开`)
  }

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  /** 未登录 / 登录态未就绪：守卫在跳转，这里同时拦住渲染，避免跳转落地前先画一帧 */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  return (
    <View className="fw">
      <View className="fw__bg" />

      {/* 顶栏主行 + 两档 tab 副行：同一块玻璃，钉在顶部（见下方 TopBar 的说明） */}
      <TopBar
        variant="glass"
        spacer
        back
        center={
          /*
            标题走**中槽**而不是 `title` / `titleEm` 两个 prop：那两个 prop 渲染出的
            标题是**紧随返回钮左对齐**的（`.topbar__row` 是普通 flex），而稿的
            `.mp-title{left:50%;translate(-50%,-50%)}` 要求**屏幕水平居中**。

            中槽本身也不够：`.topbar__center` 是 `flex: 1 1 auto`，它的可用区间是
            「返回钮右侧 → 胶囊避让区左侧」，实测 375pt 屏上是 [64px, 266px]，
            在其中居中会落在 165px 而不是屏幕中线 187.5px，肉眼能看出偏左。
            所以这里把它**绝对定位到整条栏的中线**（`.topbar` 是 `position: fixed`，
            天然是绝对定位后代的包含块），左右 `top` / `height` 由组件同一套运行时
            栅格给出：`top` = 状态栏高、`height` = 内容行高，于是标题在**胶囊那一行**
            垂直居中（与返回钮同一水平中线），不会跟着整条栏变高一起下偏。

            这两个是组件按设备反推出来的**设备 px**，必须走行内（pxtransform 只处理
            样式表；内联 px 原样下发）—— 与 `lib/nav-metrics` 的口径一致。
          */
          <View
            className="fw__navtitle"
            style={{
              top: `${metrics.statusBarHeight}px`,
              height: `${metrics.contentHeight}px`,
            }}
          >
            <Text>我的</Text>
            {/* 稿 `.mp-title .hl{color:var(--brand)}`：尾段走品牌色 */}
            <Text className="fw__navtitle-em">关注</Text>
          </View>
        }
        below={
          <View className="fw__tabs">
            {TABS.map((item) => (
              <View
                key={item.key}
                // `--${key}` 修饰类供端上自动化定位（automator 选择器不支持 :nth-child），
                // 与消息页 tab 的 `chat__tab--${key}` 同一做法
                className={`fw__tab fw__tab--${item.key}${tab === item.key ? ' is-on' : ''}`}
                onClick={() => setTab(item.key)}
              >
                <Text>{item.label}</Text>
              </View>
            ))}
          </View>
        }
      />
      {/* 副行占位：`top-bar` 的 `spacer` 只含主行，tab 行这一截由页面自己补 */}
      <View className="fw__header-gap" />

      {tab === 'feed' ? (
        /* 「关注动态」：没有数据源 → 状态页如实说明，不编一屏假动态（稿决策③） */
        <View className="fw__state">
          <View className="fw__state-disc">
            <Image className="fw__state-ic" src={ICONS.rank} mode="aspectFit" />
          </View>
          <Text className="fw__state-title">关注动态</Text>
          <Text className="fw__state-tag">未上线</Text>
          <Text className="fw__state-text">
            上线后这里会是 TA 们的上架与成交动态。现在还没有这个数据源。
          </Text>
          <View className="fw__state-go" onClick={() => setTab('people')}>
            <Text>先看关注的人</Text>
          </View>
        </View>
      ) : load === null ? (
        <View className="fw__list">
          {[0, 1, 2].map((i) => (
            <View key={`sk-${i}`} className="fw__skel">
              <View className="fw__skel-av" />
              <View className="fw__skel-col">
                <View className="fw__skel-bar" style={{ width: '34%' }} />
                <View className="fw__skel-bar" style={{ width: '62%' }} />
                <View className="fw__skel-bar" style={{ width: '46%' }} />
              </View>
              <View className="fw__skel-rel" />
            </View>
          ))}
          <View className="fw__skel-hint">
            <View className="fw__spin" />
            {/* 文案写明「演示数据」：这一帧只有演示构建会经过（真实构建的结果同步可知），
                写「正在读取关注列表」会声称一次并不存在的读取 */}
            <Text>正在加载演示数据…</Text>
          </View>
        </View>
      ) : load.kind === 'empty' ? (
        /*
          真实构建：契约 / API / DB 三层都没有关注关系，**没有数据可读**。
          这是空态（不是错误态：本页没有任何请求可发、也没有东西加载失败），
          标题沿用稿的「还没有关注的人」，缺口由正文如实说明（方案 §2.1 的
          「空态 + 一句如实的缺口说明」）；**不写「点关注就会出现在这里」** ——
          点关注现在存不下来（商品详情页 / 他人主页的「关注」只弹 toast），
          那是空承诺。

          **用户可见文案一律用产品语言**：「契约」「端点」这类词只留在注释里。
          真实构建下这一句是用户能看到的唯一说明，把内部数据契约名写进去
          既没有帮助，也是全仓唯一的例外（其余「契约」都只出现在注释里）。
          **不写「现在点『关注』也存不下来」**：`origin/main` 上他人主页的
          「关注」钮已收进 `showFollowBtn`（真实构建不渲染），本分支落后 5 个
          commit，变基后那句话会指向一个不存在的按钮。

          外面这层 `.fw__emptypad` 只为抬层：`.fw__bg` 是绝对定位的渐变层，
          会盖住静态内容（同 `pages/conversation` 的 `.conv__emptypad`）。
        */
        <View className="fw__emptypad">
          <EmptyState
            icon={ICONS.personAdd}
            title="还没有关注的人"
            text="关注功能还没上线，这里暂时读不到名单；上线后会显示在这里。"
            actionText="去首页看看"
            onAction={() => void Taro.switchTab({ url: '/pages/home/index' })}
          />
        </View>
      ) : (
        <>
          {/* 演示态必须**可辨认**：这一行是演示构建专有的说明。条数用 `stats.count` 现算，
              不写死「5 人」—— 演示数据变了而这句话没跟着变，就成了另一种假话 */}
          <View className="fw__demo">
            <View className="fw__demo-ic">
              <Image className="fw__demo-ic-img" src={ICONS.info} mode="aspectFit" />
            </View>
            <Text className="fw__demo-tx">
              {`演示数据：关注功能还没上线，下面这 ${stats.count} 人是设计稿的示例。`}
            </Text>
          </View>

          <View className="fw__stat">
            <Text>
              关注 <Text className="fw__stat-num num">{stats.count}</Text> 人
            </Text>
            <View className="fw__stat-dot" />
            <Text>
              互粉 <Text className="fw__stat-num num">{stats.mutual}</Text> 人
            </Text>
          </View>

          <View className="fw__list">
            {people.map((person) => (
              <View key={person.id} className="fw__row">
                <View className="fw__av" onClick={() => openPerson(person)}>
                  {/*
                    稿的头像是**两层**：色圈垫底 + 首字压在上面（`.frow__av` 的
                    background 就是那圈色，`char` 是它的文字内容）—— 所以这里不是
                    「有图显图 / 无图显字」的二选一。

                    `placeholderBlock` 这个名字是有意的：它只是**占位色块**，
                    真实头像（契约的 `avatarUrl`）到位时必须**新加一个分支**，
                    用独占整圆的方式渲染（`fw__av-img` 是 `position:absolute; inset:0`，
                    专给垫底色块用），不能把真头像塞进这个字段 —— 否则首字会叠在人脸上。
                  */}
                  {person.placeholderBlock ? (
                    <Image className="fw__av-img" src={person.placeholderBlock} mode="aspectFill" />
                  ) : null}
                  <Text className="fw__av-tx">{person.nickname.slice(0, 1)}</Text>
                </View>

                <View className="fw__main">
                  <View className="fw__top">
                    <Text className="fw__name" onClick={() => openPerson(person)}>
                      {person.nickname}
                    </Text>
                    {/* 认证勾：未认证时整块不占位（与「想要的人」同一处理） */}
                    {person.verified ? (
                      <Image className="fw__tick" src={ICONS.verifiedAccent} mode="aspectFit" />
                    ) : null}
                  </View>
                  <Text className="fw__bio">{person.bio}</Text>
                  <Text className="fw__seen num">{person.seenLabel}</Text>
                </View>

                {/* 互粉（品牌浅底）/ 已关注（中性描边）：两态必须区分，点击不翻转 */}
                <View
                  className={`fw__rel${person.mutual ? ' is-mutual' : ''}`}
                  onClick={manageRelation}
                >
                  <Text>{person.mutual ? '互粉' : '已关注'}</Text>
                </View>
              </View>
            ))}
          </View>

          <Text className="fw__note">只展示对方愿意公开的信息：昵称、个性签名与最近活跃时间。</Text>
        </>
      )}

      <View className={`fw__totop${showTop ? ' is-show' : ''}`} onClick={backToTop}>
        <View className="fw__totop-arrow" />
      </View>
    </View>
  )
}
