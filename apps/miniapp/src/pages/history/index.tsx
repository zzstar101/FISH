import { Image, Text, View } from '@tarojs/components'
import Taro, { usePageScroll, usePullDownRefresh } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import BackTop, { BACK_TOP_THRESHOLD } from '@/components/back-top'
import EmptyState from '@/components/empty-state'
import TopBar from '@/components/top-bar'
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { MOCK_FALLBACK_ENABLED } from '@/features/load-failure'
import { cancellable } from '@/lib/cancellable'
import { formatAmount } from '@/lib/money'
import {
  applyCleared,
  blockUrlOf,
  CLEAR_LABEL,
  type ClearedState,
  canClear,
  clearBlockedOf,
  clearDoneOf,
  clearedOf,
  DEMO_OPEN_TIP,
  type DemoRecords,
  emptyCopyOf,
  emptyKindOf,
  fetchDemoRecords,
  type HistoryTab,
  loadingTextOf,
  MESSAGE_KIND_LABEL,
  NO_BACKEND_REFRESH_TIP,
  NOTHING_CLEARED,
  noteOf,
  type RecordCell,
  shortLabelOf,
  TABS,
  tailTextOf,
  withCleared,
} from './records'
import './index.scss'

/**
 * 历史浏览（设计稿 `D:\新建文件夹\小程序1版history.html`，方案
 * `D:\FISH\四页面并行-收藏历史评论关注.md` §3.2）。
 *
 * 结构（**顶栏形态照消息页**，Owner 2026-09-23 定版）：一级标题「历史浏览」
 * （「历史」走 `--fg`、「浏览」走品牌蓝，与消息页的「消 + 息」同款两段式）+
 * 返回钮 + 右端「清空」，全部在 `components/top-bar` 的玻璃主行里；
 * 三档 tab 作为**副行**并入同一块玻璃（`below`）→ 内容区 → 骨架屏 / 空态 /
 * 底部说明 / 到底提示 → 回到顶部钮。
 * 下拉刷新用微信原生（`index.config.ts` 的 `enablePullDownRefresh` + 本页的
 * `usePullDownRefresh`，先例 `pages/orders-buy`），**不手写假 refresher**。
 *
 * ## ⚠️ 三类数据后端一条都没有（本轮最关键的口径）
 *
 * | 能力 | 契约现状 | 证据 |
 * | --- | --- | --- |
 * | 浏览足迹 | ❌ 无该域（无表、无端点） | `packages/contracts/src/` 下无 footprint / view_history |
 * | 收藏 | ❌ 契约无、API 无模块、DB 无表 | 全仓 `grep -i favorit` 只命中 web mock 与小程序文案 |
 * | 「我发过的留言」聚合 | ❌ 只有**按商品**取留言的那一条路由 | `packages/contracts/src/comments/routes.ts` 的 `COMMENT_ROUTES`；`comments/schema.ts` 的 `CommentListQuerySchema` 只有 `limit` / `cursor`，**没有 author 过滤** |
 * | 交易评价 / 评分 | ❌ 交易域无 review / rating 字段 | `packages/contracts/src/transactions/schema.ts` 里 `review` / `rating` 零命中（「我留言的」这一档里的**交易评价**那 4 条同样是演示数据） |
 * | 清空 / 取消收藏 / 删留言（写端点） | ❌ 一个都没有 | 全 API 无 `.delete(` 路由；契约里可写的只有 listings 的 offline/online、wishes 的 close/fulfill、notifications 的 markRead |
 *
 * 因此：
 * - **真实构建**（`MOCK_FALLBACK_ENABLED === false`）三档一律**空态 + 一句如实的缺口说明**
 *   （`emptyCopyOf(tab, 'noBackend')`），不是假列表、也不是错误态 —— 本页一个业务请求都不发，
 *   没有「加载失败」可言；
 * - **演示构建**（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`，两个开关的口径与
 *   「我的」页回退口径一致）才摆演示数据；
 * - **不做 N+1 拼装**（不遍历自己的商品逐个拉 `GET /listings/:id/comments` 过滤作者来假装
 *   汇总 —— 那既慢又不完整）。
 *
 * ## 「清空」到底清掉了什么（Owner 2026-09-23 要求它「不能光是样子」）
 *
 * 三档的写端点一个都没有（清空足迹 / 取消收藏 / 删留言，证据同上），所以**没有服务端可写**。
 * 做法是：**演示构建**下清掉的就是本页自己那份演示记录 —— 点完列表真的空了、并切到
 * 「已清空」空态（不是同一个「你还没有记录」），下拉刷新之后仍然为空
 * （`applyCleared` 按渲染期派生，不在取数里改数据）。
 * **真实构建**下没有记录可清、也没有端点，于是只给一句说明、不做任何本地翻转。
 *
 * ⚠️ **两条已知且刻意接受的边界**（Owner 2026-09-23 已确认口径）：
 * 1. **离开页面再进来会回到清空前** —— 标记只在页面实例内，**不落本机存储**：
 *    写端点一落地，真实数据就由服务端说了算，这时把演示期的「清过了」永久留在
 *    设备上会让用户再也看不到这一页。演示数据本来就是临时的。
 * 2. 本页**不摆「这是演示数据」的门牌**（说明条按 Owner 要求去掉），静态看上去与
 *    真实页面无异 —— 一切按上线版来，数据准确性等到后端对齐时统一处理。
 *
 * ## 后端对齐之后这一页会怎么变（写在代码里，免得后来人不知道往哪收）
 *
 * - 三档各自接真实端点；**没有数据的档就如实显示「无记录」空态**（`noBackend` 那三支
 *    改措辞即可），条数按服务端给的算，数不准的地方（`—`）跟着真实值走；
 * - 「清空」从「清演示数组」改成真实写：有端点就真发，成功后再由服务端返回的列表刷新；
 * - 那三支 `noBackend` 空态与「清空只在演示构建生效」的分支同时删除，
 *    本文件头这张缺口表也一并删掉。
 *
 * ## 账号作用域
 *
 * 演示取数包在 `@/lib/cancellable` 里（先例 `pages/profile` / `pages/orders-buy`）：
 * 换账号 / 退出时 effect 重跑即取消上一轮，迟到结果按 `null` 丢弃。
 * 「清空过哪几档」在换账号时**渲染期重置**（与 `pages/mylist` 同款）。
 */

/**
 * 空态图标（稿 `EMPTY` 表的三支）：只从 `@/assets/lib-icons` 的 `ICONS` 取。
 * 稿里的内联 `<svg>`（ic-clock / ic-heart / ic-comment）一律换成库里已有的对应图标。
 */
const EMPTY_ICON: Record<HistoryTab, string> = {
  history: ICONS.clockMuted,
  favs: ICONS.heartMuted,
  msgs: ICONS.commentMuted,
}

export default function History() {
  const authStatus = useAuthGuard()
  const userId = useAuth().user?.id ?? null

  /**
   * 演示构建才摆演示数据：开关口径是 `MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`
   * （**不能**只认前一个 —— `dev:weapp` 的日常开发也满足它，会顶掉真实空态）。
   */
  const demo = MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED

  const [tab, setTab] = useState<HistoryTab>('history')
  const [data, setData] = useState<DemoRecords | null>(null)
  /** 真实构建从不进加载态（没有任何可等的请求），否则会永远停在骨架屏上 */
  const [loading, setLoading] = useState(demo)
  const [showTop, setShowTop] = useState(false)
  /** 重拉（下拉刷新）：自增即驱动下面的 effect */
  const [reloadToken, setReloadToken] = useState(0)
  /**
   * 「清空过哪几档」。三个布尔量，**只活在本次页面实例内**。
   *
   * ⚠️ 离开页面再进来就回到「没清过」—— 这是**已知且故意接受**的行为，不是漏做：
   * 清空本该是服务端写（清空足迹 / 取消收藏 / 删留言），而这三个端点一个都没有
   * （证据见文件头），所以现在清掉的只是本页自己那份演示数组。**把「清过了」持久化
   * 下去是错的**：那会让演示数据永久消失、用户没法再看这一页，而真实数据一到
   * 又必须按服务端为准。等端点落地后，这里换成真实调用、并由服务端返回的列表决定显示。
   *
   * 存**原始数据**、在渲染期用 `applyCleared` 过滤，而不是清空时把 `data` 改掉：
   * 后者在下拉刷新重取之后会被整份覆盖回满列表。
   */
  const [clearedState, setClearedState] = useState<ClearedState>({
    ...NOTHING_CLEARED,
    ownerId: null,
  })
  /**
   * 换账号 / 退出时的**渲染期重置**（与 `pages/mylist` 同款写法）：
   * 「清空过」是上一个账号的视角，必须在**同一帧内**清掉 —— 否则新账号一进来
   * 会先画一帧「这个账号已经清空了」的空列表。写成 effect 里 setState 不行，
   * 那要到下一帧才生效。
   */
  const [prevClearedUser, setPrevClearedUser] = useState<string | null>(userId)
  if (prevClearedUser !== userId) {
    setPrevClearedUser(userId)
    setClearedState({ ...NOTHING_CLEARED, ownerId: null })
  }
  /**
   * `data` 的镜像。effect 里要判断「手里这份数据是不是当前账号的」来决定
   * 保留列表（下拉刷新）还是换骨架屏（换账号），而 `data` 一旦进依赖数组就会
   * 因为 `setData` 自己再触发一轮，只能走 ref 读。
   */
  const dataRef = useRef<DemoRecords | null>(null)

  useEffect(() => {
    const previous = dataRef.current
    /**
     * 这次 effect 是不是**下拉刷新**：`reloadToken > 0` 且手里这份数据仍属于当前账号。
     * 是刷新就保留列表（系统已经拉出原生指示器，再换成骨架屏只会让用户丢掉阅读位置，
     * 先例 `features/transaction/useOrderList` 的 `keepList`）。换账号时 `sameOwner` 为假，
     * 一律按新的一次加载处理。
     */
    const sameOwner = previous !== null && userId !== null && previous.ownerId === userId
    const isRefresh = reloadToken > 0 && sameOwner

    if (!sameOwner) {
      dataRef.current = null
      setData(null)
    }

    if (!demo || authStatus !== 'authed' || userId === null) {
      // 真实构建没有可等的请求；未登录 / 登录态未就绪时守卫在跳转，这里也不该亮骨架屏
      setLoading(false)
      // 上一轮挂着的指示器在这里收掉，不能留一个一直转的圈
      void Taro.stopPullDownRefresh()
      return
    }

    if (!isRefresh) {
      setLoading(true)
      void Taro.stopPullDownRefresh()
    }

    const forUserId = userId
    const load = cancellable(
      () => fetchDemoRecords(forUserId),
      (next) => next.ownerId === forUserId,
    )
    void load.promise.then((next) => {
      // 被取消（换账号 / 退出 / 重拉）时 next 为 null：整批结果含加载态一律不动
      if (!next) return
      dataRef.current = next
      setData(next)
      setLoading(false)
      // 原生下拉指示器在本次结果落地时收起
      void Taro.stopPullDownRefresh()
    })
    return load.cancel
  }, [demo, authStatus, userId, reloadToken])

  /** 当前账号的「已清空」标记（账号对不上时是「都没清过」） */
  const cleared = useMemo(() => clearedOf(clearedState, userId), [clearedState, userId])
  /** 当前档位的记录是否已被清空 */
  const isCleared = cleared[tab]

  /**
   * 上屏的数据 = 取回来的那份**减去清空过的档**。
   *
   * 为什么在渲染期过滤、而不是在清空时把 `data` 改掉：后者在下拉刷新重取之后会被
   * 整份覆盖回满列表 —— 用户会看到「刚清空的东西自己长回来」。
   */
  const shown = useMemo(() => (data === null ? null : applyCleared(data, cleared)), [data, cleared])
  const days = shown?.days ?? []
  const favs = shown?.favs ?? []
  const msgs = shown?.msgs ?? []

  /** 当前档位渲染出来的条目数：三档各自的列表长度现算（`history` 是**件数**不是天数） */
  const shownCount =
    tab === 'history'
      ? days.reduce((n, d) => n + d.items.length, 0)
      : tab === 'favs'
        ? favs.length
        : msgs.length

  /** 骨架屏只在「还没有数据」时顶替内容（下拉刷新保留了列表，不换骨架屏） */
  const pending = loading && data === null

  usePageScroll(({ scrollTop }) => setShowTop(scrollTop > BACK_TOP_THRESHOLD))

  const backToTop = () => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }

  const toast = (text: string) => {
    void Taro.showToast({ title: text, icon: 'none' })
  }

  /**
   * 下拉刷新：微信原生指示器（`index.config.ts` 的 `enablePullDownRefresh`）。
   * 演示构建重拉一遍演示数据（指示器在结果落地时收起，见上面的 effect）；
   * 真实构建没有任何后端可问 —— 如实说明，不假装刷新成功。
   */
  usePullDownRefresh(() => {
    if (!demo) {
      toast(NO_BACKEND_REFRESH_TIP)
      void Taro.stopPullDownRefresh()
      return
    }
    setReloadToken((token) => token + 1)
  })

  /**
   * 顶栏右端「清空」。
   *
   * **演示构建**：清掉当前档的演示记录 —— 列表当场变空、并切到「已清空」空态
   * （`clearedState` 一变，上面那份 `shown` 就跟着空），下拉刷新之后也仍然是空的。
   * **离开页面再进来会回到清空前**（标记只在本次页面实例内，理由见 `clearedState` 的注释）。
   * **真实构建**：没有记录可清、后端也没有清空 / 取消收藏 / 删留言的端点
   * （证据见文件头），只给一句说明，不做任何本地翻转。
   */
  const clearTab = () => {
    if (!canClear(demo) || userId === null) {
      toast(clearBlockedOf(tab))
      return
    }
    setClearedState((prev) => withCleared(prev, userId, tab))
    toast(clearDoneOf(tab))
  }

  /** 切档位：回到顶部（否则从长列表切到短列表会停在半空） */
  const pickTab = (key: HistoryTab) => {
    setTab(key)
    void Taro.pageScrollTo({ scrollTop: 0, duration: 0 })
  }

  /**
   * 格子 / 留言行：演示 id 在库里不存在，跳过去必然 404 —— 给明确的演示说明，
   * 不假装跳转成功，也不跳到必然 404 的页面（方案 §2.3）。
   */
  const openRecord = () => {
    toast(DEMO_OPEN_TIP)
  }

  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  /** 三列格（全部浏览 / 我收藏的共用）：方形色块 + 品类小字 + 失效遮罩 + 格下价格 */
  const renderCell = (item: RecordCell) => (
    <View key={item.id} className="hist__cell">
      <View className={`hist__thumb${item.gone ? ' is-gone' : ''}`} onClick={openRecord}>
        <Image className="hist__thumb-img" src={blockUrlOf(item.category)} mode="aspectFill" />
        <Text className="hist__ttag">{shortLabelOf(item.category)}</Text>
        {item.gone ? <Text className="hist__tgone">{item.gone}</Text> : null}
      </View>
      <Text className="hist__price num">
        <Text className="hist__price-cur">¥</Text>
        {formatAmount(item.priceCents)}
      </Text>
    </View>
  )

  return (
    <View className="hist">
      {/* 顶部冰蓝渐变圆角背景（稿 `.pagehead` 的 --grad-page + 下缘 32pt 圆角） */}
      <View className="hist__bg" />

      {/*
        顶栏（Owner 2026-09-23 定版，照消息页）：`components/top-bar` 的 glass 变体 ——
        返回钮 + 两段式标题（「历史」走 --fg、「浏览」走品牌蓝）+ 右端「清空」，
        三档 tab 作为**副行**并入同一块玻璃（`below`），内容从底下滚过。

        为什么不再用 `components/nav-bar`：那个是**漂浮**导航（只有返回钮是实体），
        放不下页面自己的动作；本页现在右端有「清空」，需要的是消息页那种
        「固定 + 玻璃底 + 副行」的栏。
      */}
      <TopBar
        variant="glass"
        spacer
        back
        onBack={() => {
          const pages = Taro.getCurrentPages()
          if (pages.length > 1) void Taro.navigateBack()
          else void Taro.switchTab({ url: '/pages/home/index' })
        }}
        title="历史"
        titleEm="浏览"
        /*
          「清空」**放在中槽、靠右对齐**，而不是放在 `actions` 槽。
          原因：`components/top-bar` 的 `.topbar__row` 是普通 flex（只有 `gap` 与
          `padding-left`），`.topbar__actions` 是 `flex: 0 0 auto` 且**没有**
          `margin-left: auto` —— 页面又不传 `center` 时，标题与动作会**并排挤在左边**
          （实测 750rpx 帧里按钮右缘离可用右边界还差约 240rpx），不是 Owner 要的
          「贴近右边」。中槽的 `.topbar__center` 本身就是 `flex: 1 1 auto`，
          给它的内容加 `justify-content: flex-end` 就能把按钮顶到行尾，
          且右侧避让（原生胶囊）仍由组件下发的 `paddingRight` 统一负责 ——
          不必改 `components/**`（本轮白名单不允许）。
        */
        center={
          <View className="hist__navacts">
            <View className="hist__clear" onClick={clearTab}>
              <Text>{CLEAR_LABEL}</Text>
            </View>
          </View>
        }
        below={
          <View className="hist__tabs">
            {TABS.map((item) => (
              <View
                key={item.key}
                className={`hist__tab hist__tab--${item.key}${item.key === tab ? ' is-on' : ''}`}
                onClick={() => pickTab(item.key)}
              >
                <Text>{item.label}</Text>
              </View>
            ))}
          </View>
        }
      />
      {/* 副行占位：组件的 `spacer` 只含主行，tab 行这一截要页面自己补 */}
      <View className="hist__header-gap" />

      <View className="hist__body">
        {pending ? (
          <>
            {/* 骨架屏按**当前档位**的版式画：浏览 / 收藏是三列格，留言是整宽行 */}
            {tab === 'history' ? <View className="hist__skel-date" /> : null}
            {tab === 'msgs' ? (
              <View>
                {[0, 1, 2].map((i) => (
                  <View key={`sk-${i}`} className="hist__skel-row">
                    <View className="hist__skel-rthumb" />
                    <View className="hist__skel-lines">
                      <View className="hist__skel-line" style={{ width: '52%' }} />
                      <View className="hist__skel-line" style={{ width: '86%' }} />
                      <View className="hist__skel-line" style={{ width: '28%' }} />
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <View className="hist__grid">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <View key={`sk-${i}`} className="hist__skel-cell">
                    <View className="hist__skel-sq" />
                    <View className="hist__skel-bar" style={{ width: '60%' }} />
                  </View>
                ))}
              </View>
            )}

            <View className="hist__skel-hint">
              <View className="hist__spin" />
              <Text>{loadingTextOf(tab)}</Text>
            </View>
          </>
        ) : shownCount === 0 ? (
          /*
            空态三种来由分开说（`emptyKindOf`）：
            - 真实构建 → 「后端还没有这条数据」（不是「你恰好没有记录」）；
            - 演示构建没清过 → 恰好没有记录；
            - 演示构建刚清过 → 「已清空」。第三种若复用第一种，
              用户会看到「我明明清空的，怎么说是没有后端」。
          */
          <EmptyState
            title={emptyCopyOf(tab, emptyKindOf(demo, isCleared)).title}
            text={emptyCopyOf(tab, emptyKindOf(demo, isCleared)).text}
            actionText={emptyCopyOf(tab, emptyKindOf(demo, isCleared)).action}
            onAction={() => void Taro.switchTab({ url: '/pages/home/index' })}
            icon={EMPTY_ICON[tab]}
          />
        ) : (
          <View>
            {tab === 'history'
              ? /* 全部浏览：按天分组（日期来自**足迹记录**，稿决策⑦）+ 三列格 */
                days.map((day) => (
                  <View key={day.date} className="hist__group">
                    <View className="hist__ghead">
                      <Text className="hist__gdate">{day.date}</Text>
                      <Text className="hist__gcount">{`${day.items.length} 件`}</Text>
                    </View>
                    <View className="hist__grid">{day.items.map(renderCell)}</View>
                  </View>
                ))
              : null}

            {tab === 'favs' ? (
              /* 我收藏的：三列格（失效角标与收藏页同源，稿决策⑥） */
              <View className="hist__grid">{favs.map(renderCell)}</View>
            ) : null}

            {tab === 'msgs' ? (
              /* 我留言的：整宽行 —— 缩略图 + 标题 + 类型胶囊 + 我那句话（2 行）+ 时间。
                 刻意**不显示价格**（稿决策④：这一档找的是「我当时说了什么」）。 */
              <View className="hist__rows">
                {msgs.map((item) => (
                  <View key={item.id} className="hist__row" onClick={openRecord}>
                    <View className="hist__rthumb">
                      <Image
                        className="hist__rthumb-img"
                        src={blockUrlOf(item.category)}
                        mode="aspectFill"
                      />
                      <Text className="hist__rthumb-tag">{shortLabelOf(item.category)}</Text>
                    </View>
                    <View className="hist__rmain">
                      <View className="hist__rtop">
                        <Text className="hist__rtitle">{item.title}</Text>
                        <Text className={`hist__rkind${item.kind === 'review' ? ' is-trade' : ''}`}>
                          {MESSAGE_KIND_LABEL[item.kind]}
                        </Text>
                      </View>
                      <Text className="hist__rtext">{item.text}</Text>
                      <Text className="hist__rtime">{item.timeLabel}</Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            {/* 底部说明：只有浏览档有（收藏档原有一条「已降价」说明，角标删了之后不成立） */}
            {noteOf(tab) ? <Text className="hist__note">{noteOf(tab)}</Text> : null}

            {/* 到底提示：列表非空才渲染（空态与骨架屏下都不该出现） */}
            <View className="hist__tail">
              <View className="hist__tail-line" />
              <Text className="hist__tail-tx num">{tailTextOf(tab, shownCount)}</Text>
              <View className="hist__tail-line" />
            </View>
          </View>
        )}
      </View>

      <BackTop show={showTop} onTop={backToTop} />
    </View>
  )
}
