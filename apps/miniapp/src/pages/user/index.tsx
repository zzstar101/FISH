import type { PublicUserProfile } from '@fish/contracts/users/schema'
import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useCallback, useMemo, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import NavBar from '@/components/nav-bar'
import { loadPublicUserHome } from '@/features/fetchers'
import { formatAmount, type MockListing } from '@/mock/api'
import './index.scss'

/**
 * C2 他人主页（设计稿 `设计稿_C2-user.html`）。
 *
 * **隐私硬规则**（设计稿第 04 帧的「公开信息边界」）：公开页只展示
 * 头像 / 昵称 / 认证徽章 / 在售数 / 卖出数 / 加入天数；
 * **不展示**邮箱、学号、班级、真实姓名、校区。未认证时不占位、不留白（徽章整块不渲染）。
 *
 * **数据来源（#122）**：`GET /users/:userId/public` + `GET /users/:userId/listings`
 * （`@fish/contracts/users/routes`），两个端点匿名可读。页面只渲染契约真有的字段：
 *
 * - **校区不渲染**：契约刻意没有这个字段（服务端可见性偏好 `publicCampus` 尚未落地，
 *   落地前不许公开），所以这里只显示「加入 N 天」，不拿 `Me` 的 campus 顶上。
 * - **好评率不渲染**：仓库没有 reviews / ratings 表，没有真实口径 —— 恒显 `--`，
 *   不编一个百分比。
 * - **卖出数**用契约的 `soldCount`（已完成交易里 TA 是卖家的条数），
 *   不是 mock 时代的「历史发布总数」。
 *
 * **本页范围内不做的事**：关注关系没有 follows 表、Chat 建会话的维度是
 * `(listingId, 买家)`（主页没有 listingId），两者都不是「换个数据源」能解决的，
 * 所以吸底两个按钮都**不再伪造本地状态**：点击只如实说明当前能力边界。
 *
 * **待落地（#143）**：加个性签名行 —— 展示口径与「我的」页一致，只显**首行**
 * （`features/profile/signature-text.ts`），并额外给一个**可点击「展开全部」**的入口
 * 看完整签名。数据源不能照搬「我的」页：`features/profile/signature.ts` 存的是
 * **当前登录用户**自己的签名（键按本人 id 分），他人签名要等 #143 落地的公开读出口径。
 */
export default function UserHome() {
  const router = useRouter<{ id?: string }>()
  /**
   * 路径参数就是这个页面的唯一输入。**没有兜底值**：mock 时代那句
   * `?? 'u-lin'` 在真实接口下等于"随手挑一个真实用户给访客看"，
   * 缺 id 一律进 notFound 态（见下面的 `load`）。
   */
  const userId = router.params.id ?? ''

  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'notFound' | 'failed'>('loading')
  const [profile, setProfile] = useState<PublicUserProfile | null>(null)
  const [items, setItems] = useState<MockListing[]>([])

  const load = useCallback(async () => {
    // 重试先清残留：上一轮的 notFound / failed 终态与旧数据不能带进新一轮加载。
    setLoadState('loading')
    setProfile(null)
    setItems([])

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
    setLoadState('ok')
  }, [userId])

  useLoad(() => {
    void load()
  })

  const [left, right] = useMemo(() => {
    const l: MockListing[] = []
    const r: MockListing[] = []
    items.forEach((item, i) => {
      if (i % 2 === 0) l.push(item)
      else r.push(item)
    })
    return [l, r]
  }, [items])

  /** 关注关系未拆 Domain（没有 follows 表）：不假装已经关注，也不假装刚刚关注成功。 */
  const onFollowTap = () => {
    void Taro.showToast({ title: '关注功能开发中', icon: 'none' })
  }

  /**
   * 发起会话要带 `listingId`（Chat 契约按 `(listingId, 买家)` 复用会话），
   * 而他人主页没有商品上下文 —— 如实引导用户回商品详情页发起，不伪造一个会话。
   */
  const onChatTap = () => {
    void Taro.showToast({ title: '请在商品详情页发起会话', icon: 'none' })
  }

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

  return (
    <View className="uhome">
      <View className="uhome__hero-bg" />

      <NavBar
        actions={
          <View
            className="uhome__more"
            onClick={() =>
              void Taro.showActionSheet({
                itemList: ['举报该用户', '分享 TA 的主页'],
              }).catch(() => undefined)
            }
          >
            <Image className="uhome__more-ic" src={ICONS.moreInk} mode="aspectFit" />
          </View>
        }
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
        <>
          {/* 资料没拿到之前不画头部与吸底条：先给骨架屏，避免闪一屏空壳
              （原实现把骨架屏放在 `profile` 非空的分支里，实际永远走不到） */}
          {profile ? (
            <View className="uhome__head">
              <View className="uhome__profile">
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
                  {/* 校区不渲染：契约没有该字段（服务端可见性偏好落地前不许公开），
                      所以这里只有加入天数，不拼「null校区」，也不拿本校区的默认值顶上 */}
                  <Text className="uhome__pcampus">{`加入 ${profile.joinedDays} 天`}</Text>
                </View>
              </View>

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
          ) : null}

          <View className="uhome__body">
            <View className="uhome__sect">
              <Text className="uhome__sect-title">TA 的在售</Text>
              {/* 计数用服务端的 activeCount（与上方「在售」同一口径），
                  不用 items.length —— 列表有单页上限，用它会在超出上限时低报 */}
              <Text className="uhome__sect-cnt num">
                {profile ? `${profile.activeCount} 件` : ''}
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
              <ScrollView className="uhome__scroll" scrollY>
                <View className="uhome__grid">
                  <View className="uhome__col">{left.map(card)}</View>
                  <View className="uhome__col">{right.map(card)}</View>
                </View>
              </ScrollView>
            )}
          </View>

          {/* ---- 吸底动作条：两个按钮都只说明当前能力边界，不伪造本地状态（见文件头） ---- */}
          {profile ? (
            <View className="uhome__bar">
              <View className="uhome__follow" onClick={onFollowTap}>
                <Text>关注</Text>
              </View>
              <View className="uhome__chat" onClick={onChatTap}>
                <Image className="uhome__chat-ic" src={ICONS.chatWhite} mode="aspectFit" />
                <Text>聊一聊</Text>
              </View>
            </View>
          ) : null}
        </>
      )}
    </View>
  )
}
